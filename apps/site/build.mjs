// build.mjs: copies the git-tracked files in every module's public/ to out/<module>/public/, then writes a root index.html (with data-smoke)
// Usage: node build.mjs [--out <dir>] (default apps/site/out, gitignored; wiped before every copy)
// Rules (docs/reference/interfaces.md: each module's public/ is served unchanged at /<module>/public/):
//   every module under apps/ that has a public/ is copied, except site itself
//   🔒 only tracked files listed by `git ls-files` are copied. Gitignored files (keys.json, *.pem, raw/, node_modules/...) and files
//      never git-added are not, or they would go straight from the deployer's laptop to the public web (deploy.sh's clean-tree check
//      cannot see ignored files). No git, or not inside a repository -> refuse to build
//   dotfiles (.gitkeep) and symlinks are skipped; a module dir or public/ that is a symlink, or whose real path is outside apps/,
//      skips the whole module with one log line
//   apps/web/public/index.html exists -> the landing page redirects to /web/public/ (?list stays on the module list); otherwise
//      the landing page is the module list
// No npm dependencies; runs automatically before deploy / dev (package.json).
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SELF = 'site';
export const MAX_FILE = 25 * 1024 * 1024; // Cloudflare static assets: 25 MiB per file
export const MAX_FILES = 20000; // Free plan: maximum static files per Worker
const MODULE_RE = /^[a-z][a-z0-9-]*$/; // directory name = module name (apps/README.md)
const inside = (child, parent) => { const r = relative(parent, child); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };

// git must find the repository from cwd only: drop GIT_DIR / GIT_INDEX_FILE etc. inherited from a git hook, so another repository's index is never read
const REPO_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_PREFIX', 'GIT_NAMESPACE'];
function git(cwd, args) {
  const env = { ...process.env };
  for (const k of REPO_ENV) delete env[k];
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
}
const WHY = 'the build copies only git-tracked files, so gitignored keys and raw data are never published';

// Root of the git repository containing apps/; throws if git is unavailable or apps/ is not in a repository (the caller does not build)
export function repoRoot(appsDir) {
  let top = '';
  try { top = git(appsDir, ['rev-parse', '--show-toplevel']).trim(); } catch (e) {
    if (e && e.code === 'ENOENT') throw new Error(`git command not found: ${WHY}; refusing to build without git`);
    throw new Error(`${appsDir} is not inside a git repository: ${WHY}; refusing to build outside a repository`);
  }
  if (!top) throw new Error(`${appsDir} is not inside a git work tree: ${WHY}; refusing to build`);
  return top;
}

