"use client";

import { useEffect, useMemo, useState } from "react";
import {
  PRESET_GOALS,
  type AgentAction,
  type CompetitiveBrief,
  type RunStatus,
  type TimelineEvent,
} from "@scout/shared";
import { BriefPanel } from "@/components/BriefPanel";
import { StatusChip } from "@/components/StatusChip";
import { Timeline } from "@/components/Timeline";
import {
  approveRun,
  createRun,
  pauseRun,
  resumeRun,
  steerRun,
  stopRun,
  subscribeRunEvents,
} from "@/lib/api";

const IDLE: RunStatus = "queued";

function hostFromUrl(url: string): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export default function HomePage() {
  const [goal, setGoal] = useState<string>(PRESET_GOALS[0].goal);
  const [requireApproval, setRequireApproval] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [status, setStatus] = useState<RunStatus | "idle">("idle");
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [currentUrl, setCurrentUrl] = useState<string>("");
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [brief, setBrief] = useState<CompetitiveBrief | null>(null);
  const [pendingAction, setPendingAction] = useState<{
    action: AgentAction;
    reason: string;
  } | null>(null);
  const [steerText, setSteerText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [browserOverride, setBrowserOverride] = useState<"expanded" | "collapsed" | null>(
    null
  );
  const [mobilePane, setMobilePane] = useState<"trace" | "live" | "brief">("trace");

  const active =
    status === "running" ||
    status === "awaiting_approval" ||
    status === "queued" ||
    status === "paused";
  const live =
    status === "running" || status === "awaiting_approval" || status === "paused";
  const paused = status === "paused";
  const runComplete =
    status === "completed" || status === "failed" || status === "stopped";
  const writing =
    active &&
    !paused &&
    events.some((e) => e.type === "thought" && /wrapping up|synthesiz/i.test(e.text));
  const host = hostFromUrl(currentUrl);

  // Expand browser while the agent is working; collapse when the run finishes.
  const browserExpanded =
    browserOverride === "expanded"
      ? true
      : browserOverride === "collapsed"
        ? false
        : live || busy || status === "queued";

  useEffect(() => {
    if (live || status === "queued") setBrowserOverride(null);
    if (runComplete) setBrowserOverride(null);
  }, [live, status, runComplete, runId]);

  // Mobile: follow the action — browser while running, brief when it lands.
  useEffect(() => {
    if (runId) setMobilePane("live");
  }, [runId]);
  useEffect(() => {
    if (brief) setMobilePane("brief");
  }, [brief]);

  useEffect(() => {
    if (!runId) return;
    const unsub = subscribeRunEvents(runId, {
      onSnapshot: (run) => {
        setStatus(run.status);
        setEvents(run.events);
        setBrief(run.brief ?? null);
        setCurrentUrl(run.currentUrl ?? "");
        setError(run.error ?? null);
        const lastStatus = [...run.events].reverse().find((e) => e.type === "status");
        if (lastStatus && lastStatus.type === "status") {
          setStatusMessage(lastStatus.message ?? lastStatus.status);
        }
        const lastShot = [...run.events]
          .reverse()
          .find((e) => e.type === "screenshot" && e.imageBase64);
        if (lastShot && lastShot.type === "screenshot") {
          setScreenshot(`data:${lastShot.mimeType};base64,${lastShot.imageBase64}`);
          setCurrentUrl(lastShot.url);
        }
        const pending = [...run.events]
          .reverse()
          .find((e) => e.type === "approval_required");
        if (run.status === "awaiting_approval" && pending && pending.type === "approval_required") {
          setPendingAction({ action: pending.action, reason: pending.reason });
        } else {
          setPendingAction(null);
        }
      },
      onEvent: (event) => {
        setEvents((prev) => {
          const idx = prev.findIndex((e) => e.id === event.id);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = event;
            return next;
          }
          return [...prev, event];
        });
        if (event.type === "status") {
          setStatus(event.status);
          setStatusMessage(event.message ?? event.status);
          if (
            event.status === "completed" ||
            event.status === "failed" ||
            event.status === "stopped"
          ) {
            setPendingAction(null);
            setBusy(false);
          }
        }
        if (event.type === "screenshot" && event.imageBase64) {
          setScreenshot(`data:${event.mimeType};base64,${event.imageBase64}`);
          setCurrentUrl(event.url);
        }
        if (event.type === "result") setBrief(event.brief);
        if (event.type === "error" && !event.recoverable) setError(event.message);
        if (event.type === "approval_required") {
          setPendingAction({ action: event.action, reason: event.reason });
        }
        if (event.type === "status" && event.status === "running") {
          setPendingAction(null);
        }
      },
      onError: (err) => setError(err.message),
    });
    return unsub;
  }, [runId]);

  const selectedPresetId = useMemo(
    () => PRESET_GOALS.find((p) => p.goal === goal)?.id ?? null,
    [goal]
  );

  const onStart = async () => {
    setBusy(true);
    setError(null);
    setEvents([]);
    setBrief(null);
    setScreenshot(null);
    setPendingAction(null);
    setCurrentUrl("");
    setStatusMessage("Starting browser session…");
    try {
      const { runId: id } = await createRun(goal.trim(), requireApproval);
      setRunId(id);
      setStatus(IDLE);
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onStop = async () => {
    if (!runId) return;
    try {
      await stopRun(runId);
      setBusy(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onPause = async () => {
    if (!runId) return;
    try {
      await pauseRun(runId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onResume = async () => {
    if (!runId) return;
    try {
      await resumeRun(runId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onApprove = async (decision: "approve" | "skip") => {
    if (!runId) return;
    try {
      await approveRun(runId, { decision });
      setPendingAction(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onSteer = async () => {
    if (!runId || !steerText.trim()) return;
    try {
      await steerRun(runId, { message: steerText.trim() });
      setSteerText("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="ops-shell">
      <header className="ops-header">
        <div className="ops-header-top">
          <div className="brand-block">
            <div className="brand-eyebrow mono">Scout</div>
            <h1>Competitive Intel Agent</h1>
          </div>

          <StatusChip status={status} message={statusMessage} />

          <div className="header-controls">
            {paused ? (
              <button
                type="button"
                className="btn-resume"
                onClick={onResume}
                disabled={!runId}
                title="Resume the run"
              >
                ▶ Resume
              </button>
            ) : (
              <button
                type="button"
                className="btn-pause"
                onClick={onPause}
                disabled={!runId || !active}
                title="Pause before the next action"
              >
                ⏸ Pause
              </button>
            )}
            <button
              type="button"
              className="btn-abort"
              onClick={onStop}
              disabled={!runId || !active}
              title="Stop the current run"
            >
              Abort
            </button>
          </div>
        </div>

        <div className="ops-goal-row">
          <div className="goal-field">
            <label className="mono" htmlFor="goal">
              Goal
            </label>
            <textarea
              id="goal"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              rows={2}
              disabled={active}
              placeholder="Describe what Scout should research in the browser…"
            />
          </div>
          <button
            type="button"
            className="btn-start"
            onClick={onStart}
            disabled={busy || active || goal.trim().length < 8}
          >
            {active ? "Running…" : "Start run"}
          </button>
        </div>

        <div className="preset-row">
          {PRESET_GOALS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`preset${selectedPresetId === p.id ? " is-selected" : ""}`}
              disabled={active}
              onClick={() => setGoal(p.goal)}
              title={p.goal}
            >
              {p.label}
            </button>
          ))}
          <label className="approve-toggle">
            <input
              type="checkbox"
              checked={requireApproval}
              disabled={active}
              onChange={(e) => setRequireApproval(e.target.checked)}
            />
            Approve navigations
          </label>
        </div>

        {active && (
          <div className="steer-bar">
            <input
              value={steerText}
              onChange={(e) => setSteerText(e.target.value)}
              placeholder="Steer mid-run… e.g. focus on pricing pages"
              onKeyDown={(e) => {
                if (e.key === "Enter") void onSteer();
              }}
            />
            <button
              type="button"
              className="btn-ghost"
              onClick={onSteer}
              disabled={!steerText.trim()}
            >
              Steer
            </button>
          </div>
        )}

        {pendingAction && (
          <div className="interrupt-banner">
            <div>
              <strong>Approval needed</strong>
              <span>{pendingAction.reason}</span>
              <code>
                {pendingAction.action.name}{" "}
                {JSON.stringify(pendingAction.action.args)}
              </code>
            </div>
            <div className="interrupt-actions">
              <button type="button" className="btn-start" onClick={() => onApprove("approve")}>
                Approve
              </button>
              <button type="button" className="btn-ghost" onClick={() => onApprove("skip")}>
                Skip
              </button>
            </div>
          </div>
        )}

        {error && <div className="error-bar mono">{error}</div>}
      </header>

      <main
        className={`ops-main${browserExpanded ? " live-expanded" : " live-collapsed"} mobile-show-${mobilePane}`}
      >
        <nav className="mobile-tabs" aria-label="Panels">
          <button
            type="button"
            className={`mobile-tab${mobilePane === "trace" ? " is-active" : ""}`}
            onClick={() => setMobilePane("trace")}
          >
            Trace
            {live && mobilePane !== "trace" ? <span className="tab-dot" /> : null}
          </button>
          <button
            type="button"
            className={`mobile-tab${mobilePane === "live" ? " is-active" : ""}`}
            onClick={() => {
              setMobilePane("live");
              setBrowserOverride("expanded");
            }}
          >
            Browser
          </button>
          <button
            type="button"
            className={`mobile-tab${mobilePane === "brief" ? " is-active" : ""}`}
            onClick={() => setMobilePane("brief")}
          >
            Brief
            {brief && mobilePane !== "brief" ? <span className="tab-dot" /> : null}
          </button>
        </nav>

        <section className="ops-pane ops-pane-trace">
          <div className="pane-head">
            <h2>Agent trace</h2>
            <p className="mono">
              ops log
              {live ? <span className="accent"> · live</span> : null}
            </p>
          </div>
          <div className="pane-body">
            <Timeline events={events} />
          </div>
        </section>

        <section className="ops-pane ops-pane-live">
          {!browserExpanded ? (
            <button
              type="button"
              className="browser-collapsed"
              onClick={() => setBrowserOverride("expanded")}
              title="Expand live browser"
            >
              <span className={`live-dot${live ? " is-live" : ""}`} />
              <span className="browser-collapsed-label mono">Browser</span>
              {screenshot ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img className="browser-collapsed-thumb" src={screenshot} alt="" />
              ) : null}
              <span className="browser-collapsed-hint mono">Expand</span>
            </button>
          ) : (
            <div className="browser-card">
              <div className="browser-head">
                <div className="browser-head-left">
                  <span className={`live-dot${live ? " is-live" : ""}`} />
                  <span>Browser</span>
                  {live ? <span className="mono browser-live-tag">live</span> : null}
                </div>
                <div className="browser-head-right">
                  <span className="mono browser-host">
                    {host || (live ? "connecting…" : "idle")}
                  </span>
                  {!live && (
                    <button
                      type="button"
                      className="browser-collapse-btn mono"
                      onClick={() => setBrowserOverride("collapsed")}
                      title="Collapse browser"
                    >
                      «
                    </button>
                  )}
                </div>
              </div>
              <div className="browser-url mono">
                {currentUrl || "Waiting to navigate…"}
              </div>
              <div className={`browser-viewport${screenshot ? " has-shot" : ""}`}>
                {screenshot ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={screenshot} alt="Current browser view" />
                ) : (
                  <div className="browser-empty">
                    {live ? (
                      <>
                        <p className="accent mono">Agent browsing live</p>
                        <p>
                          Screenshots appear after each action. Watch the trace
                          for reasoning.
                        </p>
                      </>
                    ) : (
                      <p>Start a run to watch Scout browse the web.</p>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </section>

        <section className="ops-pane ops-pane-results">
          <BriefPanel brief={brief} runComplete={runComplete} writing={writing} />
        </section>
      </main>
    </div>
  );
}
