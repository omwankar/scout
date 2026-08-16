import { z } from "zod";
import type { CompetitiveBrief, Confidence } from "@scout/shared";

const briefSchema = z.object({
  title: z.string().min(1),
  goal: z.string().min(1),
  executiveSummary: z.string().min(1),
  subjects: z
    .array(
      z.object({
        name: z.string(),
        website: z.string().optional(),
        positioning: z.string(),
        pricing: z.string().optional(),
        strengths: z.array(z.string()),
        weaknesses: z.array(z.string()),
        notableFacts: z.array(z.string()),
      })
    )
    .min(1),
  comparisonTable: z.array(
    z.object({
      dimension: z.string(),
      values: z.record(z.string()),
    })
  ),
  recommendations: z.array(z.string()),
  sources: z.array(
    z.object({
      title: z.string(),
      url: z.string(),
      usedFor: z.string(),
    })
  ),
  confidence: z.enum(["high", "medium", "low"]),
  limitations: z.array(z.string()),
});

/** Extract the first balanced `{...}` JSON object from text (handles truncation better than greedy regex). */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Append missing closers to truncated JSON (string, then open arrays/objects). */
function closeOpenStructures(s: string): string {
  let inString = false;
  let escape = false;
  const stack: string[] = [];
  for (const ch of s) {
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") stack.pop();
  }
  let out = s;
  if (inString) out += '"';
  while (stack.length) out += stack.pop();
  return out;
}

/**
 * Recover a JSON object from output truncated mid-generation (e.g. max_tokens hit).
 * Trims back to the last structural boundary and closes open braces until it parses.
 */
export function repairTruncatedJson(text: string): unknown | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let candidate = text.slice(start).trimEnd();

  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      return JSON.parse(closeOpenStructures(candidate));
    } catch {
      // Drop the trailing incomplete token and retry from the previous boundary.
      const cut = Math.max(
        candidate.lastIndexOf(","),
        candidate.lastIndexOf("{"),
        candidate.lastIndexOf("[")
      );
      if (cut <= 0) return null;
      candidate = candidate.slice(0, cut).trimEnd();
    }
  }
  return null;
}

export function tryParseBriefJson(text: string): unknown {
  const trimmed = text.replace(/```(?:json)?/gi, "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }
  const extracted = extractJsonObject(trimmed);
  if (extracted) {
    try {
      return JSON.parse(extracted);
    } catch {
      // fall through to repair
    }
  }
  const repaired = repairTruncatedJson(trimmed);
  if (repaired !== null) return repaired;
  throw new Error("No JSON object found in done payload");
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v)).filter((v) => v.trim().length > 0);
}

function coerceConfidence(value: unknown): Confidence {
  if (value === "high" || value === "medium" || value === "low") return value;
  return "low";
}

/** Coerce partial / messy model output into a valid CompetitiveBrief. */
export function coerceBrief(raw: unknown, goal: string): CompetitiveBrief {
  const obj =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  const subjectsRaw = Array.isArray(obj.subjects) ? obj.subjects : [];
  const subjects = subjectsRaw
    .filter((s): s is Record<string, unknown> => Boolean(s) && typeof s === "object")
    .map((s) => ({
      name: asString(s.name, "Unknown"),
      website: asString(s.website) || undefined,
      positioning: asString(s.positioning, "Not enough public detail gathered."),
      pricing: asString(s.pricing) || undefined,
      strengths: asStringArray(s.strengths),
      weaknesses: asStringArray(s.weaknesses),
      notableFacts: asStringArray(s.notableFacts),
    }))
    .filter((s) => s.name !== "Unknown" || s.positioning.length > 0);

  const comparisonTable = Array.isArray(obj.comparisonTable)
    ? obj.comparisonTable
        .filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === "object")
        .map((r) => ({
          dimension: asString(r.dimension, "Dimension"),
          values:
            r.values && typeof r.values === "object" && !Array.isArray(r.values)
              ? Object.fromEntries(
                  Object.entries(r.values as Record<string, unknown>).map(([k, v]) => [
                    k,
                    String(v ?? ""),
                  ])
                )
              : {},
        }))
    : [];

  const sources = Array.isArray(obj.sources)
    ? obj.sources
        .filter((s): s is Record<string, unknown> => Boolean(s) && typeof s === "object")
        .map((s) => ({
          title: asString(s.title, "Source"),
          url: asString(s.url, "https://example.com"),
          usedFor: asString(s.usedFor, "research"),
        }))
        .filter((s) => s.url.startsWith("http"))
    : [];

  const brief: CompetitiveBrief = {
    title: asString(obj.title, "Competitive brief"),
    goal: asString(obj.goal, goal),
    executiveSummary: asString(
      obj.executiveSummary,
      "Partial research completed; see subjects and limitations."
    ),
    subjects: subjects.length
      ? subjects
      : [
          {
            name: "Research incomplete",
            positioning: "Agent reached wrap-up before collecting enough structured subject data.",
            strengths: [],
            weaknesses: [],
            notableFacts: [],
          },
        ],
    comparisonTable,
    recommendations: asStringArray(obj.recommendations),
    sources,
    confidence: coerceConfidence(obj.confidence),
    limitations: asStringArray(obj.limitations),
  };

  // Validate shape after coercion (should always pass).
  return briefSchema.parse(brief);
}

export function parseBrief(raw: unknown, goal: string): CompetitiveBrief {
  const result = briefSchema.safeParse(raw);
  if (result.success) {
    return { ...result.data, goal: result.data.goal || goal };
  }
  return coerceBrief(raw, goal);
}

/** Last-resort brief when the model cannot produce valid JSON. */
export function fallbackBrief(goal: string, evidenceNotes: string[]): CompetitiveBrief {
  const snippet = evidenceNotes
    .slice(-6)
    .map((n) => n.slice(0, 280))
    .join("\n\n");

  return coerceBrief(
    {
      title: "Competitive brief (fallback)",
      goal,
      executiveSummary:
        evidenceNotes.length > 0
          ? "The run hit wrap-up before a clean model brief was produced. Key notes are preserved below under subjects/notable facts."
          : "The run ended before enough evidence was gathered for a full competitive brief.",
      subjects: [
        {
          name: "Collected evidence",
          positioning: "Aggregated browsing notes (unstructured).",
          strengths: [],
          weaknesses: [],
          notableFacts: snippet
            ? snippet.split("\n").filter(Boolean).slice(0, 8)
            : ["No evidence notes were recorded."],
        },
      ],
      comparisonTable: [],
      recommendations: [
        "Re-run with a slightly higher step budget or steer toward official pricing pages earlier.",
      ],
      sources: [],
      confidence: "low",
      limitations: [
        "Fallback brief — model JSON was missing or invalid.",
        "Facts may be incomplete or unverified.",
      ],
    },
    goal
  );
}
