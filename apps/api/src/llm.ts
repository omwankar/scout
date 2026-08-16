import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions";
import { tryParseBriefJson } from "./brief.js";
import { config } from "./config.js";
import { OPENAI_TOOLS, SYSTEM_PROMPT_BROWSE, SYSTEM_PROMPT_REPORT } from "./tools.js";

export type LlmToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
};

export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type LlmTurn = {
  thought: string;
  toolCalls: LlmToolCall[];
  assistantMessage: ChatCompletionMessageParam;
  usage?: TokenUsage;
};

export type LlmHandle =
  | { provider: "anthropic"; anthropic: Anthropic }
  | { provider: "nvidia"; openai: OpenAI };

const LLM_TIMEOUT_MS = 90_000;

export function createLlmClient(): LlmHandle {
  if (config.llmProvider === "anthropic") {
    if (!config.anthropicApiKey) {
      throw new Error("Missing ANTHROPIC_API_KEY");
    }
    return {
      provider: "anthropic",
      anthropic: new Anthropic({
        apiKey: config.anthropicApiKey,
        timeout: LLM_TIMEOUT_MS,
        maxRetries: 0,
      }),
    };
  }

  if (config.llmProvider === "nvidia") {
    if (!config.nvidiaApiKey) {
      throw new Error("Missing NVIDIA_API_KEY");
    }
    return {
      provider: "nvidia",
      openai: new OpenAI({
        apiKey: config.nvidiaApiKey,
        baseURL: config.nvidiaBaseUrl,
        timeout: LLM_TIMEOUT_MS,
        maxRetries: 0,
      }),
    };
  }

  throw new Error("Set LLM_PROVIDER=anthropic (or nvidia) and the matching API key.");
}

function openaiToolsToAnthropic(forceDone: boolean): Anthropic.Tool[] {
  const tools = forceDone
    ? OPENAI_TOOLS.filter((t) => t.type === "function" && t.function.name === "done")
    : OPENAI_TOOLS;

  return tools.map((t, i) => {
    if (t.type !== "function") throw new Error("Unexpected tool type");
    return {
      name: t.function.name,
      description: t.function.description || t.function.name,
      input_schema: (t.function.parameters || {
        type: "object",
        properties: {},
      }) as Anthropic.Tool.InputSchema,
      // Cache the static tool definitions — Anthropic reuses the processed
      // prefix on every turn, cutting per-step latency and cost.
      ...(i === tools.length - 1
        ? { cache_control: { type: "ephemeral" as const } }
        : {}),
    };
  });
}

/** Convert OpenAI-style chat history → Anthropic messages. */
function toAnthropicMessages(
  messages: ChatCompletionMessageParam[]
): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === "system") continue;

    if (msg.role === "user") {
      const content =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content
                .map((p) => ("text" in p ? p.text : ""))
                .filter(Boolean)
                .join("\n")
            : "";
      if (!content) continue;
      const last = out[out.length - 1];
      if (last?.role === "user" && typeof last.content === "string") {
        last.content = `${last.content}\n\n${content}`;
      } else {
        out.push({ role: "user", content });
      }
      continue;
    }

    if (msg.role === "assistant") {
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (typeof msg.content === "string" && msg.content.trim()) {
        blocks.push({ type: "text", text: msg.content });
      }
      // One tool_use per assistant turn — matches Scout's single-tool executor.
      for (const tc of (msg.tool_calls ?? []).slice(0, 1)) {
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
        } catch {
          input = {};
        }
        blocks.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input,
        });
      }
      if (!blocks.length) {
        blocks.push({ type: "text", text: "" });
      }
      out.push({ role: "assistant", content: blocks });
      continue;
    }

    if (msg.role === "tool") {
      const toolResult: Anthropic.ToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: msg.tool_call_id,
        content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
      };
      const last = out[out.length - 1];
      if (last?.role === "user" && Array.isArray(last.content)) {
        (last.content as Anthropic.ContentBlockParam[]).push(toolResult);
      } else if (last?.role === "user" && typeof last.content === "string") {
        out[out.length - 1] = {
          role: "user",
          content: [{ type: "text", text: last.content }, toolResult],
        };
      } else {
        out.push({ role: "user", content: [toolResult] });
      }
    }
  }

  // Anthropic requires alternating roles starting with user
  if (out.length && out[0].role !== "user") {
    out.unshift({ role: "user", content: "Continue." });
  }

  return out;
}

/**
 * Anthropic requires every tool_use to be followed immediately by tool_result(s).
 * Scout only executes one tool per turn — keep the first call and synthesize
 * any missing results so a prior bug cannot poison later turns.
 */
