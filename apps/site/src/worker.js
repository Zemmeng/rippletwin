// The site Worker: one origin serves every module. Static files are the out/ tree that build.mjs copies (/<module>/public/...),
// served by the ASSETS binding.
// /api/sumo and /api/sumo/* go to hackathon-sumo (apps/sumo, the live SUMO container, service binding SUMO). The request is forwarded
//   unchanged; header stripping, the allowlist and rate limiting happen there. No binding -> 503 sumo_off; binding throws -> 502 sumo_down.
//   On either code the page falls back to the pre-computed results in /sumo/public/. This check must come before /api/* below.
// Other /api/* go to the API Worker (service binding API). Without the binding, /api/health reports "api not connected"
//   and every other /api/* path returns 503.
// /api/public/* are static files from apps/api/public/ (reader.js and so on) and are not forwarded.
// No CORS headers on purpose: the page, engine, data and API all share one origin (docs/reference/interfaces.md).
// ⚠️ This file must export nothing except default: workerd treats every named export as an entrypoint, and exporting
//    a string stops the whole Worker from starting (tested).
const VERSION = 'site-0.1';

export default {
  async fetch(request, env = {}) {
    const path = new URL(request.url).pathname;
    // Only /api/sumo and /api/sumo/...; lookalikes such as /api/sumoX go to the API as usual
    const isSumo = path === '/api/sumo' || path.startsWith('/api/sumo/');
    const isApi = (path === '/api' || path.startsWith('/api/')) && !(path === '/api/public' || path.startsWith('/api/public/'));

    if (isSumo) {
      if (!env.SUMO || typeof env.SUMO.fetch !== 'function') {
        return fail(503, 'sumo_off', 'The live SUMO service is not connected; use the pre-computed results in /sumo/public/real/ instead');
      }
      try {
        return await env.SUMO.fetch(request);
      } catch (e) {
        console.error('SUMO service binding failed', path, e && e.stack);
        return fail(502, 'sumo_down', 'The live SUMO service is not responding; use the pre-computed results in /sumo/public/real/ instead');
      }
    }

    if (isApi) {
      if (env.API && typeof env.API.fetch === 'function') {
        try {
          return await env.API.fetch(request);
        } catch (e) {
          console.error('API service binding failed', path, e && e.stack);
          return fail(502, 'api_unreachable', 'The API Worker is not responding; try again later');
        }
      }
      if (path === '/api/health') return json({ ok: true, v: VERSION, mock: true, api: false });
      return fail(503, 'api_not_deployed', 'The API is not connected: this site has no API service binding (see services in apps/site/wrangler.jsonc)');
    }

    if (env.ASSETS) return env.ASSETS.fetch(request);
    return fail(500, 'no_assets', 'No ASSETS binding (is the assets block missing from wrangler.jsonc?)');
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

// Error envelope: docs/reference/interfaces.md, error format
const fail = (status, error, msg) => json({ ok: false, error, msg }, status);
