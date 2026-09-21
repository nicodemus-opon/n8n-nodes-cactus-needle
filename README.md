# n8n-nodes-cactus-needle

n8n community node for [Cactus Needle 3](https://cactuscompute.com/needle) — on-device tool-calling via the playground server (`POST /complete`, `/reset`, `/model`, `/finetune`).

Server: [cactus-needle-docker](https://github.com/nicodemus-opon/cactus-needle-docker) · upstream [`needle/playground/server.py`](https://github.com/cactus-compute/needle/blob/main/needle/playground/server.py) · [python docs](https://cactuscompute.com/blog/needle-python-docs).

## What it does

- **Complete**: send `{tools, query}` to `POST /complete`. One row per call, or one `empty: true` row on refusal. `usableAsTool`, so AI Agents can call it.
- **Reset**: `POST /reset`. **Get Model**: `GET /model`. **Fine-tune**: `POST /finetune`, `GET /finetune/status` (needs OpenRouter key).

## Prerequisites: running server

Option A — Docker ([cactus-needle-docker](https://github.com/nicodemus-opon/cactus-needle-docker)):

```bash
docker compose up --build -d
curl http://localhost:7860/model
```

Option B — CLI, no Docker:

```bash
pip install cactus-needle
needle playground  # http://127.0.0.1:7860, engine + weights auto-download on first run
curl http://127.0.0.1:7860/model
# needle playground --weights my.cact --port 7860 --host 127.0.0.1
```

Needs Node 20+, n8n.

## Credentials

**Cactus Needle API**: `Base URL` (default `http://localhost:7860`), `Request Timeout` (default `120000`). No auth — Test calls `GET /model`.

## Usage

1. `npm install && npm run build`, then `npm run dev` (n8n at `http://localhost:5678`).
2. Add credential + **Cactus Needle** node, pick Resource/Operation.
3. `Complete`: `Query` (e.g. `dim the living room to 30`), `Tools (JSON)` (raw schemas, OpenAI-style wrappers, or JSON string), options `Simplify` (default on), `Fail on Empty Call`, `Minimum Confidence` (e.g. `0.8` throws below threshold so you can escalate).

Refusals return `function_calls: []` → one `empty: true` row with Simplify on. Branch on `empty` or set Fail on Empty.

## Dev

```bash
npm run test  # needs server on :7860
npm run lint  # must be clean
```

## Limits

Stateless per toolset; 6+ tools → top-5 retrieval per turn; optional args omitted without evidence; no free-text fallback; `POST /load-model` not in v0.1.
