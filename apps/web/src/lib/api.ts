import type {
  ApproveRequest,
  CreateRunResponse,
  RunSnapshot,
  SteerRequest,
  TimelineEvent,
} from "@scout/shared";

// Empty string = same origin (production: UI served by the API).
// Unset = local default.
const API_URL = (
  process.env.NEXT_PUBLIC_API_URL === undefined
    ? "http://localhost:3001"
    : process.env.NEXT_PUBLIC_API_URL
).replace(/\/$/, "");

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || res.statusText);
  }
  return res.json() as Promise<T>;
}

export async function createRun(
  goal: string,
  requireApproval: boolean
): Promise<CreateRunResponse> {
  const res = await fetch(`${API_URL}/api/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ goal, requireApproval }),
  });
  return json(res);
}

export async function stopRun(runId: string): Promise<void> {
  await json(await fetch(`${API_URL}/api/runs/${runId}/stop`, { method: "POST" }));
}

export async function pauseRun(runId: string): Promise<void> {
  await json(await fetch(`${API_URL}/api/runs/${runId}/pause`, { method: "POST" }));
}

export async function resumeRun(runId: string): Promise<void> {
  await json(await fetch(`${API_URL}/api/runs/${runId}/resume`, { method: "POST" }));
}

export async function approveRun(runId: string, body: ApproveRequest): Promise<void> {
  await json(
    await fetch(`${API_URL}/api/runs/${runId}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

export async function steerRun(runId: string, body: SteerRequest): Promise<void> {
  await json(
    await fetch(`${API_URL}/api/runs/${runId}/steer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

export async function getRun(runId: string): Promise<RunSnapshot> {
  return json(await fetch(`${API_URL}/api/runs/${runId}`));
}

export function subscribeRunEvents(
  runId: string,
  handlers: {
    onEvent: (event: TimelineEvent) => void;
    onSnapshot?: (run: RunSnapshot) => void;
    onError?: (err: Error) => void;
  }
): () => void {
  const es = new EventSource(`${API_URL}/api/runs/${runId}/events`);

  es.addEventListener("snapshot", (msg) => {
    try {
      const data = JSON.parse((msg as MessageEvent).data) as {
        run: RunSnapshot;
      };
      handlers.onSnapshot?.(data.run);
    } catch (err) {
      handlers.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  });

  const types = [
    "status",
    "thought",
    "action",
    "screenshot",
    "error",
    "approval_required",
    "steer",
    "result",
  ] as const;

  for (const type of types) {
    es.addEventListener(type, (msg) => {
      try {
        const event = JSON.parse((msg as MessageEvent).data) as TimelineEvent;
        handlers.onEvent(event);
      } catch (err) {
        handlers.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  es.onerror = () => {
    // EventSource reconnects automatically; surface only hard failures later
  };

  return () => es.close();
}

export { API_URL };
