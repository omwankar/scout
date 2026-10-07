# Scout — Transparent Competitive Intel Browser Agent

Scout is an AI browser agent that takes a plain-English research goal, autonomously browses public sites with OpenRouter free models + Playwright, streams every thought/action/screenshot live, stays human-steerable, and finishes with a structured competitive brief.

## Public demo

**https://omwankar-scout.onrender.com**

**Local:**

```bash
cp .env.example .env
# set OPENROUTER_API_KEY (free: https://openrouter.ai/keys)
# optional: BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID, TAVILY_API_KEY
pnpm install
pnpm --filter @scout/shared build
pnpm dev
```

- UI: http://localhost:3000  
- API + production-style UI: http://localhost:3001  
- Health: http://localhost:3001/health  

## One-minute demo script

1. Open Scout. Brand + mission composer should read clearly in the first viewport.
2. Click the **Linear vs Asana** preset (or paste your own goal).
3. Optionally enable **Approve navigations**, then **Start research**.
4. Watch the left timeline stream thoughts + actions; the right pane updates with live browser screenshots.
5. Type a steer note like `focus on pricing pages only` mid-run.
6. When finished, scroll to the **Brief** — copy Markdown/JSON, check sources.

## What it does

| Requirement | How Scout meets it |
|---|---|
| Natural-language goal | Mission composer + presets |
| Multi-step browser actions with LLM in the loop | OpenRouter `openrouter/free` tool calls: search / navigate / click / type / scroll / extract / done / fail |
| Show work live | SSE stream of thoughts, actions, screenshots, errors |
| Human control | Stop, approve/skip gated steps, free-text steer |
| Graceful stuck handling | Retries, visible errors, explicit `fail` with what was tried |
| Clean result | Validated `CompetitiveBrief` + Markdown/JSON export |

## Architecture

```
Next.js UI  --SSE/REST-->  Fastify API  -->  OpenRouter (free models)
                                |
                                +--> Playwright --> Browserbase (hosted) or local Chromium
                                +--> Tavily (web search)
```

Monorepo:

- `apps/web` — Scout UI (Next.js static export)
- `apps/api` — agent loop, Playwright, SSE
- `packages/shared` — event + brief types

## Environment

| Var | Purpose |
|---|---|
| `OPENROUTER_API_KEY` | Required — free key at https://openrouter.ai/keys |
| `LLM_MODEL` | Default `openrouter/free` (routes to a $0 tool-calling model) |
| `OPENROUTER_HTTP_REFERER` | App URL sent to OpenRouter (`HTTP-Referer`) |
| `OPENROUTER_APP_TITLE` | App title sent to OpenRouter (`X-Title`) |
| `BROWSERBASE_API_KEY` | Recommended for hosted browsers in production |
| `BROWSERBASE_PROJECT_ID` | Required with Browserbase key |
| `TAVILY_API_KEY` | Optional — faster URL discovery via `search` tool |
| `PORT` | API port (default `3001`) |
| `CORS_ORIGIN` | Dev: `http://localhost:3000` · Prod: `*` or your origin |
| `NEXT_PUBLIC_API_URL` | Dev: `http://localhost:3001` · Prod: empty (same origin) |
| `MAX_STEPS` | Default `16` |
| `MAX_RUNTIME_MS` | Default `600000` (10 min) |
| `REQUIRE_APPROVAL_DEFAULT` | `true`/`false` |

## Deploy on Render

This repo ships a `render.yaml` Blueprint. The API listens on Render’s `PORT` and serves the static UI from the same origin.

One-click: [Deploy to Render](https://render.com/deploy?repo=https://github.com/omwankar/scout)

1. Open that link, sign in to Render, and apply the Blueprint (`omwankar-scout`).
2. When prompted, set `OPENROUTER_API_KEY` (free). Optionally `TAVILY_API_KEY` and Browserbase.
3. Health check: `/health`. Public URL: `https://omwankar-scout.onrender.com`.

Leave `NEXT_PUBLIC_API_URL` empty so the UI talks to the API on the same origin. Do not hardcode `PORT` — Render injects it.

```bash
# optional local docker check
docker build -t scout .
docker run --rm -p 3001:3001 -e PORT=3001 -e OPENROUTER_API_KEY=... -e CORS_ORIGIN=* scout
```

## Design judgments

- **Task:** Competitive intel across public sites — non-trivial, login-free, produces a decision-useful artifact.
- **Transparency over magic:** The browser viewport is the proof; the timeline is the audit log.
- **Steerability:** Approvals for high-impact navigations/typing + mid-flight natural-language steering.
- **Visual system:** Editorial research aesthetic (Fraunces + IBM Plex Sans, ink/paper/signal) — not purple-glow AI chrome.

## Known limitations

- Public pages only; no logins, CAPTCHAs, or authenticated portals.
- Selector failures happen on heavy client-rendered sites — Scout retries, then reports clearly.
- Screenshots are action-boundary JPEG frames, not a 30fps remote desktop.
- Single in-memory run store (no multi-user auth / persistence across restarts).

## Stack

OpenRouter (free) · Playwright · Browserbase · Tavily · Fastify · Next.js · TypeScript · Render/Docker

## Security note

If API keys were ever pasted into chat or a ticket, rotate them in the provider dashboards after the demo.
