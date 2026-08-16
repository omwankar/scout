import path from "node:path";
import { config as loadEnv } from "dotenv";

loadEnv();
loadEnv({ path: path.resolve(process.cwd(), "../../.env") });
loadEnv({ path: path.resolve(process.cwd(), "../../../.env") });

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

const isProd = process.env.NODE_ENV === "production";
const nvidiaApiKey = process.env.NVIDIA_API_KEY ?? "";
const anthropicApiKey = process.env.ANTHROPIC_API_KEY ?? "";

const llmProvider = (process.env.LLM_PROVIDER ??
  (anthropicApiKey ? "anthropic" : nvidiaApiKey ? "nvidia" : "none")) as
  | "nvidia"
  | "anthropic"
  | "none";

export const config = {
  port: num("PORT", 3001),
  host: process.env.HOST ?? "0.0.0.0",
  // Production serves UI + API same-origin; allow * so demos/previews still work.
  corsOrigin: process.env.CORS_ORIGIN ?? (isProd ? "*" : "http://localhost:3000"),
  anthropicApiKey,
  nvidiaApiKey,
  nvidiaBaseUrl: process.env.NVIDIA_BASE_URL ?? "https://integrate.api.nvidia.com/v1",
  llmProvider,
  model:
    llmProvider === "nvidia"
      ? process.env.NVIDIA_MODEL ||
        process.env.LLM_MODEL ||
        "meta/llama-3.3-70b-instruct"
      : process.env.LLM_MODEL ||
        process.env.ANTHROPIC_MODEL ||
        "claude-sonnet-4-6",
  browserbaseApiKey: process.env.BROWSERBASE_API_KEY ?? "",
  browserbaseProjectId: process.env.BROWSERBASE_PROJECT_ID ?? "",
  tavilyApiKey: process.env.TAVILY_API_KEY ?? "",
  maxSteps: num("MAX_STEPS", 20),
  maxRuntimeMs: num("MAX_RUNTIME_MS", 10 * 60 * 1000),
  maxToolRetries: num("MAX_TOOL_RETRIES", 2),
  maxLlmErrors: num("MAX_LLM_ERRORS", 3),
  requireApprovalDefault: process.env.REQUIRE_APPROVAL_DEFAULT === "true",
  isProd,
  webDist: process.env.WEB_DIST ?? "",
  get useBrowserbase() {
    return Boolean(this.browserbaseApiKey && this.browserbaseProjectId);
  },
  get ready() {
    const hasLlm =
      (this.llmProvider === "anthropic" && Boolean(this.anthropicApiKey)) ||
      (this.llmProvider === "nvidia" && Boolean(this.nvidiaApiKey));
    return hasLlm && Boolean(this.tavilyApiKey);
  },
};

/** Fail fast in production if critical secrets are missing. */
export function assertProductionReady(): void {
  if (!config.isProd) return;
  const missing: string[] = [];
  if (config.llmProvider === "anthropic" && !config.anthropicApiKey) {
    missing.push("ANTHROPIC_API_KEY");
  }
  if (config.llmProvider === "nvidia" && !config.nvidiaApiKey) {
    missing.push("NVIDIA_API_KEY");
  }
  if (config.llmProvider === "none") {
    missing.push("LLM_PROVIDER + ANTHROPIC_API_KEY (or NVIDIA_API_KEY)");
  }
  if (!config.tavilyApiKey) missing.push("TAVILY_API_KEY");
  if (missing.length) {
    throw new Error(`Production missing required env: ${missing.join(", ")}`);
  }
}
