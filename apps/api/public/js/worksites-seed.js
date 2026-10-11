// Seed worksites in the register (read-only: PATCH answers 403 locked). Same shape as the worksite object in worksites.js
// The first two match the engine demo plans (DEMOS.lonsdale / latrobe in apps/engine/public/js/backend.js), with unique ids
// The third closes a road on the Lonsdale demo's detour (Russell St → Little Bourke St) and overlaps the first for 3 days, to demonstrate overlapping works
// Tried locally on 2026-09-29 with the engine's conflict(): at 08:00 on 10-07 and 10-08 the clash cost was about 10,000 vehicle-minutes (the engine's live result is authoritative)
const WEEK = { from: "2026-10-05", to: "2026-10-09", hours: [7, 19] };

export const SEED_WORKSITES = [
  {
    id: "W-LONSDALE",
    title: "Lonsdale St westbound lane closure",
    kind: "road",
    status: "draft",
    links: ["l595594354_9756035316"],
    closes: { lanes: 1, footpath: null },
    time: WEEK,
    equipment: [
      { id: "VMS-1", type: "vms", at_m: 300, frames: [["ROADWORK", "AHEAD"], ["USE", "RUSSELL ST"]] },
      { id: "S-1", type: "sign", at_m: 100, text: "RIGHT LANE CLOSED" },
      { id: "A-1", type: "arrow", at_m: 60 },
      { id: "B-1", type: "barrier", at_m: 0 },
    ],
  },
  {
    id: "W-LATROBE",
    title: "La Trobe St westbound lane closure at Swanston St",
    kind: "road",
    status: "draft",
    links: ["l2187770692_2190483583"],
    closes: { lanes: 1, footpath: null },
    time: WEEK,
    equipment: [
      { id: "VMS-1", type: "vms", at_m: 260, frames: [["ROADWORK", "AHEAD"], ["USE", "RUSSELL ST"]] },
      { id: "S-1", type: "sign", at_m: 100, text: "RIGHT LANE CLOSED" },
      { id: "A-1", type: "arrow", at_m: 60 },
      { id: "B-1", type: "barrier", at_m: 0 },
    ],
  },
  {
    id: "W-LTLBOURKE",
    title: "Little Bourke St closure on the Russell St detour",
    kind: "utility",
    status: "draft",
    links: ["l26034673_245532558"],
    closes: { lanes: 1, footpath: null },
    time: { from: "2026-10-07", to: "2026-10-12", hours: [7, 19] },
    equipment: [
      { id: "S-1", type: "sign", at_m: 50, text: "ROAD CLOSED" },
      { id: "B-1", type: "barrier", at_m: 0 },
    ],
  },
];
