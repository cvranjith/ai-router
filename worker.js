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
// 200 -> { "service": "...", "backend": "...", "output": "...", "ms": 1234 }
// 4xx/5xx -> { "error": "...", ...details }, never a provider's raw error body.
//
// Only "local.codex" is wired so far — routes to the youtube_summarizer
// service already running on the Mac mini's ai-gateway (see that
// project's own README). Adding a new service should mean adding one
// entry to SERVICES below plus (if it's a genuinely new backend) one
// small adapter function — never touching the routing/auth logic here.

const SERVICES = {
  "local.codex": { backend: "ai-gateway", call: callAiGateway },
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/v1/invoke") {
      return json({ error: "not_found" }, 404);
    }

    const auth = request.headers.get("Authorization") || "";
    if (!env.GATEWAY_TOKEN || auth !== `Bearer ${env.GATEWAY_TOKEN}`) {
      return json({ error: "unauthorized" }, 401);
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

// --- ai-gateway adapter (Mac mini, via Tailscale Funnel) ---
//
// Fetches a fresh OAuth token on every call rather than caching it in
// module scope — simplest correct option, and at personal/occasional
// request volumes the extra round trip is negligible. (Module-scope
// caching across requests on a warm isolate is a legitimate future
// optimization if this Worker ever sees real traffic, but isn't worth
// the added state for this.)
async function callAiGateway(env, videoId, options) {
  if (!videoId) throw new Error("missing 'input' (video ID)");
  const length = options.length || "paragraph";

  const tokenResp = await fetch(`${env.AI_GATEWAY_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.AI_GATEWAY_CLIENT_ID,
      client_secret: env.AI_GATEWAY_CLIENT_SECRET,
    }),
    signal: AbortSignal.timeout(10000),
  });
  const tokenData = await tokenResp.json();
  if (!tokenResp.ok) {
    throw new Error(`ai-gateway auth failed: ${tokenData.error_description || tokenData.error || tokenResp.status}`);
  }

  const invokeResp = await fetch(`${env.AI_GATEWAY_URL}/invoke`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${tokenData.access_token}`,
    },
    body: JSON.stringify({
      service_id: "youtube_summarizer",
      params: { video_id: videoId, length },
    }),
    signal: AbortSignal.timeout(30000),
  });
  const invokeData = await invokeResp.json();
  if (!invokeResp.ok) {
    throw new Error(`ai-gateway: ${invokeData.error || invokeResp.status}`);
  }
  return invokeData.result.summary;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
