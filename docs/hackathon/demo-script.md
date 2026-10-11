# 4 · Demo, pitch, fallbacks, submission

*Archived from the hackathon (29 Sep – 1 Oct 2026). Translated from the original Chinese; superseded details are kept as they were.*

> Written by the pitch owner; the lead may also edit it. Both `/demo` and `/submit` follow this file. Decision IDs (D-…) refer to [docs/decisions.md](../decisions.md).

## Demo script (finals: 7-minute talk + 3-minute Q&A, 10-01 13:30; T25 draft 09-29 22:10, revised after review; pitch owner not decided)

20-second opening hook (A speaks; the screen shows only one red queue line on Lonsdale St): **"8 am on a weekday, one lane closes on Lonsdale Street: a queue of about 900 metres. Same barriers, same sign board, same hire bill — change what the sign says, and in our model it drops under 100 metres. RippleTwin finds those words before the barriers go out."**

- Roles: A = speaker [ ], B = operator [ ]. B only clicks and never speaks; B clicks when A reaches a ▶. Every line is the English original; A may reword the lines but not the numbers
- Always use the step names shown on the page: along the top, **01 Plan / 02 Stress test / 03 Ripple trace / 04 Repair**. The demo goes only 01 → 03 → back to 01; **do not click 02 Stress test** (a hard-coded illustrative scenario, see trap 4), and do not click 04 Repair (see trap 2)
- Page state before starting: EN, light theme, clear weather (D-0929-2012: the weather is only "illustrative"; never touch it), 01 Plan, preset "Lonsdale St · 08:00", 1 lane closed, VMS with only frame 1, ROADWORK AHEAD. Note: on the live site `demo('lonsdale')` includes frame 2, USE RUSSELL ST, by default; delete it before starting and type it back in live at 3:15
- Numbers: say 2 significant figures out loud (about 900 m, about 8.5 minutes); the slides and the screen show exact values. Where each number comes from and how to reproduce it: see "Numbers used in Q&A and the demo" under "Prepared judge Q&A" below
- Timing: speech estimated at 150 words a minute, and every cell's word count fits its time slot; the talk ends at 6:45, leaving 15 seconds spare
- Rehearsal traps (measured 09-29 22:10 on origin/main `6bedd9e` with `connect()`):
  1. Do not switch to 11:00 to show that "off-peak is better": with only ROADWORK AHEAD, the 11:00 queue is 932 m, longer than the 918 m at 8 am (17:00 gives 860 m). If a judge wants a different hour, change it, but do not predict which way it goes
  2. The advisor card and the three plans use different wording: 04 Repair calls `advise()`, which currently gives "USE / RUSSELL / SAVE 5 MIN" and replaces both frames (8 am → 191 m, 1,964 veh-min); the `options()` o3 guided tier is "ROADWORK AHEAD + USE / RUSSELL / SAVE 9 MIN" (→ 82 m, 966). The script follows o3, and the demo does not click 04 Repair; if a judge wants to see it, click it and read the numbers off the screen rather than from memory
  3. "Full closure" was not checked this time (`closes.lanes` must be ≥ the number of lanes); click through it once in rehearsal before deciding whether to show it
  4. Do not switch to La Trobe (D-0929-1650: hardly any congestion). **Do not click 02 Stress test, and do not volunteer the La Trobe × Swanston junction micro-simulation**: it is a hard-coded illustrative scenario with `script:true` and seed 4218 (`newStress` in `5-app.js`), showing CRITICAL RIPPLE, C-17 and D-42 on screen, which flatly contradicts "live, not scripted" in Q&A 1. If asked, say plainly "that's a scripted illustration, not the engine"
  5. The three plans side by side at 3:40, "detour 14% → 61%" at 4:15, and selection and export at 5:05 all depend on **T23** (@jinmingq: `be.options()` on the page + side by side + selection + export); the live `6-engine.js` does not call `options()` yet. The overlapping-works clash at 4:35 depends on **T21**. If they are not on the page before the freeze, use the fallback written in each cell; the lines stay the same
  6. The page has no OpenStreetMap / data credit yet (searching `apps/web/src` and `public/index.html` finds neither OpenStreetMap nor ODbL): until one is added, Q&A 9 must not say "credited on the page" (see decision 5)

