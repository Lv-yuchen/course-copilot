/**
 * Build the Course Copilot extension into `apps/extension/dist`.
 *
 * ## What it does
 *
 * 1. Compiles `apps/extension/src` using the extension's own TypeScript configuration.
 * 2. Re-bundles `background/service-worker.js` (ESM) and `sidepanel/sidepanel.js` (IIFE) with esbuild.
 * 3. Copies the manifest and every non-TypeScript asset (HTML, CSS) into the output, preserving each file's path
 *    relative to `src` — which is what lets the manifest and the HTML reference `sidepanel/sidepanel.css` directly.
 * 4. Verifies every path the manifest names actually exists, and fails if any does not.
 *
 * ## Who owns which artifact
 *
 * The two stages are not interchangeable, and the split is deliberate:
 *
 * * `content/content-script.js` is **tsc's**. A Manifest V3 static content script is a CLASSIC script, and TypeScript already
 *   emits one; bundling it would risk emitting module syntax into a file the browser parses as a script, which broke the whole
 *   extension once. It also needs no dependencies, so a bundler buys nothing there.
 * * `background/service-worker.js` and `sidepanel/sidepanel.js` are **esbuild's**. They are the entries that will consume
 *   `@course-copilot/core`, and plain `tsc` leaves such an import as a bare specifier that no browser can resolve.
 *
 * The TypeScript stage still runs in full, for two reasons: it typechecks, and it keeps producing the content script. esbuild
 * then OVERWRITES the two files it owns. Collapsing this into a content-only tsconfig is a separate change.
 *
 * ## Why it verifies rather than assumes
 *
 * A build that exits 0 while emitting a layout the manifest cannot point at is a failure this project has hit before: in
 * the abandoned attempt the build was green and the artifact was not loadable. Step 4 is what makes "build succeeded" mean
 * "this directory can be loaded", which is why emitted paths are checked against the manifest rather than hard-coded.
 *
 * The output directory is wiped first, so a stale file can never be mistaken for a fresh build.
 *
 * Usage: node scripts/build-extension.mjs
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const extensionDir = join(repoRoot, 'apps', 'extension');
const srcDir = join(extensionDir, 'src');
const distDir = join(extensionDir, 'dist');
const manifestPath = join(extensionDir, 'manifest.json');

/** Fail loudly with a consistent, greppable prefix. */
function fail(message) {
  console.log(`EXTENSION_BUILD_FAIL: ${message}`);
  process.exit(1);
}

// ------------------------------------------------------------------ compile

if (!existsSync(manifestPath)) fail(`缺少 manifest.json：${manifestPath}`);
if (!existsSync(srcDir)) fail(`缺少源码目录：${srcDir}`);

const tsc = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
if (!existsSync(tsc)) fail(`找不到编译器：${tsc}`);

