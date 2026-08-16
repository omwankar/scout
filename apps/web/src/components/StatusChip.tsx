"use client";

import type { RunStatus } from "@scout/shared";

const LABELS: Record<RunStatus | "idle", string> = {
  idle: "Idle",
  queued: "Queued",
  running: "Running",
  paused: "Paused",
  awaiting_approval: "Awaiting approval",
  completed: "Done",
  failed: "Error",
  stopped: "Stopped",
};

export function StatusChip({
  status,
  message,
}: {
  status: RunStatus | "idle";
  message?: string | null;
}) {
  const active =
    status === "running" ||
    status === "queued" ||
    status === "awaiting_approval" ||
    status === "paused";
  const done = status === "completed";
  const err = status === "failed" || status === "stopped";
  const waiting = status === "awaiting_approval" || status === "paused";

  const tone = active
    ? waiting
      ? "tone-warn"
      : "tone-live"
    : done
      ? "tone-ok"
      : err
        ? "tone-danger"
        : "tone-idle";

  return (
    <div className={`status-chip ${tone}`} title={message ?? undefined}>
      <StatusGlyph status={status} />
      <span>{LABELS[status]}</span>
      {message ? <span className="status-chip-msg">· {message}</span> : null}
    </div>
  );
}

function StatusGlyph({ status }: { status: RunStatus | "idle" }) {
  if (status === "running" || status === "queued") {
    return (
      <span className="status-glyph live">
        <span className="status-glyph-ring" />
        <span className="status-glyph-core" />
      </span>
    );
  }
  if (status === "completed") return <span className="status-glyph-text ok">✓</span>;
  if (status === "failed") return <span className="status-glyph-text danger">×</span>;
  if (status === "stopped" || status === "paused" || status === "awaiting_approval") {
    return <span className="status-glyph-text warn">‖</span>;
  }
  return <span className="status-glyph idle" />;
}
