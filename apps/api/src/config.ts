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
const openrouterApiKey = process.env.OPENROUTER_API_KEY ?? "";

export const config = {
  port: num("PORT", 3001),
  host: process.env.HOST ?? "0.0.0.0",
  corsOrigin: process.env.CORS_ORIGIN ?? (isProd ? "*" : "http://localhost:3000"),
  openrouterApiKey,
  openrouterBaseUrl: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
  openrouterReferer:
    process.env.OPENROUTER_HTTP_REFERER ??
    (isProd ? "https://omwankar-scout.onrender.com" : "http://localhost:3000"),
  openrouterTitle: process.env.OPENROUTER_APP_TITLE ?? "Scout",
  llmProvider: "openrouter" as const,
  // Free Models Router picks a $0 model that supports the features we send (tools).
  model: process.env.LLM_MODEL || process.env.OPENROUTER_MODEL || "openrouter/free",
  browserbaseApiKey: process.env.BROWSERBASE_API_KEY ?? "",
  browserbaseProjectId: process.env.BROWSERBASE_PROJECT_ID ?? "",
  tavilyApiKey: process.env.TAVILY_API_KEY ?? "",
  maxSteps: num("MAX_STEPS", 16),
  maxRuntimeMs: num("MAX_RUNTIME_MS", 10 * 60 * 1000),
  maxToolRetries: num("MAX_TOOL_RETRIES", 2),
  maxLlmErrors: num("MAX_LLM_ERRORS", 4),
  requireApprovalDefault: process.env.REQUIRE_APPROVAL_DEFAULT === "true",
  isProd,
  webDist: process.env.WEB_DIST ?? "",
  get useBrowserbase() {
    return Boolean(this.browserbaseApiKey && this.browserbaseProjectId);
  },
  get ready() {
    return Boolean(this.openrouterApiKey);
  },
};

export function assertProductionReady(): void {
  if (!config.isProd) return;
  if (!config.openrouterApiKey) {
    console.warn("Production missing OPENROUTER_API_KEY — UI will boot, research runs will fail.");
  }
}