| Time | On screen | What to say | Who operates | Wow? |
|---|---|---|---|---|
| 0:00 | Slide 1: black background, one red queue line on Lonsdale St | The 20-second opening hook above | A | Yes |
| 0:20 | Slide 2: who hurts, and how | "Every week, councils approve traffic management plans, and contractors hire barriers, signs and VMS boards — from companies like RPM Hire. Before that gear goes out, nobody can say how long the queue will be, which buses run late, or where pedestrians must walk. How many drivers detour is a rule of thumb, and every permit is checked on its own." | A | |
| 0:50 | Slide 3: the one-liner + the data behind it (1,513 links · 8 weeks of SCATS · PTV timetables · council pedestrian counters, **on screen only, not read out**) | "RippleTwin is a digital twin of the Melbourne CBD for temporary works. Place the barriers, signs and VMS you would actually hire, and see what drivers, bus riders and pedestrians will see, do, and lose — on real data." | A | |
| 1:05 | Live page, **01 Plan**: ▶ click the preset "Lonsdale St · 08:00" (Lonsdale St westbound) → "1 lane" → 08:00; VMS frame 1 ROADWORK AHEAD @ 300 m, frame 2 empty; sign S-1 RIGHT LANE CLOSED @ 100 m; no red ✕ in the rule check; the "Engine · real CBD flows" result card lower in the same panel shows the numbers | "This is live, in the browser. One lane on Lonsdale Street westbound, 8 am. Signs where the standard puts them — no rule-check errors. The engine answers straight away: a queue of about 900 metres, about eight and a half extra minutes for every car that reaches it, about 175 vehicle-hours lost across the network in that hour, and 15 bus routes — about 1,900 riders — slowed down." | B clicks · A speaks | Yes: the numbers appear live |
| 1:55 | Still on 01 Plan: ▶ under footpath, click "Works-side footpath closed", then click back to "Footpath open" when done | "The brief also asks about pedestrians. Close the footpath on the works side: 185 people an hour now walk an extra 176 metres and cross the road twice more. That one is an estimate — most footpath counts here are interpolated, and the page says so." | B clicks · A speaks | |
| 2:25 | ▶ Click **03 Ripple trace** at the top (skipping 02): the map frames the red queue line, the detour lines (line width = share), the slowed segments and the affected bus routes; on the right, "Where drivers go" and "Who is hit · and why"; the line above says 1,072 veh/h pass the works section, which can take only 810 veh/h | "Here is why. 86% of drivers stay on Lonsdale and queue; Russell, Exhibition and Spring take about 5% each. The sign only says ROADWORK AHEAD — it warns people, it doesn't tell them where to go. Commuters, locals, visitors and delivery drivers read it differently, and the panel says why. Buses can't detour, so their riders wear the queue: about 18,700 rider-minutes in one hour." | A speaks · B points | |
| 3:15 | ▶ Click back to **01 Plan** and type USE / RUSSELL ST into VMS frame 2 (`#vmsF2`), one line each | "So change the words, not the street. One more frame: USE RUSSELL ST. The queue drops from about 900 to about 550 metres. Network delay down 45%. Bus riders down 40%." | B types · A speaks | Yes: wow 1 |
| 3:40 | **[depends on T23]** Three plans side by side (`be.options()`: Minimum / Standard / Guided, built from the inventory, with hire cost, labelled "assumed price"). **Fallback if T23 is not on the page**: in 01 Plan, B changes frame 2 to USE / RUSSELL / SAVE 9 MIN (three lines, each ≤ 10 characters, 7 words in total, passes the rule check; a yellow "!" hint about lines longer than 8 may appear, which does no harm) → the result card shows 82 m, detour 61%; for the price comparison, flip to backup screenshot slide D4 | "It also builds plans from a stand-in RPM catalogue with assumed day rates. Minimum — barriers and signs — A$515 for five days. Standard adds an arrow board and a VMS: A$1,765, and the queue doesn't move, because a sign that only warns changes nobody's route. Guided is the same hardware at the same price; the VMS names the fastest detour and the time it saves. In our model the queue drops to about 80 metres, delay down about 90%." | B clicks · A speaks | Yes, twice: same price, different words |
| 4:15 | **[depends on T23]** Same screen: the grey assumption text next to detour 14% → 61%; if T23 is not up, point to "Detouring 61%" on the 01 Plan result card, or switch to backup slide B1 (sensitivity) | "Too good to be true? Following a named detour is calibrated to a field trial — about one driver in five (Erke et al., 2007). The extra pull of 'save 9 minutes' is our model's assumption: halve driver trust and Guided still cuts the queue, to about 500 metres." | A | |
| 4:35 | **[depends on T21]** Overlapping-works clash: ▶ add a second works site nearby in the same week → clash cost → one-click stagger | "Now the problem nobody owns: two permits, each fine on its own, same streets, same week. Together they cost [T21 number] extra vehicle-minutes — that's the clash. Stagger one by [T21 number] days and it drops to [T21 number]." (If T21 is not on the page, switch to the backup slide and say "on our test grid, 29,850 vehicle-minutes of clash; a five-day stagger takes it to zero") | B clicks · A speaks | Yes: wow 2 |
| 5:05 | **[depends on T23]** ▶ Select Guided → one-page export (equipment list + quote + VMS schedule + who to notify); if it is not up, flip to backup slide D6 | "The planner picks Guided and exports one page: the equipment list and quote for RPM, the VMS schedule, and who to notify. The numbers go into the approval; the gear goes on the truck." | B clicks · A speaks | |
| 5:25 | Slide 4: how it works (architecture v2) + real / assumed | "A language model's only job is to read the sign like a driver: noticed, understood, trusted, which way it points. Today that reading is a transparent rule set, labelled on screen; the model hook is built and switched off. Every number comes from the engine, in under 10 milliseconds, same answer every time. And we label what's assumed: three-quarters of link flows are interpolated, 29 of 37 behaviour parameters are low-confidence, each shown with a range." | A | |
| 6:00 | Slide 5: who uses it, who pays, roadmap (8 steps) | "Council officers approving plans, contractors writing them, and RPM Hire — who can attach an impact report to every quote and sell the right words, not just the boards. Next: validate against a real past closure, check clashes across all the city's permits, and switch on the language model for sign reading." | A | |
| 6:30 | Slide 6: close + link / QR code (team to decide) | "Before the barriers go out, try the closure on the twin. Change the words, not the street. Thank you." | A | Yes |
| 6:45 | (15 seconds spare) | | | |

