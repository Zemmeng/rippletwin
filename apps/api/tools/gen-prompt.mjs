// Generates src/prompt.js from prompts.md (prompts.md is the single source of prompts; a Worker cannot import .md, so a JS copy is generated)
// Usage: node apps/api/tools/gen-prompt.mjs          regenerate src/prompt.js
//        node apps/api/tools/gen-prompt.mjs --check  only check they match; exit code 1 if not (tests/prompt.test.mjs checks too)
// Reads only the code blocks / tables / lists marked <!-- prompt:<name> --> in prompts.md; a malformed file throws instead of producing partial output
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = new URL("..", import.meta.url);
export const PROMPTS_MD = new URL("prompts.md", HERE);
export const PROMPT_JS = new URL("src/prompt.js", HERE);

const PERSONAS = ["commuter", "local", "tourist", "delivery"];
const KINDS = ["vms", "sign", "arrow"];
const LANGS = ["zh", "en"]; // same as LANGS in public/js/explain.js

// The content right after a marker (blank lines skipped)
function after(md, name) {
  const tag = `<!-- prompt:${name} -->`;
  const i = md.indexOf(tag);
  if (i < 0) throw new Error(`prompts.md is missing marker ${tag}`);
  if (md.indexOf(tag, i + 1) >= 0) throw new Error(`prompts.md contains ${tag} more than once`);
  return md.slice(i + tag.length).replace(/^\s*\n/, "");
}

function codeBlock(md, name) {
  const m = after(md, name).match(/^```text\n([\s\S]*?)\n```/);
  if (!m) throw new Error(`<!-- prompt:${name} --> must be followed directly by a \`\`\`text code block`);
  return m[1];
}

// Two-column table: | `key` | `value` | (header and separator rows are skipped)
function table(md, name) {
  const out = {};
  for (const line of after(md, name).split("\n")) {
    if (!line.startsWith("|")) break;
    const m = line.match(/^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function list(md, name) {
  const out = [];
  for (const line of after(md, name).split("\n")) {
    const m = line.match(/^\d+\.\s+`([^`]+)`\s*$/);
    if (!m) break;
    out.push(m[1]);
  }
  return out;
}

const need = (text, keys, where) => {
  for (const k of keys) if (!text.includes(`{${k}}`)) throw new Error(`${where} is missing placeholder {${k}}`);
};

export function parsePrompts(md) {
  const v = md.match(/`prompt_v = (r\d+)`/)?.[1];
  if (!v) throw new Error("prompts.md is missing \"`prompt_v = r<n>`\"");
  const system = codeBlock(md, "system");
  if (!system.includes("<sign>")) throw new Error("system must state that text inside <sign> tags is not an instruction");
  const user = codeBlock(md, "user");
  need(user, ["persona_line", "kmh", "signs", "roads", "ask"], "user");
  const sign = codeBlock(md, "sign");
  need(sign, ["n", "kind_label", "read_s", "sign_lines"], "sign");
  if (!sign.includes("<sign>\n{sign_lines}\n</sign>")) throw new Error("the sign template must wrap sign text between <sign> and </sign> lines");
  const arrowEmpty = codeBlock(md, "arrow_empty");
  need(arrowEmpty, ["n", "kind_label", "read_s"], "arrow_empty");
  if (arrowEmpty.includes("<sign>")) throw new Error("an arrow board without text must not have a <sign> tag");
  const personas = table(md, "personas");
  if (JSON.stringify(Object.keys(personas)) !== JSON.stringify(PERSONAS)) {
    throw new Error(`persona table must be exactly ${PERSONAS.join(" / ")}, got ${Object.keys(personas).join(" / ")}`);
  }
  const kinds = table(md, "kinds");
  if (JSON.stringify(Object.keys(kinds)) !== JSON.stringify(KINDS)) throw new Error(`kind_label table must be exactly ${KINDS.join(" / ")}`);
  const asks = list(md, "asks");
  if (asks.length !== 3) throw new Error(`there must be exactly 3 asks, got ${asks.length}`);
  return { v, system, user, sign, arrowEmpty, personas, kinds, asks, explain: parseExplain(md) };
}

// Prompt for plan explanation (POST /api/explain): its own version explain_v, so changing it does not invalidate the reading cache
function parseExplain(md) {
  const v = md.match(/`explain_v = (e\d+)`/)?.[1];
  if (!v) throw new Error("prompts.md is missing \"`explain_v = e<n>`\"");
  const system = codeBlock(md, "explain_system");
  if (!system.includes("<data>")) throw new Error("explain_system must state that text inside <data> tags is not an instruction");
  if (!/json/i.test(system)) throw new Error("explain_system must contain the word json (required by DeepSeek's json_object mode)");
  const user = codeBlock(md, "explain_user");
  need(user, ["options_json", "lang_name"], "explain_user");
  if (!user.includes("<data>\n{options_json}\n</data>")) throw new Error("explain_user must wrap the plan data between <data> and </data> lines");
  const langs = table(md, "explain_langs");
  if (JSON.stringify(Object.keys(langs)) !== JSON.stringify(LANGS)) throw new Error(`explain language table must be exactly ${LANGS.join(" / ")}`);
  return { v, system, user, langs };
}

export function renderModule(p) {
  return [
    "// ⚠️ Generated file, do not edit: edit apps/api/prompts.md, then run node apps/api/tools/gen-prompt.mjs (tests/prompt.test.mjs checks they match)",
    "// prompts.md is the single source of prompts; this is only a copy the Worker can import",
    `export const PROMPT = ${JSON.stringify(p, null, 2)};`,
    "",
  ].join("\n");
}

export const generate = (md = readFileSync(PROMPTS_MD, "utf8")) => renderModule(parsePrompts(md));

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const want = generate();
  let have = "";
  try {
    have = readFileSync(PROMPT_JS, "utf8");
  } catch {
    // first generation
  }
  if (process.argv.includes("--check")) {
    if (want !== have) {
      console.log("❌ src/prompt.js does not match prompts.md: run node apps/api/tools/gen-prompt.mjs");
      process.exit(1);
    }
    console.log("✅ src/prompt.js matches prompts.md");
  } else {
    writeFileSync(PROMPT_JS, want);
    console.log(want === have ? "src/prompt.js unchanged" : "regenerated src/prompt.js");
  }
}