// Copies one module's public/ according to the git index; returns { files: [relative paths], bytes, skipped: [relative paths], untracked: count of files never git-added }
function copyTracked(pub, dst) {
  const acc = { files: [], bytes: 0, skipped: [], untracked: 0 };
  mkdirSync(dst, { recursive: true });
  const realPub = realpathSync(pub);
  const list = (args) => git(pub, ['ls-files', '-z', ...args, '--', '.']).split('\0').filter(Boolean);
  for (const rel of list([]).sort()) {
    const s = join(pub, rel);
    if (isAbsolute(rel) || rel.split('/').some((seg) => seg.startsWith('.'))) { acc.skipped.push(rel); continue; } // dot segment (including ..)
    let st;
    try { st = lstatSync(s); } catch { acc.skipped.push(rel); continue; } // tracked but deleted from the work tree
    if (!st.isFile()) { acc.skipped.push(rel); continue; } // symlink or submodule
    if (!inside(realpathSync(s), realPub)) { acc.skipped.push(rel); continue; } // a parent directory was replaced by a symlink
    if (st.size > MAX_FILE) throw new Error(`${rel} is ${(st.size / 1048576).toFixed(1)} MB, over the Cloudflare limit of 25 MiB per file`);
    const d = join(dst, rel);
    mkdirSync(dirname(d), { recursive: true });
    copyFileSync(s, d);
    acc.files.push(rel);
    acc.bytes += st.size;
  }
  acc.untracked = list(['-o', '--exclude-standard']).length; // only for the log hint: new files must be git-added before they go live
  return acc;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function indexHtml(mods, { commit = '', builtAt = '' } = {}) {
  const hasWeb = mods.some((m) => m.name === 'web' && m.hasIndex);
  const items = mods.map((m) => {
    const root = `/${m.name}/public/`;
    const head = m.hasIndex
      ? `<a href="${esc(root)}">${esc(m.name)}</a>`
      : `<span>${esc(m.name)}</span>`;
    const files = m.hasIndex ? '' : '<ul>' + m.files.slice(0, 12).map((f) => `<li><a href="${esc(root + f)}">${esc(root + f)}</a></li>`).join('') +
      (m.files.length > 12 ? `<li>…plus ${m.files.length - 12} more</li>` : '') + '</ul>';
    return `<li>${head} <small>files: ${m.files.length} · ${(m.bytes / 1024).toFixed(0)} KB</small>${files}</li>`;
  }).join('\n      ');
  // Redirect in JS so /?list can stay on the list; check.sh --e2e only requires GET / to return 200 with data-smoke (it does not follow redirects)
  const redirect = hasWeb
    ? `<script>if (!/[?&]list(=|&|$)/.test(location.search)) location.replace('/web/public/' + location.hash);</script>
<noscript><meta http-equiv="refresh" content="0; url=/web/public/"></noscript>`
    : '';
  return `<!doctype html>
<html lang="en" data-smoke="site">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="build" content="${esc(commit)} ${esc(builtAt)}">
<title>RippleTwin — modules</title>
${redirect}
<style>
  :root { --bg: #fafaf8; --fg: #1d1d1b; --muted: #6b6b66; --link: #0b5cad; }
  @media (prefers-color-scheme: dark) { :root { --bg: #161615; --fg: #ecebe6; --muted: #9a9a93; --link: #7cb4f0; } }
  body { margin: 0; padding: 24px 16px; background: var(--bg); color: var(--fg); font: 16px/1.6 system-ui, sans-serif; }
  main { max-width: 720px; margin: 0 auto; }
  a { color: var(--link); } small, footer { color: var(--muted); }
  ul { padding-left: 1.2em; } li ul { font-size: 14px; word-break: break-all; }
</style>
</head>
<body>
<main>
  <h1>RippleTwin modules</h1>
  <p>${hasWeb ? 'Opening the web app at <a href="/web/public/">/web/public/</a>…' : 'No web app yet (apps/web/public/); listing the published modules.'}</p>
  <ul>
      ${items || '<li>No module has a public/ directory</li>'}
  </ul>
  <p><small>API: <a href="/api/health">/api/health</a></small></p>
  <footer><small>build ${esc(commit || '?')} · ${esc(builtAt)}</small></footer>
</main>
</body>
</html>
`;
}

// appsDir: the apps/ directory; outDir: output directory (wiped first); returns [{ name, files, bytes, skipped, untracked, hasIndex }]
export function build({ appsDir = resolve(HERE, '..'), outDir = join(HERE, 'out'), commit, builtAt, log = console.log } = {}) {
  appsDir = resolve(appsDir); outDir = resolve(outDir);
  repoRoot(appsDir); // check first that git works and apps/ is in a repository; otherwise throw and leave the previous output untouched
  // The output dir is wiped on every build, so guard against mistakes: it must not contain apps/, and inside apps/ it can only be apps/site/out.
  // An existing non-empty dir is wiped only if a previous build created it (its index.html has data-smoke="site")
  const okOut = join(appsDir, SELF, 'out');
  if (inside(appsDir, outDir) || (inside(outDir, appsDir) && !inside(outDir, okOut))) {
    throw new Error(`output dir ${outDir} is unsafe (inside apps/ it can only be apps/${SELF}/out)`);
  }
  if (existsSync(outDir) && readdirSync(outDir).length > 0) {
    const idx = join(outDir, 'index.html');
    if (!existsSync(idx) || !readFileSync(idx, 'utf8').includes('data-smoke="site"')) {
      throw new Error(`output dir ${outDir} is not empty and was not created by build.mjs; refusing to wipe it`);
    }
  }
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const mods = [];
  const realApps = realpathSync(appsDir);
  for (const name of readdirSync(appsDir).sort()) {
    if (name === SELF || !MODULE_RE.test(name)) continue;
    const dir = join(appsDir, name);
    const pub = join(dir, 'public');
    const dirSt = lstatSync(dir);
    if (dirSt.isSymbolicLink()) { log(`  ⚠️ skipping apps/${name}: the module dir is a symlink, not followed`); continue; }
    if (!dirSt.isDirectory() || !existsSync(pub)) continue;
    if (!lstatSync(pub).isDirectory()) { log(`  ⚠️ skipping apps/${name}/public: a symlink or not a directory, not followed`); continue; }
    if (!inside(realpathSync(pub), realApps)) { log(`  ⚠️ skipping apps/${name}/public: its real path is outside apps/`); continue; }
    const r = copyTracked(pub, join(outDir, name, 'public'));
    mods.push({ name, ...r, hasIndex: r.files.includes('index.html') });
    const notes = [r.skipped.length ? `skipped ${r.skipped.join(', ')}` : '', r.untracked ? `not git-added, not copied: ${r.untracked}` : ''].filter(Boolean).join('; ');
    log(`  /${name}/public/  files: ${String(r.files.length).padStart(4)}  ${(r.bytes / 1024).toFixed(0).padStart(6)} KB${notes ? `  (${notes})` : ''}`);
  }
  const total = mods.reduce((n, m) => n + m.files.length, 0) + 1;
  if (total > MAX_FILES) throw new Error(`${total} files in total, over the Cloudflare Free plan limit of ${MAX_FILES}`);
  if (commit === undefined) {
    try { commit = git(appsDir, ['rev-parse', '--short', 'HEAD']).trim(); } catch { commit = ''; }
  }
  if (builtAt === undefined) builtAt = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  writeFileSync(join(outDir, 'index.html'), indexHtml(mods, { commit, builtAt }));
  const web = mods.some((m) => m.name === 'web' && m.hasIndex);
  log(`  /index.html  ${web ? 'redirects to /web/public/ (/?list shows the module list)' : 'module list (no apps/web/public/index.html yet)'}`);
  log(`✅ modules: ${mods.length}, files: ${total} → ${relative(process.cwd(), outDir) || '.'}`);
  return mods;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--out');
  const outDir = i > 0 && process.argv[i + 1] ? resolve(process.argv[i + 1]) : undefined;
  try {
    console.log('build.mjs: git-tracked files in apps/<module>/public/ → out/<module>/public/');
    build({ outDir });
  } catch (e) {
    console.error('❌ ' + e.message);
    process.exit(1);
  }
}
