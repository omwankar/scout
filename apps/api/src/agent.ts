import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { AgentAction, AgentActionName, CompetitiveBrief } from "@scout/shared";
import { config } from "./config.js";
import { BrowserSession } from "./browser.js";
import { fallbackBrief, parseBrief } from "./brief.js";
import {
  completeAgentTurn,
  createLlmClient,
  synthesizeBriefJson,
  type LlmHandle,
  type TokenUsage,
} from "./llm.js";
import { runStore, type RunRecord } from "./run-store.js";
import { formatSearchResults, webSearch } from "./search.js";

const TOOL_RESULT_CHARS = 4500;
const EVIDENCE_NOTE_CHARS = 3500;

function addUsage(total: TokenUsage, next?: TokenUsage) {
  if (!next) return;
  total.promptTokens += next.promptTokens;
  total.completionTokens += next.completionTokens;
  total.totalTokens += next.totalTokens;
}

function emitUsageThought(run: RunRecord, label: string, usage?: TokenUsage) {
  if (!usage) return;
  runStore.emit(run, {
    type: "thought",
    text: `Tokens ${label}: in ${usage.promptTokens} / out ${usage.completionTokens} (total ${usage.totalTokens})`,
  });
}

function asAction(
  name: AgentActionName,
  args: Record<string, unknown>,
  requiresApproval?: boolean
): AgentAction {
  return { name, args, requiresApproval };
}

function needsApproval(run: RunRecord, name: AgentActionName): boolean {
  if (!run.requireApproval) return false;
  return name === "navigate" || name === "type";
}

async function waitForApproval(
  run: RunRecord,
  action: AgentAction,
  reason: string
): Promise<"approve" | "skip"> {
  runStore.setStatus(run, "awaiting_approval", reason);
  runStore.emit(run, {
    type: "approval_required",
    action,
    reason,
  });

  const decision = await new Promise<{ decision: "approve" | "skip"; note?: string }>((resolve) => {
    run.pendingApproval = { resolve };
  });
  run.pendingApproval = undefined;

  if (decision.note) {
    run.steerQueue.push(decision.note);
  }

  if (run.stopRequested) return "skip";
  runStore.setStatus(run, "running", "Resumed after approval");
  return decision.decision;
}

function drainSteers(run: RunRecord): string | null {
  if (!run.steerQueue.length) return null;
  const messages = run.steerQueue.splice(0, run.steerQueue.length);
  for (const message of messages) {
    runStore.emit(run, { type: "steer", message });
  }
  return `Human steering notes (follow these):\n${messages.map((m) => `- ${m}`).join("\n")}`;
}

function formatSnapshot(snapshot: Awaited<ReturnType<BrowserSession["snapshot"]>>): string {
  const elements = snapshot.elements
    .map((el) => {
      const value = el.value ? ` value="${el.value}"` : "";
      return `[${el.id}] ${el.role}: "${el.name}"${value}`;
    })
    .join("\n");
  return [
    `URL: ${snapshot.url}`,
    `Title: ${snapshot.title}`,
    "",
    "Interactive elements:",
    elements || "(none detected)",
    "",
    "Visible text preview:",
    snapshot.textPreview || "(empty)",
  ].join("\n");
}

async function emitScreenshot(run: RunRecord, browser: BrowserSession) {
  try {
    const shot = await browser.screenshot();
    const page = browser.getPage();
    run.currentUrl = page.url();
    runStore.emit(run, {
      type: "screenshot",
      url: page.url(),
      imageBase64: shot.base64,
      mimeType: shot.mimeType,
    });
  } catch {
    // A missed frame is not actionable — never surface it as a run error.
  }
}

function finishWithBrief(run: RunRecord, brief: CompetitiveBrief, note: string) {
  run.brief = brief;
  runStore.emit(run, {
    type: "action",
    action: { name: "done", args: { brief } },
    result: note,
  });
  runStore.emit(run, { type: "result", brief });
  runStore.setStatus(run, "completed", note);
}

