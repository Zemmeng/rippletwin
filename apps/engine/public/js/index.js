// index.js — public exports of the engine core. Usage and result format: docs/reference/interfaces.md (Engine API).
// The web page's main entry is backend.js (connect()); it imports this file only for affected() / capFactors() to draw detours.
//   const engine = createEngine({ network, flows, readSigns, params: await loadParams() });   // readSigns: apps/api/public/js/reader.js (mockReadSigns is the fallback / test double); params fall back to assumed values
//   await engine.prepare(plan);  const result = engine.evaluate(plan);
export { createEngine, MSA_ITERS, OCCUPANCY } from './pipeline.js';
export { advise, mockAdvise, advisorSummary, applySuggestion, checkSuggestion } from './advisor.js';
export { mockReadSigns, requestsFor, signsOn } from './reading.js';
export { TYPES, MIX, PERSONAS, chooseShares, informed } from './choice.js';
export { calibrate, anchorRequest, ANCHORS, REF } from './calibrate.js';
export { loadParams, applyParams, PARAMS_URL } from './params.js';
export { makeGrid } from './grid.js';
export { loadNetwork, shortestPath, dijkstra, treePath, linkTime, bearing } from './net.js';
export { isActive, overlaps, capFactors, shiftWorksite, windowWhens, sampleHours, dayType, FOOTPATH_SIDES, footpathOf, validateWorksite, validatePlan } from './worksite.js';
export { pedImpact, pedsUnavailable, plannedFootpath, footpathActive, WALK_MPS, CLOSABLE_KINDS, OPPOSITE_M, SENSOR_NEAR_M, OVERLAP_MIN_M, MIN_REACH } from './peds.js';
export { approaches, affected, NO_DETOUR } from './routes.js';
export { readSeconds, cleanName } from './cards.js';
export { transitImpact, paxPerTrip, isTransit, routePaths, PAX_PER_TRIP, PAX_RANGE } from './transit.js';
