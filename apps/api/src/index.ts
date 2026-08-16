import path from "node:path";
import fs from "node:fs";
import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { assertProductionReady, config } from "./config.js";
import { registerRoutes } from "./routes.js";

async function main() {
  assertProductionReady();

  const app = Fastify({
    logger: true,
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: config.isProd,
    requestTimeout: config.isProd ? 120_000 : 0,
  });

  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "SAMEORIGIN");
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    if (config.isProd) {
      reply.header("X-Robots-Tag", "noindex");
    }
    return payload;
  });

  await app.register(cors, {
    origin: config.corsOrigin === "*" ? true : config.corsOrigin,
    methods: ["GET", "POST", "OPTIONS"],
  });

  await registerRoutes(app);

  const candidates = [
    config.webDist,
    path.resolve(process.cwd(), "../web/out"),
    path.resolve(process.cwd(), "../../apps/web/out"),
    path.resolve(process.cwd(), "apps/web/out"),
  ].filter(Boolean) as string[];
  const staticRoot = candidates.find((p) => fs.existsSync(p)) ?? "";

  if (staticRoot) {
    // wildcard:true so rebuilt Next asset hashes are served without an API restart.
    await app.register(fastifyStatic, {
      root: staticRoot,
      wildcard: true,
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/") || req.url.startsWith("/health")) {
        return reply.code(404).send({ error: "Not found" });
      }
      const pathname = req.url.split("?")[0] || "/";
      // Never SPA-fallback asset paths — browsers treat HTML-as-CSS as "no styles".
      if (pathname.startsWith("/_next/") || path.extname(pathname)) {
        return reply.code(404).type("text/plain").send("Not found");
      }
      return reply.type("text/html").sendFile("index.html");
    });
    app.log.info(`Serving web UI from ${staticRoot}`);
  } else if (config.isProd) {
    app.log.warn("WEB_DIST not found — API-only mode (UI will 404)");
  }

  const address = await app.listen({ port: config.port, host: config.host });
  app.log.info(
    `Scout API listening on ${address} (provider=${config.llmProvider}, model=${config.model}, browser=${config.useBrowserbase ? "browserbase" : "local"})`
  );

  const shutdown = async (signal: string) => {
    app.log.info(`Shutting down (${signal})…`);
    try {
      await app.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
