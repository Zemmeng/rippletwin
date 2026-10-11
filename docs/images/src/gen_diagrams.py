#!/usr/bin/env python3
"""Generate the RippleTwin diagrams as light and dark SVG files.

Writes four files to docs/images/ (the parent folder of this script):
  architecture-light.svg      architecture-dark.svg
  evaluation-flow-light.svg   evaluation-flow-dark.svg

Pure Python 3.9 standard library. The SVGs use only system fonts and contain no
external resources and no scripts, so GitHub can show them through <img>.

Text is measured with Helvetica/Arial advance widths times a safety factor
(system UI fonts such as SF Pro run a few per cent wider than Arial). The script
stops with an error if a line would come closer than PAD_X to the side of its
box, if a label would leave the free space it was given, or if a text colour
falls below WCAG AA contrast (4.5:1) on its background. Run check_diagrams.py
afterwards for the rendered check in Chrome.

Usage:  python3 docs/images/src/gen_diagrams.py [--out DIR]
"""

import argparse
import os
import sys
from xml.sax.saxutils import escape

W = 1600            # canvas width of both diagrams
FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"
SAFETY = 1.10       # margin over Arial metrics for wider UI fonts
PAD_X = 16          # horizontal text padding inside boxes (check_diagrams.py requires >= 12)

# Advance widths in 1/1000 em for ASCII 32..126 (Helvetica AFM; Arial is metric-compatible).
_REG = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
        556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
        1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
        667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
        333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
        556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584]
_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
         556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
         975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
         667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
         333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
         611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584]
_EXTRA = {"→": 1000, "·": 333, "—": 1000, "–": 556, "×": 584,
          "…": 1000, "’": 278, "‘": 278, "≤": 584, "≥": 584}   # anything else (CJK) counts as 1 em


def text_width(s, size, bold=False, spacing=0.0):
    """Conservative rendered width of one line of text in px."""
    table = _BOLD if bold else _REG
    units = 0
    for ch in s:
        o = ord(ch)
        units += table[o - 32] if 32 <= o <= 126 else _EXTRA.get(ch, 1000)
    return units * size / 1000.0 * SAFETY + spacing * len(s)


def wrap(s, size, max_w, bold=False):
    """Greedy word wrap; raises if a single word cannot fit."""
    lines, cur = [], ""
    for w in s.split(" "):
        trial = w if not cur else cur + " " + w
        if text_width(trial, size, bold) <= max_w:
            cur = trial
            continue
        if not cur or text_width(w, size, bold) > max_w:
            raise ValueError("word too wide for %dpx: %r" % (max_w, w))
        lines.append(cur)
        cur = w
    if cur:
        lines.append(cur)
    return lines


def fits(s, size, max_w, bold=False, what="text"):
    if text_width(s, size, bold) > max_w:
        raise ValueError("%s too wide for %.0f px: %r" % (what, max_w, s))


# --------------------------------------------------------------------------- colour

def _rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def blend(fg, bg, a):
    """Solid colour of fg at opacity a over bg."""
    f, b = _rgb(fg), _rgb(bg)
    return "#%02x%02x%02x" % tuple(round(f[i] * a + b[i] * (1 - a)) for i in range(3))


