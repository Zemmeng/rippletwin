#!/usr/bin/env python3
"""Generate RippleTwin architecture SVG (1920x1080), all text editable.

Usage: python3 gen_arch.py OUT.svg [--test] [--fallback]
  --test      add data-c="<container>" on every text for overflow checks
  --fallback  put Georgia / Arial first to test worst-case widths
"""
import sys
from xml.sax.saxutils import escape

TEST = "--test" in sys.argv
FALLBACK = "--fallback" in sys.argv
OUT = sys.argv[1]

W, H = 1920, 1080

BG = "#FAF8F3"
INK = "#0E1A33"
BODY = "#2A3550"
MUTED = "#687085"
LINE = "#D8DDE6"
CARD = "#FFFFFF"
TEAL = "#0E8F88"
TEAL_SOFT = "#E1F2F0"
TEAL_BRIGHT = "#3DD9CC"
NAVY = "#0F1C38"
NAVY2 = "#16305C"
PURPLE = "#6445C8"
PURPLE_SOFT = "#EFEAFD"
PURPLE_LINE = "#9A82E6"
AMBER = "#F0B43C"

if FALLBACK:
    SERIF = "Georgia, serif"
    SANS = "Arial, sans-serif"
else:
    SERIF = "'Source Serif 4', Charter, Georgia, 'Times New Roman', serif"
    SANS = "Inter, 'Helvetica Neue', Helvetica, Arial, sans-serif"

out = []
cur_box = ["page"]


def a(**kw):
    parts = []
    for k, v in kw.items():
        if v is None:
            continue
        parts.append(f'{k.rstrip("_").replace("_", "-")}="{v}"')
    return " ".join(parts)


def text(x, y, s, size, fill, family=None, weight=None, anchor=None, ls=None,
         italic=False, box=None):
    family = family or SANS
    attrs = a(x=x, y=y, font_family=family, font_size=size, fill=fill,
              font_weight=weight, text_anchor=anchor, letter_spacing=ls,
              font_style="italic" if italic else None)
    if TEST:
        attrs += f' data-c="{box or cur_box[0]}"'
    out.append(f"<text {attrs}>{escape(s)}</text>")


def rect(x, y, w, h, rx=0, fill="none", stroke=None, sw=None, dash=None,
         opacity=None, id_=None, fill_opacity=None):
    out.append("<rect " + a(id=id_, x=x, y=y, width=w, height=h, rx=rx, fill=fill,
                            stroke=stroke, stroke_width=sw, stroke_dasharray=dash,
                            opacity=opacity, fill_opacity=fill_opacity) + "/>")


def line(x1, y1, x2, y2, stroke, sw=2, dash=None, marker=None, opacity=None, cap=None):
    out.append("<line " + a(x1=x1, y1=y1, x2=x2, y2=y2, stroke=stroke, stroke_width=sw,
                            stroke_dasharray=dash, opacity=opacity, stroke_linecap=cap,
                            marker_end=f"url(#{marker})" if marker else None) + "/>")


def path(d, stroke="none", sw=2, fill="none", dash=None, marker=None, opacity=None,
         join="round", cap=None):
    out.append("<path " + a(d=d, fill=fill, stroke=stroke, stroke_width=sw,
                            stroke_dasharray=dash, opacity=opacity, stroke_linejoin=join,
                            stroke_linecap=cap,
                            marker_end=f"url(#{marker})" if marker else None) + "/>")


def group(label):
    out.append(f'<g id="{label}">')


def end():
    out.append("</g>")


def pill(x, y, w, h, s, size=16, dark=False, box=None):
    """Solid pill highlights an implemented capability."""
    if dark:
        rect(x, y, w, h, rx=h / 2, fill=PURPLE_LINE, fill_opacity=0.16,
             stroke="#B8A5F5", sw=1.5)
        text(x + w / 2, y + h / 2 + size * 0.36, s, size, "#DCD0FF", weight=500,
             anchor="middle", box=box)
    else:
        rect(x, y, w, h, rx=h / 2, fill=PURPLE_SOFT, stroke=PURPLE_LINE, sw=1.5)
        text(x + w / 2, y + h / 2 + size * 0.36, s, size, PURPLE, weight=500,
             anchor="middle", box=box)


