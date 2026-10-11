// Reads wrangler.jsonc: strips // and /* */ comments and trailing commas (leaving string contents alone), then JSON.parse. Shared by tests/config.test.mjs and tools/precompute.mjs
export function parseJsonc(text) {
  let out = "";
  let i = 0;
  let str = false;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (str) {
      out += c;
      if (c === "\\") {
        out += n;
        i += 2;
        continue;
      }
      if (c === '"') str = false;
      i++;
      continue;
    }
    if (c === '"') {
      str = true;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && n === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && n === "*") {
      i = text.indexOf("*/", i + 2) + 2;
      continue;
    }
    out += c;
    i++;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}
