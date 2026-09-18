// ai-router — personal AI gateway, Cloudflare Worker
//
// One stable HTTPS endpoint for all personal apps to call for AI work.
// Clients know one URL, one bearer token, and a service ID; this
// Worker decides which backend actually serves the request.
//
// POST /v1/invoke
// Authorization: Bearer <GATEWAY_TOKEN>
// { "service": "local.codex", "input": "<video id>", "options": { "length": "short" } }
//
// 200 -> { "service": "...", "backend": "...", "output": ..., "ms": 1234 }
// 4xx/5xx -> { "error": "...", ...details }, never a provider's raw error body.
//
// Wired so far — both against the ai-gateway service already running
// on the Mac mini (see that project's own README), just different
// ai-gateway service_ids underneath:
//   "local.codex"        -> youtube_summarizer; input = video ID,
//                           options.length = "short"|"paragraph"|"detailed"
//   "local.download"     -> youtube_download; input = video ID,
//                           options.kind = "video"|"audio"
//   "local.deploy"       -> mac_deploy; no input, options.action =
//                           "wifi_status"|"start_deploy"|"deploy_status"
//   "deepsink.transcribe" -> deepsink_transcribe (local Whisper); input =
//                           base64 audio chunk, options.chunk_index /
//                           options.start_offset_seconds / options.format
//   "deepsink.notes"     -> deepsink_notes (local Codex); input =
//                           full transcript text, options.marker_hints /
//                           options.background_notes
//   "deepsink.articulate" -> deepsink_articulate (local Codex); input =
//                           a short recent transcript excerpt,
//                           options.background_notes
//   "deepsink.diarize"   -> deepsink_diarize (local pyannote.audio); input =
//                           [{audio_base64, start_offset_seconds}, ...]
//                           (one per session chunk), options.format
//
// Adding a new service should mean adding one entry to SERVICES below
// plus (if it's a genuinely new backend) one small adapter function —
// never touching the routing/auth logic here.
//
// Separately: ANY path under /deepsink/sessions/* is proxied straight
// through to ai-gateway's own REST API (session_store.py /
// deepsink_sessions.py) — method, path, body, and status code all pass
// as-is, no {service, backend, output, ms} envelope. That's a real,
// stateful CRUD API now (the Mac mini is DeepSink's source of truth for
// session data), genuinely different in kind from the stateless
// service_id calls above, so it isn't shoehorned into the same
// contract — see ai-gateway's own README for the full route list.

const SERVICES = {
  "local.codex": { backend: "ai-gateway", call: summarizeViaAiGateway },
  "local.download": { backend: "ai-gateway", call: downloadViaAiGateway },
  "local.deploy": { backend: "ai-gateway", call: deployViaAiGateway },
  "deepsink.transcribe": { backend: "ai-gateway", call: deepsinkTranscribeViaAiGateway },
  "deepsink.notes": { backend: "ai-gateway", call: deepsinkNotesViaAiGateway },
  "deepsink.articulate": { backend: "ai-gateway", call: deepsinkArticulateViaAiGateway },
  "deepsink.diarize": { backend: "ai-gateway", call: deepsinkDiarizeViaAiGateway },
};

const DEEPSINK_SESSIONS_PREFIX = "/deepsink/sessions";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const auth = request.headers.get("Authorization") || "";
    if (!isAuthorized(env, auth)) {
      return json({ error: "unauthorized" }, 401);
    }

    if (url.pathname === DEEPSINK_SESSIONS_PREFIX || url.pathname.startsWith(`${DEEPSINK_SESSIONS_PREFIX}/`)) {
      try {
        return await proxyToAiGateway(request, env, url.pathname, url.search);
      } catch (err) {
        return json(
          { error: "backend_error", backend: "ai-gateway", message: String(err && err.message ? err.message : err) },
          502
        );
      }
    }

    if (request.method !== "POST" || url.pathname !== "/v1/invoke") {
      return json({ error: "not_found" }, 404);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid_json" }, 400);
    }

    const { service, input, options } = body || {};
    const entry = SERVICES[service];
    if (!entry) {
      return json({ error: "unknown_service", known_services: Object.keys(SERVICES) }, 400);
    }

    const startedAt = Date.now();
    try {
      const output = await entry.call(env, input, options || {});
      return json({ service, backend: entry.backend, output, ms: Date.now() - startedAt });
    } catch (err) {
      return json(
        { error: "backend_error", backend: entry.backend, message: String(err && err.message ? err.message : err) },
        502
      );
    }
  },
};

