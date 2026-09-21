# n8n-nodes-cactus-needle

n8n community node for [Cactus Needle 3](https://cactuscompute.com/needle): on-device tool-calling via the playground server (`POST /complete`, `/reset`, `/model`, `/load-model`, `/finetune`).

Server: [cactus-needle-docker](https://github.com/nicodemus-opon/cactus-needle-docker) · upstream [`needle/playground/server.py`](https://github.com/cactus-compute/needle/blob/main/needle/playground/server.py) · [python docs](https://cactuscompute.com/blog/needle-python-docs).

## What it does

- **Complete**: send `{tools, query}` to `POST /complete`. Single row by default (`usableAsTool`-safe for AI Agents), or one `empty: true` row on refusal.
- **Reset**: `POST /reset`. **Get Model**: `GET /model`. **Load Model**: `POST /load-model` (upload a `.cact` via binary input). **Fine-tune**: `POST /finetune`, `GET /finetune/status` (needs OpenRouter key).

## Prerequisites: running server

Option A: Docker ([cactus-needle-docker](https://github.com/nicodemus-opon/cactus-needle-docker)):

```bash
docker compose up --build -d
curl http://localhost:7860/model
```

Option B: CLI, no Docker:

```bash
pip install cactus-needle
needle playground  # http://127.0.0.1:7860, engine + weights auto-download on first run
curl http://127.0.0.1:7860/model
# needle playground --weights my.cact --port 7860 --host 127.0.0.1
```

Needs Node 20+, n8n.

## Credentials

**Cactus Needle API**: `Base URL` (default `http://localhost:7860`), `Request Timeout` (default `120000`), optional `OpenRouter API Key` (preferred store for fine-tune; per-node key still works as fallback). No auth. Test calls `GET /model`.

## Usage

1. `npm install && npm run build`, then `npm run dev` (n8n at `http://localhost:5678`).
2. Add credential + **Cactus Needle** node, pick Resource/Operation.

**Tool Calling > Complete**
- `Query`: natural-language request (e.g. `dim the living room to 30`). Off-topic input returns empty `function_calls` (a refusal, not free text).
- `Tools (JSON)`: array of tool schemas. Accepts raw schemas, OpenAI-style `{"type":"function","function":{...}}` wrappers, or a JSON-encoded string.
- Options:
  - `Simplify` (default on): single simplified row. Off returns the raw `/complete` body.
  - `Fail on Empty Call` (default off): throw on refusal instead of returning an `empty: true` row.
  - `Minimum Confidence` (default 0 = off): throw when returned confidence is below this (0 to 1).
  - `Split One Row Per Call` (default off): one item per function call. Keep off for AI Agents.
  - `Include Raw Response` (default off): attach raw body as `_full`.

**Conversation > Reset**: no params. Clears server-side conversation state.

**Model > Get Active Model**: no params. Returns the active weights name.

**Model > Load Weights File**
- `Binary Property` (default `data`): input binary field holding the `.cact` file (e.g. from Read Binary File).
- `File Name` (default empty): override the uploaded file name.

**Training > Start Fine-Tune**
- `Tools (JSON)`: tool surface to fine-tune on.
- `OpenRouter API Key`: per-node key, used only when the credential key is empty.
- `Samples` (default 200): synthetic samples to generate, 1 to 2000.

**Training > Get Fine-Tune Status**: no params. Returns background fine-tuning progress.

Refusals return `function_calls: []` as one `empty: true` row with Simplify on. Branch on `empty` or set Fail on Empty.

## Dev

```bash
npm run test:unit  # mocked, no server needed
npm run test  # needs server on :7860 (cactus-needle-docker)
npm run lint  # must be clean
```

## Limits

Stateless per toolset; 6+ tools → top-5 retrieval per turn; optional args omitted without evidence; no free-text fallback.
