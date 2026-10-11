// Purpose: checks the key settings in wrangler.jsonc / Dockerfile / package.json: a standard-4 container, a single instance, build context apps/
//          (the image carries the real-network roads data), no workers.dev entry point, the Durable Object binding and migration, a rate limit
//          of 3 per 60 s, image environment matching worker.js, the site binding name, and sumo kept out of DEPLOY_MODULES
// Usage: node tests/config.test.mjs (test.sh runs it); no npm install, no Docker; the last line is always "N passed, M failed"
import { readFileSync, existsSync } from 'node:fs';
import { CONTAINER_ENV } from '../src/proxy.js';

let P = 0, F = 0;
const ok = (cond, msg) => { if (cond) { P++; console.log('✅ ' + msg); } else { F++; console.log('❌ ' + msg); } };
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

// Strip JSONC // and /* */ comments and trailing commas (skipping string contents); same copy as in apps/site/tests/config.test.mjs
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
  const w = parseJsonc(read('../wrangler.jsonc'));
  const site = parseJsonc(read('../../site/wrangler.jsonc'));

  // ---- 1. The Worker itself ----
  ok(w.name === 'hackathon-sumo' && w.main === 'src/worker.js', `name = ${w.name}, main = ${w.main}`);
  ok(w.compatibility_date === site.compatibility_date, `compatibility_date same as the site: ${w.compatibility_date}`);
  ok(w.workers_dev === false && w.preview_urls === false, 'workers_dev off, preview_urls off: no public URL of its own, reachable only through the site service binding');
  ok(!('routes' in w) && !('route' in w) && !('assets' in w), 'reverse: no routes / route / assets (no domain attached, no static files hosted)');
  ok(w.observability?.enabled === true, 'observability on (container start / stop and forwarding errors show up in Workers Logs)');
  ok(!('vars' in w), 'reverse: no vars in wrangler.jsonc (container environment lives in envVars in worker.js; no secrets)');

  // ---- 2. Container ----
  const cs = Array.isArray(w.containers) ? w.containers : [];
  const c = cs[0] || {};
  ok(cs.length === 1 && c.class_name === 'SumoContainer', `exactly one container, class_name = ${c.class_name}`);
  ok(c.image === './Dockerfile' && existsSync(new URL('../Dockerfile', import.meta.url)), `image = ${c.image} (file exists)`);
  ok(c.image_build_context === '..' && existsSync(new URL('../../web/tools/sumo/serve.py', import.meta.url)) && existsSync(new URL('../../roads/public/cbd/network.json', import.meta.url)),
    `image_build_context = ${c.image_build_context} (= apps/, containing web/tools/sumo/serve.py and roads/public/cbd/)`);
  ok(c.instance_type === 'standard-4', `instance_type = ${c.instance_type} (4 vCPU, the Cloudflare maximum: the hour's scenarios run in parallel)`);
  ok(c.max_instances === 1, `max_instances = ${c.max_instances} (job state lives in a single instance)`);

  // ---- 3. Durable Object binding + migration ----
  const dob = w.durable_objects?.bindings || [];
  ok(dob.length === 1 && dob[0].name === 'SUMO_CONTAINER' && dob[0].class_name === 'SumoContainer', `durable_objects: ${JSON.stringify(dob)}`);
  const mig = w.migrations || [];
  ok(mig.length === 1 && mig[0].tag === 'v1' && JSON.stringify(mig[0].new_sqlite_classes) === '["SumoContainer"]' && !mig[0].new_classes,
    `migrations: ${JSON.stringify(mig)} (containers need a SQLite-backed DO)`);
  ok(!('exports' in w), 'reverse: DO not declared through exports (mutually exclusive with migrations)');

  // ---- 4. Rate limit ----
  const rl = w.ratelimits || [];
  ok(rl.length === 1 && rl[0].name === 'SUMO_RL' && rl[0].simple?.limit === 3 && rl[0].simple?.period === 60, `ratelimits: ${JSON.stringify(rl)} (3 per IP per minute)`);
  ok(/^[1-9]\d*$/.test(rl[0]?.namespace_id || ''), `namespace_id is a positive integer string: ${rl[0]?.namespace_id}`);

  // ---- 5. worker.js matches the configuration ----
  const src = read('../src/worker.js');
  ok(/export class SumoContainer extends Container\b/.test(src), 'worker.js exports class SumoContainer extends Container (= containers[0].class_name)');
  ok(src.includes("getContainer(env.SUMO_CONTAINER, 'main')"), "worker.js uses getContainer(env.SUMO_CONTAINER, 'main'): one fixed instance");
  ok(/defaultPort = 8080;/.test(src) && /sleepAfter = '12h';/.test(src), "defaultPort = 8080, sleepAfter = '12h'");

  // ---- 6. Dockerfile ----
  const df = read('../Dockerfile');
  ok(/^FROM python:3\.\d+-slim$/m.test(df), 'Dockerfile FROM python:3.x-slim');
  const copies = [...df.matchAll(/^COPY\s+(.+)$/gm)].flatMap((m) => m[1].trim().split(/\s+/).slice(0, -1));
  const missing = copies.filter((p) => !existsSync(new URL('../../' + p, import.meta.url)));
  ok(copies.length >= 4 && missing.length === 0, `all ${copies.length} COPY sources exist under apps/ (the build context)${missing.length ? '; missing: ' + missing.join(' ') : ''}`);
  // real network (contract v2): build_real.py + the three roads inputs go into the image, SUMO_ROADS_DIR points at the COPY target; routeSampler needs numpy + scipy
  const need = ['web/tools/sumo/serve.py', 'web/tools/sumo/build_demo.py', 'web/tools/sumo/build_real.py',
    'roads/public/cbd/network.json', 'roads/public/cbd/signals.json', 'roads/public/cbd/flows.json'];
  ok(need.every((p) => copies.includes(p)), `COPYs the files the real network needs: ${need.filter((p) => !copies.includes(p)).join(' ') || 'all present'}`);
  const roadsCopy = (df.match(/^COPY[ \t]+roads\/public\/cbd\/\S+(?:[ \t]+\S+)*[ \t]+(\S+)$/m) || [])[1];
  const roadsEnv = (df.match(/^ENV [^\n]*\bSUMO_ROADS_DIR=(\S+)/m) || [])[1];
  ok(roadsCopy && roadsEnv && ('/app/' + roadsCopy).replace(/\/$/, '') === roadsEnv.replace(/\/$/, ''),
    `ENV SUMO_ROADS_DIR = the directory the roads files are copied to (WORKDIR /app + ${roadsCopy})`);
  ok(/^WORKDIR \/app$/m.test(df) && /pip install [^\n]*numpy==[\d.]+[^\n]*scipy==[\d.]+/.test(df) && /import numpy, scipy\.optimize/.test(df),
    'pip installs pinned numpy + scipy and the build checks they import (routeSampler --optimize needs them)');
  ok(/import build_real; build_real\.validate_real/.test(df) && /build_real\.py --prepare-only/.test(df) && /^ENV [^\n]*SUMO_REAL_CACHE=\/app\/\S+/m.test(df),
    'the build checks that build_real imports and validate_real works, and bakes the real-network cache into the image with --prepare-only (SUMO_REAL_CACHE under /app, not in /tmp, which gets wiped)');
  const envLine = (df.match(/^ENV [\s\S]*?[^\\]\n/m) || [''])[0];
  const envOk = Object.entries(CONTAINER_ENV).every(([k, v]) => new RegExp(`\\b${k}=${v.replace(/\./g, '\\.')}(\\s|$)`).test(envLine));
  ok(envOk, `Dockerfile ENV matches envVars in worker.js (CONTAINER_ENV): ${JSON.stringify(CONTAINER_ENV)}`);
  ok(!/ALLOW_ORIGINS=|SUMO_API_KEY=|SUMO_POSTS_PER_MIN=/.test(df), 'reverse: the image sets no ALLOW_ORIGINS / SUMO_API_KEY / SUMO_POSTS_PER_MIN (the Worker strips Origin and rate-limits per IP)');
  ok(/^EXPOSE 8080$/m.test(df) && /CMD \["python", "web\/tools\/sumo\/serve\.py"\]/.test(df), 'EXPOSE 8080, CMD runs web/tools/sumo/serve.py');
  ok(/ldd .*grep 'not found'/.test(df) && /Eclipse SUMO sumo 1\.27\.1/.test(df), 'the build checks shared libraries (ldd) and SUMO version 1.27.1');
  ok(/requirements\.txt/.test(df) && read('../../web/tools/sumo/requirements.txt').includes('eclipse-sumo==1.27.1'), 'pip installs apps/web/tools/sumo/requirements.txt (eclipse-sumo==1.27.1)');
  // the build-time minimal end-to-end run must use parameters within the public ranges: clearance_s 600–2400, demand_scale 0.1–1.2 (< 600 / ≥ 1.5 always failed in testing)
  const check = (df.match(/RUN python web\/tools\/sumo\/build_demo\.py(?:[^\n]*\\\n)*[^\n]*/) || [''])[0]; // including \ continuation lines
  const cl = Number((check.match(/--clearance-s (\d+)/) || [])[1]);
  const ds = (check.match(/--demand-scale ([\d.]+)/) || [])[1];
  ok(check && cl >= 600 && cl <= 2400 && (ds === undefined || (Number(ds) >= 0.1 && Number(ds) <= 1.2)) && /test -f \/tmp\/check-out\/index\.json/.test(check),
    `the build runs build_demo.py once (clearance ${cl} s${ds ? ', demand ' + ds : ''}) and checks index.json`);

  // ---- 7. package.json / lock ----
  const pkg = JSON.parse(read('../package.json'));
  const sitePkg = JSON.parse(read('../../site/package.json'));
  ok(pkg.type === 'module' && pkg.private === true, 'package.json: type module, private');
  ok(pkg.scripts?.dev === 'wrangler dev --port 8791' && pkg.scripts?.test === 'bash test.sh' && pkg.scripts?.deploy === 'wrangler deploy', `scripts: ${JSON.stringify(pkg.scripts)}`);
  ok(pkg.devDependencies?.wrangler === sitePkg.devDependencies?.wrangler && /^\d+\.\d+\.\d+$/.test(pkg.devDependencies.wrangler), `wrangler pinned and the same as the site: ${pkg.devDependencies?.wrangler}`);
  const cc = pkg.dependencies?.['@cloudflare/containers'] || '';
  ok(/^\d+\.\d+\.\d+$/.test(cc), `@cloudflare/containers pinned: ${cc}`);
  const lock = JSON.parse(read('../package-lock.json'));
  ok(lock.packages?.['node_modules/wrangler']?.version === pkg.devDependencies.wrangler && lock.packages?.['node_modules/@cloudflare/containers']?.version === cc,
    'wrangler and @cloudflare/containers versions in package-lock.json match package.json (what npm ci installs)');

  // ---- 8. Consistent with the rest of the repo ----
  const svc = (site.services || []).find((s) => s.binding === 'SUMO');
  ok(svc && svc.service === w.name, `site service binding SUMO → ${svc && svc.service} (= this Worker's name)`);
  const conf = read('../../../hackathon.conf');
  const mods = (conf.match(/^DEPLOY_MODULES=(.*)$/m)?.[1] || '').trim().split(/\s+/);
  ok(!mods.includes('sumo'), `reverse: hackathon.conf DEPLOY_MODULES = ${mods.join(' ')}, without sumo (deploy.sh all would fail on a machine without Docker)`);
  const readme = read('../README.md');
  ok(/^Owner: @Zemmeng/m.test(readme), 'README.md has Owner: @Zemmeng');
  const reg = read('../../README.md');
  ok(/^\| sumo \| @Zemmeng \|.*\| 8791 \|/m.test(reg), 'the apps/README.md registry lists sumo on port 8791 (= the npm run dev port)');
  const owners = read('../../../.github/CODEOWNERS');
  ok(/^\/apps\/sumo\/\s+@Zemmeng\s*$/m.test(owners), '.github/CODEOWNERS has /apps/sumo/ @Zemmeng');
} catch (e) {
  F++;
  console.log('❌ the test itself crashed: ' + (e && e.stack));
}

console.log(`${P} passed, ${F} failed`);
process.exit(F ? 1 : 0);