// --- ai-gateway adapters (Mac mini, via Tailscale Funnel) ---
//
// Both share invokeAiGateway()/getAiGatewayToken() below - a fresh
// OAuth token is fetched on every call rather than caching it in
// module scope: simplest correct option, and at personal/occasional
// request volumes the extra round trip is negligible. (Module-scope
// caching across requests on a warm isolate is a legitimate future
// optimization if this Worker ever sees real traffic, but isn't worth
// the added state for this.)

async function summarizeViaAiGateway(env, videoId, options) {
  if (!videoId) throw new Error("missing 'input' (video ID)");
  const length = options.length || "paragraph";
  const result = await invokeAiGateway(env, "youtube_summarizer", { video_id: videoId, length });
  return result.summary;
}

async function downloadViaAiGateway(env, videoId, options) {
  if (!videoId) throw new Error("missing 'input' (video ID)");
  const kind = options.kind || "video";
  // "audio" has ai-gateway extract the audio track server-side via
  // ffmpeg (a stream copy against an unthrottled progressive stream -
  // see that project's own services/youtube_download.py for why),
  // which takes longer than resolving a plain redirect URL, hence the
  // longer timeout than "video" gets. Its `url` also comes back as a
  // path relative to ai-gateway itself (something like
  // "/files/<token>.m4a") rather than an absolute CDN URL, since it
  // points at a file this Worker's own AI_GATEWAY_URL is now serving -
  // resolved to an absolute URL here so the caller never has to know
  // the difference between the two kinds' result shapes.
  const timeoutMs = kind === "audio" ? 300000 : 30000;
  const result = await invokeAiGateway(env, "youtube_download", { video_id: videoId, kind }, timeoutMs);
  return { ...result, url: resolveAiGatewayURL(env, result.url) };
}

function resolveAiGatewayURL(env, url) {
  if (!url || /^https?:\/\//.test(url)) return url;
  return `${env.AI_GATEWAY_URL}${url}`;
}

// Every action here is deliberately fast (see mac_deploy.py — even
// "start_deploy" just spawns a background thread and returns), so this
// uses the same short default timeout as summarize rather than
// anything like "local.download"'s audio timeout. The real,
// multi-minute build+install work is polled for via "deploy_status"
// instead of ever being awaited in a single call.
async function deployViaAiGateway(env, input, options) {
  const action = options.action;
  if (!["wifi_status", "start_deploy", "deploy_status"].includes(action)) {
    throw new Error("invalid 'options.action' - must be 'wifi_status', 'start_deploy', or 'deploy_status'");
  }
  // `project` is optional and passed through as-is - mac_deploy defaults
  // to "ytrun" when it's absent, so yt-run's own AIGatewayClient (which
  // predates this param and never sends it) keeps working unchanged.
  const params = { action };
  if (options.project) params.project = options.project;
  return await invokeAiGateway(env, "mac_deploy", params);
}

// A chunk is up to ~3.5 minutes of 16kHz mono AAC (~1MB once base64'd)
// and Whisper runs CPU-only on the Mac mini, so this gets the same
// extended timeout as local.download's "audio" kind rather than the
// short default - a real transcription can take longer than 30s.
async function deepsinkTranscribeViaAiGateway(env, input, options) {
  if (!input) throw new Error("missing 'input' (base64 audio chunk)");
  return await invokeAiGateway(env, "deepsink_transcribe", {
    audio_base64: input,
    chunk_index: options.chunk_index,
    start_offset_seconds: options.start_offset_seconds,
    format: options.format || "m4a",
  }, 300000);
}

// Codex over a full meeting transcript can take a while too, though
// less reliably long than an audio chunk - same extended-timeout
// reasoning as above, just a smaller number.
async function deepsinkNotesViaAiGateway(env, input, options) {
  if (!input) throw new Error("missing 'input' (transcript text)");
  return await invokeAiGateway(env, "deepsink_notes", {
    transcript: input,
    marker_hints: options.marker_hints || [],
    background_notes: options.background_notes || "",
  }, 180000);
}

// Tapped mid-meeting and waited on, so the input is small and
// deepsink_articulate's own Codex timeout is short (45s default) - but
// this still gets a generous Worker-side ceiling for the same reason
// the deploy calls do (see that section's own comment): the Worker ->
// Tailscale Funnel -> Mac mini round trip alone varies ~2-19s, on top
// of whatever Codex itself takes.
async function deepsinkArticulateViaAiGateway(env, input, options) {
  if (!input) throw new Error("missing 'input' (recent transcript excerpt)");
  return await invokeAiGateway(env, "deepsink_articulate", {
    transcript: input,
    background_notes: options.background_notes || "",
  }, 90000);
}

// A whole session's audio, diarized in one pass (not per chunk - see
// deepsink_diarize.py's own module docstring for why session-relative
// speaker labels need that). This is genuinely the slowest call in this
// file: diarizing a long meeting on CPU can take many minutes, not
// seconds, and the gateway's own subprocess timeout for it defaults to
// 1800s (deepsink_diarize.timeout_seconds) - so this gets a matching
// Worker-side ceiling rather than the shorter "generous" timeouts the
// other deepsink.* calls use. Triggered on demand by a "Detect Speakers"
// button, not automatically, so a slow reply here doesn't block anything
// else in the app.
async function deepsinkDiarizeViaAiGateway(env, input, options) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error("missing 'input' (array of {audio_base64, start_offset_seconds})");
  }
  return await invokeAiGateway(env, "deepsink_diarize", {
    chunks: input,
    format: options.format || "m4a",
  }, 1800000);
}