export function repairToolPairing(
  messages: ChatCompletionMessageParam[]
): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i];
    const toolCalls =
      msg.role === "assistant" && Array.isArray(msg.tool_calls) ? msg.tool_calls : null;

    if (!toolCalls?.length) {
      // Drop orphan tool results with no preceding assistant tool_use.
      if (msg.role !== "tool") out.push(msg);
      i += 1;
      continue;
    }

    const firstCall = toolCalls[0];
    out.push({
      role: "assistant",
      content: typeof msg.content === "string" ? msg.content : null,
      tool_calls: [firstCall],
    });

    i += 1;
    let matched: ChatCompletionMessageParam | null = null;
    while (i < messages.length && messages[i].role === "tool") {
      const toolMsg = messages[i] as Extract<ChatCompletionMessageParam, { role: "tool" }>;
      if (!matched && toolMsg.tool_call_id === firstCall.id) {
        matched = toolMsg;
      }
      i += 1;
    }

    out.push(
      matched ?? {
        role: "tool",
        tool_call_id: firstCall.id,
        content:
          "Tool call was not executed. Continue with exactly one new tool call.",
      }
    );
  }

  return out;
}

/** Keep prompt small — first goal message + recent turns, never splitting tool_use/tool_result. */
export function compactMessages(
  messages: ChatCompletionMessageParam[],
  keep = 6
): ChatCompletionMessageParam[] {
  const paired = repairToolPairing(messages);
  if (paired.length <= keep) return paired;

  const head = paired[0];
  let start = Math.max(1, paired.length - (keep - 1));

  // If we would start on a lone tool result, include its assistant tool_use message.
  if (paired[start]?.role === "tool" && start > 1) {
    start -= 1;
  }
  // If the cut would orphan an assistant tool_use at the boundary, shift later.
  while (
    start > 1 &&
    paired[start - 1]?.role === "assistant" &&
    Array.isArray((paired[start - 1] as { tool_calls?: unknown[] }).tool_calls) &&
    (paired[start - 1] as { tool_calls?: unknown[] }).tool_calls!.length > 0 &&
    paired[start]?.role !== "tool"
  ) {
    start -= 1;
  }

  const tail = paired.slice(start);
  // Drop a leading tool message that still has no preceding assistant in the tail.
  while (tail.length && tail[0].role === "tool") {
    tail.shift();
  }

  if (!tail.length) return [head];

  return repairToolPairing([
    head,
    {
      role: "user",
      content:
        "[Earlier browsing turns omitted for brevity. Use the recent evidence below only.]",
    },
    ...tail,
  ]);
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function parseOpenAiToolCalls(
  choice: ChatCompletion["choices"][number]["message"]
): LlmToolCall[] {
  return (choice.tool_calls ?? []).map((tc: ChatCompletionMessageToolCall) => {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
    } catch {
      args = {};
    }
    return { id: tc.id, name: tc.function.name, args };
  });
}

async function completeAnthropicTurn(
  client: Anthropic,
  messages: ChatCompletionMessageParam[],
  options?: {
    forceDone?: boolean;
    onThoughtDelta?: (delta: string, full: string) => void;
  }
): Promise<LlmTurn> {
  const forceDone = Boolean(options?.forceDone);
  const input = compactMessages(messages, 10);
  const tools = openaiToolsToAnthropic(forceDone);

  const stream = client.messages.stream({
    model: config.model,
    max_tokens: forceDone ? 4096 : 1536,
    temperature: 0.2,
    system: [
      {
        type: "text",
        text: forceDone ? SYSTEM_PROMPT_REPORT : SYSTEM_PROMPT_BROWSE,
        cache_control: { type: "ephemeral" },
      },
    ],
    tools,
    tool_choice: forceDone
      ? { type: "tool", name: "done" }
      : { type: "any" },
    messages: toAnthropicMessages(input),
  });

  let thought = "";
  stream.on("text", (text) => {
    thought += text;
    options?.onThoughtDelta?.(text, thought);
  });

  const response = await withTimeout(stream.finalMessage(), LLM_TIMEOUT_MS, "LLM turn");

  thought = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text.trim())
    .filter(Boolean)
    .join("\n");

  // Anthropic requires every tool_use to be followed by a tool_result.
  // Scout executes exactly one tool per turn — keep only the first tool_use.
  const toolUses = response.content
    .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
    .slice(0, 1);

  const toolCalls: LlmToolCall[] = toolUses.map((t) => ({
    id: t.id,
    name: t.name,
    args: (t.input ?? {}) as Record<string, unknown>,
  }));

  const assistantMessage: ChatCompletionMessageParam = {
    role: "assistant",
    content: thought || null,
    tool_calls: toolUses.map((t) => ({
      id: t.id,
      type: "function" as const,
      function: {
        name: t.name,
        arguments: JSON.stringify(t.input ?? {}),
      },
    })),
  };

  const usage: TokenUsage | undefined = response.usage
    ? {
        promptTokens: response.usage.input_tokens ?? 0,
        completionTokens: response.usage.output_tokens ?? 0,
        totalTokens:
          (response.usage.input_tokens ?? 0) + (response.usage.output_tokens ?? 0),
      }
    : undefined;

  return { thought, toolCalls, assistantMessage, usage };
}

