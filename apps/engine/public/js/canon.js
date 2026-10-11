// canon.js — JSON with sorted keys (the same object gives the same output whatever its field order); used for cache keys in the engine, same approach as apps/api cardkey.js
export function canon(x) {
  if (Array.isArray(x)) return '[' + x.map(canon).join(',') + ']';
  if (x && typeof x === 'object') return '{' + Object.keys(x).sort().map(k => JSON.stringify(k) + ':' + canon(x[k])).join(',') + '}';
  return JSON.stringify(x ?? null);
}
