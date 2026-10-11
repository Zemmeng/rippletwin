// assign.js — step 5: split the affected vehicles across routes using the calibrated shares, then compute each link's travel time, queue and the network's total travel time. Pure function.
// Background flow = this hour's link flow from flows.json (which already includes the affected vehicles). Diverted vehicles are subtracted from the stay route's links and added to the detour's links;
// on shared upstream links the subtraction and addition cancel out. Total delay D = network total travel time (veh·min) − total travel time with no works.

import { linkTime, queueVeh, VEH_GAP_M } from './net.js';
import { capFactors, dayType } from './worksite.js';

// splits = [{ ap, share: { routeId: share } }] (ap comes from routes.js affected())
export function evaluate(net, flows, when, active = [], splits = []) {
  const dt = dayType(when);
  const v = new Map();
  for (const l of net.links.values()) v.set(l.id, flows?.days?.[dt]?.[l.id]?.[when.hour] ?? 0);
  // Affected vehicles F = the smallest flow still left on the stay route: with two works on the same link or adjacent on one street, the second can only split vehicles the first has not already moved (no double subtraction/addition)
  // Full closure (blocked) is the exception: no vehicle may stay on a closed link, so F = the largest flow still left on the closed links (vehicles turning in from side streets are rerouted between the stay route's ends too);
  // otherwise only the end-to-end through traffic would move, the rest would be counted as stuck with no delay, and a full closure would look better than a one-lane closure (review-backend-logic)
  // Share that diverts = sum of the detour shares: with no detour (full closure, nowhere to go) nothing moves; the vehicles stay stuck and are reported in blocked_vph
  const used = [];
  for (const { ap, share } of splits) {
    const F = ap.blocked
      ? Math.max(0, ...ap.chain.map(id => v.get(id) ?? 0))
      : Math.min(ap.volume, ...ap.stayLinks.map(id => v.get(id)));
    const moved = ap.alts.reduce((s, r) => s + (share[r.id] || 0), 0);
    used.push(F);
    for (const id of ap.stayLinks) v.set(id, v.get(id) - moved * F);
    for (const r of ap.alts) {
      const p = share[r.id] || 0;
      if (p) for (const id of r.links) v.set(id, v.get(id) + p * F);
    }
  }
  // A full closure moves the largest flow on the closed links, so an upstream link that carried fewer vehicles (some turned in from side streets) can go negative: clip to 0 after splitting.
  // Clip only at the end: the subtraction and addition on shared upstream links must cancel first, or clipping early would create vehicles upstream from nothing
  for (const [id, x] of v) if (x < 0) v.set(id, 0);
  const f = capFactors(net, active);
  const links = new Map();
  let tt = 0, blocked = 0;
  for (const l of net.links.values()) {
    const x = f.get(l.id);
    const cap = l.cap_vph * (x ? x.f : 1);
    const vol = v.get(l.id);
    let t = linkTime(l.t0_s, vol, cap);
    if (!Number.isFinite(t)) { blocked += vol; t = linkTime(l.t0_s, vol, l.cap_vph); } // fully closed but vehicles remain (no detour): reported separately, not counted as delay
    // The queue sits on the whole street upstream of the works: convert to length using the street's original lane count (not the lanes left open at the works)
    links.set(l.id, { v: vol, cap, t, queue_m: Number.isFinite(queueVeh(vol, cap)) && cap > 0 ? (queueVeh(vol, cap) * VEH_GAP_M) / Math.max(1, l.lanes) : 0 });
    tt += vol * t;
  }
  return { tt_s: tt, links, blocked_vph: blocked, used };
}

export function pathNow(ev, ids) {
  return ids.reduce((s, id) => s + ev.links.get(id).t, 0);
}

export function maxQueue(ev, ids) {
  return ids.reduce((m, id) => Math.max(m, ev.links.get(id).queue_m), 0);
}
