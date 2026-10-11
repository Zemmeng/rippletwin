"""AI panel (src/js/9-ai.js): step 3 "AI road users · what each one read" and "AI call log", plus the AI explanation on the step 4 plan cards.

Usage: python3 apps/web/tests/test_ai.py (needs node ≥ 18; no network, no LLM calls)
Pure-function and real-backend.js assertions live in tests/ai_glue.mjs; this file first runs static source assertions, then runs node and forwards its ✅ / ❌ lines.
The last line is "N passed, M failed".
"""
import pathlib
import re
import shutil
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
SRC = HERE.parent / "src" / "js"
AI = (SRC / "9-ai.js").read_text(encoding="utf-8")
APP = (SRC / "5-app.js").read_text(encoding="utf-8")
CMP = (SRC / "8-compare.js").read_text(encoding="utf-8")
passed = failed = 0


def check(name, ok, detail=""):
    global passed, failed
    if ok:
        passed += 1
        print(f"✅ {name}")
    else:
        failed += 1
        print(f"❌ {name}{(': ' + detail) if detail else ''}")


def body(name, text):
    """Body of function name(){…} (matched by brace pairing)"""
    i = text.find(f"function {name}(")
    if i < 0:
        return ""
    j = text.find("{", i)
    depth = 0
    for k in range(j, len(text)):
        depth += {"{": 1, "}": -1}.get(text[k], 0)
        if depth == 0:
            return text[j:k + 1]
    return ""


code = re.sub(r"/\*.*?\*/", "", AI, flags=re.S)
# 1 Mount point: only a one-line hook is added to another module's file
check("5-app.js mounts aiMount() on the step 3 network panel", "clashMount();aiMount();" in APP)
# 2 Privacy / network: no requests at all; downloads are assembled in the browser
check("negative: 9-ai.js has no import() / fetch() / XMLHttpRequest / sendBeacon / WebSocket",
      not re.search(r"\bimport\s*\(|\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket", code))
dl = body("aiDownload", AI)
check("JSON download: Blob + createObjectURL (local file, nothing uploaded); content only passes through the aiLogJSON() allow-list",
      "new Blob([txt]" in dl and "URL.createObjectURL" in dl and "aiLogJSON(AI.log" in dl and "revokeObjectURL" in dl)
check("the log comes only from backend.js: aiLog() snapshot + onAiLog() subscription, in the same tick", re.search(r"AI\.log=api\.aiLog\(\);\s*api\.onAiLog\(", AI) is not None)
# 3 Injection: text written by the model only goes through textContent
check("why is written with textContent (data-aiwhy)", "q.textContent=p&&p.reading&&p.reading.why||''" in AI)
check("negative: the whole of 9-ai.js has a single innerHTML (aiRender writes the result of aiHTML(), where every string goes through esc())",
      code.count("innerHTML") == 1 and "el.innerHTML=h;" in body("aiRender", AI))
interp = re.findall(r"\$\{((?:[^{}]|\{[^{}]*\})*)\}", body("aiPersonaHTML", AI) + body("aiLogRowHTML", AI) + body("aiTileHTML", AI))
raw = [x for x in interp if re.search(r"\.(text|why|src|error|persona)\b|\b(txt|adv|who)\b|aiAdvice\(|aiSrcLabel\(|aiKind\(|aiTime\(", x) and "esc(" not in x and not x.startswith("aiSrcTone(")]
check("all text in reading cards / tiles / log rows goes through esc()", not raw, str(raw[:3]))
# 4 Signature guard: the same state does not rebuild the DOM
check("aiRender has a signature guard (signature covers the HTML and the why text)", "if(el.dataset.sig===sig)return;" in AI and "const sig=h+'\\u0000'+whys;" in AI)
check("one run asks for ~20 readings but redraws once (aiRenderSoon debounce)", "setTimeout(aiRender,120)" in AI)
# 6 Review fixes: no readings from the previous plan on error / invalid text / unfinished run; the badge's source comes from this plan's readings
check("negative: aiReadings uses the same test as engPanel3 (a stale EP.sum kept after a run() error is not used for the cards)",
      "if(aiState(EP)!=='ok'" in body("aiReadings", AI) and "ep.runErr&&!ep.busy?'err'" in AI)
check("aiRender draws by state: if not ok, only a one-line note matching the panel + the call log",
      "aiHTML(rd,st)" in body("aiRender", AI) and "if(st&&st!=='ok')" in body("aiHTML", AI))
check("EN/ZH: panel title and log title both present", "L('AI road users · what each one read','AI 路人 · 各自读到了什么')" in AI and "L(`AI call log (${n})`,`AI 调用日志（${n}）`)" in AI)

# 7 Four tiles (30 Sep, @unicornnnnnny: the panel on the right was easy to miss → 2 × 2 tiles; clicking one expands its detail card)
ah = body("aiHTML", AI)
check("the four road-user types are drawn as 2 × 2 tiles (aiTileHTML); the opened one gets its full card below the tiles (aiPersonaHTML)",
      "TYPES4.map(t=>aiTileHTML(t,ps[t],t===sel,!noAdv))" in ah and "aiPersonaHTML(sel,ps[sel])" in ah and ".ai-tiles{display:grid;grid-template-columns:1fr 1fr" in (HERE.parent / "src" / "styles.css").read_text(encoding="utf-8"))
rr = body("aiRender", AI)
check("clicking a tile toggles AI.sel (click again to close) and scrolls the card into view after redraw; the signature includes the selection (.on in the HTML)",
      "AI.sel=AI.sel===x.dataset.aip?'':x.dataset.aip;aiRender();" in rr and "scrollIntoView" in rr and "class=\"metric ai-tile${sel?' on':''}\"" in AI)
GLASS = (HERE.parent / "src" / "js" / "7-glass.js").read_text(encoding="utf-8")
check("the AI road-users panel is expanded by default in compact mode (SEC_KEEP includes #aiBox)", "#aiBox" in re.search(r"const SEC_KEEP='([^']*)'", GLASS).group(1))

node = shutil.which("node")
if not node:
    check("node found (the pure-function assertions run under node)", False)
else:
    try:
        r = subprocess.run([node, str(HERE / "ai_glue.mjs")], capture_output=True, text=True, encoding="utf-8", timeout=120)
        out, rc = r.stdout + r.stderr, r.returncode
    except subprocess.TimeoutExpired:
        out, rc = "❌ ai_glue.mjs did not finish within 120 s\n", 1
    f0 = failed
    for line in out.splitlines():
        if line.startswith("✅"):
            passed += 1
            print(line)
        elif line.startswith("❌"):
            failed += 1
            print(line)
    if rc != 0 and failed == f0:
        failed += 1
        print(f"❌ ai_glue.mjs exit code {rc}")
        print("\n".join(out.splitlines()[-15:]))
print(f"{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
