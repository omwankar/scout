"use client";

import { useEffect, useRef, useState } from "react";
import type { TimelineEvent } from "@scout/shared";

const BODY_PREVIEW = 1200;

function isTelemetryNoise(event: TimelineEvent): boolean {
  if (event.type === "screenshot") return true;
  if (event.type !== "thought") return false;
  const t = event.text.trim();
  return (
    /^Tokens\b/i.test(t) ||
    /^Step\s+\d+\s*\/\s*\d+/i.test(t) ||
    /protecting step budget/i.test(t) ||
    /Redirecting from .* → done/i.test(t) ||
    /Steps left:/i.test(t)
  );
}

const KIND_META: Record<
  string,
  { label: string; color: string; icon: string }
> = {
  status: { label: "Status", color: "var(--trace-status)", icon: "·" },
  thought: { label: "Reasoning", color: "var(--trace-reasoning)", icon: "◇" },
  action: { label: "Action", color: "var(--trace-action)", icon: "▸" },
  error: { label: "Error", color: "var(--trace-error)", icon: "×" },
  approval_required: { label: "Approval", color: "var(--trace-human)", icon: "‖" },
  steer: { label: "Steer", color: "var(--trace-human)", icon: "↳" },
  result: { label: "Result", color: "var(--trace-action)", icon: "✓" },
};

function shortenUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, "") + (u.pathname === "/" ? "" : u.pathname);
  } catch {
    return url.slice(0, 64);
  }
}

function truncate(text: string, max = BODY_PREVIEW): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

function body(event: TimelineEvent): string {
  switch (event.type) {
    case "status":
      return event.message || event.status;
    case "thought":
      return event.text;
    case "action": {
      const name = event.action.name;
      const args = event.action.args;
      if (event.error) return `Failed — ${event.error}`;
      if (name === "search") {
        const q = String(args.query ?? "");
        return truncate(`search “${q}” · ${event.result ?? ""}`, 320);
      }
      if (name === "navigate") {
        return `navigate → ${shortenUrl(String(args.url ?? ""))}`;
      }
      if (name === "extract") {
        return truncate(event.result ?? "extract page text", 320);
      }
      if (name === "done") return "Brief compiled";
      if (name === "fail") return String(args.message ?? event.result ?? "Failed");
      return truncate(event.result ?? name, 320);
    }
    case "error":
      return event.message;
    case "approval_required":
      return event.reason;
    case "steer":
      return event.message;
    case "result":
      return event.brief.title;
    default:
      return "";
  }
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function Timeline({ events }: { events: TimelineEvent[] }) {
  const visible = events.filter((e) => !isTelemetryNoise(e));
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const [pinned, setPinned] = useState(true);
  const [showJump, setShowJump] = useState(false);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onScroll = () => {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      setPinned(nearBottom);
      setShowJump(!nearBottom);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  const lastVisible = visible[visible.length - 1];
  const streamTick =
    lastVisible?.type === "thought" ? lastVisible.text.length : 0;
  const isStreaming =
    lastVisible?.type === "thought" && Boolean(lastVisible.streaming);

  useEffect(() => {
    if (!pinned) {
      setShowJump(true);
      return;
    }
    // Instant scroll while tokens stream — smooth scrolling on every delta janks.
    endRef.current?.scrollIntoView({ behavior: isStreaming ? "auto" : "smooth" });
    setShowJump(false);
  }, [visible.length, pinned, lastVisible?.id, streamTick, isStreaming]);

  if (!visible.length) {
    return (
      <div className="trace-empty">
        <p className="trace-empty-title">Agent trace</p>
        <p>
          Start a run to watch reasoning, actions, and observations stream live.
        </p>
      </div>
    );
  }

  return (
    <div className="trace-shell">
      <div className="trace-scroll" ref={scrollerRef}>
        <div className="trace-list">
          {visible.map((event) => {
            const meta = KIND_META[event.type] ?? KIND_META.status;
            const tool = event.type === "action" ? event.action.name : null;
            const color =
              event.type === "error" ? "var(--trace-error)" : meta.color;
            return (
              <article
                key={event.id}
                className="trace-row"
                style={{ borderLeftColor: color }}
              >
                <div className="trace-time">{formatTime(event.ts)}</div>
                <div className="trace-main">
                  <div className="trace-meta">
                    <span style={{ color }} aria-hidden>
                      {meta.icon}
                    </span>
                    <span style={{ color }}>{meta.label}</span>
                    {tool ? <span className="trace-tool">{tool}</span> : null}
                  </div>
                  <p
                    className={`trace-text${
                      event.type === "thought"
                        ? " is-reasoning"
                        : event.type === "error"
                          ? " is-error"
                          : ""
                    }${
                      event.type === "thought" && event.streaming ? " is-streaming" : ""
                    }`}
                  >
                    {event.type === "thought"
                      ? event.text
                      : truncate(body(event))}
                    {event.type === "thought" && event.streaming ? (
                      <span className="stream-cursor" aria-hidden>
                        ▍
                      </span>
                    ) : null}
                  </p>
                </div>
              </article>
            );
          })}
        </div>
        <div ref={endRef} />
      </div>
      {showJump && (
        <button
          type="button"
          className="jump-latest"
          onClick={() => {
            setPinned(true);
            endRef.current?.scrollIntoView({ behavior: "smooth" });
            setShowJump(false);
          }}
        >
          ↓ Jump to latest
        </button>
      )}
    </div>
  );
}
