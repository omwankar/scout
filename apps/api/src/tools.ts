import type OpenAI from "openai";

export const OPENAI_TOOLS: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "search",
      description:
        "Web search via Tavily to find official product, pricing, and docs URLs quickly.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          reason: { type: "string" },
        },
        required: ["query", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "navigate",
      description: "Navigate to a public http(s) URL. Prefer official product/pricing/docs pages.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Absolute URL to open" },
          reason: { type: "string" },
        },
        required: ["url", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "click",
      description: "Click an interactive element by numeric id from the page snapshot.",
      parameters: {
        type: "object",
        properties: {
          elementId: { type: "number" },
          reason: { type: "string" },
        },
        required: ["elementId", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "type",
      description: "Type into an input by element id. Optionally submit with Enter.",
      parameters: {
        type: "object",
        properties: {
          elementId: { type: "number" },
          text: { type: "string" },
          submit: { type: "boolean" },
          reason: { type: "string" },
        },
        required: ["elementId", "text", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "scroll",
      description: "Scroll the page to reveal more content before extract.",
      parameters: {
        type: "object",
        properties: {
          direction: { type: "string", enum: ["up", "down"] },
          amount: { type: "number" },
          reason: { type: "string" },
        },
        required: ["direction", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "extract",
      description:
        "Extract main page content (pricing, positioning, features). Call after landing on a useful page.",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string" },
        },
        required: ["reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "done",
      description:
        "Finish the run. Pass a full CompetitiveBrief when ready, or {} to request server synthesis from evidence.",
      parameters: {
        type: "object",
        properties: {
          brief: {
            type: "object",
            description: "CompetitiveBrief object (optional — omit to request synthesis)",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fail",
      description: "Stop with a clear failure after reasonable recovery attempts.",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string" },
          whatWasTried: { type: "string" },
        },
        required: ["message", "whatWasTried"],
      },
    },
  },
];

/** Browse prompt — competitive intel focused. */
export const SYSTEM_PROMPT_BROWSE = `You are Scout, a competitive-intel browser agent that researches products live on the public web.

Hero pattern (two products A vs B):
1) search for each product's official site + pricing page
2) navigate official pricing/product pages (prefer *.com/pricing, official docs)
3) extract after each useful landing
4) if extract is thin (nav-only), scroll or click into Pricing / Product / Docs, then extract again
5) once you have positioning + pricing signals for BOTH subjects, call done

Rules:
- Call exactly ONE tool per turn.
- Prefer official domains over blogs/reviews.
- Prefer extract after navigate; use click/scroll only to reach pricing/content.
- Never invent prices or features — quote what the page shows; unknowns go in limitations.
- When ready, call done({ brief }) with a full CompetitiveBrief, or done({}) to request server synthesis.
- When ≤2 steps remain, call done immediately.
- Public http(s) only. No logins/CAPTCHAs/paywalls.`;

/** Report/wrap-up prompt — includes CompetitiveBrief schema. */
export const SYSTEM_PROMPT_REPORT = `You compile competitive intelligence briefs for Scout.
Return ONLY valid JSON matching this CompetitiveBrief schema (no markdown fences):

{
  "title": string,
  "goal": string,
  "executiveSummary": string,
  "subjects": [{
    "name": string,
    "website"?: string,
    "positioning": string,
    "pricing"?: string,
    "strengths": string[],
    "weaknesses": string[],
    "notableFacts": string[]
  }],
  "comparisonTable": [{ "dimension": string, "values": { [subjectName]: string } }],
  "recommendations": string[],
  "sources": [{ "title": string, "url": string, "usedFor": string }],
  "confidence": "high" | "medium" | "low",
  "limitations": string[]
}

Requirements:
- Cover every subject mentioned in the goal (typically 2+).
- Include a comparisonTable with at least: Positioning, Pricing, Best for.
- Use real URLs from the evidence notes as sources.
- Be decision-useful for a startup/product team. Lower confidence if evidence is thin.
- Do not invent facts not supported by evidence.`;

/** @deprecated use SYSTEM_PROMPT_BROWSE */
export const SYSTEM_PROMPT = SYSTEM_PROMPT_BROWSE;