// Per-route timeout, same reasoning as the deepsink.* adapters above
// (Whisper/Codex/diarization genuinely take a while) — matched against
// the actual work each route does server-side, not a single blanket
// number for the whole passthrough.
function deepsinkTimeoutMs(pathname, method) {
  if (pathname.endsWith("/diarize")) return 1800000;
  if (pathname.endsWith("/finish") || pathname.endsWith("/regenerate")) return 180000;
  if (method === "POST" && pathname.endsWith("/chunks")) return 300000;
  return 30000;
}

async function proxyToAiGateway(request, env, pathname, search) {
  const accessToken = await getAiGatewayToken(env);
  const init = {
    method: request.method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    signal: AbortSignal.timeout(deepsinkTimeoutMs(pathname, request.method)),
  };
  if (request.method !== "GET" && request.method !== "DELETE") {
    init.body = await request.text();
  }
  const resp = await fetch(`${env.AI_GATEWAY_URL}${pathname}${search}`, init);
  const text = await resp.text();
  return new Response(text, {
    status: resp.status,
    headers: { "Content-Type": "application/json" },
  });
}

async function invokeAiGateway(env, serviceId, params, timeoutMs = 30000) {
  const accessToken = await getAiGatewayToken(env);

  const invokeResp = await fetch(`${env.AI_GATEWAY_URL}/invoke`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ service_id: serviceId, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const invokeData = await invokeResp.json();
  if (!invokeResp.ok) {
    throw new Error(`ai-gateway: ${invokeData.error || invokeResp.status}`);
  }
  return invokeData.result;
}

async function getAiGatewayToken(env) {
  // 20s, not 10s: measured by hand, the Worker -> Tailscale Funnel ->
  // Mac mini round trip alone (this call is the very first hop of
  // every single /invoke, regardless of service) varies anywhere from
  // ~2s to ~19s on its own - Funnel always relays rather than going
  // peer-to-peer, since the Worker is outside the tailnet. 10s made this
  // the single most common source of a spurious "backend_error" /
  // "operation was aborted due to timeout" on an otherwise-healthy Mac.
  const tokenResp = await fetch(`${env.AI_GATEWAY_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.AI_GATEWAY_CLIENT_ID,
      client_secret: env.AI_GATEWAY_CLIENT_SECRET,
    }),
    signal: AbortSignal.timeout(20000),
  });
  const tokenData = await tokenResp.json();
  if (!tokenResp.ok) {
    throw new Error(`ai-gateway auth failed: ${tokenData.error_description || tokenData.error || tokenResp.status}`);
  }
  return tokenData.access_token;
}

// Accepts GATEWAY_TOKEN plus any of GATEWAY_TOKEN_1/_2/_3 as equally
// valid bearer tokens — lets one stable token stay configured in every
// real client while a separate one (set via the same `wrangler secret
// put` mechanism) is used for one-off testing, without ever having to
// rotate or hand out the stable one for that. Unset slots are just
// undefined and filtered out below, so there's no need to fill in all
// four.
function isAuthorized(env, authHeader) {
  const candidates = [env.GATEWAY_TOKEN, env.GATEWAY_TOKEN_1, env.GATEWAY_TOKEN_2, env.GATEWAY_TOKEN_3].filter(Boolean);
  return candidates.some((token) => authHeader === `Bearer ${token}`);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
