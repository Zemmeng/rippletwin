// cards.js — small helpers for step 2: sign read time and road-name cleaning. The requests themselves are in reading.js (the "reading request" of D-0929-1435).
// Read time = legible distance ÷ speed (WA VMS guideline §7.4: 320 mm characters are legible at about 200 m, 200 mm at about 100 m).

export function legibleM(char_mm = 320) {
  return char_mm >= 320 ? 200 : char_mm >= 200 ? 100 : 60;
}

export function readSeconds(kmh, char_mm = 320) {
  return Math.round(legibleM(char_mm) / (Math.max(5, kmh) / 3.6));
}

// Road names going into the prompt: keep only the characters the api accepts, at most 40
export function cleanName(s) {
  const t = String(s ?? '').replace(/[^A-Za-z0-9 .,'&/()-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
  return t || 'Unnamed road';
}

export const round1 = x => Math.round(x * 10) / 10;
export const bucket = (x, step) => Math.round((Number(x) || 0) / step) * step;