def stage_header(x, y, num, name, dark=False):
    text(x, y, num, 26, TEAL_BRIGHT if dark else TEAL, weight=700)
    text(x + 42, y - 1, "/", 20, "#8FA0BF" if dark else MUTED, weight=400)
    text(x + 62, y - 2, name, 15, "#FFFFFF" if dark else INK, weight=600, ls=4)


# ---------------------------------------------------------------- document
out.append(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" '
           f'viewBox="0 0 {W} {H}">')
out.append("<title>RippleTwin: business workflow and system architecture</title>")
out.append("<defs>")
if not FALLBACK:
    out.append("<style>@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700"
               "&amp;family=Source+Serif+4:opsz,wght@8..60,400;8..60,600;8..60,700&amp;display=swap');</style>")
for mid, col, size in (("ah-ink", INK, 12), ("ah-teal", TEAL, 12),
                       ("ah-purple", PURPLE, 11), ("ah-bright", TEAL_BRIGHT, 9)):
    out.append(f'<marker id="{mid}" viewBox="0 0 10 10" refX="9" refY="5" '
               f'markerWidth="{size}" markerHeight="{size}" markerUnits="userSpaceOnUse" '
               f'orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="{col}"/></marker>')
out.append(f'<linearGradient id="engine-bg" x1="0" y1="0" x2="1" y2="1">'
           f'<stop offset="0" stop-color="{NAVY}"/><stop offset="1" stop-color="{NAVY2}"/>'
           f'</linearGradient>')
out.append('<clipPath id="map-clip"><rect x="0" y="0" width="184" height="190" rx="12"/></clipPath>')
out.append("</defs>")
rect(0, 0, W, H, fill=BG, id_="background")

# ---------------------------------------------------------------- header
group("header")
text(60, 108, "RippleTwin", 80, INK, SERIF, 700, ls=-1)
text(62, 180, "From a roadworks plan to a tested decision", 40, INK, SERIF, 400)
text(1780, 64, "BUSINESS WORKFLOW + SYSTEM ARCHITECTURE", 15, INK, weight=600,
     anchor="end", ls=3)
line(1796, 59, 1860, 59, INK, 1.5)
end()

# ---------------------------------------------------------------- inputs row
RY, RH = 204, 140
group("planning-inputs")
cur_box[0] = "planning"
rect(60, RY, 950, RH, rx=14, fill=CARD, stroke=LINE, sw=1.5)
out.append(f'<circle cx="126" cy="{RY+70}" r="40" fill="{TEAL_SOFT}"/>')
rect(111, RY + 49, 30, 40, rx=4, stroke=TEAL, sw=2.5)
for dy in (12, 20, 28):
    line(118, RY + 49 + dy, 134, RY + 49 + dy, TEAL, 2.2, cap="round")
text(188, RY + 34, "WHO & WHAT", 15, TEAL, weight=600, ls=4)
text(188, RY + 72, "Contractors / council planners", 30, INK, SERIF, 600)
# chips: which part of the plan goes where
CY = RY + 90
rect(188, CY, 132, 32, rx=8, fill=TEAL_SOFT, stroke="#B9DFDB", sw=1.2)
text(254, CY + 21, "VMS wording", 16, BODY, weight=500, anchor="middle")
rect(340, CY, 600, 32, rx=8, fill="#F3F5F8", stroke=LINE, sw=1.2)
text(640, CY + 21, "Road segment · lane closure · time window · equipment placement",
     16, BODY, weight=500, anchor="middle")
end()