def _lum(h):
    def ch(c):
        c = c / 255.0
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (ch(c) for c in _rgb(h))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a, b):
    la, lb = sorted((_lum(a), _lum(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


ORANGE = "#F07D1A"   # brand accent (RippleTwin logo)
TEAL = "#0E8F88"     # secondary

# page: GitHub's page colour, used only for contrast checks (the SVG background is transparent)
THEMES = {
    "light": {
        "page": "#ffffff", "text": "#1f2328", "muted": "#59636e",
        "group": "#f6f8fa", "group_line": "#d1d9e0", "edge": "#59636e",
        "badge_text": "#ffffff", "tint": 0.10,
        "cats": {   # name: (stroke, accent for small text and badges); fills are tints of the stroke
            "orange": (ORANGE, "#a34f09"),
            "teal": (TEAL, "#0a6f69"),
            "slate": ("#5b6f8f", "#465a78"),
            "grey": ("#8c959f", "#59636e"),
        },
    },
    "dark": {
        "page": "#0d1117", "text": "#e6edf3", "muted": "#9da7b3",
        "group": "#151b23", "group_line": "#3d444d", "edge": "#8b949e",
        "badge_text": "#0d1117", "tint": 0.16,
        "cats": {
            "orange": (ORANGE, "#f5a35c"),
            "teal": ("#17a79e", "#4fd0c6"),
            "slate": ("#8296b6", "#aebcd4"),
            "grey": ("#6e7681", "#9da7b3"),
        },
    },
}


# --------------------------------------------------------------------------- document

def _n(v):
    """Compact number formatting."""
    v = round(v, 1)
    return str(int(v)) if v == int(v) else str(v)


class Doc:
    """Collects SVG elements in paint layers and enforces text fit and contrast."""

    LAYERS = ("groups", "subgroups", "edges", "nodes", "labels")

    def __init__(self, theme):
        self.th = THEMES[theme]
        self.theme = theme
        self.layers = {k: [] for k in self.LAYERS}
        self.markers = set()

    def cat(self, name, base=None):
        stroke, accent = self.th["cats"][name]
        return {"stroke": stroke, "accent": accent, "fill": blend(stroke, base or self.th["group"], self.th["tint"])}

    def need_contrast(self, fg, bg, what=""):
        c = contrast(fg, bg)
        if c < 4.5:
            raise ValueError("%s: contrast %.2f < 4.5 (%s on %s, %s)" % (what, c, fg, bg, self.theme))

    # ---- primitives; each returns its markup and adds it to `layer` unless layer is None

    def _add(self, layer, out):
        if layer:
            self.layers[layer].append(out)
        return out

    def text(self, layer, x, y, s, size, color, bg, weight=None, anchor=None, spacing=None):
        self.need_contrast(color, bg, repr(s))
        a = 'x="%s" y="%s" font-size="%s" fill="%s"' % (_n(x), _n(y), _n(size), color)
        if weight:
            a += ' font-weight="%s"' % weight
        if anchor:
            a += ' text-anchor="%s"' % anchor
        if spacing:
            a += ' letter-spacing="%s"' % _n(spacing)
        return self._add(layer, "<text %s>%s</text>" % (a, escape(s)))

    def rich(self, layer, x, y, parts, bg):
        """One line made of (text, size, weight, colour, dx) parts."""
        out = []
        for s, size, weight, color, dx in parts:
            self.need_contrast(color, bg, repr(s))
            a = 'font-size="%s" fill="%s"' % (_n(size), color)
            if weight:
                a += ' font-weight="%s"' % weight
            if dx:
                a += ' dx="%s"' % _n(dx)
            out.append("<tspan %s>%s</tspan>" % (a, escape(s)))
        return self._add(layer, '<text x="%s" y="%s">%s</text>' % (_n(x), _n(y), "".join(out)))

    def marker(self, color):
        mid = "arrow-" + color.lstrip("#")
        self.markers.add((mid, color))
        return mid

    def path(self, pts, color=None, dashed=False, arrow=True, layer="edges"):
        color = color or self.th["edge"]
        d = "M" + " L".join("%s %s" % (_n(x), _n(y)) for x, y in pts)
        a = 'class="edge" d="%s" fill="none" stroke="%s" stroke-width="1.5" stroke-linejoin="round"' % (d, color)
        if dashed:
            a += ' stroke-dasharray="6 5"'
        if arrow:
            a += ' marker-end="url(#%s)"' % self.marker(color)
        return self._add(layer, "<path %s/>" % a)

    def arrow(self, pts, **kw):
        """Polyline ending in an arrowhead whose tip touches the last point."""
        (x1, y1), (x2, y2) = pts[-2], pts[-1]
        dx, dy = x2 - x1, y2 - y1
        n = (dx * dx + dy * dy) ** 0.5
        pts = list(pts[:-1]) + [(x2 - 3 * dx / n, y2 - 3 * dy / n)]   # the marker tip sits 3 px past the end
        return self.path(pts, **kw)

    def dot(self, x, y):
        self.layers["edges"].append('<circle cx="%s" cy="%s" r="3.5" fill="%s"/>' % (_n(x), _n(y), self.th["edge"]))

    def group(self, x, y, w, h, label, dashed=False, line=None, layer="groups"):
        """A container with a small-caps label in its top-left corner."""
        th = self.th
        fits(label, 12, w - 2 * 20, True, "group label")
        self.need_contrast(th["muted"], th["group"], "group label " + label)
        dash = ' stroke-dasharray="7 5"' if dashed else ""
        self.layers[layer].append(
            '<g class="group"><rect x="%s" y="%s" width="%s" height="%s" rx="14" fill="%s" stroke="%s" '
            'stroke-width="1.5"%s/><text x="%s" y="%s" font-size="12" font-weight="700" letter-spacing="1.2" '
            'fill="%s">%s</text></g>'
            % (_n(x), _n(y), _n(w), _n(h), th["group"], line or th["group_line"], dash, _n(x + 20), _n(y + 28),
               th["muted"], escape(label)))

    def box(self, x, y, w, h, c, dashed=False, inner="", fill=None, layer="nodes"):
        dash = ' stroke-dasharray="6 4"' if dashed else ""
        self.layers[layer].append(
            '<g class="node"><rect x="%s" y="%s" width="%s" height="%s" rx="10" fill="%s" stroke="%s" '
            'stroke-width="1.5"%s/>%s</g>' % (_n(x), _n(y), _n(w), _n(h), fill or c["fill"], c["stroke"], dash, inner))

    def tag(self, x, y, lines, base, strong=1, size=12, w=None, cat="grey", layer="labels"):
        """A small rounded note; the first `strong` lines are bold. Returns (w, h)."""
        th = self.th
        c = self.cat(cat)
        fill = blend(c["stroke"], base, 0.12)
        w = w or max(text_width(s, size, i < strong) for i, s in enumerate(lines)) + 2 * 12
        h = 12 + 16 * len(lines)
        inner = []
        for i, s in enumerate(lines):
            fits(s, size, w - 24, i < strong, "tag line")
            inner.append(self.text(None, x + 12, y + 18 + 16 * i, s, size, th["text"] if i < strong else th["muted"],
                                   fill, weight="600" if i < strong else None))
        self.layers[layer].append(
            '<g class="node"><rect x="%s" y="%s" width="%s" height="%s" rx="7" fill="%s" stroke="%s" '
            'stroke-width="1"/>%s</g>' % (_n(x), _n(y), _n(w), _n(h), fill, c["stroke"], "".join(inner)))
        return w, h

    def heading(self, title, subtitle, x=32):
        th = self.th
        fits(title, 28, W - 2 * x, True, "title")
        fits(subtitle, 15, W - 2 * x, False, "subtitle")
        self.text("labels", x, 62, title, 28, th["text"], th["page"], weight="700")
        self.text("labels", x, 94, subtitle, 15, th["muted"], th["page"])

    def legend_row(self, x, y, label, bg, cat=None, dashed=None, size=13):
        """One legend entry: a colour swatch (cat) or a line sample (dashed=True/False). Returns its width."""
        if cat:
            c = self.cat(cat, bg)
            self.layers["nodes"].append(
                '<rect x="%s" y="%s" width="22" height="16" rx="4" fill="%s" stroke="%s" stroke-width="1.5"/>'
                % (_n(x), _n(y - 12), c["fill"], c["stroke"]))
        else:
            self.arrow([(x, y - 4), (x + 24, y - 4)], dashed=dashed)
        self.text("labels", x + 32, y + 1, label, size, self.th["text"], bg)
        return 32 + text_width(label, size)

    def svg(self, height, title, desc):
        defs = "".join(
            '<marker id="%s" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="10" markerHeight="10" '
            'markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M0 1 L10 5 L0 9 Z" fill="%s"/></marker>'
            % m for m in sorted(self.markers))
        body = "\n".join(sum((self.layers[k] for k in self.LAYERS), []))
        return ('<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %d %d" role="img" '
                'aria-labelledby="title desc" font-family="%s">\n'
                '<title id="title">%s</title>\n<desc id="desc">%s</desc>\n<defs>%s</defs>\n%s\n</svg>\n'
                % (W, height, W, height, FONT.replace("'", "&apos;"), escape(title), escape(desc), defs, body))


class Node:
    """A rounded box with a title, a coloured sub-line and wrapped body paragraphs."""

    TITLE, SUB, BODY = 16, 13, 14

    @classmethod
    def rows(cls, w, title, sub=None, body=()):
        maxw = w - 2 * PAD_X
        fits(title, cls.TITLE, maxw, True, "node title")
        rows = [(title, cls.TITLE, "600", "text")]
        if sub:
            fits(sub, cls.SUB, maxw, False, "node sub-line")
            rows.append((sub, cls.SUB, None, "accent"))
        for para in body:
            rows += [(s, cls.BODY, None, "muted") for s in wrap(para, cls.BODY, maxw)]
        return rows

    @staticmethod
    def baselines(n):
        """Offsets of each row's baseline: title at 30, sub-line 19 below it, then 20 px per line."""
        return [30 + (19 if i else 0) + 20 * max(i - 1, 0) for i in range(n)]

    @classmethod
    def need(cls, w, title, sub=None, body=()):
        return cls.baselines(len(cls.rows(w, title, sub, body)))[-1] + 16

    def __init__(self, doc, x, y, w, cat, title, sub=None, body=(), dashed=False, h=None, base=None):
        self.x, self.y, self.w = x, y, w
        c = doc.cat(cat, base)
        rows = self.rows(w, title, sub, body)
        need = self.baselines(len(rows))[-1] + 16
        self.h = need if h is None else h
        if self.h < need:
            raise ValueError("box too short for %r: %d < %d" % (title, self.h, need))
        colours = {"text": doc.th["text"], "muted": doc.th["muted"], "accent": c["accent"]}
        inner = "".join(doc.text(None, x + PAD_X, y + by, s, size, colours[col], c["fill"], weight=weight)
                        for (s, size, weight, col), by in zip(rows, self.baselines(len(rows))))
        doc.box(x, y, w, self.h, c, dashed=dashed, inner=inner)

    r = property(lambda self: self.x + self.w)
    b = property(lambda self: self.y + self.h)
    cx = property(lambda self: self.x + self.w / 2)
    cy = property(lambda self: self.y + self.h / 2)


def edge_label(doc, x, y, s, lo, hi, bg, anchor="middle", size=13):
    """A short label beside an edge; it must stay inside the free span [lo, hi]."""
    w = text_width(s, size)
    left = {"middle": x - w / 2, "start": x, "end": x - w}[anchor]
    if left < lo or left + w > hi:
        raise ValueError("edge label %r (%.0f..%.0f) leaves its span %.0f..%.0f" % (s, left, left + w, lo, hi))
    doc.text("labels", x, y, s, size, doc.th["muted"], bg, anchor=None if anchor == "start" else anchor)


# --------------------------------------------------------------------------- diagram 1

def architecture(theme):
    d = Doc(theme)
    th = d.th
    M, IN, GH, GP = 32, 24, 50, 22      # margin, group padding, group header, group bottom padding
    CF_X, CF_R = M, 1290                # browser and Cloudflare groups
    EX_X, EX_R = 1330, W - M            # right strip: legend and external service
    L, R = CF_X + IN, CF_R - IN         # inner span of the two main groups

    d.heading("RippleTwin system architecture",
              "How the live demo is served and built. Dashed parts were retired after the hackathon "
              "(status: October 2026).")

    # ---- tier 1: browser
    B_Y = 132
    NY, LANE = B_Y + 72, B_Y + 54       # node top; lane above the nodes for the web -> player edge
    G = 90
    NW = (R - L - 3 * G) / 4.0
    specs = [("Web app", "apps/web", ["Zero-build single page", "6-step workbench · EN / 中文"]),
             ("Traffic engine", "apps/engine", ["Deterministic JavaScript", "Runs in the browser"]),
             ("Sign reader", "apps/api/public/js/reader.js", ["Pre-computed answers → /api/read → keyword rules"]),
             ("SUMO replay player", "apps/sumo · sumo-client.js", ["Live cloud run, or the pre-computed replay"])]
    NH = max(Node.need(NW, *s) for s in specs)
    web, eng, reader, player = [Node(d, L + i * (NW + G), NY, NW, "teal", *s, h=NH) for i, s in enumerate(specs)]

    for a, b, lab in [(web, eng, "run()"), (eng, reader, "readSigns()")]:
        d.arrow([(a.r, a.cy), (b.x, b.cy)])
        edge_label(d, (a.r + b.x) / 2, a.cy - 8, lab, a.r + 6, b.x - 6, th["group"])
    sx = web.x + web.w * 0.75
    d.arrow([(sx, NY), (sx, LANE), (player.cx, LANE), (player.cx, NY)])
    edge_label(d, reader.x - G / 2, LANE - 7, "runReal()", eng.x, reader.r, th["group"])

    # legend, top right
    items = [("teal", None, "Runs in the browser"), ("orange", None, "Runs on Cloudflare"),
             ("slate", None, "Data and state"), ("grey", None, "External service"),
             (None, False, "Request or data flow"), (None, True, "Retired after the event")]
    lg_h = 50 + 25 * len(items) - 2
    t1_h = max(NY + NH + GP - B_Y, lg_h)
    d.group(CF_X, B_Y, CF_R - CF_X, t1_h, "BROWSER")
    d.group(EX_X, B_Y, EX_R - EX_X, t1_h, "LEGEND")
    for i, (cat, dashed, s) in enumerate(items):
        fits(s, 13, EX_R - EX_X - 52 - PAD_X, False, "legend entry")
        d.legend_row(EX_X + 20, B_Y + 55 + 25 * i, s, th["group"], cat=cat, dashed=dashed)

    # ---- tier 2: Cloudflare edge Worker with its routing table
    CF_Y = B_Y + t1_h + 84
    cols = {"S": (L, 340), "U": (L + 400, 380), "A": (L + 840, 370)}    # static / SUMO / API columns
    assert cols["A"][0] + cols["A"][1] == R
    rt = ("hackathon-site Worker", "apps/site · the only public entry point",
          ["One HTTPS origin for every module, so the browser needs no CORS"])
    chip_y = CF_Y + GH + Node.need(R - L, *rt) - 4
    router = Node(d, L, CF_Y + GH, R - L, "orange", *rt, h=chip_y + 30 + 16 - CF_Y - GH)
    for key, s in [("S", "other paths → static assets"), ("U", "/api/sumo/* → SUMO binding"),
                   ("A", "/api/* → API binding")]:
        x0, w0 = cols[key]
        cw = text_width(s, 13) + 24
        cx0 = x0 + w0 / 2 - cw / 2
        inner = d.text(None, cx0 + 12, chip_y + 20, s, 13, th["text"], th["page"])
        d.layers["labels"].append(
            '<g class="node"><rect x="%s" y="%s" width="%s" height="30" rx="7" fill="%s" stroke="%s" '
            'stroke-width="1"/>%s</g>' % (_n(cx0), _n(chip_y), _n(cw), th["page"], ORANGE, inner))

    # browser -> site Worker
    gap_mid = (B_Y + t1_h + CF_Y) / 2
    for i, s in enumerate(["HTTPS", "same origin"]):
        edge_label(d, L, gap_mid - 4 + 16 * i, s, L, web.cx - 8, th["page"], anchor="start")
    for n, labs in [(web, ["GET page"]), (eng, ["GET JSON data"]), (reader, ["POST /api/read"]),
                    (player, ["/api/sumo/v1/*", "/sumo/public/real/*"])]:
        d.arrow([(n.cx, B_Y + t1_h), (n.cx, CF_Y)])
        y0 = gap_mid + 4 - 8 * (len(labs) - 1)
        for i, s in enumerate(labs):
            edge_label(d, n.cx + 10, y0 + 16 * i, s, n.cx + 6, n.cx + NW / 2 + G - 6, th["page"], anchor="start")

    # ---- tier 3: static assets, the retired SUMO service, the API Worker and its state
    T3_Y = router.b + 64
    sx0, sw0 = cols["S"]
    static = Node(d, sx0, T3_Y, sw0, "slate", "Static assets", "apps/site/out/ · built by build.mjs",
                  ["Every module's git-tracked public/ files, served at /<module>/public/",
                   "Page, scripts, CBD data, parameters, baked SUMO replays, pre-computed readings"])

    ux, uw = cols["U"]
    tw, tg_h = d.tag(ux + 12, T3_Y + 42, ["Retired after the event · baked replays served instead"], th["group"],
                     strong=0, w=uw - 24)
    sumo_w = Node(d, ux + 12, T3_Y + 42 + tg_h + 14, uw - 24, "orange", "hackathon-sumo Worker", "apps/sumo",
                  ["Path whitelist, body cap, per-IP rate limit"], dashed=True)
    cont = Node(d, ux + 12, sumo_w.b + 44, uw - 24, "orange", "Cloudflare Container", "standard-4 · one instance",
                ["Eclipse SUMO 1.27.1 behind serve.py", "Real CBD network, 08:00–09:00"], dashed=True)
    d.arrow([(sumo_w.cx, sumo_w.b), (cont.cx, cont.y)], dashed=True)
    edge_label(d, sumo_w.cx + 10, sumo_w.b + 26, "/sumo/v1/*", sumo_w.cx + 6, ux + uw - 8, th["group"], anchor="start")
    sg_b = cont.b + 14
    d.group(ux, T3_Y, uw, sg_b - T3_Y, "LIVE SUMO SERVICE", dashed=True, line=d.cat("grey")["stroke"],
            layer="subgroups")

    ax, aw = cols["A"]
    api = Node(d, ax, T3_Y, aw, "orange", "hackathon-api Worker", "apps/api",
               ["/api/read · /api/explain", "/api/worksites · /api/health"])
    SX, SW = ax + 26, aw - 26
    sy = api.b + 14
    spine = ax + 13
    c = d.cat("slate")
    for name, kind, desc in [("READINGS", "KV namespace", "Cache of LLM sign readings"),
                             ("LlmBudget", "Durable Object", "Global daily budget for LLM calls"),
                             ("WorksiteRegister", "Durable Object", "Shared register of worksites")]:
        fits(name + "  " + kind, 14, SW - 2 * PAD_X, True, "store")
        fits(desc, 13, SW - 2 * PAD_X, False, "store")
        d.box(SX, sy, SW, 58, c, inner=d.rich(None, SX + PAD_X, sy + 25, [(name, 14, "600", th["text"], 0),
                                                                        (kind, 12, None, c["accent"], 8)], c["fill"])
              + d.text(None, SX + PAD_X, sy + 44, desc, 13, th["muted"], c["fill"]))
        d.arrow([(spine, sy + 29), (SX, sy + 29)])
        last = sy
        sy += 68
    d.path([(spine, api.b), (spine, last + 29)], arrow=False)

    # site Worker -> targets
    for key, target_y, s, dashed in [("S", static.y, "ASSETS binding", False),
                                     ("U", T3_Y, "service binding", True), ("A", api.y, "service binding", False)]:
        x0, w0 = cols[key]
        d.arrow([(x0 + w0 / 2, router.b), (x0 + w0 / 2, target_y)], dashed=dashed)
        edge_label(d, x0 + w0 / 2 + 10, router.b + 36, s, x0 + w0 / 2 + 6, x0 + w0, th["group"], anchor="start")

    cf_b = max(static.b, sg_b, last + 58) + GP
    d.group(CF_X, CF_Y, CF_R - CF_X, cf_b - CF_Y, "CLOUDFLARE")

    # ---- external service, right strip
    ds = Node(d, EX_X + 16, CF_Y + GH, EX_R - EX_X - 32, "grey", "DeepSeek API", "deepseek-flash",
              ["OpenAI-compatible", "chat completions"])
    ex_b = ds.b + GP
    d.group(EX_X, CF_Y, EX_R - EX_X, ex_b - CF_Y, "EXTERNAL")
    xe = EX_X + 40
    d.arrow([(api.r, api.y + 40), (xe, api.y + 40), (xe, ds.b)], dashed=True)
    tw, tg_h = d.tag(xe + 14, ex_b + 14, ["API key removed", "after the event", "→ rule fallback"], th["page"],
                     strong=2)
    if xe + 14 + tw > EX_R or ex_b + 14 + tg_h > api.y + 40 - 12:
        raise ValueError("DeepSeek tag does not fit")
    edge_label(d, xe - 8, ex_b + 32, "HTTPS", CF_R + 4, xe - 4, th["page"], anchor="end")

    # ---- tier 4: offline build
    band_y = cf_b + 76
    py = band_y + GH
    c = d.cat("slate")
    col1 = ["OpenStreetMap", "DataVic SCATS signal volumes", "PTV GTFS tram and bus timetables",
            "OpenFreeMap vector tiles"]
    col2 = ["City of Melbourne pedestrian counts", "City of Melbourne buildings",
            "Open-Meteo weather (back-test)", "Hire equipment list (assumed)"]
    c1w = max(text_width(s, 14) for s in col1)
    c2w = max(text_width(s, 14) for s in col2)
    pipe_w = PAD_X + c1w + 28 + c2w + PAD_X
    pipe_h = 30 + 19 + 20 * len(col1) + 16
    px = L
    inner = [d.text(None, px + PAD_X, py + 30, "Offline data pipeline", 16, th["text"], c["fill"], weight="600"),
             d.text(None, px + PAD_X, py + 49, "apps/roads · Python, re-runnable", 13, c["accent"], c["fill"])]
    for col, cx0 in [(col1, px + PAD_X), (col2, px + PAD_X + c1w + 28)]:
        inner += [d.text(None, cx0, py + 69 + 20 * i, s, 14, th["muted"], c["fill"]) for i, s in enumerate(col)]
    d.box(px, py, pipe_w, pipe_h, c, inner="".join(inner))
    pipe_r = px + pipe_w

    sj = Node(d, pipe_r + 72, py, 360, "slate", "Static JSON", "Committed to git",
              ["apps/roads/public/cbd/*.json · 11 files", "apps/params/public/params.json · hand-curated"], h=pipe_h)
    art = Node(d, sj.r + 64, py, W - M - IN - (sj.r + 64), "slate", "Pre-computed artefacts", "Made during the event",
               ["apps/sumo/public/real/ · baked SUMO replays, seed 42",
                "apps/api/public/answers/demo.json · 92 LLM sign readings"], h=pipe_h)
    band_h = GH + pipe_h + GP
    d.group(M, band_y, W - 2 * M, band_h, "OFFLINE · BUILD TIME")
    d.arrow([(pipe_r, py + pipe_h / 2), (sj.x, py + pipe_h / 2)])
    edge_label(d, (pipe_r + sj.x) / 2, py + pipe_h / 2 - 8, "build", pipe_r + 4, sj.x - 4, th["group"])

    # bus: both outputs become the site Worker's static assets
    bus_y = cf_b + 38
    d.arrow([(sj.cx, sj.y), (sj.cx, bus_y), (static.cx, bus_y), (static.cx, static.b)])
    d.path([(art.cx, art.y), (art.cx, bus_y), (sj.cx, bus_y)], arrow=False)
    d.dot(sj.cx, bus_y)
    edge_label(d, static.cx + 14, bus_y - 9, "build time · git-tracked public/ files are deployed as static assets",
               static.cx + 6, sj.cx - 6, th["page"], anchor="start")

    height = band_y + band_h + M
    desc = ("Four browser modules (web app, traffic engine, sign reader and SUMO replay player) send every request "
            "over same-origin HTTPS to one Cloudflare Worker, hackathon-site. It serves each module's public files "
            "as static assets, sends /api/* through a service binding to the hackathon-api Worker (KV cache "
            "READINGS, Durable Objects LlmBudget and WorksiteRegister) and sends /api/sumo/* to the hackathon-sumo "
            "Worker and its Cloudflare Container running Eclipse SUMO 1.27.1. The SUMO service was retired after "
            "the event and baked replays are served instead. The API Worker called the DeepSeek API until its key "
            "was removed after the event; sign reading now falls back to keyword rules. An offline Python pipeline "
            "(apps/roads) turns open data into static JSON, which is deployed with the pre-computed SUMO replays "
            "and 92 pre-computed LLM sign readings.")
    return d.svg(int(height), "RippleTwin system architecture", desc)


# --------------------------------------------------------------------------- diagram 2

FLOW_CATS = {"ai": "orange", "engine": "teal", "sim": "slate", "io": "grey"}


def card_layout(w, title, body, chips):
    """Rows of a flow card as (kind, text, y offset), and the height the card needs."""
    tmax = w - PAD_X - 62
    out = []
    tl = wrap(title, 16, tmax, bold=True)
    if len(tl) > 2:
        raise ValueError("title wraps to more than two lines: " + title)
    out += [("title", s, 52 + 20 * i) for i, s in enumerate(tl)]
    by = 104
    for p in body:                      # a string is a paragraph; a list is a tight list of short lines
        for item in ([p] if isinstance(p, str) else p):
            for s in wrap(item, 14, w - 2 * PAD_X):
                out.append(("body", s, by))
                by += 20
        by += 6
    for cat, s in chips:
        lines = wrap(s, 12, w - 2 * PAD_X - 24)
        h = 12 + 16 * len(lines)
        out.append(("chip", (cat, lines, h), by))
        by += h + 8
    return out, by - 6 + 12


def flow_card(d, x, y, w, h, kind, num, kicker, title, body, chips=()):
    th = d.th
    c = d.cat(FLOW_CATS[kind], th["page"])
    rows, need = card_layout(w, title, body, chips)
    if need > h:
        raise ValueError("card %r needs %d px, has %d" % (title, need, h))
    inner = []
    tx = x + (62 if num else PAD_X)
    if num:
        badge = c["accent"] if d.theme == "light" else c["stroke"]
        d.need_contrast(th["badge_text"], badge, "badge")
        inner.append('<circle cx="%s" cy="%s" r="17" fill="%s"/>' % (_n(x + 33), _n(y + 44), badge))
        inner.append('<text x="%s" y="%s" font-size="16" font-weight="700" fill="%s" text-anchor="middle">%s</text>'
                     % (_n(x + 33), _n(y + 50), th["badge_text"], num))
    fits(kicker, 11, x + w - PAD_X - tx - 11, True, "kicker")
    inner.append(d.text(None, tx, y + 30, kicker, 11, c["accent"], c["fill"], weight="700", spacing=1))
    for k, s, oy in rows:
        if k == "title":
            inner.append(d.text(None, tx, y + oy, s, 16, th["text"], c["fill"], weight="600"))
        elif k == "body":
            inner.append(d.text(None, x + PAD_X, y + oy, s, 14, th["muted"], c["fill"]))
        else:
            cat, lines, ch = s
            cc = d.cat(cat, c["fill"])
            fill = blend(cc["stroke"], c["fill"], 0.14)
            inner.append('<g class="node"><rect x="%s" y="%s" width="%s" height="%s" rx="7" fill="%s" stroke="%s" '
                         'stroke-width="1"/>' % (_n(x + PAD_X), _n(y + oy - 2), _n(w - 2 * PAD_X), _n(ch), fill,
                                                 cc["stroke"]))
            inner += [d.text(None, x + PAD_X + 12, y + oy + 16 + 16 * i, ln, 12, th["text"], fill)
                      for i, ln in enumerate(lines)]
            inner.append("</g>")
    d.box(x, y, w, h, c, inner="".join(inner))


def evaluation_flow(theme):
    d = Doc(theme)
    th = d.th
    M = 40
    CW = 262
    GAP = (W - 2 * M - 5 * CW) / 4.0
    col = [M + i * (CW + GAP) for i in range(5)]

    d.heading("How a works plan is evaluated",
              "From a works plan to a one-page execution pack, on Melbourne's real CBD road network. The AI only "
              "reads signs; the numbers come from the deterministic engine and SUMO.", x=M)

    after = "grey"
    row1 = [
        ("io", None, "INPUT", "Works plan",
         ["Closed lanes and footpaths", "Dates and working hours", "Signs and VMS text"], ()),
        ("engine", 1, "ENGINE", "Affected traffic & named detours",
         ["The approach and up to three detours, named after their streets",
          "Real 1,513-link CBD network with SCATS flows"], ()),
        ("ai", 2, "AI", "Sign reading per persona",
         ["Commuter, local, tourist, delivery",
          "Noticed? Understood? Trusted? Which road?",
          "LLM or keyword rules, cached"],
         [(after, "Since the event: 92 pre-computed LLM readings, other wording by keyword rules")]),
        ("engine", 3, "ENGINE", "Route choice",
         ["Two-group logit: informed and uninformed drivers",
          "Two-point calibration: a warning-only sign diverts 3%, a sign naming the detour 20%"], ()),
        ("engine", 4, "ENGINE", "Assignment",
         ["BPR link times + D/D/1 queues",
          "6 MSA iterations feed queues back into route choice"], ()),
    ]
    row2 = [  # drawn right to left: step 5 sits under step 4
        ("engine", 5, "ENGINE", "Impacts",
         ["Queue, delay per vehicle and vehicle-minutes, against the same hour without works",
          "Tram and bus riders, pedestrians",
          "Clash with nearby works"], ()),
        ("sim", 6, "SIMULATION", "Micro-simulation cross-check",
         ["Eclipse SUMO on the real network, 08:00–09:00, for the covered plan",
          "Input: the engine's detour share p",
          "A cross-check, not proof: signal timing and turn shares are assumed"],
         [(after, "Since the event: pre-computed replay, seed 42")]),
        ("engine", 7, "ENGINE + RULES", "Compare plans",
         [["A Minimum: no VMS", "B Standard: 2 VMS show delay", "C Guided: 1 VMS names detour"],
          "Kits drawn from limited hire stock; hire cost assumed",
          "Rule-based advisor suggests up to three fixes"],
         [("orange", "Any AI summary may only quote engine numbers")]),
        ("io", None, "OUTPUT", "Export one-page pack",
         ["Chosen plan and the reason", "Hire quote and stock check", "VMS schedule, set-up checks, who to notify"],
         ()),
    ]
    h1 = max(card_layout(CW, t, b, ch)[1] for _, _, _, t, b, ch in row1)
    h2 = max(card_layout(CW, t, b, ch)[1] for _, _, _, t, b, ch in row2)
    y1 = 140
    y2 = y1 + h1 + 96
    for i, card in enumerate(row1):
        flow_card(d, col[i], y1, CW, h1, *card)
    for i, card in enumerate(row2):
        flow_card(d, col[4 - i], y2, CW, h2, *card)

    ay1, ay2 = y1 + 44, y2 + 44
    for i in range(4):
        d.arrow([(col[i] + CW, ay1), (col[i + 1], ay1)])
    for i in range(4, 1, -1):
        d.arrow([(col[i], ay2), (col[i - 1] + CW, ay2)])
    d.arrow([(col[4] + CW / 2, y1 + h1), (col[4] + CW / 2, y2)])       # step 4 -> step 5

    # queue feedback 4 -> 3
    fy = y1 + h1 + 28
    xa, xb = col[4] + 44, col[3] + CW - 44
    d.arrow([(xa, y1 + h1), (xa, fy), (xb, fy), (xb, y1 + h1)], dashed=True)
    edge_label(d, (xa + xb) / 2, fy + 20, "queue feedback", col[3] + CW / 2 + 8, col[4] + CW / 2 - 8, th["page"])
    # every kit and advisor fix goes through the engine again
    gy = y1 + h1 + 62
    x7, x0 = col[2] + CW / 2, col[0] + CW / 2
    d.arrow([(x7, y2), (x7, gy), (x0, gy), (x0, y1 + h1)], dashed=True)
    edge_label(d, (x0 + x7) / 2, gy - 10, "each kit and advisor fix is re-run through steps 1–5", x0 + 8, x7 - 8,
               th["page"])

    # callout in the free cell
    cx, cy, cw, chh = col[0], y2, CW, h2
    fill = blend(ORANGE, th["page"], 0.07 if theme == "light" else 0.10)
    inner = ['<rect x="%s" y="%s" width="%s" height="%s" rx="10" fill="%s"/>' % (_n(cx), _n(cy), _n(cw), _n(chh), fill),
             '<rect x="%s" y="%s" width="5" height="%s" rx="2.5" fill="%s"/>' % (_n(cx), _n(cy), _n(chh), ORANGE)]
    tx, tmax = cx + PAD_X + 6, cw - 2 * PAD_X - 6
    yy = cy + 40
    for s in ["AI interprets —", "the engine calculates"]:
        fits(s, 19, tmax, True, "callout title")
        inner.append(d.text(None, tx, yy, s, 19, th["text"], fill, weight="700"))
        yy += 25
    yy += 10
    for p in ["The LLM only says how each road user reads a sign: noticed, understood, trusted, which road.",
              "Route shares, queues and delays are computed by the engine, which is deterministic: the same plan "
              "and readings always give the same numbers."]:
        for s in wrap(p, 14, tmax):
            inner.append(d.text(None, tx, yy, s, 14, th["muted"], fill))
            yy += 20
        yy += 8
    if yy - 8 > cy + chh - 6:
        raise ValueError("callout overflow")
    d.layers["nodes"].append('<g class="node">' + "".join(inner) + "</g>")

    # legend
    ly = y2 + h2 + 46
    x = M
    for cat, s in [("orange", "AI (LLM, keyword-rule fallback)"), ("teal", "Deterministic engine"),
                   ("slate", "Micro-simulation (SUMO)"), ("grey", "Input, output and post-event notes")]:
        x += d.legend_row(x, ly, s, th["page"], cat=cat, size=14) + 40
    x += d.legend_row(x, ly, "Feedback loop", th["page"], dashed=True, size=14)
    if x > W - M:
        raise ValueError("legend too wide")

    desc = ("Pipeline from a works plan to a one-page execution pack. Input: closed lanes and footpaths, dates and "
            "hours, signs and VMS text. Step 1, engine: affected traffic and up to three named detours on the real "
            "1,513-link CBD network. Step 2, AI: each persona (commuter, local, tourist, delivery) reads the signs, "
            "by LLM or keyword rules, cached. Step 3, engine: two-group logit route choice calibrated at two points, "
            "3% for a warning-only sign and 20% for a sign naming the detour. Step 4, engine: assignment with BPR "
            "link times and D/D/1 queues over 6 MSA iterations that feed queues back into route choice. Step 5, "
            "engine: impacts on queues, delay per vehicle, vehicle-minutes, tram and bus riders, pedestrians and "
            "clashes with nearby works. Step 6, simulation: Eclipse SUMO cross-check on the real network using the "
            "engine's detour share. Step 7: compare plans A Minimum, B Standard and C Guided, built from limited "
            "hire stock with assumed hire cost, plus a rule-based advisor; each kit and fix is re-run through "
            "steps 1 to 5. Output: a one-page pack. The AI interprets signs; the engine calculates.")
    return d.svg(int(ly + 34), "How a works plan is evaluated", desc)


# --------------------------------------------------------------------------- main

def main(argv=None):
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", default=os.path.dirname(here), help="output folder (default: docs/images)")
    args = ap.parse_args(argv)
    os.makedirs(args.out, exist_ok=True)
    for name, fn in [("architecture", architecture), ("evaluation-flow", evaluation_flow)]:
        for theme in ("light", "dark"):
            svg = fn(theme)
            path = os.path.join(args.out, "%s-%s.svg" % (name, theme))
            with open(path, "w", encoding="utf-8", newline="\n") as f:
                f.write(svg)
            print("wrote %s (%d bytes)" % (path, len(svg.encode("utf-8"))))
    return 0


if __name__ == "__main__":
    sys.exit(main())
