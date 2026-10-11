# 1 · Challenge brief (facts only, no solutions)

*Archived from the hackathon (29 Sep – 1 Oct 2026). Translated from the original Chinese; superseded details are kept as they were.*

> Everything about what the organisers require is taken from this file. Lead edits only. Anything not yet verified is read in the strictest way and marked *(unverified)*.
> Solutions go in [plan.md](plan.md), not here. Decision IDs (D-…) refer to [docs/decisions.md](../decisions.md).
> Sources: the Student Briefing PDF, the Canvas course pages (archived after the challenges unlocked at 10:45), and two Chinese summaries ("Judging criteria", "Challenge summary"). Where details disagree, the English original wins.

## The challenge in one sentence

We are doing **Challenge 5** (D-0929-1215): RPM Hire, "Digital Tool for Temporary Infrastructure", theme Future Cities. Build a digital tool that, **before** a road closure or work zone goes on site, uses a typical traffic equipment inventory (barriers, signs, VMS boards) to simulate its knock-on effects on surrounding traffic, pedestrians and public transport.

Key points of the Challenge 5 text (the English original is on the RPM Hire page in the Canvas "Problem Statements" module):

- Users: councils and contractors
- Pain point: when planning road closures and work zones, the knock-on effects are hard to foresee. Three affected groups are named: surrounding traffic, pedestrians and public transport
- What to build: a digital tool; the verb in the original is "simulates the impact of a planned road closure or work zone"
- Input: a typical traffic equipment inventory, naming barriers, signage and VMS boards
- Timing: before it is deployed on site
- The original gives no dataset, no challenge-specific judging criteria and no required deliverable format, so it is judged on the general criteria

All 9 challenges (5 sponsors):

| # | Sponsor | In one line | Theme |
|---|---|---|---|
| 1 | Airwallex | AI now does the entry-level work: how do newcomers become experts? | Future Work |
| 2 | Airwallex | Design financial infrastructure for people with irregular income | Future Work |
| 3 | RPM Hire | Traffic controllers: use AI to reduce fatigue and spot hazards in real time | Future Work |
| 4 | RPM Hire | End-of-queue warning at roadworks (VMS + variable speed signs + linked alarms), plus a set of guidelines | Future Work |
| 5 | RPM Hire | A tool that simulates the impact of a road closure or work zone before it goes live ← us | Future Cities |
| 6 | RPM Hire | Business case and infrastructure sizing for moving the equipment transport fleet to electric vehicles (5-year horizon) | Future Energy |
| 7 | SMEC AI | "Sovereign AI" that Australian small businesses will actually use, with inference and data kept onshore | Not stated in the original |
| 8 | Cremorne Digital Hub | Run a precinct of under 1 km² as one system; a working prototype is required | Cities · Work · Energy |
| 9 | Untapped | Use AI to make learning as engaging as a game and as useful as a mentor | Future Work |

Two special awards ($1,000 each):

- **SMEC Sovereign AI Award** (Sovereign AI Award – Makers, not Takers): eligibility follows the hard rule of Challenge 7. All inference and business data processing must run on hardware the team controls or on facilities hosted in Australia, and business data may not be sent to overseas APIs (open-weight models are allowed). Judged on four questions: would the boss use it on Monday · how sovereign is it · is it affordable · how well is it built. The original gives no weights
- **Untapped Innovation Award**: creativity and originality 25% · technical excellence 25% · prototype / PoC quality 25% · user experience and engagement 15% · scalability 10%. The archived Canvas page has only 4 rows (it lacks "prototype / PoC quality"); the 5-row version comes from the Chinese summary *(unverified)*

## Official links and key points