async function completeNvidiaTurn(
  client: OpenAI,
  messages: ChatCompletionMessageParam[],
  options?: {
    forceDone?: boolean;
    onThoughtDelta?: (delta: string, full: string) => void;
  }
): Promise<LlmTurn> {
  const forceDone = Boolean(options?.forceDone);
  const input = compactMessages(messages, 10);

  // NVIDIA tool+stream is unreliable (hangs). Use non-stream, then drip thought text.
  const completion = (await withTimeout(
    client.chat.completions.create({
      model: config.model,
      messages: [
        {
          role: "system",
          content: forceDone ? SYSTEM_PROMPT_REPORT : SYSTEM_PROMPT_BROWSE,
        },
        ...input,
      ],
      tools: forceDone
        ? OPENAI_TOOLS.filter((t) => t.type === "function" && t.function.name === "done")
        : OPENAI_TOOLS,
      tool_choice: forceDone
        ? { type: "function", function: { name: "done" } }
        : "auto",
      temperature: 0.2,
      top_p: 0.7,
      max_tokens: forceDone ? 4096 : 2048,
      stream: false,
    }),
    LLM_TIMEOUT_MS,
    "LLM turn"
  )) as ChatCompletion;

  const choice = completion.choices[0]?.message;
  if (!choice) throw new Error("Empty LLM response");

  const thought = (choice.content || "").trim();
  if (thought && options?.onThoughtDelta) {
    // Simulate token stream for timeline UX
    const chunkSize = 24;
    let acc = "";
    for (let i = 0; i < thought.length; i += chunkSize) {
      const piece = thought.slice(i, i + chunkSize);
      acc += piece;
      options.onThoughtDelta(piece, acc);
    }
  }

  const toolCalls = parseOpenAiToolCalls(choice).slice(0, 1);
  const usage = completion.usage
    ? {
        promptTokens: completion.usage.prompt_tokens ?? 0,
        completionTokens: completion.usage.completion_tokens ?? 0,
        totalTokens: completion.usage.total_tokens ?? 0,
      }
    : undefined;

  return {
    thought,
    toolCalls,
    assistantMessage: {
      role: "assistant",
      content: choice.content ?? null,
      tool_calls: toolCalls.map((t) => ({
        id: t.id,
        type: "function" as const,
        function: {
          name: t.name,
          arguments: JSON.stringify(t.args ?? {}),
        },
      })),
    },
    usage,
  };
}

export async function completeAgentTurn(
  handle: LlmHandle,
  messages: ChatCompletionMessageParam[],
  options?: {
    forceDone?: boolean;
    onThoughtDelta?: (delta: string, full: string) => void;
  }
): Promise<LlmTurn> {
  if (handle.provider === "anthropic") {
    return completeAnthropicTurn(handle.anthropic, messages, options);
  }
  return completeNvidiaTurn(handle.openai, messages, options);
}

export type SynthesizeResult = {
  raw: unknown;
  usage?: TokenUsage;
};

export async function synthesizeBriefJson(
  handle: LlmHandle,
  goal: string,
  evidenceNotes: string[]
): Promise<SynthesizeResult> {
  const notes = evidenceNotes.slice(-12).map((n, i) => `--- Note ${i + 1} ---\n${n.slice(0, 2500)}`);
  const userContent = [
    `Goal: ${goal}`,
    "",
    "Evidence gathered during browsing (may be partial):",
    ...notes,
    "",
    "Return ONE CompetitiveBrief JSON object only.",
    "Cover every subject in the goal. Include comparisonTable with Positioning, Pricing, Best for.",
    "Use real URLs from evidence as sources. No markdown fences.",
  ].join("\n");

  if (handle.provider === "anthropic") {
    const response = await withTimeout(
      handle.anthropic.messages.create({
        model: config.model,
        max_tokens: 8000, // truncated JSON was the top synthesis failure
        temperature: 0.2,
        system: SYSTEM_PROMPT_REPORT,
        messages: [{ role: "user", content: userContent }],
      }),
      LLM_TIMEOUT_MS,
      "Brief synthesis"
    );
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (!text) throw new Error("Empty brief synthesis");
    // Parses clean JSON, fenced JSON, or repairs truncated output.
    const raw = tryParseBriefJson(text);
    return {
      raw,
      usage: response.usage
        ? {
            promptTokens: response.usage.input_tokens ?? 0,
            completionTokens: response.usage.output_tokens ?? 0,
            totalTokens:
              (response.usage.input_tokens ?? 0) + (response.usage.output_tokens ?? 0),
          }
        : undefined,
    };
  }

  const completion = (await withTimeout(
    handle.openai.chat.completions.create({
      model: config.model,
      temperature: 0.2,
      top_p: 0.7,
      max_tokens: 8000,
      stream: false,
      messages: [
        { role: "system", content: SYSTEM_PROMPT_REPORT },
        { role: "user", content: userContent },
      ],
    }),
    LLM_TIMEOUT_MS,
    "Brief synthesis"
  )) as ChatCompletion;

  const text = completion.choices[0]?.message?.content?.trim() || "";
  if (!text) throw new Error("Empty brief synthesis");
  const raw = tryParseBriefJson(text);
  return {
    raw,
    usage: completion.usage
      ? {
          promptTokens: completion.usage.prompt_tokens ?? 0,
          completionTokens: completion.usage.completion_tokens ?? 0,
          totalTokens: completion.usage.total_tokens ?? 0,
        }
      : undefined,
  };
}
