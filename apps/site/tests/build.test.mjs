// Purpose: test build.mjs: git-tracked files in each module's public/ are copied to <out>/<module>/public/, gitignored and
//          never-added files are not, symlinked modules are skipped, the build refuses to run outside a git repository, the
//          landing page has data-smoke and redirects to /web/public/ when web exists, and no directory is wiped by mistake
// Usage: node tests/build.test.mjs (test.sh runs it); fake repositories live in a temp dir, nothing is written to the real
//        repository and apps/site/out is not touched; the last line is always "N passed, M failed"
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../build.mjs';

let P = 0, F = 0;
const ok = (cond, msg) => { if (cond) { P++; console.log('✅ ' + msg); } else { F++; console.log('❌ ' + msg); } };
const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = join(HERE, '..');
const APPS = join(SITE, '..');
const TMP = mkdtempSync(join(tmpdir(), 'site-build-'));
const quiet = () => {};
const put = (p, s) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s); };
const read = (p) => readFileSync(p, 'utf8');
// When run from a git hook, GIT_DIR / GIT_INDEX_FILE are inherited; drop them so the temp repository really is the temp one
const REPO_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_PREFIX', 'GIT_NAMESPACE'];
const gitEnv = () => { const e = { ...process.env }; for (const k of REPO_ENV) delete e[k]; return e; };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const throwsMsg = (fn) => { try { fn(); return ''; } catch (e) { return String(e && e.message) || '?'; } };
// Every file under one module in the output (relative to public/)
const walk = (d, base = d) => existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(d, e.name), base) : [join(d, e.name).slice(base.length + 1).split(sep).join('/')]) : [];