- Website / challenge page: Canvas course https://canvas.lms.unimelb.edu.au/courses/244146 (the challenges are in the "Problem Statements" module; submissions go through "Pre-screening Submissions" and "Final Presentations")
- Key points:
  - Event: FEIT Hackathon Festival 2026, Faculty of Engineering and IT, University of Melbourne, 2026-09-29 (Tuesday) to 10-01 (Thursday)
  - Any format is allowed: product idea, solution, programming language and devices are all open; the original calls it open-ended and beginner friendly
  - Two rounds: on 9/30 a 3-slide pre-screen submission selects the top 12–15 teams; only finalists present on 10/1
  - Venue: Tuesday and Wednesday in the Carrillo Gantner Theatre, Sidney Myer Asia Centre (Parkville); Thursday in the Science Gallery Theatre (Melbourne Connect)
  - Wear your name badge at all times: meals are collected with the badge, and the free coffee vouchers hang on it
  - The organisers want at least 1–2 people from each team at every activity and workshop
  - The original is inconsistent: the Briefing gives the pre-screen deadline as "Tuesday 30 September" and the finals as "Wednesday 1 October", but 9/30 is a Wednesday and 10/1 a Thursday. Canvas wins

## Key times (all with time zone; checked against `START` / `DEADLINE` in [`hackathon.conf`](../../hackathon.conf))

Time zone Australia/Melbourne. All three days are AEST (UTC+10); daylight saving starts only on 10-04.

| Event | Time | Notes |
|---|---|---|
| Check-in | 2026-09-29 08:45–09:20 AEST | Collect name badges at the registration desk outside the Carrillo Gantner Theatre |
| Start | 2026-09-29 09:30 AEST | Opening ceremony; matches conf `START` |
| Challenges unlocked | 2026-09-29 10:45 AEST | Canvas "Problem Statements" |
| Hacking time (schedule) | Tue 13:30–17:15 · Wed 09:30–13:00 · Thu 09:30–12:00 AEST | Staff confirmed we may work at any time during the event, not only in these slots (D-0929-1222) |
| Pre-screen deadline | 2026-09-30 (Wed) 12:30 AEST | Canvas "Pre-screening Submissions", 3-slide PDF |
| Pre-screen results | Time not found *(unverified)* | 12–15 teams advance |
| Deadline | 2026-10-01 (Thu) 12:00 AEST | Final submission, Canvas "Final Presentations"; matches conf `DEADLINE` |
| Demos / judging | From 2026-10-01 13:30 AEST | Finalists present: 7 minutes talk + 3 minutes Q&A per team; judges deliberate at 16:00 |
| Results | 2026-10-01 17:00 AEST | Awards |

## Judging criteria

The official general criteria, used for both the pre-screen and the finals; each criterion is scored 1–5. "What judges look for" is our reading; the original gives only the names and weights *(unverified)*. Challenge 5 has no specific criteria of its own; the special-award criteria are above.

| Criterion | Weight | What judges look for | How we score |
|---|---|---|---|
| Potential Effectiveness | 40% | Does it really solve the problem in the brief, and how large is the impact? | Pre-screen slide 1 (Problem Statement, solution overview); finals demo |
| Technical Feasibility | 30% | What already works, and what MVP can be delivered within three days? | Pre-screen slide 2 (tech stack, current state, MVP plan) and the diagram on slide 3 |
| Originality | 15% | Is the idea new, and how does it differ from existing solutions? | Pre-screen slide 1, solution overview |
| Viability (Business & Social Uptake) | 10% | Will anyone use it and pay for it, and how will it be rolled out? | Pre-screen slide 1 |
| Presentation of Ideas | 5% (finals only) | Is it clear and persuasive? | Finals: 7-minute talk + 3-minute Q&A |

- The pre-screen uses only the first four criteria (95% in total); the original does not say how they are rescaled *(unverified)*

## Deliverables (kept in sync with the submission checklist in [demo-script.md](demo-script.md))

- [ ] Code repository: must be public and linked in the submission, and all code must stay accessible throughout judging. The original does not require a licence. Due 2026-10-01 12:00 AEST (with the final submission)
- [ ] Demo video: not officially required. For the pre-screen, a demo video or a QR code / link to the repository may be attached as a bonus (from the Chinese summary; not in the Briefing) *(unverified)*. No deadline
- [ ] Slides / documents: a 3-page pre-screen PDF. Page 1 Project Overview (team name, project name, Problem Statement, solution overview); page 2 Tech & Progress (tech stack / tools, what has been built so far, the MVP plan for day 3); page 3, optional, Visuals / UI / Diagrams (mockups, wireframes, an architecture diagram or a use-case flow). Due 2026-09-30 12:30 AEST. For the finals ("Final Presentations"), what to submit and in what format: original not found *(unverified)*. Due 2026-10-01 12:00 AEST
- [ ] Submission form: the Canvas assignments "Pre-screening Submissions" and "Final Presentations". Each needs a submission title (the organisers suggest "project name + a one-line tagline"); give the team name only, no member names. Team name and project name not decided yet. Due at the two times above
- [ ] Third-party assets and API list: list every third-party asset and API (including paid ones), plus a note on the collaboration tools prepared before the event. Due 2026-10-01 12:00 AEST