group("data-foundation")
cur_box[0] = "data"
rect(1040, RY, 820, RH, rx=14, fill=CARD, stroke=LINE, sw=1.5)
out.append(f'<circle cx="1106" cy="{RY+70}" r="40" fill="{TEAL_SOFT}"/>')
dbx, dby = 1106, RY + 54
out.append(f'<ellipse cx="{dbx}" cy="{dby}" rx="16" ry="6" fill="none" stroke="{TEAL}" stroke-width="2.5"/>')
path(f"M{dbx-16},{dby} V{dby+30} A16,6 0 0 0 {dbx+16},{dby+30} V{dby}", TEAL, 2.5)
path(f"M{dbx-16},{dby+10} A16,6 0 0 0 {dbx+16},{dby+10}", TEAL, 2.5)
path(f"M{dbx-16},{dby+20} A16,6 0 0 0 {dbx+16},{dby+20}", TEAL, 2.5)
text(1168, RY + 34, "DATA FOUNDATION", 15, TEAL, weight=600, ls=4)
text(1168, RY + 70, "OSM roads · SCATS traffic counts", 20, INK, SERIF)
text(1168, RY + 100, "RPM Hire equipment · research evidence", 20, INK, SERIF)
# transit and walking data
cur_box[0] = "future"
rect(1560, RY + 22, 280, 96, rx=12, fill=PURPLE_SOFT, stroke=PURPLE_LINE, sw=1.5)
text(1582, RY + 50, "TRANSIT & WALKING", 12, TEAL, weight=600, ls=2.5)
text(1582, RY + 78, "PTV tram & bus timetables", 15, INK, weight=500)
text(1582, RY + 100, "City pedestrian counters", 15, INK, weight=500)
end()

# ---------------------------------------------------------------- stage row
SY, SH = 406, 330
MID = SY + SH / 2
X1, W1 = 60, 350
X2, W2 = 460, 560
X3, W3 = 1130, 350
X4, W4 = 1530, 330
P = 32  # inner padding

group("input-arrows")
cur_box[0] = "page"
line(254, RY + RH, 254, SY - 2, TEAL, 2.5, marker="ah-teal")
text(266, 382, "sign text", 15, TEAL, weight=500)
line(700, RY + RH, 700, SY - 2, TEAL, 2.5, marker="ah-teal")
text(712, 382, "roadworks configuration", 15, TEAL, weight=500)
path(f"M1250,{RY+RH} V374 H960 V{SY-2}", TEAL, 2.5, marker="ah-teal")
text(1262, 366, "data inputs", 15, TEAL, weight=500)
end()

# 01 interpret
group("stage-01-interpret")
cur_box[0] = "s1"
rect(X1, SY, W1, SH, rx=16, fill=CARD, stroke=LINE, sw=1.5)
x = X1 + P
stage_header(x, SY + 46, "01", "INTERPRET")
text(x, SY + 98, "Read the signs", 36, INK, SERIF, 600)
text(x, SY + 144, "Four driver profiles", 20, BODY)
text(x, SY + 170, "commuter · local · tourist · delivery", 15, MUTED)
text(x, SY + 208, "LLM reads each sign · rule fallback", 18, BODY)
pill(x, SY + 224, 152, 32, "Connected")
line(x, SY + 276, X1 + W1 - P, SY + 276, LINE, 1.5)
text(x, SY + 310, "Sign response → route choice", 19, INK, weight=500)
end()

# 02 simulate
group("stage-02-simulate")
cur_box[0] = "s2"
rect(X2, SY, W2, SH, rx=16, fill="url(#engine-bg)", stroke="#2B4172", sw=1.5)
x = X2 + P
stage_header(x, SY + 46, "02", "SIMULATE", dark=True)
text(x, SY + 98, "Deterministic engine", 36, "#FFFFFF", SERIF, 600)
text(x, SY + 146, "Find detours & choose routes", 20, "#DCE3F0")
text(x, SY + 180, "Compute queues & delay", 20, "#DCE3F0")
text(x, SY + 214, "Evaluate overlapping works", 20, "#DCE3F0")
pill(x, SY + 234, 300, 32, "Real-CBD clashes · stagger fix", dark=True)
line(x, SY + 282, X2 + 356, SY + 282, "#2B4172", 1.5)
text(x, SY + 312, "Same input → same result", 19, "#FFFFFF", weight=500)

# schematic street map (illustrative only)
out.append(f'<g id="schematic-map" transform="translate({X2+362},{SY+124})">')
out.append('<g clip-path="url(#map-clip)">')
rect(0, 0, 184, 190, rx=12, fill="#132850")
out.append('<g transform="rotate(-10 92 95)">')
for yy in (18, 58, 98, 138, 178):
    line(-40, yy, 230, yy, "#2A4474", 1.4)
