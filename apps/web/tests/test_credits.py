"""Data-source attribution: the OSM (ODbL), DataVic (CC BY 4.0) and City of Melbourne (CC BY) licences all require attribution, and judges may ask about it.

Usage: python3 apps/web/tests/test_credits.py
The last line is always "N passed, M failed"; any failure exits with code 1.
"""
import json
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import build  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
APP = (SRC / "js" / "5-app.js").read_text(encoding="utf-8")
CMP = (SRC / "js" / "8-compare.js").read_text(encoding="utf-8")
BODY = (SRC / "body.html").read_text(encoding="utf-8")
CSS = (SRC / "styles.css").read_text(encoding="utf-8")
PAGE, _ = build.bundle()
DATA = ROOT.parent / "roads" / "public" / "cbd"

passed = failed = 0


def check(name, ok, detail=""):
    global passed, failed
    if ok:
        passed += 1
        print(f"✅ {name}")
    else:
        failed += 1
        print(f"❌ {name}{(': ' + detail) if detail else ''}")


credits = APP[APP.index("const CREDITS=["):APP.index("function creditLines()")]

# 1. The two required lines (named by the team lead on 29 Sep)
check("page has \"© OpenStreetMap contributors\", linked to openstreetmap.org/copyright",
      "© OpenStreetMap contributors" in credits and "https://www.openstreetmap.org/copyright" in credits)
check("page has the DataVic SCATS attribution (Traffic Signal Volume Data, CC BY 4.0, linked to the dataset page)",
      "SCATS" in credits and "Traffic Signal Volume Data" in credits and "CC BY 4.0" in credits
      and "https://discover.data.vic.gov.au/dataset/traffic-signal-volume-data" in credits)

# 2. Every source recorded in the data files appears in the credits (goes red if new data is added without attribution)
KEYS = ["OpenStreetMap", "OpenMapTiles", "Traffic Signal Volume Data", "Victorian traffic signals", "PTV GTFS", "City of Melbourne"]
missing = []
for f in sorted(DATA.glob("*.json")):
    if f.name == "equipment.json":  # equipment: RPM Hire product pages + assumed day rates, stated in the execution pack; not an open-data licence
        continue
    try:
        srcs = json.loads(f.read_text(encoding="utf-8")).get("sources") or []
    except Exception:
        continue
    for s in srcs if isinstance(srcs, list) else []:
        key = next((k for k in KEYS if k.lower() in s.lower()), None)
        if key is None or key not in credits:
            missing.append(f"{f.name}: {s}")
check(f"every source recorded in apps/roads/public/cbd/*.json is in the credits", not missing, "; ".join(missing[:4]))

# 3. Placement
check("page footer: #credits is filled by renderCredits() in the current language, redrawn on start-up and on language switch",
      'id="credits"' in BODY and APP.count("renderCredits();") >= 2)
check("desktop: centred below the visible map area (between --safe-l and --safe-r), no glass frame; phone: the last row of the page",
      re.search(r"\.credits\{position:fixed;z-index:4;left:calc\(var\(--safe-l\) \+ \(100vw - var\(--safe-l\) - var\(--safe-r\)\)/2\);transform:translateX\(-50%\);bottom:calc\(var\(--safe-b\)", CSS) is not None
      and '<div class="credits" id="credits"' in BODY
      and ".credits{grid-area:credits;padding:12px 16px 20px;" in CSS and 'grid-template-areas:"top" "map" "time" "panel" "credits"' in CSS)
check("execution pack print page: a \"Data sources\" section above the footer", "<section class=\"pd-src\"><h2>${esc(L('Data sources','数据来源'))}</h2>" in CMP and "credits:creditLines()" in CMP)
check("copied execution-pack text ends with the data sources", "packText(p,lang)+`\\n\\n${L('Data sources','数据来源')}\\n`+creditLines()" in CMP)
check("response playbook (copied in step 4) ends with the data sources", APP.count("creditLines().map(s=>'- '+s)") >= 2)
check("every credit line has an English and a Chinese version", credits.count("short:[") == credits.count("full:[") == 5)

print(f"{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
