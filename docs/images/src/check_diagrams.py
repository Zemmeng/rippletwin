#!/usr/bin/env python3
"""Render-check the diagrams written by gen_diagrams.py.

For each of the four SVG files this script:
  1. checks the file is under 300 KB and self-contained: no scripts, no
     <image>, <foreignObject> or style sheets, and no URL other than the SVG
     namespace;
  2. renders it to PNG with headless Chrome, inside an <img> tag on GitHub's
     light (#ffffff) or dark (#0d1117) page colour, which is how GitHub shows
     an SVG in a README;
  3. measures every text element in Chrome, once with the declared system
     font stack and once forced to Arial, and reports text that comes closer
     than 12 px to the side of its box, text that leaves its box, labels that
     overlap a box or another label, and edges that run through text.

Pure Python 3.9 standard library plus Google Chrome (or Chromium).

Usage:  python3 docs/images/src/check_diagrams.py [--dir DIR] [--png DIR] [--chrome PATH]
Exit status is 0 when every check passes. Open the PNGs and look at them as well:
the geometry checks cannot judge alignment or colour.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

NAMES = ["architecture-light", "architecture-dark", "evaluation-flow-light", "evaluation-flow-dark"]
MAX_BYTES = 300 * 1024
MIN_PAD = 12
CHROME_CANDIDATES = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "google-chrome", "google-chrome-stable", "chromium", "chromium-browser",
]

# Runs inside Chrome on an inline copy of the SVG and writes a JSON report into <pre id="out">.
MEASURE_JS = r"""
const MIN_PAD = %(min_pad)d;
function box(el) { const b = el.getBBox(); return {x: b.x, y: b.y, r: b.x + b.width, b: b.y + b.height}; }
function hit(a, b, m) { return a.x < b.r - m && b.x < a.r - m && a.y < b.b - m && b.y < a.b - m; }
function label(t) { return JSON.stringify(t.textContent.slice(0, 60)); }
function measure(svg) {
  const out = [];
  let minPad = Infinity;
  // 1. text inside a node or group keeps MIN_PAD to the sides of its own rectangle
  for (const g of svg.querySelectorAll('g.node, g.group')) {
    const rect = g.querySelector('rect');
    const R = box(rect);
    for (const t of g.querySelectorAll('text')) {
      const T = box(t);
      minPad = Math.min(minPad, T.x - R.x, R.r - T.r);
      if (T.x < R.x + MIN_PAD - 0.5 || T.r > R.r - MIN_PAD + 0.5)
        out.push('padding < ' + MIN_PAD + ' px: ' + label(t) + ' left ' + (T.x - R.x).toFixed(1) + ', right ' + (R.r - T.r).toFixed(1));
      if (T.y < R.y + 2 || T.b > R.b - 2)
        out.push('text leaves its box vertically: ' + label(t));
    }
  }
  // 2. free labels: no overlap with any node and with each other
  const nodes = [...svg.querySelectorAll('g.node')].map(g => [g, box(g.querySelector('rect'))]);
  const free = [...svg.querySelectorAll(':scope > text')];
  for (const t of free) {
    const T = box(t);
    for (const [g, R] of nodes) if (hit(T, R, 0)) out.push('label overlaps a box: ' + label(t));
  }
  for (let i = 0; i < free.length; i++) for (let j = i + 1; j < free.length; j++)
    if (hit(box(free[i]), box(free[j]), 0)) out.push('labels overlap: ' + label(free[i]) + ' / ' + label(free[j]));
  // 3. edges never run through text (sampled every 2 px, text box grown by 1 px)
  const texts = [...svg.querySelectorAll('text')].map(t => [t, box(t)]);
  for (const p of svg.querySelectorAll('path.edge')) {
    const len = p.getTotalLength();
    const seen = new Set();
    for (let s = 0; s <= len; s += 2) {
      const q = p.getPointAtLength(s);
      for (const [t, T] of texts) {
        if (!seen.has(t) && q.x > T.x - 1 && q.x < T.r + 1 && q.y > T.y - 1 && q.y < T.b + 1) {
          seen.add(t); out.push('edge crosses text: ' + label(t));
        }
      }
    }
  }
  // 4. everything stays on the canvas
  const W = svg.viewBox.baseVal.width, H = svg.viewBox.baseVal.height;
  for (const t of svg.querySelectorAll('text')) {
    const T = box(t);
    if (T.x < 0 || T.y < 0 || T.r > W || T.b > H) out.push('text outside the canvas: ' + label(t));
  }
  return {problems: out, minPad: minPad, texts: svg.querySelectorAll('text').length};
}
const svg = document.querySelector('svg');
const report = {system: measure(svg)};
svg.setAttribute('font-family', 'Arial');
report.arial = measure(svg);
document.getElementById('out').textContent = JSON.stringify(report);
"""


def find_chrome(explicit):
    for c in ([explicit] if explicit else []) + CHROME_CANDIDATES:
        if os.path.isfile(c) or shutil.which(c):
            return c if os.path.isfile(c) else shutil.which(c)
    sys.exit("Chrome or Chromium not found; pass --chrome PATH")


def static_checks(path, text):
    problems = []
    size = os.path.getsize(path)
    if size >= MAX_BYTES:
        problems.append("file is %d bytes (limit %d)" % (size, MAX_BYTES))
    urls = [u for u in re.findall(r"https?://[^\s\"'<>)]+", text) if u != "http://www.w3.org/2000/svg"]
    if urls:
        problems.append("external references: %s" % ", ".join(sorted(set(urls))))
    for tag in ("<script", "<image", "<foreignObject", "<style", "@import", "href="):
        if tag in text:
            problems.append("contains %s" % tag)
    for tag in ("<title", "<desc"):
        if tag not in text:
            problems.append("missing %s>" % tag)
    return problems, size


def run_chrome(chrome, args, timeout=60):
    return subprocess.run([chrome, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                           "--no-first-run", "--no-default-browser-check"] + args,
                          capture_output=True, text=True, timeout=timeout)


def main(argv=None):
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dir", default=os.path.dirname(here), help="folder with the SVG files (default: docs/images)")
    ap.add_argument("--png", default=None, help="where to write PNG renders (default: a temporary folder)")
    ap.add_argument("--chrome", default=os.environ.get("CHROME"), help="path to Chrome or Chromium")
    args = ap.parse_args(argv)
    chrome = find_chrome(args.chrome)
    png_dir = args.png or tempfile.mkdtemp(prefix="diagrams-")
    os.makedirs(png_dir, exist_ok=True)
    work = tempfile.mkdtemp(prefix="diagram-check-")
    failed = 0
    for name in NAMES:
        path = os.path.join(os.path.abspath(args.dir), name + ".svg")
        with open(path, encoding="utf-8") as f:
            text = f.read()
        problems, size = static_checks(path, text)
        m = re.search(r'<svg[^>]* width="(\d+)" height="(\d+)"', text)
        w, h = int(m.group(1)), int(m.group(2))
        page = "#0d1117" if name.endswith("-dark") else "#ffffff"

        # PNG render through <img>, as on GitHub
        html = os.path.join(work, name + "-img.html")
        with open(html, "w", encoding="utf-8") as f:
            f.write('<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:%s}'
                    'img{display:block}</style><img src="file://%s" width="%d" height="%d">' % (page, path, w, h))
        png = os.path.join(png_dir, name + ".png")
        r = run_chrome(chrome, ["--window-size=%d,%d" % (w, h), "--screenshot=" + png, "file://" + html])
        if not os.path.isfile(png):
            problems.append("render failed: %s" % r.stderr.strip()[-300:])

        # geometry check on an inline copy
        html = os.path.join(work, name + "-measure.html")
        svg_inline = re.sub(r"^<\?xml[^>]*>\s*", "", text)
        with open(html, "w", encoding="utf-8") as f:
            f.write('<!doctype html><meta charset="utf-8"><body style="margin:0">%s<pre id="out"></pre>'
                    '<script>%s</script>' % (svg_inline, MEASURE_JS % {"min_pad": MIN_PAD}))
        r = run_chrome(chrome, ["--window-size=%d,%d" % (w, h), "--virtual-time-budget=3000", "--dump-dom",
                                "file://" + html])
        m = re.search(r'<pre id="out">(.*?)</pre>', r.stdout, re.S)
        stats = "geometry not measured"
        if not m or not m.group(1).strip():
            problems.append("geometry check did not run: %s" % r.stderr.strip()[-300:])
        else:
            rep = json.loads(m.group(1).replace("&quot;", '"').replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&"))
            for font, r in rep.items():
                problems += ["[%s] %s" % (font, s) for s in r["problems"]]
            stats = "%d texts, min padding %.1f px (system font) / %.1f px (Arial)" % (
                rep["system"]["texts"], rep["system"]["minPad"], rep["arial"]["minPad"])

        status = "ok" if not problems else "FAIL"
        print("%-24s %-4s %6.1f KB  %dx%d  %s" % (name, status, size / 1024.0, w, h, png))
        print("    " + stats)
        for p in problems:
            print("    - " + p)
        failed += bool(problems)
    shutil.rmtree(work, ignore_errors=True)
    print("%d of %d diagrams pass" % (len(NAMES) - failed, len(NAMES)))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