async function forceCompileBrief(
  client: LlmHandle,
  run: RunRecord,
  messages: ChatCompletionMessageParam[],
  evidenceNotes: string[],
  usageTotal: TokenUsage
): Promise<boolean> {
  runStore.emit(run, {
    type: "thought",
    text: "Wrapping up — compiling brief from evidence (no more browsing)…",
  });

  // Prefer direct JSON synthesis first — more reliable / less hang-prone than tool_choice=done
  // with a giant tool schema + long chat history.
  if (evidenceNotes.length) {
    try {
      runStore.emit(run, {
        type: "thought",
        text: "Synthesizing CompetitiveBrief from collected notes…",
      });
      const { raw, usage } = await synthesizeBriefJson(client, run.goal, evidenceNotes);
      addUsage(usageTotal, usage);
      emitUsageThought(run, "wrap-up", usage);
      const brief = parseBrief(raw, run.goal);
      if (!brief.limitations.includes("Compiled at end of step budget")) {
        brief.limitations.push("Compiled at end of step budget");
      }
      if (brief.confidence === "high") brief.confidence = "medium";
      finishWithBrief(run, brief, "Brief synthesized at wrap-up");
      return true;
    } catch (err) {
      runStore.emit(run, {
        type: "error",
        message: `Brief synthesis failed: ${err instanceof Error ? err.message : String(err)}`,
        recoverable: true,
      });
    }
  }

  messages.push({
    role: "user",
    content:
      "CRITICAL: No more browsing. Call the done tool NOW with a complete CompetitiveBrief from the evidence already gathered. Lower confidence if incomplete.",
  });

  try {
    const turn = await completeAgentTurn(client, messages, { forceDone: true });
    addUsage(usageTotal, turn.usage);
    emitUsageThought(run, "forced-done", turn.usage);
    // Always pair forced tool_use with a tool_result for history hygiene.
    messages.push(turn.assistantMessage);
    const doneCall = turn.toolCalls.find((t) => t.name === "done");
    if (doneCall) {
      messages.push({
        role: "tool",
        tool_call_id: doneCall.id,
        content: "Brief accepted.",
      });
    }
    if (turn.thought) {
      runStore.emit(run, { type: "thought", text: turn.thought });
    }
    if (doneCall?.args?.brief) {
      const brief = parseBrief(doneCall.args.brief, run.goal);
      finishWithBrief(run, brief, "Brief compiled (forced wrap-up)");
      return true;
    }
  } catch (err) {
    runStore.emit(run, {
      type: "error",
      message: `Forced done failed: ${err instanceof Error ? err.message : String(err)}`,
      recoverable: true,
    });
  }

  // Guarantee a brief so the demo run never dead-ends on JSON shape errors.
  const brief = fallbackBrief(run.goal, evidenceNotes);
  finishWithBrief(run, brief, "Brief compiled from evidence fallback");
  return true;
}