for xx in (8, 52, 96, 140, 184):
    line(xx, -40, xx, 240, "#2A4474", 1.4)
line(-40, 98, 230, 98, "#39588C", 3.2)
line(96, -40, 96, 240, "#39588C", 3.2)
path("M-20,170 C30,150 90,200 220,150", "#1D3D6E", 16, opacity=0.95)
# blocked baseline path
line(96, 98, 140, 98, TEAL_BRIGHT, 2, dash="4 4", opacity=0.45)
# detour (bright)
path("M12,98 H96 V58 H140 V98 H176", TEAL_BRIGHT, 8, opacity=0.18)
path("M12,98 H52", TEAL_BRIGHT, 3.5, marker="ah-bright")
path("M52,98 H96 V58 H124", TEAL_BRIGHT, 3.5, marker="ah-bright")
path("M124,58 H140 V98 H170", TEAL_BRIGHT, 3.5, marker="ah-bright")
# worksite barriers
for bx, by in ((118, 98), (52, 138)):
    rect(bx - 12, by - 6, 24, 12, rx=2, fill=AMBER)
    path(f"M{bx-8},{by+6} L{bx-2},{by-6} M{bx+2},{by+6} L{bx+8},{by-6}", NAVY, 2.4, cap="butt")
    path(f"M{bx-6},{by+12} L{bx+6},{by+24} M{bx+6},{by+12} L{bx-6},{by+24}", AMBER, 2.4, cap="round")
out.append(f'<circle cx="12" cy="98" r="7" fill="#132850" stroke="{TEAL_BRIGHT}" stroke-width="2.5"/>')
out.append(f'<circle cx="176" cy="98" r="7" fill="#132850" stroke="{TEAL_BRIGHT}" stroke-width="2.5"/>')
out.append("</g></g>")
rect(0, 0, 184, 190, rx=12, stroke="#2B4172", sw=1.2)
out.append("</g>")
end()

# 03 review
group("stage-03-review")
cur_box[0] = "s3"
rect(X3, SY, W3, SH, rx=16, fill=CARD, stroke=LINE, sw=1.5)
x = X3 + P
stage_header(x, SY + 46, "03", "REVIEW")
text(x, SY + 98, "See the impact", 36, INK, SERIF, 600)
text(x, SY + 144, "Detour routes", 20, BODY)
text(x, SY + 174, "Car, tram, bus & foot delay", 20, BODY)
text(x, SY + 204, "Baseline vs proposed plan", 20, BODY)
line(x, SY + 228, X3 + W3 - P, SY + 228, LINE, 1.5)
text(x, SY + 258, "CLASH COST", 13, TEAL, weight=600, ls=3)
text(x, SY + 290, "D(A+B) − D(A) − D(B)", 25, INK, SERIF)
text(x, SY + 316, "D = total delay", 15, MUTED)
end()

# 04 decide
group("stage-04-decide")
cur_box[0] = "s4"
rect(X4, SY, W4, SH, rx=16, fill=CARD, stroke=LINE, sw=1.5)
x = X4 + P
stage_header(x, SY + 46, "04", "DECIDE")
text(x, SY + 98, "Planner selects", 32, INK, SERIF, 600)
text(x, SY + 144, "a plan", 32, INK, SERIF, 600)
text(x, SY + 192, "Compare 3 kits + hire cost", 19, BODY)
text(x, SY + 224, "Pick one, record why", 19, BODY)
text(x, SY + 256, "Export a one-page pack", 19, BODY)
line(x, SY + 276, X4 + W4 - P, SY + 276, LINE, 1.5)
text(x, SY + 310, "Human decision", 19, INK, weight=500)
end()

group("main-flow-arrows")
cur_box[0] = "page"
line(X1 + W1, MID, X2 - 2, MID, INK, 2.5, marker="ah-ink")
line(X2 + W2, MID, X3 - 2, MID, INK, 2.5, marker="ah-ink")
text((X2 + W2 + X3) / 2, MID - 42, "Baseline +", 14, MUTED, weight=500, anchor="middle")
text((X2 + W2 + X3) / 2, MID - 20, "proposed runs", 14, MUTED, weight=500, anchor="middle")
line(X3 + W3, MID, X4 - 2, MID, INK, 2.5, marker="ah-ink")
end()