try {
  // ---- 1. Fake apps/ in a temp git repo: web has an index page, roads has data only, site's own public/ must not be copied, modules without public/ are skipped ----
  const repo = join(TMP, 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, '-c', 'init.defaultBranch=main', 'init', '-q');
  const apps = join(repo, 'apps');
  const tracked = {
    'apps/web/public/index.html': '<!doctype html><title>web</title>',
    'apps/web/public/js/app.js': 'export {}',
    'apps/roads/public/cbd/network.json': '{"version":1}',
    'apps/roads/public/cbd/.gitkeep': '',
    'apps/site/public/secret.html': 'site\'s own public/ must not be served',
    'apps/engine/src/index.js': 'export {}', // no public/
    'apps/README.md': '# apps',
    '.gitignore': 'keys.json\n*.pem\nraw/\nnode_modules/\n',
  };
  for (const [p, s] of Object.entries(tracked)) put(join(repo, p), s);
  git(repo, 'add', '--', ...Object.keys(tracked));
  // Gitignored files (only on the deployer's laptop) and files never git-added: neither may appear in the output
  put(join(apps, 'roads/public/keys.json'), '{"key":"PLACEHOLDER-NOT-A-REAL-KEY"}');
  put(join(apps, 'roads/public/raw/scats-full.csv'), 'site,count\n2921,1\n');
  put(join(apps, 'web/public/dev.pem'), '-----PLACEHOLDER-----');
  put(join(apps, 'web/public/node_modules/x/index.js'), 'export {}');
  put(join(apps, 'roads/public/draft.json'), '{"draft":true}');
  ok(git(repo, 'status', '--porcelain', '--', 'apps/roads/public/keys.json', 'apps/roads/public/raw').trim() === '', 'precondition: keys.json and raw/ are gitignored, so git status cannot see them (deploy.sh\'s clean-tree check would not stop them)');

  const out = join(TMP, 'out1');
  const mods = build({ appsDir: apps, outDir: out, commit: 'abc1234', builtAt: 'T', log: quiet });

  ok(JSON.stringify(mods.map((m) => m.name)) === '["roads","web"]', `only modules with public/ are copied, except site itself (got ${mods.map((m) => m.name).join(', ')})`);
  ok(read(join(out, 'web/public/index.html')) === '<!doctype html><title>web</title>' && existsSync(join(out, 'web/public/js/app.js')), 'web/public/ is copied unchanged to <out>/web/public/ (including subdirectories)');
  ok(read(join(out, 'roads/public/cbd/network.json')) === '{"version":1}', 'roads/public/cbd/network.json is copied unchanged to <out>/roads/public/cbd/');
  ok(!existsSync(join(out, 'roads/public/cbd/.gitkeep')), 'dotfiles (.gitkeep) are not copied');
  ok(!existsSync(join(out, 'site')) && !existsSync(join(out, 'engine')), 'negative: neither site\'s own public/ nor modules without public/ appear in the output');
  ok(!existsSync(join(out, 'roads/public/keys.json')) && !existsSync(join(out, 'roads/public/raw')), 'negative: gitignored keys.json and raw/ do not appear in the output (never published)');
  ok(!existsSync(join(out, 'web/public/dev.pem')) && !existsSync(join(out, 'web/public/node_modules')), 'negative: gitignored *.pem and node_modules/ do not appear in the output');
  ok(!existsSync(join(out, 'roads/public/draft.json')), 'negative: files never git-added are not copied (the output matches a commit exactly)');
  ok(JSON.stringify(walk(join(out, 'roads/public'))) === '["cbd/network.json"]' && JSON.stringify(walk(join(out, 'web/public')).sort()) === '["index.html","js/app.js"]', 'the output holds exactly the git-tracked files');

  const idx = read(join(out, 'index.html'));
  ok(idx.includes('data-smoke'), 'landing index.html contains data-smoke (required by check.sh --e2e)');
  ok(idx.includes("location.replace('/web/public/'") && idx.includes('url=/web/public/'), 'apps/web/public/index.html exists → landing page redirects to /web/public/ (JS plus noscript fallback)');
  ok(/\[\?&\]list/.test(idx), '?list on the landing page skips the redirect and stays on the module list');
  ok(!/localhost|127\.0\.0\.1/i.test(idx), 'negative: the landing page has no localhost / 127.0.0.1 (required by check.sh --e2e)');
  ok(idx.includes('href="/roads/public/cbd/network.json"'), 'a module without index.html (roads) lists file links in the module list');
  ok(!/keys\.json|scats-full|draft\.json/.test(idx), 'negative: the module list has no links to ignored or untracked files');
  ok(idx.includes('abc1234'), 'the landing page carries the build commit, so the live version is identifiable');

  // ---- 2. Symlinked module: apps/zz → a dir outside the repository; skipped with one log line even when the link itself is committed ----
  put(join(TMP, 'outside/public/leak.txt'), 'file outside the repository');
  symlinkSync(join(TMP, 'outside'), join(apps, 'zz'), 'junction');
  put(join(apps, 'yy/src/x.js'), 'export {}');
  symlinkSync(join(TMP, 'outside/public'), join(apps, 'yy/public'), 'junction');
  git(repo, 'add', '--', 'apps/zz', 'apps/yy/public', 'apps/yy/src/x.js');
  const logs = [];
  const out3 = join(TMP, 'out3');
  let mods3 = [];
  const err3 = throwsMsg(() => { mods3 = build({ appsDir: apps, outDir: out3, commit: '', builtAt: 'T', log: (s) => logs.push(String(s)) }); });
  ok(err3 === '', `a symlinked module does not fail the whole build (${err3 || 'ok'})`);
  ok(!existsSync(join(out3, 'zz')) && !mods3.some((m) => m.name === 'zz') && walk(out3).every((f) => !f.endsWith('leak.txt')), 'negative: module dir is a symlink (apps/zz → outside the repository) → not followed, leak.txt is not in the output');
  ok(logs.some((l) => l.includes('zz') && l.includes('skipping')), 'a skipped symlinked module prints one explanatory log line');
  ok(!existsSync(join(out3, 'yy')) && !mods3.some((m) => m.name === 'yy'), 'negative: public/ itself is a symlink (apps/yy/public → outside the repository) → skipped');
  rmSync(join(apps, 'zz'));
  rmSync(join(apps, 'yy'), { recursive: true });

  // ---- 3. Not in a git repository / git not found → refuse to build and keep the previous output ----
  const plain = join(TMP, 'plain');
  put(join(plain, 'apps/roads/public/keys.json'), '{"key":"PLACEHOLDER"}');
  const out4 = join(TMP, 'out4');
  const ceil = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = TMP; // in case the temp dir happens to sit inside a repository
  const err4 = throwsMsg(() => build({ appsDir: join(plain, 'apps'), outDir: out4, commit: '', builtAt: 'T', log: quiet }));
  if (ceil === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = ceil;
  ok(err4.includes('git') && !existsSync(join(out4, 'roads')), `negative: apps/ not in a git repository → error, no build (${err4.split(': ')[0] || 'no error'})`);
  const path0 = process.env.PATH;
  process.env.PATH = join(TMP, 'no-bin');
  const err5 = throwsMsg(() => build({ appsDir: apps, outDir: out, commit: '', builtAt: 'T', log: quiet }));
  process.env.PATH = path0;
  ok(err5.includes('git') && existsSync(join(out, 'index.html')), `negative: git command not found → error, no build, previous output kept (${err5.split(': ')[0] || 'no error'})`);

  // ---- 4. No web: the landing page is the module list, with no redirect ----
  rmSync(join(apps, 'web'), { recursive: true });
  const out2 = join(TMP, 'out2');
  build({ appsDir: apps, outDir: out2, commit: '', builtAt: 'T', log: quiet });
  const idx2 = read(join(out2, 'index.html'));
  ok(idx2.includes('data-smoke') && !idx2.includes('location.replace') && !idx2.includes('http-equiv="refresh"'), 'no apps/web → the landing page is the module list, has data-smoke, no redirect');

  // ---- 5. A rebuild wipes first: leftovers from the last build do not stay in the output ----
  put(join(out2, 'roads/public/stale.json'), '{}');
  build({ appsDir: apps, outDir: out2, commit: '', builtAt: 'T', log: quiet });
  ok(!existsSync(join(out2, 'roads/public/stale.json')), 'a rebuild wipes the output dir first, so deleted files do not stay live');

  // ---- 6. Mistake guards: never wipe a dir the build did not create, never write elsewhere in apps/ ----
  const foreign = join(TMP, 'foreign');
  put(join(foreign, 'keep.txt'), 'do not delete me');
  let threw = false;
  try { build({ appsDir: apps, outDir: foreign, log: quiet }); } catch { threw = true; }
  ok(threw && existsSync(join(foreign, 'keep.txt')), 'negative: output dir non-empty and not created by build.mjs → error, not wiped');
  threw = false;
  try { build({ appsDir: apps, outDir: join(apps, 'roads'), log: quiet }); } catch { threw = true; }
  ok(threw && existsSync(join(apps, 'roads/public/cbd/network.json')), 'negative: output dir pointing at apps/<another module> → error, that module\'s files are still there');
  threw = false;
  try { build({ appsDir: apps, outDir: TMP, log: quiet }); } catch { threw = true; }
  ok(threw && existsSync(join(apps, 'roads')), 'negative: output dir containing apps/ → error');

  // ---- 7. Real repository: every module with public/ is served at /<module>/public/, files = git-tracked files, no ignored file included ----
  const real = join(TMP, 'real');
  const got = build({ outDir: real, log: quiet });
  const isDir = (p) => existsSync(p) && lstatSync(p).isDirectory();
  const want = readdirSync(APPS).filter((m) => m !== 'site' && /^[a-z][a-z0-9-]*$/.test(m) && isDir(join(APPS, m)) && isDir(join(APPS, m, 'public'))).sort();
  ok(JSON.stringify(got.map((m) => m.name)) === JSON.stringify(want), `real repo: served modules = modules under apps/ with public/ (${want.join(', ') || 'none'})`);
  const trackedOf = (m) => git(join(APPS, m, 'public'), 'ls-files', '-z', '--', '.').split('\0')
    .filter((f) => f && !f.split('/').some((s) => s.startsWith('.')) && existsSync(join(APPS, m, 'public', f)) && lstatSync(join(APPS, m, 'public', f)).isFile()).sort();
  ok(got.every((m) => JSON.stringify(walk(join(real, m.name, 'public')).sort()) === JSON.stringify(trackedOf(m.name))), 'real repo: each module\'s output files = tracked files listed by git ls-files (dotfiles excepted)');
  const ignored = git(APPS, 'ls-files', '-z', '-o', '-i', '--exclude-standard', '--', '.').split('\0').filter((f) => /^[a-z][a-z0-9-]*\/public\//.test(f) && !f.startsWith('site/'));
  ok(ignored.every((f) => !existsSync(join(real, f))), `negative: none of the ${ignored.length} gitignored apps/*/public/ files in the real repo is in the output`);
  if (existsSync(join(APPS, 'sim/public/index.html'))) ok(existsSync(join(real, 'sim/public/index.html')), 'real repo: /sim/public/index.html is in the output');
  if (existsSync(join(APPS, 'roads/public/cbd/network.json'))) ok(existsSync(join(real, 'roads/public/cbd/network.json')), 'real repo: /roads/public/cbd/network.json is in the output (interfaces, road network data files)');
  ok(read(join(real, 'index.html')).includes('data-smoke'), 'real repo: the landing page contains data-smoke');

  // ---- 8. CLI: node build.mjs --out <dir> prints what it copied and exits 0 ----
  const cli = join(TMP, 'cli');
  const stdout = execFileSync(process.execPath, [join(SITE, 'build.mjs'), '--out', cli], { encoding: 'utf8', env: gitEnv() });
  ok(existsSync(join(cli, 'index.html')) && /\/[a-z-]+\/public\//.test(stdout) && stdout.includes('✅'), 'CLI node build.mjs --out <dir>: prints how much each module copied and ends with ✅');
} catch (e) {
  F++;
  console.log('❌ the test itself crashed: ' + (e && e.stack));
} finally {
  rmSync(TMP, { recursive: true, force: true });
}

console.log(`${P} passed, ${F} failed`);
process.exit(F ? 1 : 0);