export async function runAgent(run: RunRecord): Promise<void> {
  if (config.llmProvider === "none" || (!config.anthropicApiKey && !config.nvidiaApiKey)) {
    runStore.setStatus(run, "failed", "Missing LLM API key");
    run.error = "Set ANTHROPIC_API_KEY (recommended) or NVIDIA_API_KEY, then restart.";
    runStore.emit(run, { type: "error", message: run.error, recoverable: false });
    return;
  }

  let client: LlmHandle;
  try {
    client = createLlmClient();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    runStore.setStatus(run, "failed", message);
    run.error = message;
    runStore.emit(run, { type: "error", message, recoverable: false });
    return;
  }

  const browser = new BrowserSession();
  const startedAt = Date.now();
  const messages: ChatCompletionMessageParam[] = [];
  const evidenceNotes: string[] = [];
  const usageTotal: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let consecutiveErrors = 0;
  let extractsSeen = 0;

  try {
    runStore.setStatus(
      run,
      "running",
      config.useBrowserbase ? "Launching Browserbase session" : "Launching local browser"
    );
    await browser.launch();
    runStore.emit(run, {
      type: "thought",
      text: `Browser ready (${browser.provider}). LLM: ${config.llmProvider} / ${config.model}. Step budget: ${config.maxSteps}.`,
    });
    await emitScreenshot(run, browser);

    const opening = [
      `Research goal: ${run.goal}`,
      "",
      `Budget: up to ${config.maxSteps} steps, ${Math.round(config.maxRuntimeMs / 60000)} min runtime.`,
      "Hero path for A vs B: search official sites → navigate /pricing (and product home) for EACH subject → extract after each useful page → done.",
      "If an extract is thin (nav/chrome only), scroll or click Pricing/Product and extract again before moving on.",
      "Do not call done until both subjects have positioning + pricing signals (unless ≤2 steps remain).",
      config.tavilyApiKey ? "Tavily search is available — use it to find official URLs fast." : "Navigate directly to known official URLs.",
      "",
      formatSnapshot(await browser.snapshot()),
    ].join("\n");
    messages.push({ role: "user", content: opening });

    for (let step = 0; step < config.maxSteps; step++) {
      if (run.stopRequested) {
        runStore.setStatus(run, "stopped", "Stopped by user");
        return;
      }

      // Honor Pause — block before the next LLM/tool turn until Resume or Abort.
      if (run.pauseRequested) {
        if (run.status !== "paused") {
          runStore.setStatus(run, "paused", "Paused — waiting for resume");
        }
        while (run.pauseRequested && !run.stopRequested) {
          await new Promise((r) => setTimeout(r, 250));
        }
        if (run.stopRequested) {
          runStore.setStatus(run, "stopped", "Stopped by user");
          return;
        }
        if (run.status === "paused") {
          runStore.setStatus(run, "running", "Resumed");
        }
      }

      if (Date.now() - startedAt > config.maxRuntimeMs) {
        const ok = await forceCompileBrief(client, run, messages, evidenceNotes, usageTotal);
        if (ok) {
          emitUsageThought(run, "run total", usageTotal);
          return;
        }
        throw new Error(
          `Run exceeded maximum runtime (${Math.round(config.maxRuntimeMs / 60000)} min)`
        );
      }

      const steer = drainSteers(run);
      if (steer) {
        messages.push({ role: "user", content: steer });
      }

      const stepsLeft = config.maxSteps - step;

      // Only force wrap-up on the final step — leave room for thorough browsing.
      if (stepsLeft <= 1) {
        runStore.emit(run, {
          type: "thought",
          text: `Step ${step + 1}/${config.maxSteps}: final step — compiling brief.`,
        });
        const ok = await forceCompileBrief(client, run, messages, evidenceNotes, usageTotal);
        if (ok) {
          emitUsageThought(run, "run total", usageTotal);
          return;
        }
        throw new Error("Could not compile brief before step budget ended");
      }

      // Soft nudge only when we already have solid multi-subject evidence.
      if (extractsSeen >= 4 && stepsLeft <= 3) {
        messages.push({
          role: "user",
          content:
            "You have multiple extracts. If BOTH subjects have positioning + pricing evidence, prefer calling done. Otherwise grab the missing official pricing page first.",
        });
      }

      runStore.emit(run, {
        type: "thought",
        text: `Step ${step + 1}/${config.maxSteps}: deciding next action… (${stepsLeft} left)`,
        streaming: true,
      });

      const thoughtStreamId = `think-${step}-${Date.now()}`;
      let lastFlush = 0;
      let streamedAny = false;

      let turn;
      try {
        turn = await completeAgentTurn(client, messages, {
          onThoughtDelta: (_delta, full) => {
            streamedAny = true;
            const now = Date.now();
            if (now - lastFlush < 60 && full.length % 24 !== 0) return;
            lastFlush = now;
            runStore.emitThoughtStream(run, thoughtStreamId, full, true);
          },
        });
      } catch (err) {
        consecutiveErrors += 1;
        const message = err instanceof Error ? err.message : String(err);
        runStore.emit(run, {
          type: "error",
          message: `LLM error: ${message}`,
          recoverable: consecutiveErrors < config.maxLlmErrors,
        });
        if (consecutiveErrors >= config.maxLlmErrors) throw err;
        messages.push({
          role: "user",
          content: `The previous model call failed (${message}). Continue carefully with one tool call.`,
        });
        continue;
      }

      addUsage(usageTotal, turn.usage);
      emitUsageThought(run, `step ${step + 1}`, turn.usage);

      if (turn.thought) {
        if (streamedAny) {
          runStore.emitThoughtStream(run, thoughtStreamId, turn.thought, false);
        } else {
          runStore.emit(run, { type: "thought", text: turn.thought });
        }
      }

      let toolUses = turn.toolCalls.slice(0, 1);
      if (!toolUses.length) {
        consecutiveErrors += 1;
        // Do not push an assistant tool_use without a matching tool_result.
        messages.push({
          role: "user",
          content:
            "You must call exactly one tool per turn (search/navigate/click/type/scroll/extract/done/fail).",
        });
        if (consecutiveErrors >= config.maxLlmErrors || stepsLeft <= 1) {
          const ok = await forceCompileBrief(client, run, messages, evidenceNotes, usageTotal);
          if (ok) {
            emitUsageThought(run, "run total", usageTotal);
            return;
          }
          throw new Error("Agent stopped calling tools");
        }
        continue;
      }

      // Only redirect browse → done on the very last step.
      if (
        stepsLeft <= 1 &&
        toolUses[0] &&
        !["done", "fail"].includes(toolUses[0].name)
      ) {
        runStore.emit(run, {
          type: "thought",
          text: `Redirecting from ${toolUses[0].name} → done (final step).`,
        });
        const ok = await forceCompileBrief(client, run, messages, evidenceNotes, usageTotal);
        if (ok) {
          emitUsageThought(run, "run total", usageTotal);
          return;
        }
        throw new Error("Could not compile brief before step budget ended");
      }

      // Push assistant only after we know we will answer with a tool_result.
      messages.push({
        role: "assistant",
        content:
          typeof turn.assistantMessage.content === "string"
            ? turn.assistantMessage.content
            : turn.thought || null,
        tool_calls: toolUses.map((t) => ({
          id: t.id,
          type: "function" as const,
          function: {
            name: t.name,
            arguments: JSON.stringify(t.args ?? {}),
          },
        })),
      });

      for (const tool of toolUses) {
        if (run.stopRequested) {
          messages.push({
            role: "tool",
            tool_call_id: tool.id,
            content: "Stopped by user before tool executed.",
          });
          break;
        }

        const name = tool.name as AgentActionName;
        const args = tool.args;
        const action = asAction(name, args, needsApproval(run, name));

        if (action.requiresApproval) {
          const decision = await waitForApproval(
            run,
            action,
            `Approve ${name}? ${String(args.reason ?? "")}`
          );
          if (decision === "skip") {
            runStore.emit(run, {
              type: "action",
              action,
              result: "Skipped by user",
            });
            messages.push({
              role: "tool",
              tool_call_id: tool.id,
              content: "Action skipped by human. Choose a different approach.",
            });
            continue;
          }
        }

        // Empty / incomplete done → synthesize brief (don't retry or spam errors).
        if (name === "done") {
          const briefArg = extractBriefArg(args);
          messages.push({
            role: "tool",
            tool_call_id: tool.id,
            content: briefArg
              ? "Brief payload received."
              : "done received without brief — synthesizing from evidence.",
          });

          if (briefArg) {
            try {
              const brief = parseBrief(briefArg, run.goal);
              finishWithBrief(run, brief, "Brief compiled");
              emitUsageThought(run, "run total", usageTotal);
              return;
            } catch (err) {
              runStore.emit(run, {
                type: "thought",
                text: `done brief invalid — synthesizing wrap-up (${err instanceof Error ? err.message : String(err)})`,
              });
            }
          } else {
            runStore.emit(run, {
              type: "thought",
              text: "Model signaled done — compiling brief from evidence…",
            });
          }

          const ok = await forceCompileBrief(
            client,
            run,
            messages,
            evidenceNotes,
            usageTotal
          );
          if (ok) {
            emitUsageThought(run, "run total", usageTotal);
            return;
          }
          throw new Error("done signaled but wrap-up could not compile a brief");
        }

        let resultText = "";
        let errorText: string | undefined;
        const maxRetries = Math.max(0, config.maxToolRetries);

        for (let retry = 0; retry <= maxRetries; retry++) {
          try {
            resultText = await executeTool(browser, name, args, run.goal);
            consecutiveErrors = 0;
            errorText = undefined;
            break;
          } catch (err) {
            errorText = err instanceof Error ? err.message : String(err);
            consecutiveErrors += 1;
            runStore.emit(run, {
              type: "action",
              action,
              retry: retry + 1,
              error: errorText,
            });
            if (retry < maxRetries) {
              await browser.getPage().waitForTimeout(400);
            }
          }
        }

        if (errorText && !resultText) {
          runStore.emit(run, {
            type: "error",
            message: `Action ${name} failed: ${errorText}`,
            recoverable: true,
          });
          messages.push({
            role: "tool",
            tool_call_id: tool.id,
            content: `ERROR: ${errorText}. Recover with a different action or call fail/done if blocked.`,
          });
          await emitScreenshot(run, browser);
          continue;
        }

        if (name === "fail") {
          run.error = String(args.message ?? resultText);
          runStore.emit(run, {
            type: "action",
            action,
            result: run.error,
          });
          runStore.emit(run, {
            type: "error",
            message: `${run.error} Tried: ${String(args.whatWasTried ?? "")}`,
            recoverable: false,
          });
          runStore.setStatus(run, "failed", run.error);
          emitUsageThought(run, "run total", usageTotal);
          return;
        }

        if (name === "extract") extractsSeen += 1;
        if (name === "search" || name === "extract") {
          evidenceNotes.push(`[${name}] ${resultText.slice(0, EVIDENCE_NOTE_CHARS)}`);
        } else if (name === "navigate") {
          evidenceNotes.push(
            `[navigate] ${resultText.slice(0, 200)} | page: ${browser.getPage().url()}`
          );
        }

        runStore.emit(run, {
          type: "action",
          action,
          result: resultText.slice(0, 500),
        });

        const remaining = Math.max(0, config.maxSteps - step - 1);
        let toolContent: string;

        if (name === "search") {
          toolContent = `${resultText.slice(0, TOOL_RESULT_CHARS)}\n\nSteps left: ${remaining}. Navigate to official product/pricing URLs next.`;
        } else if (name === "extract") {
          await emitScreenshot(run, browser);
          const url = browser.getPage().url();
          run.currentUrl = url;
          const thin = resultText.replace(/\s+/g, " ").trim().length < 280;
          toolContent = [
            `URL: ${url}`,
            resultText.slice(0, TOOL_RESULT_CHARS),
            "",
            `Steps left: ${remaining}.`,
            thin
              ? "Extract looks thin (likely nav chrome). Scroll or click Pricing/Product/Docs, then extract again."
              : extractsSeen >= 4
                ? "Solid extracts so far — if both subjects covered, consider done; else get the missing pricing page."
                : "Continue covering remaining subjects (prefer official /pricing).",
          ].join("\n");
        } else {
          // Screenshot + snapshot in parallel — saves a browser round-trip per step.
          const [, snapshot] = await Promise.all([
            emitScreenshot(run, browser),
            browser.snapshot(),
          ]);
          run.currentUrl = snapshot.url;
          toolContent = [
            resultText.slice(0, TOOL_RESULT_CHARS),
            "",
            formatSnapshot(snapshot),
            "",
            `Steps left: ${remaining}.`,
            remaining <= 1
              ? "MUST call done next."
              : extractsSeen >= 4
                ? "If both subjects have pricing + positioning, prefer done; else keep browsing."
                : "Extract this page if it has pricing/positioning, else navigate to /pricing.",
          ].join("\n");
        }

        messages.push({
          role: "tool",
          tool_call_id: tool.id,
          content: toolContent,
        });
      }

      if (run.stopRequested) {
        runStore.setStatus(run, "stopped", "Stopped by user");
        return;
      }
    }

    const ok = await forceCompileBrief(client, run, messages, evidenceNotes, usageTotal);
    if (!ok) {
      throw new Error(`Exceeded max steps (${config.maxSteps}) without completing the brief`);
    }
    emitUsageThought(run, "run total", usageTotal);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    run.error = message;
    runStore.emit(run, {
      type: "error",
      message,
      recoverable: false,
    });
    if (run.status !== "stopped" && run.status !== "completed") {
      runStore.setStatus(run, "failed", message);
    }
    if (usageTotal.totalTokens > 0) {
      emitUsageThought(run, "run total", usageTotal);
    }
  } finally {
    await browser.close();
  }
}

