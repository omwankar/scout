import { nanoid } from "nanoid";
import type {
  CompetitiveBrief,
  RunSnapshot,
  RunStatus,
  TimelineEvent,
} from "@scout/shared";

type Listener = (event: TimelineEvent) => void;

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
type EmitInput = DistributiveOmit<TimelineEvent, "id" | "ts"> & {
  id?: string;
  ts?: number;
};

export type RunRecord = {
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
  stopRequested: boolean;
  pauseRequested: boolean;
  pendingApproval?: {
    resolve: (decision: { decision: "approve" | "skip"; note?: string }) => void;
  };
  steerQueue: string[];
  listeners: Set<Listener>;
};

class RunStore {
  private runs = new Map<string, RunRecord>();

  create(goal: string, requireApproval: boolean): RunRecord {
    const now = Date.now();
    const run: RunRecord = {
      id: nanoid(12),
      goal,
      status: "queued",
      requireApproval,
      createdAt: now,
      updatedAt: now,
      events: [],
      stopRequested: false,
      pauseRequested: false,
      steerQueue: [],
      listeners: new Set(),
    };
    this.runs.set(run.id, run);
    return run;
  }

  get(id: string): RunRecord | undefined {
    return this.runs.get(id);
  }

  snapshot(run: RunRecord): RunSnapshot {
    return {
      id: run.id,
      goal: run.goal,
      status: run.status,
      requireApproval: run.requireApproval,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      currentUrl: run.currentUrl,
      events: run.events,
      brief: run.brief,
      error: run.error,
    };
  }

  emit(run: RunRecord, event: EmitInput) {
    const full = {
      ...event,
      id: event.id ?? nanoid(8),
      ts: event.ts ?? Date.now(),
    } as TimelineEvent;
    run.events.push(full);
    run.updatedAt = full.ts;

    // Keep only the last 3 screenshot payloads — older base64 blobs bloat
    // memory and make SSE replays on reconnect painfully slow.
    if (full.type === "screenshot") {
      const shots = run.events.filter(
        (e) => e.type === "screenshot" && e.imageBase64
      );
      for (let i = 0; i < shots.length - 3; i++) {
        (shots[i] as { imageBase64: string }).imageBase64 = "";
      }
    }
    for (const listener of run.listeners) {
      try {
        listener(full);
      } catch {
        // ignore broken listeners
      }
    }
    return full;
  }

  /** Upsert a streaming thought by id so the timeline grows text in place. */
  emitThoughtStream(run: RunRecord, id: string, text: string, streaming: boolean) {
    const existing = run.events.find((e) => e.id === id);
    if (existing && existing.type === "thought") {
      existing.text = text;
      existing.streaming = streaming;
      existing.ts = Date.now();
      run.updatedAt = existing.ts;
      for (const listener of run.listeners) {
        try {
          listener(existing);
        } catch {
          // ignore
        }
      }
      return existing;
    }
    return this.emit(run, {
      id,
      type: "thought",
      text,
      streaming,
    });
  }

  setStatus(run: RunRecord, status: RunStatus, message?: string) {
    run.status = status;
    run.updatedAt = Date.now();
    this.emit(run, { type: "status", status, message });
  }

  subscribe(run: RunRecord, listener: Listener): () => void {
    run.listeners.add(listener);
    return () => run.listeners.delete(listener);
  }
}

export const runStore = new RunStore();
