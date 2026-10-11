// Purpose: run full simulated hours headless in Node and check arrivals, determinism, the work-zone difference and signal timing
// Usage: node tests/sim.test.mjs (test.sh runs it); the last line is always "N passed, M failed"
import { readFileSync } from 'node:fs';
import { Sim, HOUR, sigState, walkOn, hashStr } from '../public/js/sim.js';

const data = JSON.parse(readFileSync(new URL('../public/demand/demand_2921.json', import.meta.url), 'utf8'));
let P = 0, F = 0;
const ok = (cond, msg) => { if (cond) { P++; console.log('✅ ' + msg); } else { F++; console.log('❌ ' + msg); } };
const run = (hour, day, wz) => { const s = new Sim({ data, hour, day, wz, seed: hashStr(day + ':' + hour) }); while (s.t < HOUR) s.step(); return s; };
const near = (got, want, tol) => want === 0 ? got === 0 : Math.abs(got - want) / want <= tol;

const base17 = run(17, 'wd', false), wz17 = run(17, 'wd', true);
const b = base17.summary(), w = wz17.summary();

// 1. arrivals match the data (Poisson arrivals vary: cars / bikes / pedestrians ±12%, trams ±20%)
for (const [k, tol] of [['car', 0.12], ['bike', 0.12], ['ped', 0.12], ['tram', 0.2]]) {
  ok(near(b.spawned[k], b.expected[k], tol), `weekday 17:00 ${k} arrivals ${b.spawned[k]}, data ${Math.round(b.expected[k])} (±${tol * 100}%)`);
}
// 2. no NaN / negative speeds
ok(base17.agents.every(a => Number.isFinite(a.s) && Number.isFinite(a.v) && a.v >= 0), 'after a full hour every agent has a finite position and a finite, non-negative speed');
// 3. the same seed gives exactly the same result
ok(JSON.stringify(run(17, 'wd', false).summary()) === JSON.stringify(b), 'two runs with the same seed give an identical summary');
// 4. normally cars and bikes never share a lane, so there are no same-lane closing events; left turners get through in phase B and the junction does not deadlock
ok(!b.byLabel['Car closing on bike in same lane'], 'normal: no car-closing-on-bike-in-same-lane events');
ok(b.outside === 0, `normal: no cars queued off-screen at the end of the hour (actual ${b.outside})`);
// 5. work zone: identical arrivals, but the westbound queue, off-screen cars and conflicts do not decrease, and same-lane closing events appear
ok(w.spawned.ped === b.spawned.ped, 'work-zone and normal runs have identical pedestrian arrivals (only the work zone differs)');
ok(w.outside > b.outside, `more cars queue off-screen with the work zone (${b.outside} → ${w.outside})`);
ok(w.conflicts >= b.conflicts && (w.byLabel['Car closing on bike in same lane'] || 0) > 0, `work zone has no fewer conflicts than normal (${b.conflicts} → ${w.conflicts}) and same-lane closing events appear`);
// 6. 03:00 is nearly empty: no cars queued off-screen
const n3 = run(3, 'wd', false).summary();
ok(n3.outside === 0 && n3.conflicts <= 3, `03:00: ${n3.outside} cars off-screen, ${n3.conflicts} conflicts`);
// 7. signal timing: in phase A Swanston is green and La Trobe red; the east crosswalk walks only in the first 21 s of phase A
ok(sigState('A', 10) === 'G' && sigState('C', 10) === 'R' && sigState('AB', 40) === 'G' && sigState('A', 40) === 'R', 'signals: at 10 s A is green and C red; at 40 s A is red but the left turn (AB) is still green');
ok(walkOn('E', 5) && !walkOn('E', 25) && walkOn('W', 25) && walkOn('N', 60), 'walk signals: east walks at 5 s but not at 25 s; west still walks at 25 s; north walks at 60 s');

console.log(`${P} passed, ${F} failed`);
process.exit(F ? 1 : 0);
