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

export type LlmHandle = { provider: "openrouter"; openai: OpenAI };

const LLM_TIMEOUT_MS = 90_000;
const TOOL_NAMES = ["search", "navigate", "click", "type", "scroll", "extract", "done", "fail"] as const;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createLlmClient(): LlmHandle {
  if (!config.openrouterApiKey) {
    throw new Error("Missing OPENROUTER_API_KEY. Create a free key at https://openrouter.ai/keys");
  }
  return {
    provider: "openrouter",
    openai: new OpenAI({
      apiKey: config.openrouterApiKey,
      baseURL: config.openrouterBaseUrl,
      timeout: LLM_TIMEOUT_MS,
      maxRetries: 0,
      defaultHeaders: {
        "HTTP-Referer": config.openrouterReferer,
        "X-Title": config.openrouterTitle,
        "X-OpenRouter-Title": config.openrouterTitle,
      },
    }),
  };
}

/** Keep every tool_use paired with a tool_result so OpenRouter history stays valid. */
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
        content: "Tool call was not executed. Continue with exactly one new tool call.",
      }
    );
  }

  return out;
}

/** Free models have smaller effective context — keep the goal + a short tail. */
export function compactMessages(
  messages: ChatCompletionMessageParam[],
  keep = 6
): ChatCompletionMessageParam[] {
  const paired = repairToolPairing(messages);
  if (paired.length <= keep) return paired;

  const head = paired[0];
  let start = Math.max(1, paired.length - (keep - 1));

  if (paired[start]?.role === "tool" && start > 1) start -= 1;
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
  while (tail.length && tail[0].role === "tool") tail.shift();
  if (!tail.length) return [head];

  return repairToolPairing([
    head,
    {
      role: "user",
      content: "[Earlier browsing turns omitted. Use only the recent evidence below.]",
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

function statusOf(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const rec = err as { status?: number; statusCode?: number };
  return rec.status ?? rec.statusCode;
}

async function withOpenRouterRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await withTimeout(fn(), LLM_TIMEOUT_MS, label);
    } catch (err) {
      lastErr = err;
      const status = statusOf(err);
      const message = err instanceof Error ? err.message : String(err);
      const rateLimited = status === 429 || /rate.?limit|too many requests/i.test(message);
      if (!rateLimited || attempt === 3) throw err;
      await sleep(2000 * (attempt + 1));
    }
  }
  throw lastErr;
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

/** Free models sometimes emit a tool call as JSON text instead of `tool_calls`. */
function parseToolFromText(text: string): LlmToolCall | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const candidates: string[] = [];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const raw of candidates) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const name = String(parsed.name ?? parsed.tool ?? parsed.function ?? "").toLowerCase();
      if (!TOOL_NAMES.includes(name as (typeof TOOL_NAMES)[number])) continue;
      const args =
        parsed.arguments && typeof parsed.arguments === "object"
          ? (parsed.arguments as Record<string, unknown>)
          : Object.fromEntries(
              Object.entries(parsed).filter(([k]) => !["name", "tool", "function", "arguments"].includes(k))
            );
      return { id: `text-${name}-${Date.now()}`, name, args };
    } catch {
      // keep scanning
    }
  }

  const call = trimmed.match(
    new RegExp(`\\b(${TOOL_NAMES.join("|")})\\s*\\(\\s*(\\{[\\s\\S]*\\})\\s*\\)`, "i")
  );
  if (call) {
    try {
      return {
        id: `text-${call[1]}-${Date.now()}`,
        name: call[1].toLowerCase(),
        args: JSON.parse(call[2]) as Record<string, unknown>,
      };
    } catch {
      return null;
    }
  }

  return null;
}

function openRouterBody(forceDone: boolean) {
  return {
    model: config.model,
    temperature: 0.2,
    top_p: 0.9,
    max_tokens: forceDone ? 2048 : 1024,
    stream: false as const,
    // OpenRouter extras: stay on free models that actually support tools.
    provider: {
      require_parameters: true,
      allow_fallbacks: true,
    },
  };
}

async function completeOpenRouterTurn(
  client: OpenAI,
  messages: ChatCompletionMessageParam[],
  options?: {
    forceDone?: boolean;
    onThoughtDelta?: (delta: string, full: string) => void;
  }
): Promise<LlmTurn> {
  const forceDone = Boolean(options?.forceDone);
  const input = compactMessages(messages, 6);

  const completion = (await withOpenRouterRetry(
    () =>
      client.chat.completions.create({
        ...openRouterBody(forceDone),
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
        tool_choice: forceDone ? { type: "function", function: { name: "done" } } : "required",
      } as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming),
    "LLM turn"
  )) as ChatCompletion;

  const choice = completion.choices[0]?.message;
  if (!choice) throw new Error("Empty OpenRouter response");

  let thought = (choice.content || "").trim();
  let toolCalls = parseOpenAiToolCalls(choice).slice(0, 1);

  if (!toolCalls.length) {
    const parsed = parseToolFromText(thought);
    if (parsed) {
      toolCalls = [parsed];
      thought = "";
    }
  }

  if (thought && options?.onThoughtDelta) {
    const chunkSize = 24;
    let acc = "";
    for (let i = 0; i < thought.length; i += chunkSize) {
      const piece = thought.slice(i, i + chunkSize);
      acc += piece;
      options.onThoughtDelta(piece, acc);
    }
  }

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
      content: thought || null,
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
  return completeOpenRouterTurn(handle.openai, messages, options);
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
  const notes = evidenceNotes.slice(-8).map((n, i) => `--- Note ${i + 1} ---\n${n.slice(0, 1800)}`);
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

  const completion = (await withOpenRouterRetry(
    () =>
      handle.openai.chat.completions.create({
        ...openRouterBody(true),
        max_tokens: 2048,
        messages: [
          { role: "system", content: SYSTEM_PROMPT_REPORT },
          { role: "user", content: userContent },
        ],
      } as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming),
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
