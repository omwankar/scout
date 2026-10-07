import type { FastifyInstance } from "fastify";
import type { ApproveRequest, CreateRunRequest, SteerRequest } from "@scout/shared";
import { config } from "./config.js";
import { runAgent } from "./agent.js";
import { runStore } from "./run-store.js";

export async function registerRoutes(app: FastifyInstance) {
  app.get("/health", async () => ({
    ok: true,
    ready: config.ready,
    llmProvider: config.llmProvider,
    model: config.model,
    maxSteps: config.maxSteps,
    browser: config.useBrowserbase ? "browserbase" : "local",
    hasTavily: Boolean(config.tavilyApiKey),
    hasLlmKey: Boolean(config.openrouterApiKey),
  }));

  app.post<{ Body: CreateRunRequest }>("/api/runs", async (req, reply) => {
    const goal = (req.body?.goal ?? "").trim();
    if (goal.length < 8) {
      return reply.code(400).send({ error: "Goal must be at least 8 characters" });
    }
    if (goal.length > 2000) {
      return reply.code(400).send({ error: "Goal is too long" });
    }

    const requireApproval =
      typeof req.body?.requireApproval === "boolean"
        ? req.body.requireApproval
        : config.requireApprovalDefault;

    const run = runStore.create(goal, requireApproval);
    setImmediate(() => {
      void runAgent(run);
    });

    return { runId: run.id };
  });

  app.get<{ Params: { id: string } }>("/api/runs/:id", async (req, reply) => {
    const run = runStore.get(req.params.id);
    if (!run) return reply.code(404).send({ error: "Run not found" });
    return runStore.snapshot(run);
  });

  app.get<{ Params: { id: string } }>("/api/runs/:id/events", async (req, reply) => {
    const run = runStore.get(req.params.id);
    if (!run) return reply.code(404).send({ error: "Run not found" });

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": config.corsOrigin,
    });

    let open = true;
    const write = (event: unknown, eventName = "message") => {
      if (!open) return;
      try {
        reply.raw.write(`event: ${eventName}\n`);
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        open = false;
      }
    };

    write({ type: "snapshot", run: runStore.snapshot(run) }, "snapshot");

    for (const event of run.events) {
      // Skip screenshot events whose payload was pruned — nothing to render.
      if (event.type === "screenshot" && !event.imageBase64) continue;
      write(event, event.type);
    }

    const unsubscribe = runStore.subscribe(run, (event) => {
      write(event, event.type);
      if (
        event.type === "status" &&
        (event.status === "completed" ||
          event.status === "failed" ||
          event.status === "stopped")
      ) {
        write({}, "close");
      }
    });

    const heartbeat = setInterval(() => {
      if (!open) return;
      try {
        reply.raw.write(": heartbeat\n\n");
      } catch {
        open = false;
      }
    }, 15000);

    const cleanup = () => {
      open = false;
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.raw.on("close", cleanup);
    reply.raw.on("error", cleanup);
  });

  app.post<{ Params: { id: string } }>("/api/runs/:id/stop", async (req, reply) => {
    const run = runStore.get(req.params.id);
    if (!run) return reply.code(404).send({ error: "Run not found" });
    run.stopRequested = true;
    run.pauseRequested = false;
    if (run.pendingApproval) {
      run.pendingApproval.resolve({ decision: "skip", note: "Stopped by user" });
    }
    runStore.setStatus(run, "stopped", "Stop requested");
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/runs/:id/pause", async (req, reply) => {
    const run = runStore.get(req.params.id);
    if (!run) return reply.code(404).send({ error: "Run not found" });
    if (
      run.status !== "running" &&
      run.status !== "queued" &&
      run.status !== "awaiting_approval"
    ) {
      return reply.code(409).send({ error: "Run is not active" });
    }
    run.pauseRequested = true;
    runStore.setStatus(run, "paused", "Pausing — will stop before the next action");
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/runs/:id/resume", async (req, reply) => {
    const run = runStore.get(req.params.id);
    if (!run) return reply.code(404).send({ error: "Run not found" });
    if (!run.pauseRequested && run.status !== "paused") {
      return reply.code(409).send({ error: "Run is not paused" });
    }
    run.pauseRequested = false;
    if (run.status === "paused") {
      runStore.setStatus(run, "running", "Resumed");
    }
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: ApproveRequest }>(
    "/api/runs/:id/approve",
    async (req, reply) => {
      const run = runStore.get(req.params.id);
      if (!run) return reply.code(404).send({ error: "Run not found" });
      if (!run.pendingApproval) {
        return reply.code(409).send({ error: "No pending approval" });
      }
      const decision = req.body?.decision;
      if (decision !== "approve" && decision !== "skip") {
        return reply.code(400).send({ error: "decision must be approve or skip" });
      }
      run.pendingApproval.resolve({ decision, note: req.body?.note });
      return { ok: true };
    }
  );

  app.post<{ Params: { id: string }; Body: SteerRequest }>(
    "/api/runs/:id/steer",
    async (req, reply) => {
      const run = runStore.get(req.params.id);
      if (!run) return reply.code(404).send({ error: "Run not found" });
      const message = (req.body?.message ?? "").trim();
      if (!message) return reply.code(400).send({ error: "message required" });
      run.steerQueue.push(message);
      runStore.emit(run, { type: "steer", message });
      return { ok: true };
    }
  );
}
