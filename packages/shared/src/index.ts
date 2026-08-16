export type RunStatus =
  | "queued"
  | "running"
  | "paused"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "stopped";

export type Confidence = "high" | "medium" | "low";

export type CompetitiveBrief = {
  title: string;
  goal: string;
  executiveSummary: string;
  subjects: Array<{
    name: string;
    website?: string;
    positioning: string;
    pricing?: string;
    strengths: string[];
    weaknesses: string[];
    notableFacts: string[];
  }>;
  comparisonTable: Array<{
    dimension: string;
    values: Record<string, string>;
  }>;
  recommendations: string[];
  sources: Array<{
    title: string;
    url: string;
    usedFor: string;
  }>;
  confidence: Confidence;
  limitations: string[];
};

export type AgentActionName =
  | "search"
  | "navigate"
  | "click"
  | "type"
  | "scroll"
  | "extract"
  | "done"
  | "fail";

export type AgentAction = {
  name: AgentActionName;
  args: Record<string, unknown>;
  requiresApproval?: boolean;
};

export type TimelineEvent =
  | {
      id: string;
      type: "status";
      ts: number;
      status: RunStatus;
      message?: string;
    }
  | {
      id: string;
      type: "thought";
      ts: number;
      text: string;
      streaming?: boolean;
    }
  | {
      id: string;
      type: "action";
      ts: number;
      action: AgentAction;
      result?: string;
      retry?: number;
      error?: string;
    }
  | {
      id: string;
      type: "screenshot";
      ts: number;
      url: string;
      imageBase64: string;
      mimeType: "image/jpeg" | "image/png";
    }
  | {
      id: string;
      type: "error";
      ts: number;
      message: string;
      recoverable: boolean;
    }
  | {
      id: string;
      type: "approval_required";
      ts: number;
      action: AgentAction;
      reason: string;
    }
  | {
      id: string;
      type: "steer";
      ts: number;
      message: string;
    }
  | {
      id: string;
      type: "result";
      ts: number;
      brief: CompetitiveBrief;
    };

export type CreateRunRequest = {
  goal: string;
  requireApproval?: boolean;
};

export type CreateRunResponse = {
  runId: string;
};

export type RunSnapshot = {
  id: string;
  goal: string;
  status: RunStatus;
  requireApproval: boolean;
  createdAt: number;
  updatedAt: number;
  currentUrl?: string;
  events: TimelineEvent[];
  brief?: CompetitiveBrief;
  error?: string;
};

export type ApproveRequest = {
  decision: "approve" | "skip";
  note?: string;
};

export type SteerRequest = {
  message: string;
};

export const PRESET_GOALS = [
  {
    id: "linear-asana",
    label: "Linear vs Asana",
    goal: "Compare Linear (linear.app) vs Asana (asana.com) for a 15-person startup product team. Visit each official site and pricing page. Capture positioning, public pricing tiers, core workflows (issues/projects), and who each is best for. Prefer /pricing pages. Do not wrap up until both products have pricing + positioning evidence.",
  },
  {
    id: "notion-ai",
    label: "Notion AI landscape",
    goal: "Research Notion AI vs 2–3 alternatives (e.g. Coda AI, Mem, or similar). Use official product and pricing pages. Summarize positioning, pricing signals, and when to pick Notion AI vs an alternative.",
  },
  {
    id: "browser-hosts",
    label: "Browserbase vs Steel",
    goal: "Brief me on Browserbase vs Steel for hosted browser infrastructure for AI agents. Cover product positioning, key features, and any public pricing or docs signals from official sites. End with a recommendation for a small team building a browser agent.",
  },
] as const;

export function briefToMarkdown(brief: CompetitiveBrief): string {
  const lines: string[] = [];
  lines.push(`# ${brief.title}`);
  lines.push("");
  lines.push(`**Goal:** ${brief.goal}`);
  lines.push("");
  lines.push(`**Confidence:** ${brief.confidence}`);
  lines.push("");
  lines.push("## Executive summary");
  lines.push(brief.executiveSummary);
  lines.push("");

  for (const subject of brief.subjects) {
    lines.push(`## ${subject.name}`);
    if (subject.website) lines.push(`Website: ${subject.website}`);
    lines.push("");
    lines.push(subject.positioning);
    if (subject.pricing) {
      lines.push("");
      lines.push(`**Pricing:** ${subject.pricing}`);
    }
    if (subject.strengths.length) {
      lines.push("");
      lines.push("**Strengths**");
      for (const s of subject.strengths) lines.push(`- ${s}`);
    }
    if (subject.weaknesses.length) {
      lines.push("");
      lines.push("**Weaknesses**");
      for (const w of subject.weaknesses) lines.push(`- ${w}`);
    }
    if (subject.notableFacts.length) {
      lines.push("");
      lines.push("**Notable facts**");
      for (const f of subject.notableFacts) lines.push(`- ${f}`);
    }
    lines.push("");
  }

  if (brief.comparisonTable.length) {
    lines.push("## Comparison");
    const names = Array.from(
      new Set(brief.comparisonTable.flatMap((row) => Object.keys(row.values)))
    );
    lines.push(`| Dimension | ${names.join(" | ")} |`);
    lines.push(`| --- | ${names.map(() => "---").join(" | ")} |`);
    for (const row of brief.comparisonTable) {
      lines.push(
        `| ${row.dimension} | ${names.map((n) => row.values[n] ?? "—").join(" | ")} |`
      );
    }
    lines.push("");
  }

  if (brief.recommendations.length) {
    lines.push("## Recommendations");
    for (const r of brief.recommendations) lines.push(`- ${r}`);
    lines.push("");
  }

  if (brief.sources.length) {
    lines.push("## Sources");
    for (const s of brief.sources) {
      lines.push(`- [${s.title}](${s.url}) — ${s.usedFor}`);
    }
    lines.push("");
  }

  if (brief.limitations.length) {
    lines.push("## Limitations");
    for (const l of brief.limitations) lines.push(`- ${l}`);
  }

  return lines.join("\n");
}