# ---------------------------------------------------------------- advisor loop
ZY, ZH = 774, 176
group("advisor-loop")
cur_box[0] = "zone"
rect(60, ZY, 1390, ZH, rx=18, fill="#F5F1FE", fill_opacity=0.7, stroke=PURPLE_LINE,
     sw=1.8)
PY, PH = ZY + 48, 46
pills = [(1160, 260, "Suggest up to 3 fixes"),
         (830, 260, "Reword · move · stagger"),
         (520, 240, "Send revised plan")]
for px, pw, s in pills:
    rect(px, PY, pw, PH, rx=12, fill=PURPLE_SOFT, stroke="#C3B3F2", sw=1.5)
    text(px + pw / 2, PY + 30, s, 21, INK, SERIF, anchor="middle")
cy = PY + PH / 2
# review -> suggest (Results)
line(1290, SY + SH, 1290, PY - 2, PURPLE, 2, marker="ah-purple")
text(1302, ZY + 26, "Results", 15, PURPLE, weight=600)
line(1160, cy, 1092, cy, PURPLE, 2, marker="ah-purple")
line(830, cy, 762, cy, PURPLE, 2, marker="ah-purple")
# send revised plan -> simulate (re-run) and -> interpret (if wording changed)
line(700, PY, 700, SY + SH + 2, PURPLE, 2, marker="ah-purple")
text(712, ZY + 26, "Re-run in engine", 15, PURPLE, weight=600)
path(f"M520,{cy} H254 V{SY+SH+2}", PURPLE, 2, marker="ah-purple")
text(266, ZY + 26, "If VMS reworded: re-read first", 15, PURPLE, weight=600)
text(92, ZY + ZH - 26, "RULE ADVISOR LOOP", 15, PURPLE, weight=600, ls=3)
text(440, ZY + ZH - 26, "The advisor only proposes edits. Every fix is re-run in the engine, "
     "then compared in Review.", 16, MUTED, italic=True)
end()

group("status")
cur_box[0] = "status"
rect(1480, ZY, 380, ZH, rx=14, fill=CARD, stroke=LINE, sw=1.5)
text(1504, ZY + 32, "STATUS", 13, MUTED, weight=600, ls=3)
items = [(True, "Deterministic engine: working"),
         (True, "LLM reading + fallback: working"),
         (True, "CBD clashes + stagger: working"),
         (True, "Transit + walking impacts: working"),
         (True, "AI explain · compare · export: working")]
for i, (ok, s) in enumerate(items):
    yy = ZY + 62 + i * 25
    if ok:
        out.append(f'<circle cx="1512" cy="{yy-5}" r="6" fill="{TEAL}"/>')
    else:
        out.append(f'<circle cx="1512" cy="{yy-5}" r="5.5" fill="none" stroke="{PURPLE}" stroke-width="2"/>')
    text(1528, yy, s, 15, BODY)
end()

# ---------------------------------------------------------------- footer
group("footer")
cur_box[0] = "page"
line(60, 972, 1860, 972, "#C9CFDA", 1.5)
text(60, 1040, "AI interprets — the engine calculates", 42, INK, SERIF, 700)
line(876, 996, 876, 1054, "#C9CFDA", 1.5)
text(904, 1018, "VMS text check · rule fallback · API keys stay server-side", 16, INK,
     weight=500, ls=0.6)
text(904, 1046, "Implementation status · 29 Sep 2026 · D-0929-2307", 15, MUTED)
line(1496, 996, 1496, 1054, "#C9CFDA", 1.5)
line(1524, 1012, 1580, 1012, INK, 2.5, marker="ah-ink")
text(1596, 1018, "Main workflow", 16, INK)
line(1524, 1040, 1580, 1040, PURPLE, 2, marker="ah-purple")
text(1596, 1046, "Advisor feedback loop", 16, INK)
end()

out.append("</svg>")
with open(OUT, "w", encoding="utf-8") as f:
    f.write("\n".join(out) + "\n")
print("wrote", OUT)
