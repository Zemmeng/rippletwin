// For the sign-text editor: checkSigns(request) never throws and returns { ok, error?, warnings[] }
// error = over the spec (/api/read would answer 400, readSigns() would throw SignError); warnings = within the spec but hard to read, advisory only
// Soft-warning source: RPM Hire VMS product page (checked 2026-09-29): ideally 3 lines of 8 characters; each frame usually shows for 2 s, 3 s for 4 lines or flashing
// Based on the engine's vms.js, plus two extra rules: a line that is a whole road name is not too long, and non-standard abbreviations
import { normalizeRequest, signMessage, countWords, SignError } from "./signs.js";
import { roadAliases, oddAbbreviations } from "./rules.js";

export const SOFT = {
  lines: 3, // warn above 3 lines per frame
  chars: 8, // warn above 8 characters per line (except a line that is a whole candidate road name: it cannot be shortened)
  frameS: 2, // each frame needs at least 2 s
  frameS4: 3, // a 4-line frame needs at least 3 s
  secPerWord: 1, // about 1 s per word (the same assumption as notice in rules.js)
};

const frameTime = (lines) => (lines.length >= 4 ? SOFT.frameS4 : SOFT.frameS);

export function checkSigns(request) {
  let req;
  try {
    req = normalizeRequest(request);
  } catch (e) {
    if (e instanceof SignError) return { ok: false, error: { code: e.code, msg: e.message }, warnings: [] };
    throw e;
  }
  const roadLines = new Set(roadAliases(req.roads).map((a) => a.toks.join(" ")));
  const isRoad = (line) => roadLines.has(line.replace(/['.]/g, ""));
  const warnings = [];
  req.signs.forEach((s, i) => {
    // msg is Chinese on purpose (shown verbatim in the zh UI); the English UI maps by code, like SignError in signs.js
    const warn = (code, msg) => warnings.push({ sign: i, code, msg });
    const words = countWords(signMessage(s));
    if (s.kind === "vms") {
      s.frames.forEach((f, j) => {
        if (f.length > SOFT.lines) warn("many_lines", `第 ${j + 1} 帧 ${f.length} 行，超过 ${SOFT.lines} 行不好读`);
        for (const line of f) {
          if (line.length > SOFT.chars && !isRoad(line)) warn("long_line", `「${line}」${line.length} 个字符，超过 ${SOFT.chars} 个不好读`);
        }
      });
      const need = s.frames.reduce((t, f) => t + frameTime(f), 0);
      if (s.frames.length > 1 && s.read_s < need) {
        warn("frames_too_fast", `两帧要轮一遍至少 ${need} 秒，这个车速下只能读 ${s.read_s} 秒，有人只看到一帧`);
      }
    }
    if (s.read_s < words * SOFT.secPerWord) {
      warn("short_read", `${words} 个词按每词 ${SOFT.secPerWord} 秒要 ${words * SOFT.secPerWord} 秒，只能读 ${s.read_s} 秒`);
    }
    const odd = oddAbbreviations([signMessage(s)], req.roads);
    if (odd.length) warn("odd_abbrev", `非标准缩写 ${odd.join(" ")}：游客可能看不懂`);
  });
  return { ok: true, warnings };
}
