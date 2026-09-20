# n8n-nodes-cactus-needle

n8n community node for [Cactus Needle 3](https://cactuscompute.com/needle) — the tiny on-device tool-calling model — via the `cactus-docker` playground server (`POST /complete`, `/reset`, `/model`, `/finetune`).

Server source: [cactus-compute/needle — `needle/playground/server.py`](https://github.com/cactus-compute/needle/blob/main/needle/playground/server.py).
Python reference: [needle-python-docs](https://cactuscompute.com/blog/needle-python-docs).

## What it does

- **Tool Calling → Complete**: send `{tools, query}` to `POST /complete`, get back `function_calls`, `reasoning`, `confidence`, … One output row per call (or one `empty: true` row on refusal).
- **Conversation → Reset**: `POST /reset` clears server-side state.
- **Model → Get Active Model**: `GET /model`.
- **Training → Start Fine-Tune / Get Status**: `POST /finetune`, `GET /finetune/status` (needs the `[train]` image variant + an OpenRouter key).

The node is marked `usableAsTool`, so an n8n AI Agent can call **Complete** as a tool.

## Prerequisites

1. A running Needle playground server. From `cactus-docker`:
   ```bash
   docker compose up --build -d
   curl http://localhost:7860/model
   ```
2. Node 20+, n8n.

## Credentials

**Cactus Needle API**:
- `Base URL` — default `http://localhost:7860`. In Coolify in-stack use `http://needle3:7860`.
- `Request Timeout (ms)` — default `120000` (cold starts are slow).

No auth header — the playground server has none. Click **Test** on the credential: it calls `GET /model` against your Base URL. `/finetune` takes its OpenRouter key per-request (node param).

## Usage

1. `npm install`, `npm run build` (official `n8n-node build`: TypeScript + icons + validation).
2. `npm run dev` (starts n8n at http://localhost:5678 with hot reload), or copy `dist/` into `~/.n8n/custom`.
3. Add credential **Cactus Needle API**, add node **Cactus Needle**, pick Resource/Operation.
4. `Complete` params:
   - `Query` — e.g. `dim the living room to 30`.
   - `Tools (JSON)` — raw JSON-schema dicts, OpenAI-style `{"type":"function","function":{...}}` wrappers, or a JSON-encoded string. Example in the default value.
   - Options: `Simplify` (default on), `Fail on Empty Call`, `Minimum Confidence`.

### Handling refusals

Off-topic input returns `function_calls: []`. With Simplify on you get one row with `empty: true`, `name: null`. Either branch on `empty` or set **Fail on Empty Call**.

### Confidence gating

Set **Minimum Confidence** (e.g. `0.8`): below threshold the node throws so you can escalate / re-ask — same pattern as `agent.complete()` + `confidence` in the Python docs.

## Local test

Needs the server on `http://localhost:7860`:

```bash
npm run test    # integration + 33 adversarial probes (needs the server)
npm run lint    # official n8n linter (strict / Cloud-compatible) — must be clean
```

`test/run.js`: raw `/complete` + `/model` + `/reset` checks, `tsc` build check, and a mock-`IExecuteFunctions` run of the compiled `dist` node (complete → reset → get). `test/adversarial.js`: malformed tools, empty query, bad Base URLs, per-item resources, finetune-without-key, timeouts and more.

## Publishing

Releases go out via GitHub Actions with npm provenance (required by n8n since May 2026) — see `.github/workflows/publish.yml`. One-time setup: npm Trusted Publisher for this repo, or an `NPM_TOKEN` secret. Then:

```bash
npm run release   # lint + build + version bump + tag + push → workflow publishes
```

After the first publish, run the official static check:

```bash
npm run scan   # scan-community-package n8n-nodes-cactus-needle (registry lookup, post-publish only)
```

## Notes / limits (faithful to server.py)

- Stateless per toolset: server re-binds when `tools` change; each caller can use a different tool surface.
- 6+ tools → retrieval head admits top-5 per turn.
- Optional args may be omitted when the query gives no evidence — don't assume keys exist.
- No free-text fallback: empty `function_calls` is the refusal.
- `weights` / `.cact` upload (`POST /load-model`) is intentionally not in v0.1 (raw-bytes upload); use the server directly for that.
