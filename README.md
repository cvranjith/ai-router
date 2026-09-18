# ai-router

One always-on HTTPS endpoint, at Cloudflare's edge, that personal apps
call for AI work — one URL, one bearer token, one `service` ID. The
Worker decides which backend actually serves the request, so adding a
new provider or moving a backend later never means changing the apps
that call it. See `requirement-cloudflare.md` (in the `yt-run` repo)
for the full design and future plans (Groq, Gemini, `local.ollama`).

Currently wired — both against the `ai-gateway` service already
running on the Mac mini, reached over its existing Tailscale Funnel
URL. No changes to `ai-gateway` itself were needed — this Worker is
just a new, separate OAuth2 client of it.

- **`local.codex`** → `youtube_summarizer`
- **`local.download`** → `youtube_download`
- **`local.deploy`** → `mac_deploy` (triggers `install_to_device.sh` on the Mac itself)
- **`deepsink.transcribe`** → `deepsink_transcribe` (local Whisper, DeepSink app)
- **`deepsink.notes`** → `deepsink_notes` (local Codex, DeepSink app)

## Contract

```
POST /v1/invoke
Authorization: Bearer <GATEWAY_TOKEN>
{ "service": "local.codex", "input": "<video id>", "options": { "length": "short" } }

200 -> { "service": "local.codex", "backend": "ai-gateway", "output": "<summary>", "ms": 1234 }
401 -> { "error": "unauthorized" }
400 -> { "error": "unknown_service", "known_services": [...] }
502 -> { "error": "backend_error", "backend": "...", "message": "..." }
```

`local.download` takes `"options": { "kind": "video" | "audio" }` and
its `output` is an object, not a string:
`{ "video_id", "kind", "title", "ext", "url", "filesize" }`.

`local.deploy` takes `"options": { "action": "wifi_status" | "start_deploy" | "deploy_status", "project": "ytrun" | "deepsink" }`
and needs no `input`. `project` is optional (defaults to `"ytrun"` on the
ai-gateway side if omitted) and picks which app's install script runs —
yt-run and DeepSink each have their own status/lock, so polling one
project's `deploy_status` is never confused by the other's build.
`start_deploy` returns immediately (`{ "status": "running" }`) rather
than waiting for the actual multi-minute build+install — poll
`deploy_status` afterward
(`{ "status": "idle"|"running"|"success"|"failed", "log_tail": "..." }`)
until it's no longer `"running"`.

`deepsink.transcribe` takes `"input"` as a base64-encoded audio chunk and
`"options": { "chunk_index": 0, "start_offset_seconds": 0.0, "format": "m4a" }`.
Runs Whisper locally on the Mac mini (no audio leaves it); `output` is
`{ "blocks": [{ "start", "end", "text" }, ...] }`, already offset by
`start_offset_seconds`.

`deepsink.notes` takes `"input"` as the full transcript text and
`"options": { "marker_hints": [{ "offset_seconds", "comment" }, ...] }`.
Runs Codex locally on the Mac mini; `output` is
`{ "title", "summary", "key_points", "decisions", "action_items", "open_questions" }`
— the exact shape DeepSink's `SessionNotesPayload` decodes.

## One-time setup

### 1. Register this Worker as an ai-gateway client

From the `ai-gateway` project directory:

```
/opt/homebrew/opt/python@3.10/bin/python3.10 generate_config.py cloudflare_worker
```

This prints a `client_id`/`client_secret` — save both, shown only once.

### 2. Generate a shared token for your apps to call *this* Worker

Any random string works; e.g.:

```
openssl rand -base64 32
```

`GATEWAY_TOKEN_1`, `GATEWAY_TOKEN_2`, and `GATEWAY_TOKEN_3` are also
accepted as equally-valid bearer tokens, entirely optional — set one
via the same `wrangler secret put` command below for one-off/testing
use, so a real client's own configured token never has to be rotated
just to hand out a temporary one.

### 3. Set secrets

Each of these prompts for a value (or pipe one in):

```
wrangler secret put GATEWAY_TOKEN            # from step 2
wrangler secret put AI_GATEWAY_CLIENT_ID     # from step 1
wrangler secret put AI_GATEWAY_CLIENT_SECRET # from step 1
```

Secrets are encrypted at rest, never shown again, and never appear in
`wrangler.toml`, the repo, or any Worker response. `AI_GATEWAY_URL`
itself isn't a secret (it's just a hostname), so it lives as a plain
`[vars]` entry in `wrangler.toml` instead.

### 4. Local dev (optional, before deploying)

```
cp .dev.vars.example .dev.vars   # then fill in real values
wrangler dev
```

`wrangler dev` runs the Worker locally, reading secrets from
`.dev.vars` (gitignored) instead of the real deployed secrets store.

### 5. Deploy

```
wrangler deploy
```

Prints your Worker's URL — looks like
`https://ai-router.<your-subdomain>.workers.dev`.

## Testing

```
WORKER_URL=https://ai-router.<your-subdomain>.workers.dev \
GATEWAY_TOKEN=<the token from step 2> \
./test.sh
```

Covers: missing auth (401), unknown service (400), and a real
`local.codex` call end to end.

## Logs

```
wrangler tail
```

Streams live logs while you send requests — useful for debugging a
failing route without guessing.

## Adding a new service later

1. Write a small adapter function (see `summarizeViaAiGateway` in
   `worker.js` for the shape: `async (env, input, options) => output`,
   throwing on failure).
2. Add one entry to the `SERVICES` map at the top of `worker.js`.
3. Add any new secrets it needs (`wrangler secret put ...`).

The routing/auth logic in `fetch()` never needs to change.

## What would change for streaming

Right now the Worker waits for the whole backend response before
replying. Streaming would mean each adapter returning a
`ReadableStream` (or the raw upstream `Response.body`) instead of an
awaited string, and `fetch()` piping that straight through instead of
wrapping it in the `{ service, backend, output, ms }` envelope — doable
later without restructuring the registry/auth layer, just the response
path.

## What would change to move off Cloudflare

The Cloudflare-specific surface is deliberately just the `export
default { fetch(request, env) }` entry point and `env.*` for secrets/
vars. The registry, adapters, and auth check are plain JS with no
Cloudflare APIs — porting to a small Node/Express (or Deno/Bun) service
would mean rewriting only that entry point to read `process.env` and
wire up an HTTP server, not touching `SERVICES` or the adapters.
