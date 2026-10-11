// Small helpers shared by worker.js and register.js: byte-limited body reader, JSON responses, the error envelope

// Reads at most max bytes: rejects outright on an oversized Content-Length; otherwise counts while streaming and cancels the stream past the limit, so the whole body is never buffered. Returns null when over the limit
export async function readLimited(request, max) {
  const len = Number(request.headers?.get?.("content-length"));
  if (Number.isFinite(len) && len > max) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    buf.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

export function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    // Readings depend only on the body, but POST is never cached anyway; health must show the current version; the register can change at any time
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

// Error envelope: docs/reference/interfaces.md
export const fail = (status, error, msg) => json({ ok: false, error, msg }, status);
