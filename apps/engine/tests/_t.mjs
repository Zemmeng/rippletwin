// minimal test harness: ok() records an assertion; t() wraps an async test, an exception counts as a failure; done() prints "N passed, M failed" and exits accordingly
let P = 0, F = 0;
export function ok(cond, msg) {
  if (cond) { P++; console.log('✅ ' + msg); } else { F++; console.log('❌ ' + msg); }
}
export async function t(name, fn) {
  try { await fn(); } catch (e) { F++; console.log(`❌ ${name} threw: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`); }
}
export function done() {
  console.log(`${P} passed, ${F} failed`);
  process.exit(F ? 1 : 0);
}
// worksite A: La Trobe St westbound, one lane closed between Russell St and Swanston St (toy grid)
export function wsA(frames = [['ROADWORK', 'AHEAD']], extra = {}) {
  return {
    id: 'A', links: ['L-n0_6-n0_5'], closes: { lanes: 1 }, time: { from: '2026-10-05', to: '2026-10-09', hours: [7, 19] },
    equipment: [{ id: 'vms1', type: 'vms', at_m: 300, frames }, { id: 's1', type: 'sign', at_m: 100, text: 'RIGHT LANE CLOSED' }],
    ...extra,
  };
}
// worksite B: Lonsdale St westbound, one lane closed on the same block (A's detour traffic passes through here)
export function wsB(extra = {}) {
  return {
    id: 'B', links: ['L-n1_6-n1_5'], closes: { lanes: 1 }, time: { from: '2026-10-07', to: '2026-10-12', hours: [7, 19] },
    equipment: [{ id: 'vmsB', type: 'vms', at_m: 300, frames: [['ROADWORK', 'AHEAD']] }],
    ...extra,
  };
}
export const WHEN = { date: '2026-10-06', hour: 17 }; // Tuesday evening peak