## Rules and restrictions (lead only)

| Item | Official wording | Our reading | Status |
|---|---|---|---|
| Pre-event code / templates | Rule 2: existing projects may not be entered. Rule 3: no development or design of any kind before the start, including but not limited to code, graphics, audio and 3D | Strictest reading: delete `starters/` (D-0929-1311, done in a separate PR); write the project code from scratch after the start; describe the collaboration tools prepared before the event in the submission | Unverified: not asked, handled in the strictest way |
| Build time | Rule 4: build only within the official time | Staff confirmed we may work at any time during the event (D-0929-1222) | Confirmed (verbally) |
| Must the repository be public? | Rule 5: any code written must be in a public repository, linked in the submission, and all code must stay accessible throughout judging | Must be public; do not make it private or delete it before judging ends | Confirmed: explicit in the original |
| Licence requirements | The original says nothing about a code licence. Rule 6: third-party assets must be lawfully licensed and publicly downloadable or purchasable; teams may buy them at their own cost | A code licence is not mandatory; data is credited under its own licence (OSM ODbL, DataVic CC BY 4.0) | Unverified: code licence not asked |
| Team size | Canvas discussion board: 3–5 people per team | We have 5: @Zemmeng (lead), @louisxie316-dotcom, @jinmingq, @Unzzip, @unicornnnnnny | Unverified: from the discussion board, not in the Briefing |
| Which AI tools / APIs are allowed | The original does not restrict tools. Rule 6: every third-party asset and API (including paid ones) must be listed in the submission. Challenge 7 and the SMEC award have separate sovereignty rules | Allowed; everything used goes on the list; the sovereignty rules apply only to Challenge 7 and the SMEC award | Unverified: not stated explicitly |
| Must AI use be disclosed? | Not mentioned | Strictest reading: list the AI tools used, together with the third-party list | Unverified |
| Demo length | Finals: 7 minutes talk + 3 minutes Q&A per team (Canvas schedule) | Only finalists present | Confirmed: Canvas |
| Finals qualification | Briefing: the top 12–15 teams advance; the Canvas resources page says 15 teams | Go by the pre-screen results | Unverified: the two numbers disagree |

## Available resources

Only names, where to apply and who applied. **No keys.**

| Resource | Where to apply | Who applied | Quota |
|---|---|---|---|
| Cloudflare account (Workers / Durable Objects) | dash.cloudflare.com | @Zemmeng | Plan not checked *(unverified)* |
| LLM API | TBD | TBD | TBD; the key lives only in Cloudflare, never in the repository |
| OpenStreetMap road network | openstreetmap.org | Public data, no application needed | Free; ODbL, attribution required |
| DataVic SCATS signal volumes (site 2921) | discover.data.vic.gov.au | Public data, no application needed | Free; CC BY 4.0, attribution required |
| City of Melbourne pedestrian counts | data.melbourne.vic.gov.au | Public data, no application needed | Free; licence not checked *(unverified)* |
| Canvas course | Invitation from the organisers | Whole team | — |

## Questions for the organisers

| Question | Who asks | Answer |
|---|---|---|
| Does a generic pre-event skeleton such as `starters/` count as pre-event code? | — | Not asking: decided to delete `starters/` under the strictest reading |
| Are the two special awards limited to teams doing that sponsor's challenges? | TBD | Not asked |
| Untapped says sample cybersecurity material is attached, but it is in neither the PDF nor Canvas | TBD | Not asked |
| What does "Final Presentations" require (slides / video / link), and in what format? | TBD | Not asked |
| When and where are the pre-screen results announced? | TBD | Not asked |
