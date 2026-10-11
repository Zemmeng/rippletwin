# Pitch assets (archived)

*Archived from the hackathon (29 Sep – 1 Oct 2026). Translated from the original Chinese; superseded details are kept as they were.*

The team made these files on 29–30 Sep 2026 for the pre-screening round, a 3-slide PDF due on Canvas at 12:30 on 30 Sep. They are snapshots from that point: none of them shows the SUMO traffic simulation or the final 6-step workbench, and their status labels describe the product as it stood on 29 Sep. They have been superseded by the current images in [`docs/images/`](../../images/) and the architecture docs in [`docs/architecture/`](../../architecture/README.md).

| File | What it is |
|---|---|
| `00-prescreen.html` | Source of the 3-page 16:9 pre-screen deck (drafted by @Zemmeng, PR #44): project overview with the before/after VMS crops and engine numbers, tech and progress, and the architecture page. Open it in a browser; it loads the images in this folder by relative path. |
| `00-prescreen.pdf` | The last committed export of that deck (3 pages, 960×540 pt, headless Chrome, 30 Sep 02:09, 428 KB). |
| `01-before-vms.jpg`, `01-after-vms.jpg` | Crops of the VMS editor used on page 1 of the deck: ROADWORK AHEAD alone, then with a second frame, USE RUSSELL ST. |
| `03-architecture-rippletwin-en.svg` | Page 3 of the deck (@jinmingq, PR #51): a 1920×1080 editable SVG of the business workflow and system architecture (planning inputs and data → Interpret → Simulate → Review → Decide, with the rule-based advisor loop). Its status box and footer are dated 29 Sep. |
| `gen_arch.py` | Dependency-free Python generator for that SVG (see below). |
| `03-architecture-en.pdf`, `03-architecture-en.png` | The first product architecture diagram (@Zemmeng, 29 Sep 16:30; 960×540 pt PDF, 1600×900 PNG), exported from `03-architecture.html?lang=en`. |
| `rippletwin-business-workflow.svg` | An alternative 1920×1080 editable workflow diagram (29 Sep, @jinmingq, PR #52, drawn with OpenAI Codex). Its status labels are frozen at the 29 Sep snapshot; see [`rippletwin-business-workflow-notes.md`](rippletwin-business-workflow-notes.md). |

## Regenerating the architecture SVG

From the repository root:

```bash
python3 docs/hackathon/pitch/gen_arch.py docs/hackathon/pitch/03-architecture-rippletwin-en.svg
```

- `--test` adds a `data-c="<container>"` attribute to every text element, for overflow checks
- `--fallback` uses only Georgia / Arial, to check worst-case text widths
- Regenerating gives the committed SVG byte for byte. Edit the generator rather than the SVG, so that the next run does not overwrite manual edits
- Fonts: Inter and Source Serif 4 from Google Fonts (SIL Open Font Licence), loaded through `@import` when online; offline or in a vector editor the SVG falls back to Charter / Georgia and Helvetica / Arial. Both font sets were render-checked at the time: 74 editable text elements, with no text overflowing its box, overlapping other text or crossed by an arrow. The main workflow is drawn as solid dark lines and the advisor loop as solid purple lines

The original notes recorded that the SVG was updated on 29 Sep to match D-0929-2307 and main at the time: LLM sign reading with rule fallback, real-CBD overlapping works and staggering, tram, bus and pedestrian impacts, the rule-based advisor, and the comparison of 3 equipment kits with a one-page export were all marked "working". "Working" meant implemented, not that every reading called the LLM live; the demo also used pre-computed readings. The advisor was labelled rule-based throughout.

## Re-exporting the pre-screen PDF

In Chrome: Print → Save as PDF, margins "None", "Background graphics" ticked (the page size is 16:9). Or headless, from the repository root on macOS:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --no-pdf-header-footer \
  --virtual-time-budget=5000 --print-to-pdf=docs/hackathon/pitch/00-prescreen.pdf \
  "file://$PWD/docs/hackathon/pitch/00-prescreen.html"
```

## Size limits

Images in this folder were kept under 500 KB. PDFs under `docs/hackathon/pitch/` may be up to 10 MB (D-0930-0116); the pre-commit hook and `scripts/check.sh` still enforce this. Videos were never committed: the demo video is linked through `VIDEO_URL` in `hackathon.conf`.

## Removed from this folder

When the folder moved here from `docs/pitch-assets/`, the following were removed from the tree; they are available at the [`hackathon-final` tag](https://github.com/Zemmeng/rippletwin/tree/hackathon-final/docs/pitch-assets):

- `03-architecture.html`, the self-rendering bilingual source of `03-architecture-en.*` (Chinese by default, `?lang=en` for English), and its unexported copy `03-architecture-v2.html`
- the Chinese exports `03-architecture-zh.pdf` and `03-architecture-zh.png`
- `01-before-engine.jpg` and `01-after-engine.jpg`, crops of the 29 Sep engine cards that nothing referenced

The demo video cover `demo-video-cover.svg` moved to [`docs/images/demo-video-cover.svg`](../../images/demo-video-cover.svg).
