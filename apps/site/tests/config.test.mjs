// Purpose: check the key settings in wrangler.jsonc / package.json: assets dir is out, /api/* runs the Worker first except /api/public/*,
//          the API and SUMO service bindings, and scripts that build first
// Usage: node tests/config.test.mjs (test.sh runs it); no npm install; the last line is always "N passed, M failed"
import { existsSync, readFileSync } from 'node:fs';

let P = 0, F = 0;
const ok = (cond, msg) => { if (cond) { P++; console.log('✅ ' + msg); } else { F++; console.log('❌ ' + msg); } };

// Strip JSONC // and /* */ comments and trailing commas (leaving string contents alone)
function parseJsonc(text) {
  let out = '', i = 0, str = false;
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (str) { out += c; if (c === '\\') { out += n; i += 2; continue; } if (c === '"') str = false; i++; continue; }
    if (c === '"') { str = true; out += c; i++; continue; }
    if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { i = text.indexOf('*/', i + 2) + 2; continue; }
    out += c; i++;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

try {
  const raw = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  const w = parseJsonc(raw);
  ok(w.main === 'src/worker.js' && typeof w.name === 'string' && /^[a-z0-9-]+$/.test(w.name), `wrangler.jsonc: main = src/worker.js, name = ${w.name} (lowercase letters, digits and hyphens only)`);
  ok(w.workers_dev === true && w.preview_urls === false && w.observability?.enabled === true, 'workers_dev on, preview_urls off, observability on');
  ok(/^\d{4}-\d{2}-\d{2}$/.test(w.compatibility_date || ''), `compatibility_date = ${w.compatibility_date}`);
  ok(w.assets?.directory === 'out' && w.assets?.binding === 'ASSETS', 'assets: directory out (build.mjs output), binding ASSETS (used by worker.js)');
  const rwf = w.assets?.run_worker_first || [];
  ok(rwf.includes('/api/*') && rwf.includes('!/api/public/*'), `run_worker_first = ${JSON.stringify(rwf)}: /api/* runs the Worker first, /api/public/* stays with static assets`);
  // The service must equal the name in apps/api/wrangler.jsonc, or the deploy fails with Could not resolve service binding
  const api = parseJsonc(readFileSync(new URL('../../api/wrangler.jsonc', import.meta.url), 'utf8'));
  const svc = Array.isArray(w.services) ? w.services : [];
  const byName = Object.fromEntries(svc.map((s) => [s.binding, s.service]));
  ok(svc.length === 2 && Object.keys(byName).sort().join(',') === 'API,SUMO', `services has exactly two bindings, API and SUMO (worker.js reads env.API, env.SUMO): ${JSON.stringify(svc)}`);
  ok(byName.API === api.name && api.name === 'hackathon-api', `API binds the API Worker: service = ${byName.API}, apps/api/wrangler.jsonc name = ${api.name}`);
  // SUMO binds the Worker in front of the live SUMO container. apps/sumo was written alongside this file; if it has no wrangler.jsonc yet, only the service name is checked
  // hackathon-sumo was deleted after the event: removing the SUMO binding means changing the two-binding check above, these checks and
  // the SUMO binding check in apps/sumo/tests/config.test.mjs in the same commit (see README.md, status after the hackathon)
  ok(byName.SUMO === 'hackathon-sumo', `SUMO binds hackathon-sumo: service = ${byName.SUMO}`);
  const sumoCfg = new URL('../../sumo/wrangler.jsonc', import.meta.url);
  if (existsSync(sumoCfg)) {
    const sumo = parseJsonc(readFileSync(sumoCfg, 'utf8'));
    ok(sumo.name === byName.SUMO, `apps/sumo/wrangler.jsonc name = ${sumo.name}, matching the SUMO binding's service (rename both together)`);
  } else {
    console.log('⏭️  apps/sumo/wrangler.jsonc does not exist yet; skipping the "name = hackathon-sumo" check');
  }
  const conf = readFileSync(new URL('../../../hackathon.conf', import.meta.url), 'utf8');
  const mods = (conf.match(/^DEPLOY_MODULES=(.*)$/m)?.[1] || '').trim().split(/\s+/);
  ok(mods.includes('api') && mods.includes('site') && mods.indexOf('api') < mods.indexOf('site'), `hackathon.conf DEPLOY_MODULES = ${mods.join(' ')}: api comes before site (a binding's target Worker must exist first)`);
  ok(!('vars' in w), 'negative: wrangler.jsonc has no vars (site needs none; secrets live only as wrangler secrets on the API Worker)');

  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  ok(/^\d+\.\d+\.\d+$/.test(pkg.devDependencies?.wrangler || ''), `wrangler version pinned: ${pkg.devDependencies?.wrangler}`);
  ok(/^node build\.mjs && wrangler deploy$/.test(pkg.scripts?.deploy || ''), 'npm run deploy builds first, then wrangler deploy (called by deploy.sh)');
  ok(/^node build\.mjs && wrangler dev --port 8790$/.test(pkg.scripts?.dev || ''), 'npm run dev builds first, port 8790');
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  ok(lock.packages?.['node_modules/wrangler']?.version === pkg.devDependencies.wrangler, `package-lock.json also has wrangler ${pkg.devDependencies.wrangler} (what npm ci installs)`);
} catch (e) {
  F++;
  console.log('❌ the test itself crashed: ' + (e && e.stack));
}

console.log(`${P} passed, ${F} failed`);
process.exit(F ? 1 : 0);