/** Run the compiler with one of the extension's configs, failing the build on any diagnostic. */
function runTsc(configName, what) {
  const configPath = join(extensionDir, configName);
  if (!existsSync(configPath)) fail(`找不到 TypeScript 配置：${configPath}`);
  try {
    execFileSync(process.execPath, [tsc, '-p', configPath], { cwd: repoRoot, stdio: 'inherit' });
  } catch (error) {
    fail(`${what}失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

/*
 * TYPE CHECK FIRST, over the WHOLE extension.
 *
 * `tsconfig.json` covers every source file and emits nothing, so this is where a helper the worker does not yet import — the
 * memory cache, for instance — is still checked. Typechecking before the wipe also means a type error cannot leave a half-built
 * `dist/` behind.
 */
runTsc('tsconfig.json', 'TypeScript 类型检查');

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

/*
 * THEN EMIT THE ONE FILE tsc OWNS.
 *
 * A dedicated config whose `files` list is the content script plus the two ambient declaration files. It emits exactly
 * `dist/content/content-script.js`, which is why the production script can no longer grow a JavaScript file for every local module
 * a worker happens to import. See `apps/extension/tsconfig.content.json` for why the content script is the only tsc-owned
 * artifact.
 */
runTsc('tsconfig.content.json', '内容脚本编译');

// ------------------------------------------------------------------ bundle

/*
 * The two entries esbuild owns, and the ONLY two.
 *
 * A single-file output per entry is a requirement, not a preference: the manifest names one worker file and the HTML names one
 * panel file, so a split or a chunk would leave a script the browser never loads. `bundle: true` is what inlines workspace
 * dependencies instead of emitting a bare specifier, and `minify`/`sourcemap` stay off because the gates and several tests
 * assert against readable artifact text.
 *
 * `format` differs per entry for a concrete reason: the manifest declares the worker `type: "module"`, so ESM is correct
 * there, while the panel script must still satisfy the classic-script parse the skeleton gate applies to it.
 */
const BUNDLE_TARGETS = [
  { entry: ['src', 'background', 'service-worker.ts'], out: ['background', 'service-worker.js'], format: 'esm' },
  { entry: ['src', 'sidepanel', 'sidepanel.ts'], out: ['sidepanel', 'sidepanel.js'], format: 'iife' },
];

/*
 * The content script is deliberately absent from the list above. This assertion is what keeps it that way: adding it would
 * have to delete this line, which is a visible, reviewable act rather than an accident.
 */
if (BUNDLE_TARGETS.some((target) => target.entry.includes('content-script.ts'))) {
  fail('内容脚本不得交给 esbuild：MV3 静态 content script 必须是 classic script，由 tsc 产出');
}

for (const target of BUNDLE_TARGETS) {
  const entryPoint = join(extensionDir, ...target.entry);
  const outfile = join(distDir, ...target.out);
  if (!existsSync(entryPoint)) fail(`找不到打包入口：${entryPoint}`);
  try {
    await build({
      entryPoints: [entryPoint],
      outfile,
      bundle: true,
      platform: 'browser',
      format: target.format,
      minify: false,
      sourcemap: false,
      // A single self-contained file: no code splitting, no shared chunks, no sidecar assets.
      splitting: false,
      logLevel: 'silent',
    });
  } catch (error) {
    fail(`esbuild 打包失败（${target.out.join('/')}）：${error instanceof Error ? error.message : String(error)}`);
  }
}

// ----------------------------------------------------------------- assemble

cpSync(manifestPath, join(distDir, 'manifest.json'));

/*
 * Assets that the compiler does not emit.
 *
 * Type declarations describe types and must not ship, so `.d.ts` is excluded. Source maps and declarations are already
 * switched off in the TypeScript configuration, so nothing else needs filtering here.
 */
const ASSET_EXTENSIONS = ['.html', '.css'];
let assetCount = 0;

/** Copy assets from src into dist, preserving each file's path relative to src. */
function copyAssets(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const source = join(dir, entry.name);
    if (entry.isDirectory()) {
      copyAssets(source);
      continue;
    }
    if (entry.name.endsWith('.d.ts')) continue;
    if (!ASSET_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) continue;

    const destination = join(distDir, relative(srcDir, source));
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination);
    assetCount += 1;
  }
}
copyAssets(srcDir);

// ------------------------------------------------------------------- verify

const manifest = JSON.parse(readFileSync(join(distDir, 'manifest.json'), 'utf8'));
const problems = [];

/** Every path the manifest names must exist on disk for the browser to load the extension. */
const referenced = [];
if (typeof manifest.background?.service_worker === 'string') referenced.push(manifest.background.service_worker);
if (typeof manifest.side_panel?.default_path === 'string') referenced.push(manifest.side_panel.default_path);
if (typeof manifest.action?.default_popup === 'string') referenced.push(manifest.action.default_popup);
for (const script of manifest.content_scripts ?? []) {
  for (const file of script.js ?? []) referenced.push(file);
  for (const file of script.css ?? []) referenced.push(file);
}
for (const icon of Object.values(manifest.icons ?? {})) referenced.push(icon);

for (const entry of referenced) {
  if (!existsSync(join(distDir, entry))) problems.push(`manifest 引用的文件不存在：${entry}`);
}
if (referenced.length === 0) problems.push('manifest 没有引用任何文件，产物不完整');

if (manifest.manifest_version !== 3) {
  problems.push(`manifest_version 应为 3，实际 ${String(manifest.manifest_version)}`);
}

/*
 * Only `sidePanel` is permitted at this step. The check names the allowed set rather than listing forbidden permissions,
 * so a permission added later has to be a deliberate edit here as well — it cannot slip in silently.
 */
const ALLOWED_PERMISSIONS = ['sidePanel'];
for (const permission of manifest.permissions ?? []) {
  if (!ALLOWED_PERMISSIONS.includes(permission)) {
    problems.push(`未预期的权限：${permission}（本步只允许 ${ALLOWED_PERMISSIONS.join(', ')}）`);
  }
}
/*
 * Host access is an ALLOWLIST with exactly one entry, naming the single public site this extension may reach.
 *
 * It used to be asserted empty. That was correct while the extension read no remote data at all, and it is superseded rather than
 * relaxed: the entry is now required to be present VERBATIM, so adding a second host, or dropping this one, fails the build.
 *
 * No WHU host may appear. The review corpus is public; the course-selection system is not, and the extension has no business
 * asking the browser for access to it.
 */
const ALLOWED_HOST_PERMISSIONS = ['https://whucourses.cn/*'];
if (JSON.stringify(manifest.host_permissions) !== JSON.stringify(ALLOWED_HOST_PERMISSIONS)) {
  problems.push(
    `host_permissions 必须恰好为 ${JSON.stringify(ALLOWED_HOST_PERMISSIONS)}，实际 ${JSON.stringify(manifest.host_permissions)}`,
  );
}
for (const pattern of manifest.host_permissions ?? []) {
  if (/whu\.edu\.cn|jwgl/iu.test(pattern)) {
    problems.push(`host_permissions 不得包含武大域名：${pattern}`);
  }
}

/*
 * The side panel's HTML is checked for the two things that would break it silently in the browser: an inline script (which
 * the extension Content Security Policy refuses) and a missing stylesheet reference.
 */
const sidePanelPath = manifest.side_panel?.default_path;
if (typeof sidePanelPath === 'string' && existsSync(join(distDir, sidePanelPath))) {
  const html = readFileSync(join(distDir, sidePanelPath), 'utf8');
  const htmlPath = dirname(join(distDir, sidePanelPath));
  if (/<script(?![^>]*\bsrc=)/iu.test(html)) {
    problems.push('side panel HTML 含内联 <script>，扩展 CSP 会拒绝执行');
  }
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/gu)) {
    const target = match[1];
    if (target === undefined || /^[a-z]+:/iu.test(target)) continue;
    if (!existsSync(join(htmlPath, target))) problems.push(`side panel HTML 引用的文件不存在：${target}`);
  }
}

if (problems.length > 0) fail(problems.join('；'));

// ------------------------------------------------------------------- report

/** List every emitted file, relative to dist. */
function emitted(dir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...emitted(join(dir, entry.name), relativePath));
    else out.push(relativePath);
  }
  return out.sort();
}

console.log('');
console.log(`  产物目录: ${distDir}`);
for (const file of emitted(distDir)) console.log(`    ${file}`);
console.log(`  资产文件: ${assetCount} 个（html/css）`);
console.log(`  name    : ${manifest.name}`);
console.log(`  version : ${manifest.version}`);
console.log(`  权限    : ${manifest.permissions === undefined ? '(无)' : JSON.stringify(manifest.permissions)}`);
console.log(`  宿主权限: ${manifest.host_permissions === undefined ? '(无)' : JSON.stringify(manifest.host_permissions)}`);
console.log('');
console.log('EXTENSION_BUILD_OK');