## Pre-screen, 3 pages (due 09-30 12:30; draft 09-29 17:40, updated at 21:00 with the numbers after T16–T19 went live)

- PDF: [`pitch/00-prescreen.pdf`](pitch/00-prescreen.pdf) (16:9, 3 pages, about 410 KB) · source file [`pitch/00-prescreen.html`](pitch/00-prescreen.html) (opens in a browser as three pages; to change the text, edit the HTML directly)
- Before/after on the right of page 1, `pitch/01-before-*.jpg` / `pitch/01-after-*.jpg`: panel screenshots of the live page (liquid-glass version) at Lonsdale St 08:00, with the sign showing only ROADWORK AHEAD versus one extra frame, USE RUSSELL ST (09-29 20:51, taken with headless Chrome after switching to "Detailed")
- Page 3 embeds [`03-architecture-v2.html?lang=en`](https://github.com/Zemmeng/rippletwin/blob/hackathon-final/docs/pitch-assets/03-architecture-v2.html): 6 text changes on the original diagram from #42, with the AI box labelled "rules today" (D-0929-1718: LLM sign reading not connected yet); pedestrians and trams (T17/T18) are connected and no longer marked "next". The original [`03-architecture.html`](https://github.com/Zemmeng/rippletwin/blob/hackathon-final/docs/pitch-assets/03-architecture.html) is unchanged (both files are now kept only at the `hackathon-final` tag)
- Re-export (Mac): `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --no-pdf-header-footer --virtual-time-budget=5000 --print-to-pdf=docs/hackathon/pitch/00-prescreen.pdf "file://$PWD/docs/hackathon/pitch/00-prescreen.html"`; or print from the browser → Save as PDF → margins "None" → tick "Background graphics"
- Process: 4 agents verify the numbers in the repository → 2 drafts merged → three-way review for errors (facts / judges / rules) → final (full texts on the lead's machine in `.claude/agent-out/prescreen-*.md`, not committed)

### For the whole team to decide (before submission)

| # | Item | Currently on the page |
|---|---|---|
| 1 | Team name | All three pages have a `[Team name]` placeholder; the submission gives the team name only, no member names |
| 2 | Whether to include the live link + QR code: the URL's subdomain contains a member's handle (zemmmeng), which may conflict with "team name only" | Page 2: `[demo link + QR — team to confirm]` |
| 3 | The headline uses Lonsdale −45% (consistent with the live default scenario, D-0929-1650), with bus riders −40% as the subtitle | Page 1 green bar, page 2 |
| 4 | The clash cost of 29,850 comes from the grid test network; rerun it on the real CBD tonight? | Page 2, marked "test grid" |
| 5 | The page 2 MVP follows #48's "5 things before the freeze": overlapping-works clash on the page, 3 plans from the inventory with hire cost, multi-plan comparison + selection + one-page export; the team to judge whether these can be finished | Page 2 MVP column |
| 6 | Is it OK to name RPM VMS Preview, Mooven and one.network (text only, no logos)? | Page 1, What's different |
| 7 | Page 3: architecture diagram v2 or the original? | v2 used |
| 8 | Who submits to Canvas "Pre-screening Submissions" before 09-30 12:30; before submitting, change the Status time in the page 2 footnote to the submission time | — |

### Where each number on the page comes from (when a judge asks "where does this number come from?", answer from this)

| Claim on the page | Source |
|---|---|
| Lonsdale St delay −45% (10,493 → 5,746 veh-min, queue 918 → 548 m) | `connect().compare()` in `backend.js`, demo `lonsdale` (1 lane, 8 am, 513 vehicles), sign reading by keyword rules; the live page follows the same path, and the numbers in the screenshot match |
| Bus riders −40% (15 routes, 1,925 people an hour, 18,693 → 11,206 rider-minutes) | `summary.transit` from the same `compare()` (T17, PTV GTFS); 25 riders per service is an assumed value |
| One footpath closed: 185 people an hour walk an extra 176 m and cross the road 2 more times | `summary.peds` from `run()` (T18), `closes.footpath: 'left'`; this pedestrian flow is interpolated along the same street (`method: street_interp`), not measured |
| After the advisor's rewrite "USE / RUSSELL / SAVE 9 MIN", the queue is 82 m and the 8 am delay 966 veh-min | Rerun of the first change from `advise()` (rules-based advisor); not on the page, a verbal backup |
| 3 plans at A$515–1,765; the guided one takes the queue from 918 → 82 m | `be.options(demoPlan('lonsdale'))` (T22, #59): o1 cheapest A$515 / 918 m, o2 standard A$1,765 / 918 m, o3 guided A$1,765 / 82 m; 5-day hire; day rates and inventory are assumed values |
| Actual diversion in London was only 1/5 of the stated intention (Chatterjee 2002) | The quoted source in `apps/params/public/params.json` |
| 1,513 links, 8 weeks of SCATS | Link count of `network.json`; `flows.json` period 2026-08-01..09-27 (56 days used) |
| < 10 ms per run | `demo.mjs --real` measured 1.4–6.6 ms |
| 29 of 37 parameters are assumptions or low confidence; 74% of link flows are estimates | `params.json` confidence none 18 + low 11; `flows.json` coverage estimated 1,127 / 1,513 |
| Claims about competitors | The lead's local research, `idea-prior-art.md` and `idea-users.md`; never say "first" |

## Preset data and reset

- Demo account / room: `<no credentials here; say where to get them>`
- Reset: `<command>` — Note: use only "clear the data, keep the links"; **never use a destructive reset that breaks links already sent out**

## Pitch outline (2–3 sentences of script per slide)

The through-line = one works site (Lonsdale St westbound, 08:00), one story, three steps (01 Plan, place the equipment → 03 Ripple trace, see the impact → back to 01 Plan, change the words on the sign). "Verifiable results" do not get a slide of their own: the numbers appear live in the demo, and slide 4 carries only the "real / assumed" comparison.

| Slide | Content | Script (2–3 sentences; exact lines in the demo script) | Time |
|---|---|---|---|
| 1 | Hook: one red queue line on Lonsdale St + "Change the words, not the street" | One lane, a queue of about 900 m; same equipment, same price, change the words on the sign and it drops below 100 m (model result) | 0:20 |
| 2 | Problem: who hurts (councils, contractors, RPM's customers) and how (queues, buses and pedestrians cannot be worked out in advance; detour shares are guesswork; every permit is reviewed on its own) | The three impacts named in the brief: surrounding traffic, pedestrians, public transport | 0:30 |
| 3 | The solution in one line + the data behind it (1,513 links · 8 weeks of SCATS · PTV timetables · council pedestrian counters; the data list on screen only) | Place the barriers, signs and VMS you would really hire; see what each group sees, does and loses | 0:15 |
| — (live page) | Demo: 01 Plan → 03 Ripple trace → back to 01 Plan to change the words → three plans [T23] → overlapping-works clash [T21] → export [T23] | See 1:05–5:25 in the table above; every step has a hidden backup screenshot slide, D1–D6 (if the live site is down, or T21 / T23 are not on the page, flip to the screenshots; the lines stay the same) | 4:20 |
| 4 | How it works: architecture v2 (the LLM only reads signs, and today that is rules; the engine computes every number, < 10 ms, same input same result) + two columns, real / assumed | Real: SCATS, PTV GTFS, council pedestrian counters, the OSM network; assumed: 74% of link flows interpolated, 29 of 37 parameters low confidence, riders per trip, hire rates | 0:35 |
| 5 | Who uses it, who pays + the 8-step roadmap (D-0929-2011: register → current state → generate plans → simulate → overlap → AI explanation → a human decides → export; completed steps ticked) | RPM attaches an impact report to every quote and sells "the right words"; councils get the numbers an approval needs; next step: back-test a real closure first | 0:30 |
| 6 | Closing line + link / QR code (team to decide, see pre-screen decision 2) | "Change the words, not the street." | 0:15 |
| B1–B6 | Q&A backup slides (not shown): B1 sensitivity table (anchors 10% / 5%, trust halved), B2 data sources and licences (including © OpenStreetMap contributors, ODbL), B3 validation plan, B4 how we differ from Aimsun / Mooven and others, B5 clash cost on the real network [T21], B6 engine formulas (BPR + queue + per-type choice model + two-point calibration) | Shown only when asked | — |

Slides link: `<>` · exported PDF: `pitch/slides.pdf`

## Judging criteria mapping (per [challenge-brief.md](challenge-brief.md))

| Criterion | Our evidence | Which slide / demo step |
|---|---|---|
| Potential effectiveness 40% | We use the inputs named in the brief (barriers / signage / VMS) to answer the three impacts named in the brief: cars (a queue of about 900 m, +8.5 minutes per vehicle), buses (15 routes, 18,693 rider-min) and pedestrians (185 people/h walk an extra 176 m and cross the road 2 more times). It can also change decisions: changing the words on the sign gives −45%, and the guided tier at the same price −91% (model result; still −51% with trust halved); the overlapping-works clash gives the number of days to stagger | Slide 2; demo 1:05–5:05 |
| Technical feasibility 30% | Opens live (Cloudflare); computed in the browser, < 10 ms per run, same input same result; any CBD segment can be clicked; real data: 1,513 links / 56 days of SCATS / PTV GTFS / council pedestrian counters; 7 engine test files, including reverse assertions; what is estimated is labelled on the spot (74% of link flows interpolated, 29/37 parameters low confidence) | Demo 1:05 (computed live), 3:15 (type and the numbers change); slide 4; Q&A 1–4 |
| Originality 15% | Simulates "what people read", not just "a stretch of road is missing" (the LLM reads signs, the engine computes the numbers, D-0929-1435); named detours calibrated to a field trial, not to stated survey intentions; overlapping-works clash cost D(A+B) − D(A) − D(B); plans built from the inventory, with a quote (stand-in catalogue, assumed hire rates) | Demo 3:15–5:05; slide 4 |
| Business and social viability 10% | RPM: an impact report on every quote, selling "guidance" and not just equipment (same price, a 90% difference in the model); councils: the numbers a TMP review needs; contractors: opens in a browser, nothing to install; open data only (ODbL / CC BY), no personal data | Slide 5; demo 5:05 export |
| Presentation 5% | One works site, one story, three steps; 2 significant figures out loud; assumptions stated before anyone asks (4:15); ≥ 2 rehearsals, fallbacks A/B/C | Throughout; rehearsal log below |

## Prepared judge Q&A

"(panel)" marks questions that the simulated judge panel ([specs/judge-panel-0929.md](specs/judge-panel-0929.md): AI agents role-playing judges, not real judge feedback) said would be asked. Give a one-sentence conclusion first, then one number or source; if we don't know, say "not yet" + the next step.

| # | Question | Key points of the answer (say the English as written) | Who answers |
|---|---|---|---|
| 1 | (panel) Is this computed live, or scripted? | Live, in your browser. Every click reruns the engine on the real network — under 10 ms, same input same answer. Name a street or an hour and we'll run it now. The only thing not "live" is sign reading, and today that's a rule set, labelled on screen. (Do not demo "full closure" or "off-peak is better" on the spot; at this moment never click 02 Stress test, which is a hard-coded illustrative scenario, see rehearsal trap 4) | [ ] |
| 2 | (panel) Where do the numbers come from? | Traffic: 8 weeks (56 days) of SCATS hourly counts on 1,513 OpenStreetMap links; 386 links measured, 1,127 interpolated and marked "estimated". Buses and trams: PTV GTFS timetables; riders per trip assumed (25 per bus at peak). Pedestrians: City of Melbourne counters, mostly interpolated. Delay: BPR travel times plus a deterministic queue. | [ ] |
| 3 | (panel) How do you know drivers follow the sign? | We calibrate where there is evidence. A named detour moves about 20% of drivers (Erke, Sagberg & Hagman 2007 field trial, range 10–30%). The warning-only 3% is our assumption, range 1–6%. We deliberately don't use survey answers: in London real diversion was a fifth of stated intention (Chatterjee 2002). If only 10% follow a named detour, USE RUSSELL ST still gives −24% delay and Guided still takes the queue from 918 to 161 m. The extra pull of "save 9 minutes" is our model's assumption; halve driver trust and Guided still gets to about 500 m. Size uncertain, direction robust. (Basis for the 3%: D-0929-1536) | [ ] |
| 4 | (panel) Has it been validated? | Not against a real closure yet — that's step one after the hackathon. What we have: baseline flows come from real counts, the named-detour anchor from a field trial, 7 engine test files with reverse assertions (e.g. a closure can never make anyone faster). Plan: back-test a past Melbourne CBD closure using before/after SCATS counts. | [ ] |
| 5 | (panel) Why not Aimsun, VISSIM or SIDRA? | Those are expert tools — very accurate, days of calibration by a traffic engineer, desktop licences. We're the 30-second screening layer before that: a planner or an RPM sales rep can test sign wording and staging in a browser. They model lost capacity; we also model what the sign says. Big jobs still go to them. | [ ] |
| 6 | (panel) Why not Mooven / one.network? | As far as we know, Mooven measures travel-time impact once works are on the road — after. We're before the barriers go out. Works registers such as one.network show overlapping permits; we put a price in minutes on the overlap and suggest the stagger. (Unverified: confirm per pre-screen decision 6 before naming competitors) | [ ] |
| 7 | (panel) Is the LLM real? | Not in this demo, on purpose. Sign reading is a transparent keyword rule, labelled "rules estimate". The LLM hook is built (OpenAI-compatible endpoint, answers cached, off by default); switching it on is configuration. Even then the model only reads the sign — noticed, understood, trusted, which route — and every number comes from the engine, so it stays reproducible. (D-0929-1718, 1830) | [ ] |
| 8 | (panel) What does RPM Hire get? | A reason to sell guidance, not just hardware: Standard and Guided cost the same (A$1,765 for 5 days — a stand-in catalogue with assumed day rates, since RPM doesn't publish prices) and in our model differ by about 90% in delay — the value is in the words. An impact report on every quote helps their customers get council approval faster. Plans never exceed stock. Model: per-plan fee, or bundled with hire. | [ ] |
| 9 | (panel) Data licences? Privacy? | All open data: OpenStreetMap (ODbL), SCATS via DataVic, PTV GTFS and City of Melbourne (CC BY 4.0); the attribution is on our data slide. Only aggregate counts — no personal data, no tracking, no login. (Only after the credit line has been added to the page can this become "credited on the page", see decision 5; flip to B2 if needed) | [ ] |
| 10 | (panel) Negative delays? Data quality? | We found one and fixed it: a slow side street (Little Bourke St, 20 km/h) made detours look like savings; now a closure can never make a trip faster (#58). Broken SCATS detectors (negative reads) are flagged and those links estimated, with the method recorded per link; some links already run over capacity, so we only count the extra caused by the works. | [ ] |
| 11 | (panel) Why 918 m? Isn't that too precise? | Say "about 900 metres". At 8 am, 1,072 vehicles an hour still use the works section; with one lane closed it passes 810. The extra 262 an hour queue — at about 7 metres a car over two lanes, that's roughly 900 m. It's written on screen in Ripple trace. We treat the before/after difference as the result and the absolute as indicative; spillback into upstream junctions isn't modelled yet. (Do not say 513: that is only the stream that has to make a detour choice, `approach.volume`; the screen shows 1,072 / 810) | [ ] |
| 12 | Where do the four traveller types and 50/25/10/15 come from? | Assumed — there's no CBD survey split — and labelled "assumed" with a range on screen (D-0929-1536). Of the per-type parameters, route familiarity has a source; hurry, sign trust and queue aversion are our defaults, low confidence. In params.json only 8 of 37 values are medium or high confidence. | [ ] |
| 13 | Cyclists? Wheelchair users? | Not yet. Cycling isn't modelled; step-free access is null because the footpath data has no kerb or ramp detail. (Do not volunteer the junction micro-simulation; if pressed, say "we have a scripted illustration of an intersection, not the engine", see trap 4) | [ ] |
| 14 | Does it scale beyond the CBD? | The engine is generic: OpenStreetMap plus SCATS, which DataVic publishes statewide. The CBD was chosen because counts are dense. Bigger areas need data preparation, not a new engine. | [ ] |
| 15 | Which LLM, what does it cost, where is data sent? | Provider-agnostic. Each sign message is read once per traveller type and cached — a fraction of a cent each. For councils we'd use an Australian-hosted model (DeepSeek is off the table on federal devices). | [ ] |
| 16 | What did you build during the hackathon? | All product code after kickoff. Before the event we prepared collaboration scripts (branch checks, secret scan) and a generic starter skeleton we didn't use; both are disclosed in the README. (D-0929-1311, deleting `starters/`, has not been done yet: it is still on main, and README:181 says so too; only once it is done can this become "only collaboration scripts", see decision 6) | [ ] |
| 17 | Will you keep going? | [ team to decide ] Suggested: validate on one past closure → switch on LLM reading with cached answers → pilot with RPM on one live worksite. | [ ] |

### Numbers used in Q&A and the demo (measured 09-29 22:10 on origin/main `6bedd9e` with `connect()`, T5 rule-based sign reading; Lonsdale St westbound, 1 lane closed, 08:00; the road-user shares are assumed values)

| Claim | Numbers | How to reproduce |
|---|---|---|
| Baseline: the sign says only ROADWORK AHEAD | Queue 918 m; +509 s per affected vehicle; detour 14%; network 10,493 veh-min; buses: 15 routes, 1,925 people/h, 18,693 rider-min | `be.run(be.demo('lonsdale', { frames: [['ROADWORK','AHEAD']] }))` |
| Works-section flow vs capacity (Q&A 11) | 1,072 veh/h need to pass, but only 810 veh/h can once one lane is closed; 262 extra vehicles an hour, at 7 m per vehicle over 2 lanes ≈ 918 m | `run().hot[0]` from the row above (`v` 1072, `cap` 810, `queue_m` 918); the first line of page 03 Ripple trace |
| Add a frame, USE RUSSELL ST (the live default) | 548 m; 5,746 (−45%); +244 s; detour 35%; buses 11,206 (−40%) | `be.run(be.demo('lonsdale'))` |
| o1 cheapest / o2 standard | A$515 / A$1,765 (5 days, stand-in catalogue, prices are assumed values, `options().inventory.assumed = true`); both 918 m, 10,493 | `be.options(be.demo('lonsdale'))` |
| o3 guided (ROADWORK AHEAD + USE / RUSSELL / SAVE 9 MIN) | A$1,765; 82 m; 966 (−91%); +48 s; detour 61%; buses 1,722 | As above; if T23 is not on the page, typing these two frames by hand in 01 Plan also gives 82 m |
| Advisor `advise()` (04 Repair, current main) | USE / RUSSELL / SAVE 5 MIN, replacing both frames → at 8 am 191 m, 1,964 | `be.advise(be.demo('lonsdale'))`; inconsistent with o3, see decision 2 below |
| Sensitivity: named-detour anchor 20% → 10% | USE RUSSELL ST 730 m, 7,975 (−24%); o3 wording 161 m, 1,685 (−84%) | Set `anchors.named_route_divert` in `params.json` to 0.1 and run `connect()` again |
| Sensitivity: anchor → 5% | 856 m, 9,641 (−8%); o3 wording 309 m, 3,126 (−70%) | As above, set to 0.05 |
| Sensitivity: trust halved for all 4 types | USE RUSSELL ST 623 m, 6,637 (−37%), detour 30%; o3 wording 498 m, 5,172 (−51%), detour 37%; ROADWORK AHEAD alone unchanged (918 m) | Set `persona.<type>.trust` in `params.json` to the engine default × 0.5 (commuter 0.5, local 0.3, tourist 0.55, delivery 0.4) and call `connect({ params: applyParams(p) })`; measured with node on 09-29 at `6bedd9e` |
| What the extra pull of "save 9 minutes" rests on | Two-point calibration covers only the 3% (works warning only) and 20% (named route) anchors; the step from 35% to 61% comes from SAVE 9 MIN and is driven by hurry / trust / queue_averse, which are all `default` (the engine's built-in defaults) in `status().params_used.persona`; only `familiar` is read from `params.json` | `api.status().params_used.persona` |
| The 3% anchor | `anchors.generic_warning_divert` = 0.03, confidence low, the lead's assumption, range 1–6% | `apps/params/public/params.json` |
| Overlapping-works clash | Grid test network: 29,850 veh-min, delayed by 5 days → 0; real CBD network: [T21 number] | `node apps/engine/tools/demo.mjs --real`; the real network waits for T21 |
| Parameters, links | 37 numbers with a confidence level in `params.json`: high 3, medium 5, low 11, none 18 (29 low or none); of the 1,513 links, 1,127 have interpolated flows | Count the `confidence` fields; for links, see the pre-screen source table (T15 branch) |

### For the lead / whole team to decide

1. Who are the pitch owner, speaker A and operator B?
2. Which "change the words" path the demo takes: the o3 guided tier (SAVE 9 MIN → 82 m) or the advisor card (currently SAVE 5 MIN → 191 m on main). Ideally the two wordings are unified before the freeze; otherwise the judges see two versions
3. Once T21's real-network clash cost is out, replace the 4:35 row and the [T21 number] in the table above; if it does not come out, use the grid-network backup line in the script. If T23 is not on the page before the freeze, use the hand-typed fallback at 3:40 + the screenshot slides
4. Whether Q&A 6 may name competitors (same as pre-screen decision 6)
5. Add a credit line to the page, "© OpenStreetMap contributors (ODbL) · SCATS / PTV / City of Melbourne CC BY 4.0": the web area belongs to T20, @unicornnnnnny, so the lead needs to pass it on to @unicornnnnnny (in the T20 handoff note); once it is added, change Q&A 9 back to "credited on the page"
6. Whether to do D-0929-1311 before submission (delete `starters/`, change README:181): if it is done, change Q&A 16 back to "only collaboration scripts"
7. Step names: the script already uses the names currently on the page (01 Plan / 02 Stress test / 03 Ripple trace / 04 Repair). If they are to become Plan / See the impact / Fix, pass that to T20 and write it into its handoff note, then come back and update the script

## Fallbacks (three levels)

| Level | Method | When | Whose computer |
|---|---|---|---|
| A | Live `DEMO_URL` | Network works | |
| B | Local preview + `MOCK=1` | Live site down / no network | |
| C | Screen recording (`out/demo.mp4`, not committed; link in `VIDEO_URL` in the conf) | Everything is down | |

## Checklist for the 30 minutes before the demo

- [ ] `?v=` bumped; the live site runs the latest version
- [ ] Private windows with the tabs opened in advance (live + local)
- [ ] Notifications off, text enlarged (browser at 125%)
- [ ] Devices charged, backup hotspot ready
- [ ] Path B tested once with the network off

## Rehearsal log

| Run | Time | Duration | Where it got stuck | What changed |
|---|---|---|---|---|
| 1 | | | | |
| 2 | | | | |

## Trial-run observations (written by step 3 of `/demo`)

| ID | Severity | How many hit it independently | Issue | Status |
|---|---|---|---|---|
| | | | | |

Checked and found not to hold: `<list separately; do not mix into the table above>`
Failed / non-returning agents: `<count, kept separately>`

## Review of public-facing text

| Text | AI draft | Reviewed by | Status |
|---|---|---|---|
| README judges' section | | | Pending |
| Submission form fields | | | Pending |
| Video subtitles / narration | | | Pending |

## Submission checklist (lead only; per the official requirements in [challenge-brief.md](challenge-brief.md); every item needs a way to verify it)

### Repository

| # | Item | Owner | How to verify | Status |
|---|---|---|---|---|
| 1 | `bash scripts/check.sh` full run green | lead | Paste the summary line | Not done |
| 2 | `bash scripts/secret-scan.sh --history` zero hits | lead | Paste the output | Not done |
| 3 | `.env`, data and large files not in the history | lead | Spot-check `git log --all --stat` | Not done |
| 4 | Team name filled in in LICENSE | lead | Open and check | Not done |
| 5 | README top judges' section: screenshot, live URL, video, how to run, English section (drafted by the pitch owner under "Review of public-facing text"; the README is the lead's exclusive area, so the lead writes it in) | lead | Open and check | Done 09-30 (#97–#102) |
| 6 | Unused `starters/` deleted or explained | lead | `ls starters` | Not done |
| 7 | Pre-event template explained in the README "Disclosure" section | lead | Open and check | Not done |

### Demo

| # | Item | Owner | How to verify | Status |
|---|---|---|---|---|
| 8 | `DEMO_URL` opens in a private window and on mobile data | DEPLOYER | Try on a phone | Not done |
| 9 | Video is unlisted and playable, length within the limit | pitch owner | Open it from another account | Done 09-30: plays when logged out (YouTube oEmbed), 1:25 |

### Materials

| # | Item | Owner | How to verify | Status |
|---|---|---|---|---|
| 10 | Slides exported as PDF into [`pitch/`](pitch/) | pitch owner | File exists | Not done |
| 11 | Form field drafts written under "Review of public-facing text" above and reviewed | pitch owner | Status is done | Not done |
| 12 | Members, track and AI-use disclosure complete | lead | Check against [challenge-brief.md](challenge-brief.md) | Not done |

### Wrap-up (**clicked by a human**)

| # | Item | Owner | How to verify | Status |
|---|---|---|---|---|
| 13 | `git tag -a submission -m "Submission version <time>" && git push origin submission` | lead | `git tag` | Not done |
| 14 | Make the repository public (if required): `gh repo edit --visibility public` | lead, by hand | Open the repository in a private window | Not done |
| 15 | Submit the form on the competition platform | lead, by hand | Screenshot of the success page saved in [`pitch/`](pitch/) | Not done |
| 16 | Mark "Submitted <time>" at the top of [task-board.md](task-board.md); no more code changes on main after submission | lead | | Not done |