/** Accept nested brief, or a flattened CompetitiveBrief as tool args. */
function extractBriefArg(args: Record<string, unknown>): unknown {
  if (args.brief !== undefined && args.brief !== null) return args.brief;
  if (typeof args.title === "string" && Array.isArray(args.subjects)) {
    return args;
  }
  return undefined;
}

async function executeTool(
  browser: BrowserSession,
  name: AgentActionName,
  args: Record<string, unknown>,
  goal: string
): Promise<string> {
  switch (name) {
    case "search": {
      const results = await webSearch(String(args.query));
      return `Search results for "${String(args.query)}":\n\n${formatSearchResults(results)}`;
    }
    case "navigate":
      return `Navigated to ${await browser.navigate(String(args.url))}`;
    case "click":
      return browser.click(Number(args.elementId));
    case "type":
      return browser.type(Number(args.elementId), String(args.text), Boolean(args.submit));
    case "scroll":
      return browser.scroll(
        (args.direction === "up" ? "up" : "down") as "up" | "down",
        typeof args.amount === "number" ? args.amount : 600
      );
    case "extract":
      return await browser.extract();
    case "done": {
      const briefArg = extractBriefArg(args);
      if (briefArg === undefined) {
        throw new Error("done requires a brief object");
      }
      const brief = parseBrief(briefArg, goal);
      return JSON.stringify(brief);
    }
    case "fail":
      return String(args.message ?? "Failed");
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
