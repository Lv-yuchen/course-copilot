/**
 * Static verification of the built extension at `apps/extension/dist`.
 *
 * ## Scope
 *
 * Static only, with no browser involved: the manifest parses, is manifest v3, carries only the permissions this step
 * allows, and every path it names exists on disk. The emitted JavaScript is checked to be valid UTF-8 and syntactically
 * valid, because a service worker or panel script that cannot be parsed fails in the browser in a way that looks like
 * "nothing happened".
 *
 * ## Why the byte-level checks exist
 *
 * Console output in this environment mangles non-ASCII text through the display codepage, so mojibake on screen means
 * nothing either way. The only trustworthy statement about the encoding is made against the file's bytes and a round-trip
 * through UTF-8, which is what this does.
 *
 * ## Why permissions are checked against an allow-list
 *
 * Listing forbidden permissions would silently accept anything not on the list. Naming what IS allowed means a new
 * permission requires editing this file, so it cannot appear unnoticed.
 *
 * Usage: node scripts/verify-extension-skeleton.mjs
 */
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const distDir = join(repoRoot, 'apps', 'extension', 'dist');

/**
 * The artifact as a JavaScript parser would see it, with `\uXXXX` escapes resolved.
 *
 * ## Why some checks read this instead of the raw file
 *
 * The worker and panel are now bundled by esbuild, which re-encodes every non-ASCII literal as a `\uXXXX` escape. The panel's
 * Chinese UI wording therefore appears in the artifact as `"\u5DF2\u8BC6\u522B WHU ..."` — the SAME string at runtime, spelled
 * differently in the file. An assertion that searches for the literal text is really asking "does the panel say this to the
 * user?", so it must read the decoded form or it would report a wording change that never happened.
 *
 * This is a spelling difference, not a contract change. It is proven rather than assumed: the escaped form is decoded here and
 * the decoded text still contains every wording the checks look for, so the check keeps its original meaning. Text-level checks
 * about CODE SHAPE (identifiers, message types, call forms, forbidden APIs) intentionally keep reading the raw artifact, since
 * those are about the program rather than about what it displays.
 *
 * @param text - raw artifact contents.
 * @returns the same text with Unicode escapes replaced by the characters they denote.
 */
function decodedText(text) {
  return text
    .replace(/\\u\{([0-9a-fA-F]+)\}/gu, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/gu, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

/** The single selector the content script is permitted to query. */
const COURSE_PANEL_SELECTOR = 'div.panel.panel-info';

/** The only permissions this step permits. */
const ALLOWED_PERMISSIONS = ['sidePanel'];

/** Tokens whose presence in emitted code would mean out-of-scope behaviour. */
/*
 * Tokens whose presence in emitted code would mean out-of-scope behaviour.
 *
 * `sendMessage`/`onMessage` were on this list while the extension had no messaging at all. They were removed when the page
 * identity bridge made messaging a requirement — an entry left behind would have reported the intended design as a
 * violation, which is the check-becomes-stale failure this project has hit repeatedly.
 *
 * `fetch` and `whucourses` left this list in 16F-C for exactly the same reason: the worker now BUNDLES the review provider, whose
 * code contains a `fetch` reference and the `whucourses.cn` origin. That presence is the wiring this step exists to produce, so
 * keeping those tokens here would report the intended design as a violation.
 *
 * What replaces them is not a weaker check but a narrower one: the worker's own SOURCE is asserted below to call no `fetch` and to
 * name no query method, and the runtime harness proves that initialization performs zero network requests. `localStorage` and
 * `indexedDB` stay forbidden everywhere — nothing in this extension may persist, and the provider has no reason to.
 */
const FORBIDDEN_IN_CODE = ['XMLHttpRequest', 'localStorage', 'indexedDB', 'jwgl', 'recommend'];

const checks = [];
/** Record one check result. */
function check(label, ok, detail = '') {
  checks.push({ label, ok, detail });
}

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

// -------------------------------------------------------------- existence ----

const manifestPath = join(distDir, 'manifest.json');
check('apps/extension/dist/manifest.json 存在', existsSync(manifestPath));

if (!existsSync(manifestPath)) {
  for (const { label, ok, detail } of checks) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `  (${detail})`}`);
  console.log('');
  console.log('EXTENSION_SKELETON_FAIL: 产物缺失，请先运行 npm run extension:build');
  process.exit(1);
}

// --------------------------------------------------------------- manifest ----

const manifestBytes = readFileSync(manifestPath);
const manifestText = manifestBytes.toString('utf8');

check('manifest 无 BOM', !(manifestBytes[0] === 0xEF && manifestBytes[1] === 0xBB && manifestBytes[2] === 0xBF));
check('manifest 是合法 UTF-8（无替换字符）', !manifestText.includes('\uFFFD'));

let manifest = null;
try {
  manifest = JSON.parse(manifestText);
} catch (error) {
  check('manifest JSON 可解析', false, error instanceof Error ? error.message : String(error));
}
check('manifest JSON 可解析', manifest !== null);

if (manifest !== null) {
  check('manifest_version === 3', manifest.manifest_version === 3, String(manifest.manifest_version));
  check('name === "Course Copilot"', manifest.name === 'Course Copilot', String(manifest.name));
  check('version 存在', typeof manifest.version === 'string' && manifest.version.length > 0, String(manifest.version));
  check('description 存在且无乱码', typeof manifest.description === 'string'
    && manifest.description.length > 0
    && !manifest.description.includes('\uFFFD'));

  // ---- permissions: allow-list, and host access must remain absent ----
  const declared = manifest.permissions ?? [];
  check('permissions 全部在允许列表内', declared.every((permission) => ALLOWED_PERMISSIONS.includes(permission)),
    JSON.stringify(declared));
  check('permissions 只声明了 sidePanel', JSON.stringify([...declared].sort()) === JSON.stringify([...ALLOWED_PERMISSIONS].sort()),
    JSON.stringify(declared));
  /*
   * Host access is an ALLOWLIST of exactly one entry.
   *
   * It used to be asserted ABSENT, which was correct while the extension read no remote data. 16G-A supersedes that: the entry is
   * now required verbatim, so a second host?or a missing one?fails here. The assertion is an exact match rather than a substring
   * test, because "contains whucourses" would accept `https://whucourses.cn.evil.example/*`.
   */
  const hostPermissions = manifest.host_permissions ?? [];
  check('host_permissions 恰好为 ["https://whucourses.cn/*"]',
    JSON.stringify(hostPermissions) === JSON.stringify(['https://whucourses.cn/*']),
    JSON.stringify(hostPermissions));
  check('host_permissions 不含任何武大域名',
    hostPermissions.every((pattern) => !/whu\.edu\.cn|jwgl/iu.test(pattern)),
    JSON.stringify(hostPermissions));
  check('host_permissions 不含其它站点',
    hostPermissions.every((pattern) => pattern === 'https://whucourses.cn/*'),
    JSON.stringify(hostPermissions));
  check('optional_permissions 未声明', manifest.optional_permissions === undefined);
  check('optional_host_permissions 未声明', manifest.optional_host_permissions === undefined);

  // ---- out-of-scope features must not be present at this step ----
/*
   * This check asserted content_scripts was ABSENT while the extension read no page. It is inverted rather than deleted,
   * because the statement it makes — "the extension touches exactly one page, and this is which one" — is still worth
   * holding true. The exactness of the match is verified in its own section below.
   */
  check('content_scripts 已声明且只有一个', Array.isArray(manifest.content_scripts) && manifest.content_scripts.length === 1);
  check('无 declarative_net_request', manifest.declarative_net_request === undefined);
  check('无 web_accessible_resources', manifest.web_accessible_resources === undefined);
  check('无 externally_connectable', manifest.externally_connectable === undefined);

  // ---- side panel wiring ----
  check('side_panel 已声明', manifest.side_panel !== undefined);
  check('side_panel.default_path 指向 sidepanel/sidepanel.html',
    manifest.side_panel?.default_path === 'sidepanel/sidepanel.html', String(manifest.side_panel?.default_path));
  check('background.service_worker 已声明', typeof manifest.background?.service_worker === 'string');
  check('background 声明为 ES module', manifest.background?.type === 'module');

  // ---- every referenced path must exist ----
  const referenced = [];
  if (typeof manifest.background?.service_worker === 'string') referenced.push(manifest.background.service_worker);
  if (typeof manifest.side_panel?.default_path === 'string') referenced.push(manifest.side_panel.default_path);
  if (typeof manifest.action?.default_popup === 'string') referenced.push(manifest.action.default_popup);
  for (const script of manifest.content_scripts ?? []) {
    for (const file of script.js ?? []) referenced.push(file);
    for (const file of script.css ?? []) referenced.push(file);
  }
  for (const icon of Object.values(manifest.icons ?? {})) referenced.push(icon);

  let missing = 0;
  for (const entry of referenced) {
    const present = existsSync(join(distDir, entry));
    if (!present) missing += 1;
    console.log(`  ${present ? 'PASS' : 'FAIL'}  引用文件存在: ${entry}`);
  }
  check('manifest 引用的文件全部存在', missing === 0 && referenced.length > 0,
    `引用 ${referenced.length} 个，缺失 ${missing} 个`);
}

// ------------------------------------------------------------ side panel ----

/**
 * The course-card renderer's source, read ONCE at module scope.
 *
 * Read here rather than inside the panel block, because two separate groups of checks consult it — the shape of the card area, and the rule that the renderer
 * consumes the frozen presentation model instead of reaching into a course object — and a second read would be a second thing to keep in step.
 */
const cardRendererSource = readFileSync(join(distDir, '..', 'src', 'sidepanel', 'course-cards.ts'), 'utf8');
/**
 * The same file with comments removed.
 *
 * Used by every check that searches for an IDENTIFIER, because the prose legitimately names the very things those checks forbid: the rationale explains why the
 * evaluator must not build `innerHTML`, and `title` is both the card's own heading property and the page field the identity sample originally banned. A raw text
 * search flags the explanation rather than a violation.
 */
const cardRendererCode = cardRendererSource.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1');

const sidePanelDir = join(distDir, 'sidepanel');
for (const file of ['sidepanel.html', 'sidepanel.css', 'sidepanel.js']) {
  check(`sidepanel/${file} 存在`, existsSync(join(sidePanelDir, file)));
}

const htmlPath = join(sidePanelDir, 'sidepanel.html');
if (existsSync(htmlPath)) {
  const htmlBytes = readFileSync(htmlPath);
  const html = htmlBytes.toString('utf8');

  check('side panel HTML 是合法 UTF-8（无替换字符）', !html.includes('\uFFFD'));
  check('side panel HTML 声明 charset=utf-8', /charset=["']?utf-8/iu.test(html));

  /*
   * The extension Content Security Policy forbids inline script, so an inline <script> would be refused at runtime with
   * only a console error to show for it. Checked here because it is a build-time fact.
   */
  check('side panel HTML 无内联 <script>', !/<script(?![^>]*\bsrc=)/iu.test(html));
  check('side panel HTML 引用了外部模块脚本', /<script[^>]*type="module"[^>]*src="sidepanel\.js"/iu.test(html));
  check('side panel HTML 引用了样式表', /<link[^>]*rel="stylesheet"[^>]*href="sidepanel\.css"/iu.test(html));

  // Every relative src/href must resolve inside dist.
  let unresolved = 0;
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/gu)) {
    const target = match[1];
    if (target === undefined || /^[a-z]+:/iu.test(target)) continue;
    if (!existsSync(join(sidePanelDir, target))) {
      unresolved += 1;
      console.log(`  FAIL  side panel HTML 引用的文件不存在: ${target}`);
    }
  }
  check('side panel HTML 中的相对引用全部存在', unresolved === 0);

  // The required visible copy.
  check('side panel 显示 "Course Copilot"', html.includes('Course Copilot'));
  check('side panel 显示 "Browser Extension Development"', html.includes('Browser Extension Development'));
  /*
   * The static placeholder was replaced by the page-identity line, so that string is deliberately gone.
   *
   * The two wordings live in DIFFERENT files, which an earlier version of this check got wrong: the initial HTML carries
   * only the non-committal wording, and the "identified" wording is a constant in the panel script that gets written into
   * the element at runtime. Checking the HTML for both reported a failure for correct code.
   */
  check('side panel HTML 初始状态为未检测到', html.includes('当前未检测到支持的 WHU 自主选课页面'));
  check('side panel HTML 未预先声称已识别', !html.includes('已识别 WHU 自主选课页面'));

  const panelScriptPath = join(sidePanelDir, 'sidepanel.js');
  if (existsSync(panelScriptPath)) {
    /*
     * Read DECODED: the bundler escapes non-ASCII literals, so the raw file spells this wording as `\uXXXX`. See
     * `decodedText` for why that is a spelling difference and not a wording change.
     */
    const panelScript = decodedText(readFileSync(panelScriptPath, 'utf8'));
    check('panel 脚本含已识别页面文案', panelScript.includes('已识别 WHU 自主选课页面'));
    check('panel 脚本含未检测到页面文案', panelScript.includes('当前未检测到支持的 WHU 自主选课页面'));
  }

  /*
   * UPDATED IN 16J-PREUI-E4-C2-B3-A. `推荐` and `评价` moved out of the blanket ban, for the same reason `教师` did in C2-A: the panel now has a recommendation
   * result area, and it cannot report a review-source state, a recommendation count or an evidence-insufficiency count without naming them. Banning the words
   * would ban the feature.
   *
   * What the ban was protecting is NOT the words. It was that the panel showed no course-level content: no preference or filter controls, no credit values and no
   * course count scraped from the page. Those are asserted directly below, where they actually apply.
   */
  /*
   * UPDATED IN PRE-RELEASE-UX-A18. '偏好' was on this list because the panel had no preference UI and the word implied one. The product owner asked for that
   * UI back, so the word is now the feature's own name and banning it would ban the feature. What the ban protected — that no course-level value is scraped
   * from the page and shown as a fact — still holds for the two that remain.
   */
  for (const token of ['学分', '课程数']) {
    check(`side panel 不含业务文案「${token}」`, !html.includes(token));
  }
  /*
   * UPDATED IN PRE-RELEASE-UX-A18. These two rules banned every preference control and every input element, which held while the panel had none. The product
   * owner asked for the four importance sliders back, so the rules become the exact shape that was approved rather than the absence of a feature: four range
   * inputs with the frozen 0..10 bounds, one reset, and no other kind of control anywhere.
   *
   * A `filter` id stays banned outright: the availability filter is the PAGE's own, and a panel-side one would be a second filter the engine never sees.
   */
  const preferenceSliders = [...html.matchAll(/<input[^>]*id="preference-([A-Za-z]+)"[^>]*>/gu)];
  check('panel 恰有四个偏好滑杆，且 id 来自四个维度',
    preferenceSliders.length === 4
    && preferenceSliders.map((match) => match[1]).sort().join(',') === 'attendanceFriendliness,gradeFriendliness,overallScore,workloadFriendliness');
  check('每个偏好滑杆是 0..10 整数档的 range',
    preferenceSliders.length === 4
    && preferenceSliders.every((match) => /type="range"/u.test(match[0]) && /min="0"/u.test(match[0]) && /max="10"/u.test(match[0]) && /step="1"/u.test(match[0])));
  check('panel 无筛选控件（filter 只能是页面的）', !/id="[^"]*filter[^"]*"/iu.test(html));
  check('panel 的输入类元素只有那四个 range（无 select/textarea，无提交类 input）',
    !/<(?:select|textarea)\b/iu.test(html)
    && [...html.matchAll(/<input[^>]*>/gu)].every((match) => /type="range"/u.test(match[0])));
  /*
   * And the course-card absence is stated as its own rule: the result area reports a SUMMARY, and how an individual course is presented — teacher text, score,
   * credits, seats, grade aggregates — is a separate step that has not happened.
   */
  /*
   * The course-card area, which this step adds.
   *
   * The protection is no longer "there are no cards" — there are. It is that the cards are display-only, that their text is never assembled as markup, and that
   * each of the three kinds renders exactly the modules its canonical entry has: a rated course has no confidence, no evidence tier and no grade aggregate, and an
   * insufficient one has no score at all. Rendering an empty module for any of those would tell a reader the extension checked and found nothing.
   *
   * Read once at module scope, so the checks below and the field-access checks further down share one read of the renderer.
   */
  check('panel 有课程卡片区域', /id="cards-recommended"/u.test(html) && /id="cards-rated"/u.test(html) && /id="cards-insufficient"/u.test(html));
  /*
   * UPDATED IN PRE-RELEASE-UX-A13: scoped to the three CARD LISTS rather than the whole cards area.
   *
   * The rated section now carries a collapse button in its HEADER, which is a deliberate disclosure control and not an operation on a course. The contract this
   * check protects is that a CARD holds no action control — the extension performs no course operation — so it is applied where a card actually lives: the
   * document must contain no control inside any of the three lists.
   */
  check('卡片清单内无任何操作控件（button/a/input），卡片仍是只读展示', (() => {
    for (const listId of ['card-list-recommended', 'card-list-rated', 'card-list-insufficient']) {
      const start = html.indexOf(`id="${listId}"`);
      if (start < 0) return false;
      const list = html.slice(start, html.indexOf('</ol>', start));
      if (/<(?:button|a|input|select|textarea)\b/iu.test(list)) return false;
    }
    return true;
  })());
  /*
   * And the ONE disclosure control that IS allowed in the cards area is named, so a second interactive element cannot appear beside it unnoticed.
   */
  check('卡片区内的唯一控件是 rated 折叠按钮，且状态在 DOM 中',
    /<button[^>]*id="rated-toggle"[^>]*aria-expanded="false"[^>]*aria-controls="rated-cards"/u.test(html));
  check('卡片渲染器不使用 innerHTML',
    !cardRendererCode.includes('innerHTML') && !cardRendererCode.includes('insertAdjacentHTML') && !cardRendererCode.includes('outerHTML'));
  check('卡片渲染器不出现风险调整分',
    !cardRendererCode.includes('riskAdjustedScore'));
  check('卡片渲染器的教师文本只来自 presentation',
    cardRendererCode.includes('presentation.teacher') && !cardRendererCode.includes('teacherSet'));
  check('卡片渲染器不排序',
    !/\.sort\s*\(/u.test(cardRendererCode));
  /*
   * The rated kind must not render the modules its canonical entry lacks, and the insufficient kind must not render a score or a rank. Asserted against the
   * renderer's own functions, because the presentation types cannot express "this function must not mention that field".
   *
   * UPDATED IN PRE-RELEASE-UX-A12: `appendGrade` left this list. A11 carried the grade aggregates into the rated entry and A12 renders them, so the rated card now
   * legitimately draws the same compact grade line a recommended one does. The two that REMAIN are the ones the entry genuinely has no data for — a confidence and
   * per-aspect evidence — and rendering an empty module for either would tell a reader the extension checked and found nothing.
   */
  const ratedFn = cardRendererCode.slice(cardRendererCode.indexOf('function ratedCard'), cardRendererCode.indexOf('function insufficientCard'));
  for (const forbidden of ['presentation.confidence', 'presentation.evidenceStrength', 'appendEvidence']) {
    check(`rated 卡片不渲染 ${forbidden}`, !ratedFn.includes(forbidden));
  }
  check('rated 卡片渲染同一行紧凑成绩（A12）', ratedFn.includes('appendGrade(body, presentation.grade)'));
  check('insufficient 卡片不渲染成绩行（A12 未改其语义）', !cardRendererCode.slice(cardRendererCode.indexOf('function insufficientCard'), cardRendererCode.indexOf('export function renderCourseCards')).includes('appendGrade'));
  const insufficientFn = cardRendererCode.slice(cardRendererCode.indexOf('function insufficientCard'), cardRendererCode.indexOf('export function renderCourseCards'));
  for (const forbidden of ['CARD_TEXT.score', 'CARD_TEXT.rank']) {
    check(`insufficient 卡片不渲染 ${forbidden}`, !insufficientFn.includes(forbidden));
  }
  check('insufficient 卡片的匹配置信标签不是推荐置信度', insufficientFn.includes('matchConfidence') && !insufficientFn.includes('CARD_TEXT.confidence'));
  /*
   * SECTION HYDRATION is deliberately NOT rendered in this step. The canonical status is about whether a section's DETAIL row was loaded — teacher, schedule,
   * location, department, capacity — and NOT about review coverage, so a label like "评价信息覆盖：完整" would misdescribe what the enum means. Asserted so the
   * omission is a recorded decision rather than an oversight.
   */
  check('本步不渲染 sectionHydration（其 status 语义与评价覆盖无关）',
    !cardRendererCode.includes('sectionHydration') && !cardRendererCode.includes('HYDRATION_STATUS_TEXT'));
  /*
   * The approval note may name the teacher field; nothing else may. Both halves are asserted, so a later UI cannot quietly start showing teacher data.
   */
  const approvalNoteStart = html.indexOf('id="full-preparation-note"');
  const approvalNoteEnd = html.indexOf('</p>', approvalNoteStart);
  const outsideApproval = approvalNoteStart < 0
    ? html
    : html.slice(0, approvalNoteStart) + html.slice(approvalNoteEnd < 0 ? html.length : approvalNoteEnd);
  check('「教师」只出现在批准说明中，面板其它位置不得出现',
    approvalNoteStart >= 0 && html.includes('教师') && !outsideApproval.includes('教师'));
  /*
   * THE ONE-APPROVAL COPY CONTRACT.
   *
   * The user approves ONE action that performs THREE page interactions — enabling WHU's own 「有余量」 filter, loading the filtered listing to its end, and expanding only
   * the courses whose teacher data is incomplete — so the copy must name all three. For the load-more it must name the CONTROL rather than only the outcome:
   * "自动加载课程列表" describes the purpose correctly and the action misleadingly, because the extension clicks a control the user did not press.
   *
   * UPDATED IN PRE-RELEASE-UX-A10 from two interactions to three, and the filter refusal 修改筛选条件 was REMOVED rather than reworded: this slice makes the run apply a
   * filter, so that promise became false and a stale promise is worse than a missing one. The location wording is 页面底部 rather than WHU 页面底部, which is what the
   * shipped sentence says.
   */
  check('批准说明点名第一、二类交互的具体控件与位置（自动点击 + 页面底部 + 点此查看更多）',
    html.includes('自动点击') && html.includes('页面底部') && html.includes('点此查看更多'));
  check('批准说明点名第三类交互（自动启用 + 有余量筛选 + 只分析当前可选课程）',
    html.includes('自动启用') && html.includes('有余量') && html.includes('只分析当前可选课程'));
  check('批准说明点名第二类交互（展开详情 + 教师信息未完整 + 补全任课老师）',
    html.includes('展开详情') && html.includes('教师信息未完整') && html.includes('补全任课老师'));
  check('批准说明声明不会选课/退课/提交，且不再声称不修改筛选条件',
    html.includes('不会选课') && html.includes('退课') && html.includes('提交') && !html.includes('修改筛选条件'));
  /*
   * The rejection half. A shortened sentence that promises the outcome without the click would still list no forbidden token, so the ban is on the specific
   * abstraction that would hide the interaction.
   */
  check('批准说明未把第一类交互抽象回「自动加载」（那样会隐藏自动点击）',
    !html.includes('会自动加载当前课程列表'));
  check('批准按钮文案为「加载可选课程信息并生成推荐」',
    html.includes('加载可选课程信息并生成推荐') && !html.includes('加载完整课程信息并生成推荐'));
  /*
   * UPDATED IN 16J-PREUI-E4-C2-B3-A. The old rule was "the button must not promise a recommendation", which held while the recommendation was unwired. It IS
   * wired now, so the honest requirement is inverted: the label must say so, and there must be exactly ONE entry point — no second "生成推荐" button, because two
   * controls starting overlapping work would be two approvals for one outcome.
   *
   * UPDATED IN PRE-RELEASE-UX-A13, from a bare count of two to the exact set of three. The third control is the rated section's collapse toggle, added deliberately;
   * naming all three by their own ids keeps the rule STRICTER than the count it replaces, because a second recommendation entry point could no longer hide behind the
   * same total.
   */
  const buttonIds = [...html.matchAll(/<button[^>]*id="([^"]+)"/gu)].map((match) => match[1]).sort();
  check('推荐已接线，故按钮必须如实说明，且只有一个入口',
    JSON.stringify(buttonIds) === JSON.stringify(['full-preparation-cancel', 'full-preparation-start', 'preferences-apply', 'preferences-reset', 'rated-toggle'])
    && !html.includes('id="recommendation-start"'));
}

// ---------------------------------------------------------------- emitted ----

for (const relativeScript of ['background/service-worker.js', 'sidepanel/sidepanel.js']) {
  const scriptPath = join(distDir, relativeScript);
  if (!existsSync(scriptPath)) {
    check(`${relativeScript} 存在`, false);
    continue;
  }
  const bytes = readFileSync(scriptPath);
  const text = bytes.toString('utf8');

  check(`${relativeScript} 是合法 UTF-8（无替换字符）`, !text.includes('\uFFFD'));

  try {
    execFileSync(process.execPath, ['--check', scriptPath], { stdio: 'pipe' });
    check(`${relativeScript} 语法有效（node --check）`, true);
  } catch (error) {
    check(`${relativeScript} 语法有效（node --check）`, false,
      error instanceof Error ? error.message.slice(0, 200) : String(error));
  }

  /*
   * Comments are stripped before searching, because a comment saying "does not fetch anything" would otherwise be reported
   * as a network call. That false positive has misled checks in this project more than once.
   */
  const withoutComments = text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1');
  for (const token of FORBIDDEN_IN_CODE) {
    check(`${relativeScript} 代码中不含 ${token}`, !new RegExp(`\\b${token}\\b`, 'u').test(withoutComments));
  }
}

// ------------------------------------------------- content script privacy ----
/*
 * The privacy contract, enforced mechanically.
 *
 * This step's hard rule is that the content script reads only `location.hostname` and `location.pathname`, and that its
 * outbound message contains only `type` and `supported`. Those are claims about code, so they are checked against the code —
 * comments stripped first, because this file's own comments describe what it does NOT do and would otherwise be reported as
 * violations. That false positive has misled checks in this project several times.
 */
const contentScriptPath = join(distDir, 'content', 'content-script.js');
check('content/content-script.js 存在', existsSync(contentScriptPath));

if (existsSync(contentScriptPath)) {
  const raw = readFileSync(contentScriptPath, 'utf8');
  const code = raw.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1');

  /** Reads this step permits. */
  for (const token of ['location.hostname', 'location.pathname']) {
    check(`content script 读取 ${token}`, code.includes(token));
  }

  /** Reads this step forbids: any of these would mean the script looks at page content or session state. */
  const FORBIDDEN_READS = [
    ['location.search', '查询字符串'],
    ['location.hash', 'URL hash'],
    ['location.href', '完整 URL'],
    ['location.origin', '完整 origin'],
    ['URLSearchParams', '解析查询字符串'],
    /*
     * `querySelectorAll` is NOT on this list from this step onward: the panel count requires it. `querySelector` (singular) was added in
     * 16J-PREUI-E3-A, where the load-state markers made two single-element reads necessary — see the grant note in
     * `scripts/confirm-content-privacy.mjs`, which enforces that exactly those two exist and that they read only presence and computed visibility.
     */
    ['querySelector(', '读取单个元素'],
    ['getElementById', 'DOM 提取'],
    /*
     * `textContent` and `getAttribute` were forbidden while the extension read no element content at all. The course-identity
     * step explicitly authorises exactly two such reads: the heading text (via `span.kcmc` when present, else the heading) and
     * the `kch_id` input's `value`. So this list now names the reads that remain out of bounds and what specifically IS read is
     * asserted separately below — a stronger statement than forbidding the whole category, which would have been satisfied by
     * reading nothing while also being satisfied by reading anything the list forgot.
     */
    ['innerHTML', '元素内容'],
    ['outerHTML', '元素内容'],
    ['innerText', '元素内容'],
    ['dataset', '元素属性'],
    ['children', '元素内容'],
    ['outerText', '元素内容'],
    ['document.body', '页面内容'],
    ['document.cookie', 'cookie'],
    ['localStorage', '本地存储'],
    ['sessionStorage', '会话存储'],
    ['indexedDB', '数据库'],
    ['fetch', '网络请求'],
    ['XMLHttpRequest', '网络请求'],
    ['WebSocket', '网络请求'],
  ];
  /*
   * The granted single-element reads are removed BEFORE the token scan, exactly as `scripts/confirm-content-privacy.mjs` does, so `querySelector(` is
   * exempt for the granted reads and nothing else. The bundle does not inline the constants, so the exemption names the constant form the artifact
   * actually contains, and it covers the element-level reads too: the expansion watcher's panel probe and the hydration adapter's row, cell and
   * expand-control lookups.
   */
  /*
   * UPDATED IN PRE-RELEASE-UX-A9: `#searchBox` joined the granted document reads, and the availability filter's four element-relative reads joined the
   * element list, plus the `group` receiver they are resolved through. Every addition is named individually, so this exemption stays as narrow as the
   * contract it mirrors — the two gates must agree, and a read granted in one but not the other is exactly the drift they exist to catch.
   */
  const grantedElementQueries = [
    'COURSE_PANEL_SELECTOR', 'ROW_SELECTOR', 'TEACHER_CELL_SELECTOR', 'EXPAND_CONTROL_SELECTOR',
    'AVAILABILITY_GROUP_SELECTOR', 'AVAILABILITY_OPTION_SELECTOR', 'FILTER_QUERY_BUTTON_SELECTOR', 'FILTER_EXPAND_CONTROL_SELECTOR', "'ul'",
  ];
  let codeWithoutGrantedReads = code
    .split('document.querySelector(LOAD_MORE_SELECTOR)').join('')
    .split('document.querySelector(END_SIGN_SELECTOR)').join('')
    .split('document.querySelector(COURSE_LIST_CONTAINER_SELECTOR)').join('')
    .split('document.querySelector(LOAD_MORE_ANCHOR_SELECTOR)').join('')
    .split('document.querySelector(SEARCH_BOX_SELECTOR)').join('');
  for (const argument of grantedElementQueries) {
    codeWithoutGrantedReads = codeWithoutGrantedReads
      .split(`node.querySelector(${argument})`).join('')
      .split(`row.querySelector(${argument})`).join('')
      .split(`panel.querySelector(${argument})`).join('')
      .split(`group.querySelector(${argument})`).join('')
      .split(`ul.querySelector(${argument})`).join('');
  }
  for (const [token, why] of FORBIDDEN_READS) {
    const present = token === 'querySelector(' ? codeWithoutGrantedReads.includes(token) : code.includes(token);
    check(`content script 代码中不含 ${token}（${why}）`, !present);
  }

  /*
   * The one permitted DOM query, and the guarantee that it is the ONLY one.
   *
   * Two things are asserted: exactly one `querySelectorAll` call exists, and the only selector string in the file is the
   * course-panel selector. A second selector would mean the script looks at elements this step does not sanction, and the
   * selector-count check is what catches that rather than trusting a reading of the code.
   */
  const queryCalls = [...code.matchAll(/querySelectorAll\s*\(/gu)];
/*
   * Three queries, and their selectors are enumerated rather than counted. A count alone would have accepted a fourth query on
   * an unrelated selector; naming the allowed set means a new read has to be added here as well.
   */
  /*
   * Every argument passed to `querySelectorAll` is enumerated — literals AND identifiers — and each is checked against the
   * allowed set. `selector` and `COURSE_PANEL_SELECTOR` are identifiers, which is why a literals-only check would have missed
   * a new selector introduced through a helper's parameter. The allowed identifiers are themselves constants whose values are
   * asserted elsewhere in this file, so the closure is provable rather than assumed.
   */
  const allowedSelectorArguments = new Set(["'input'", "'tr'", "'td'", 'selector', 'COURSE_PANEL_SELECTOR', 'ROW_SELECTOR', 'TEACHER_CELL_SELECTOR', 'EXPAND_CONTROL_SELECTOR']);
  const selectorArguments = [...code.matchAll(/querySelectorAll\(\s*([^)\s]+)/gu)].map((match) => match[1] ?? '');
  check('querySelectorAll 的每个实参都在允许集内',
    selectorArguments.length > 0 && selectorArguments.every((argument) => allowedSelectorArguments.has(argument)),
    JSON.stringify([...new Set(selectorArguments)]));
  check('querySelectorAll 数量与允许集相符（6 处）', selectorArguments.length === 6, String(selectorArguments.length));

  /*
   * `firstWithClass` takes the selector as a parameter, so the arguments passed to IT are the remaining evidence about which
   * element kinds are queried.
   */
/*
   * The declaration is excluded explicitly: its second parameter is named `selector`, so counting it would report the parameter
   * name as a bad argument — a false positive from matching the definition rather than the uses.
   */
  const withClassSelectors = [...code.matchAll(/firstWithClass\([^,]+,\s*([^,]+),/gu)]
    .map((match) => (match[1] ?? '').trim())
    .filter((selector) => selector !== 'selector');
  check('firstWithClass 只用 div / span / td / font',
    withClassSelectors.length > 0 && withClassSelectors.every((selector) => selector === "'div'" || selector === "'span'" || selector === "'td'" || selector === "'font'"),
    JSON.stringify([...new Set(withClassSelectors)]));

  /*
   * The panel selector's VALUE is asserted, because the closure above only proves the identifier is the one allowed — not that
   * it still names the course panel.
   */
  check('COURSE_PANEL_SELECTOR 的值仍是 div.panel.panel-info', /COURSE_PANEL_SELECTOR\s*=\s*'div\.panel\.panel-info'/u.test(code));

  /*
   * Selectors are recognised by SHAPE — a tag name followed by one or more classes — rather than by "contains a dot". The
   * looser test also matched the hostname and pathname string constants, because a domain name contains dots while being
   * nothing like a selector.
   */
  const selectorStrings = [...code.matchAll(/(['"])([^'"]*)\1/gu)]
    .map((match) => match[2] ?? '')
/*
     * A class name containing a hyphen is required. That is what separates a real selector from a domain name: `jwgl.whu.edu.cn`
     * has exactly the shape `tag.class.class` too, and the looser pattern accepted it as a selector.
     */
    .filter((text) => /^[a-z][a-z0-9]*(?:\.[A-Za-z_][\w-]*)+$/u.test(text) && text.includes('-'));
  check('唯一的 CSS 选择器是 div.panel.panel-info',
    selectorStrings.length === 1 && selectorStrings[0] === COURSE_PANEL_SELECTOR,
    JSON.stringify(selectorStrings));

  /*
   * UPDATED IN 16J-PREUI-E4-B2-R1. This used to require exactly one `querySelectorAll(...).length`, because the panel count was the only consumer and it was
   * written inline. The count now goes through a shared helper that counts by ITERATING, so the old form is gone — and asserting its absence is the sharper
   * statement: the results are walked by index and never swept into an array or visitor, which is what would make the whole page readable in one move.
   */
  const readCounts = [...code.matchAll(/querySelectorAll\s*\([^)]*\)\s*\.length/gu)];
  check('querySelectorAll 结果不以 .length 读取，且未被 Array.from/map/forEach 整体消费',
    readCounts.length === 0
    && !/Array\.from\s*\([^)]*querySelectorAll/u.test(code)
    && !/querySelectorAll[^;]*\.(?:map|forEach)\s*\(/u.test(code), String(readCounts.length));

  /*
   * The outbound payload is inspected as source shape. `sendMessage` may carry exactly two fields, and neither may be a
   * URL.
   *
   * The pattern crosses newlines because the emitted call is NOT one line: TypeScript formats
   * `{ type: X, supported }` across lines, and an earlier version of this regex with `[^}]*` matched nothing at all, so the
   * payload check silently examined an empty string and reported a failure for correct code.
   */
  const sendMatches = [...code.matchAll(/sendMessage\((\{[\s\S]*?\})\)/gu)];
/*
   * The content script sends exactly three messages: page identity, the panel count, and the auto-expand event. The count is asserted both as a
   * number and as a NAME, so the contract is explicit rather than "some number of calls" — and the third type is named here so a fourth cannot
   * arrive unnoticed.
   */
  check('content script 恰好发出六处 runtime 消息', sendMatches.length === 6, String(sendMatches.length));
  check('content script 的出站消息类型封闭为 {PAGE_STATUS, PANEL_COUNT, AUTO_EXPAND_EVENT, TEACHER_HYDRATION_EVENT, FULL_PREPARATION_EVENT, AVAILABILITY_FILTER_EVENT}',
    sendMatches.every((match) => {
      const text = match[1] ?? '';
      return text.includes('PAGE_STATUS') || text.includes('PANEL_COUNT')
        || text.includes('AUTO_EXPAND_EVENT') || text.includes('TEACHER_HYDRATION_EVENT')
        || text.includes('FULL_PREPARATION_EVENT') || text.includes('AVAILABILITY_FILTER_EVENT');
    }));
  const payloads = sendMatches.map((match) => match[1] ?? '');
  const statusPayload = payloads.find((text) => text.includes('PAGE_STATUS')) ?? '';
  const countPayload = payloads.find((text) => text.includes('PANEL_COUNT')) ?? '';
  const payload = statusPayload === '' ? (payloads[0] ?? '') : statusPayload;

  /*
   * Top-level keys are extracted by scanning at bracket depth zero.
   *
   * The scan tracks whether a KEY or a VALUE is expected: after a colon, the next token is a value and is skipped, so it
   * cannot be counted as another key. An earlier version normalised the colon away and simply collected depth-zero
   * identifiers, which reported `["type","PAGE_STATUS_MESSAGE","supported"]` for the correct payload
   * `{ type: PAGE_STATUS_MESSAGE, supported }` — the value mistaken for a key, producing a failure for correct code.
   */
  function topLevelKeys(text) {
    const body = text.replace(/^\{/u, '').replace(/\}$/u, '');
    const keys = [];
    let depth = 0;
    let expectingKey = true;
    let index = 0;
    while (index < body.length) {
      const character = body[index];
      if ('{[('.includes(character)) {
        depth += 1;
        index += 1;
        continue;
      }
      if ('}])'.includes(character)) {
        depth -= 1;
        index += 1;
        continue;
      }
      if (depth > 0) {
        index += 1;
        continue;
      }
      if (character === ',') {
        expectingKey = true;
        index += 1;
        continue;
      }
      if (character === ':') {
        expectingKey = false;
        index += 1;
        continue;
      }
      const match = /^\s*([A-Za-z_$][\w$]*)/u.exec(body.slice(index));
      if (match !== null && match[1] !== undefined) {
        if (expectingKey) {
          keys.push(match[1]);
          expectingKey = false;
        }
        index += match[0].length;
        continue;
      }
      index += 1;
    }
    return keys;
  }

  /*
   * Each payload is checked against ITS OWN expected shape.
   *
   * The page-status message carries `type` + `supported`; the panel-count message carries `type` + `count`. An earlier
   * version checked both against `{type, supported}`, which reported the correctly-formed count message as both missing a
   * field and having an extra one — a failure produced by the checker's assumption, not by the code.
   */
  const EXPECTED_PAYLOADS = [
    { name: '页面状态', payload: statusPayload, keys: ['type', 'supported'] },
    { name: '面板计数', payload: countPayload, keys: ['type', 'count'] },
  ];

  /** Fields that must never appear, in any payload. */
  const FORBIDDEN_FIELDS = ['url', 'href', 'search', 'hash', 'origin', 'host', 'pathname', 'title', 'html', 'cookie', 'token', 'query'];

  for (const expected of EXPECTED_PAYLOADS) {
    const keys = topLevelKeys(expected.payload);
    const label = expected.name;
    check(`${label} payload 存在`, expected.payload !== '', expected.payload.replace(/\s+/gu, ' '));
    check(`${label} payload 的键恰好为 ${JSON.stringify(expected.keys)}`,
      JSON.stringify([...keys].sort()) === JSON.stringify([...expected.keys].sort()),
      JSON.stringify(keys));
    for (const forbidden of FORBIDDEN_FIELDS) {
      check(`${label} payload 不含 ${forbidden} 字段`, !keys.includes(forbidden));
    }
  }
}

// ------------------------------------------------------------ match pattern ----
/*
 * The match pattern must be exact: one host, one path, nothing broader. A wildcard host would grant the extension access to
 * every page on the university's domain, which this step does not need and must not ask for.
 */
let matchPattern = null;
if (manifest !== null) {
  const scripts = manifest.content_scripts ?? [];
  check('恰好声明一个 content script', scripts.length === 1, String(scripts.length));
  const first = scripts[0];
  const matches = first?.matches ?? [];
  check('content script 恰好一个 match', matches.length === 1, JSON.stringify(matches));
  matchPattern = matches[0] ?? null;
  check('match 精确指向选课页',
    matchPattern === 'https://jwgl.whu.edu.cn/xsxk/zzxkyzb_cxZzxkYzbIndex.html*',
    String(matchPattern));

  /*
   * Broader patterns are checked by shape: a `*` in the host position, or `<all_urls>`, would widen access beyond the one
   * page. The single path wildcard at the end only covers the query string, which the script never reads.
   */
  for (const broader of ['<all_urls>', 'https://*.whu.edu.cn/*', 'https://jwgl.whu.edu.cn/*', '*://*/*']) {
    check(`match 不是过宽模式 ${broader}`, matchPattern !== broader);
  }
  check('match 的 host 部分不含通配符', matchPattern !== null && !/^[a-z]+:\/\/\*/iu.test(matchPattern));
  check('content script 只注入主框架', first?.all_frames === false);
  check('content script 在 document_idle 运行', first?.run_at === 'document_idle');
  check('content script js 指向构建产物', JSON.stringify(first?.js) === JSON.stringify(['content/content-script.js']));
}
// ----------------------------------------------------- message contract ----
/*
 * The message type names are string literals repeated in three files, which is a real hazard: rename one and the bridge
 * stops working silently, with matching code on both sides that simply never fires.
 *
 * They are checked for exact agreement across the built files, and the QUERY direction is checked separately because it is
 * the one the worker sends and the content script receives — a mismatch there would make a panel opened on an
 * already-loaded page report "not detected" for a page that is supported.
 */
const bridgeSources = {
  'background/service-worker.js': readFileSync(join(distDir, 'background', 'service-worker.js'), 'utf8'),
  'content/content-script.js': readFileSync(join(distDir, 'content', 'content-script.js'), 'utf8'),
  'sidepanel/sidepanel.js': readFileSync(join(distDir, 'sidepanel', 'sidepanel.js'), 'utf8'),
};
for (const literal of ['COURSE_COPILOT_PAGE_STATUS', 'COURSE_COPILOT_PING', 'COURSE_COPILOT_QUERY_STATUS']) {
  const present = Object.entries(bridgeSources)
    .filter(([, text]) => text.includes(literal))
    .map(([file]) => file);
  check(`消息类型 ${literal} 在两端一致出现`, present.length >= 2, present.join(', '));
}
check('查询消息由 worker 发出、由 content script 接收',
  bridgeSources['background/service-worker.js'].includes('COURSE_COPILOT_QUERY_STATUS')
  && bridgeSources['content/content-script.js'].includes('COURSE_COPILOT_QUERY_STATUS'));
check('页面状态消息由 content script 发出、由 panel 与 worker 接收',
  bridgeSources['content/content-script.js'].includes('COURSE_COPILOT_PAGE_STATUS')
  && bridgeSources['sidepanel/sidepanel.js'].includes('COURSE_COPILOT_PAGE_STATUS')
  && bridgeSources['background/service-worker.js'].includes('COURSE_COPILOT_PAGE_STATUS'));

/*
 * ## The public-review message (16G-C)
 *
 * The worker declares exactly SIX message types. Asserted as an exact count rather than `>= 6`, so a message cannot be added
 * without this line being edited deliberately — an approximate count would let the contract drift while still passing.
 *
 * UPDATED IN 16J-G-B, which added `COURSE_COPILOT_QUERY_RECOMMENDATIONS`. That is a genuinely new GLOBAL type, unlike
 * `COURSE_COPILOT_QUERY_VISIBLE_ROWS`, which the transport helper declares and the worker never names.
 *
 * UPDATED IN RELEASE-BLOCKER-B1, which added `COURSE_COPILOT_FULL_PREPARATION_EVENT` — the one type the worker RELAYS rather than forwards. It has to be named
 * here for the relay to recognise it, and naming it is not the same as owning it: the worker constructs no report, reads none of its fields, and sends nothing
 * back to a tab, so the run still lives entirely in the content script.
 */
const declaredMessageTypes = [...readFileSync(join(distDir, '..', 'src', 'background', 'service-worker.ts'), 'utf8')
  .matchAll(/const (\w+_MESSAGE) = '([^']+)'/gu)].map((match) => match[2]).sort();
check('worker 恰好声明 7 个消息类型',
  JSON.stringify(declaredMessageTypes) === JSON.stringify([
    'COURSE_COPILOT_FULL_PREPARATION_EVENT',
    'COURSE_COPILOT_PAGE_STATUS',
    'COURSE_COPILOT_PANEL_COUNT',
    'COURSE_COPILOT_PING',
    'COURSE_COPILOT_QUERY_PUBLIC_REVIEWS',
    'COURSE_COPILOT_QUERY_RECOMMENDATIONS',
    'COURSE_COPILOT_QUERY_STATUS',
  ].sort()),
  JSON.stringify(declaredMessageTypes));
check('公开评价消息由 worker 接收',
  bridgeSources['background/service-worker.js'].includes('COURSE_COPILOT_QUERY_PUBLIC_REVIEWS'));
/*
 * It is an INTERNAL message with no UI producer yet. Neither the content script nor the panel may know about it: wiring a panel to
 * it is a later, deliberate step, and a name appearing here by accident would mean the UI is already involved.
 */
check('公开评价消息尚未出现在 content script',
  !bridgeSources['content/content-script.js'].includes('COURSE_COPILOT_QUERY_PUBLIC_REVIEWS'));
check('公开评价消息尚未出现在 panel',
  !bridgeSources['sidepanel/sidepanel.js'].includes('COURSE_COPILOT_QUERY_PUBLIC_REVIEWS'));

// ------------------------------------------- classic-script parse gate ----
/*
 * The gate that was missing.
 *
 * A static Manifest V3 content script is loaded as a CLASSIC script. It cannot be an ES module, and the manifest has no
 * `type: "module"` for `content_scripts`. The previous build emitted
 *
 *     export {};
 *
 * as the last line of `content/content-script.js`, and Edge recorded
 * `Uncaught SyntaxError: Unexpected token 'export'` at that exact line. The entire script failed to parse, so not one line
 * ran: no page status was sent, the service worker was never woken, and the side panel stayed on "not detected".
 *
 * Text searching for the word `export` would not have been a reliable gate — it appears in comments and in string literals,
 * and it would also have to reason about scope. This asks the question that actually matters by PARSING the artifact with
 * classic-script grammar: `node:vm`'s `Script` accepts only a classic script, so module syntax anywhere at the top level is a
 * SyntaxError. No new dependency is involved.
 *
 * The same parse is applied to the panel script for the same reason. The service worker is deliberately NOT parsed this way:
 * its manifest entry declares `type: "module"`, so module syntax is legal there and asserting otherwise would be wrong.
 */
const CLASSIC_SCRIPTS = ['content/content-script.js', 'sidepanel/sidepanel.js'];

for (const relative of CLASSIC_SCRIPTS) {
  const scriptPath = join(distDir, relative);
  if (!existsSync(scriptPath)) {
    check(`${relative} 存在（classic script 门禁）`, false);
    continue;
  }

  const source = readFileSync(scriptPath, 'utf8');
  let parseError = null;
  try {
    /*
     * Construction parses the source. It is never run: nothing is executed, so no page, extension API or timer is touched.
     * `filename` only makes a parse error easier to read.
     */
    new vm.Script(source, { filename: relative });
  } catch (error) {
    parseError = error;
  }

  check(`${relative} 可作为 classic script 解析（node:vm）`, parseError === null,
    parseError === null ? '' : String(parseError.message).slice(0, 160));

  /*
   * A human-readable companion assertion. It is not the gate — the parse above is — but it names the specific token pair that
   * caused the real failure, so a future reader sees the symptom as well as the verdict. Comments are stripped first, because
   * this file's own documentation discusses `export {}` and would otherwise register as a violation.
   */
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1');
  const moduleSyntax = /^\s*(?:import|export)\b/mu.test(withoutComments);
  check(`${relative} 顶层无模块语法（TOP_LEVEL_MODULE_SYNTAX_PRESENT = no）`, !moduleSyntax);

  check(`${relative} 不以 export {}; 结尾`, !/export\s*\{\s*\}\s*;?\s*$/u.test(withoutComments.trimEnd()));
}
// ------------------------------------------------ recovery protocol ----
/*
 * The zero-permission recovery protocol, by shape.
 *
 * The behavioural half lives in `test/step42RecoveryProtocol.test.ts`, which runs the built scripts with stubbed extension
 * APIs. What is checked here is the part that must hold of the artifact itself: which fields the ping carries, that the panel
 * reads no sensitive tab property, that nothing is persisted, and that recovery no longer depends on the worker's memory.
 */
const workerSource = readFileSync(join(distDir, 'background', 'service-worker.js'), 'utf8');
const panelSource = readFileSync(join(distDir, 'sidepanel', 'sidepanel.js'), 'utf8');

/** Strip comments so documentation about a token is not mistaken for a use of it. */
function codeOf(text) {
  return text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1');
}
const workerCode = codeOf(workerSource);
const panelCode = codeOf(panelSource);
/*
 * The panel's own SOURCE, with comments removed.
 *
 * Added in 16J-PREUI-E4-C2-B3-B2. The bundle is now wider than this file: it also contains `course-cards.ts`, whose evaluator legitimately has a `title` property
 * for the card heading and whose rationale discusses `innerHTML` in order to forbid it. Checks that search the bundle for an IDENTIFIER would therefore flag the
 * renderer's own vocabulary rather than a violation by the panel — so those checks read this instead.
 */
const panelSourceCode = codeOf(readFileSync(join(distDir, '..', 'src', 'sidepanel', 'sidepanel.ts'), 'utf8'));

/*
 * The panel supplies the tab id. Without it a restarted worker has no way to discover which tab to ask, which is exactly the
 * failure that was reproduced in a real browser.
 */
check('面板的 PING 携带 tabId', /sendMessage\(\{\s*type:\s*PING_MESSAGE,\s*tabId/iu.test(panelCode) || /\btabId\b/u.test(panelCode));
check('面板读取当前活动 tab 的 id', /tabs\.query\(/u.test(panelCode) && /active:\s*true/u.test(panelCode) && /currentWindow:\s*true/u.test(panelCode));

/*
 * `chrome.tabs.query` does not require the `"tabs"` permission; that permission governs the sensitive properties. Reading
 * only `id` is what keeps this true, so the absence of the others is asserted rather than assumed.
 */
for (const sensitive of ['url', 'pendingUrl', 'title', 'favIconUrl']) {
  check(`面板不读取 tab.${sensitive}`, !new RegExp(`\\.${sensitive}\\b`, 'u').test(panelCode));
}

check('面板只读取 tab 的 id', /\.id\b/u.test(panelCode));

/*
 * Recovery must not depend on the worker's in-memory record of reporting tabs. The identifier may remain as a cache for the
 * passive broadcast path, but the ping must not be answered from it when a tab id is available.
 */
/*
 * The emitted call is `chrome.tabs\n  .sendMessage(askedTabId, …)`, so the pattern must not require the namespace and the
 * method to be adjacent on one line. The earlier version did, and reported a failure for correct code.
 */
check('worker 用给定的 tabId 向内容脚本询问', /\.sendMessage\(\s*askedTabId\b/u.test(workerCode));
check('worker 在回答面板前等待内容脚本的回复', /\.then\(/u.test(workerCode) && /return true;/u.test(workerCode));
check('worker 不枚举全部 tab（无 tabs.query）', !/tabs\.query\(/u.test(workerCode));
check('worker 不做重试循环', !/retry|setInterval/u.test(workerCode));

/*
 * No persistence anywhere: the whole design is that the tab is supplied afresh each time the panel opens.
 */
for (const [name, code] of [['worker', workerCode], ['面板', panelCode], ['内容脚本', codeOf(readFileSync(join(distDir, 'content', 'content-script.js'), 'utf8'))]]) {
  for (const token of ['chrome.storage', 'storage.local', 'storage.session', 'storage.sync', 'localStorage', 'indexedDB']) {
    check(`${name} 不使用 ${token}`, !code.includes(token));
  }
}
// ------------------------------------------------ build ownership + bundling ----
/*
 * Who produces which artifact, and what a bundle is allowed to contain.
 *
 * ## Why ownership is asserted rather than commented
 *
 * The build has two emit stages: `tsc` compiles everything, then esbuild overwrites the worker and the panel. That order is
 * what makes the split work — but it also means a later edit could quietly move an entry from one stage to the other and the
 * build would still exit 0. These checks read the build script and fail unless it declares EXACTLY the two bundled entries with
 * the intended formats, and they assert that the content script is not among them.
 *
 * The assertion is on the declaration rather than merely on the artifact because the artifact alone cannot distinguish
 * "bundled by esbuild" from "compiled by tsc and left alone": both are valid JavaScript with no imports when there is nothing to
 * inline. The declaration is the part that carries the intent.
 */
const buildScript = readFileSync(join(repoRoot, 'scripts', 'build-extension.mjs'), 'utf8');

check('构建脚本使用 esbuild JS API（而非 shell 调用）', /import\s*\{\s*build\s*\}\s*from\s*'esbuild'/u.test(buildScript));
check('构建脚本的打包目标是 worker 与 panel 两项', /const BUNDLE_TARGETS = \[[\s\S]*?\];/u.test(buildScript)
  && (buildScript.match(/entry: \['src',/gu) ?? []).length === 2);
check('worker 打包为 ESM', /out: \['background', 'service-worker\.js'\], format: 'esm'/u.test(buildScript));
check('panel 打包为 IIFE', /out: \['sidepanel', 'sidepanel\.js'\], format: 'iife'/u.test(buildScript));
check('构建脚本显式拒绝把内容脚本交给 esbuild',
  buildScript.includes('内容脚本不得交给 esbuild'));
/*
 * The negative half: the content script must not appear as a bundling entry. Checked as a property of the target list rather
 * than as a substring of the whole file, because the file's own comments discuss the content script by name.
 */
const bundleTargetBlock = /const BUNDLE_TARGETS = \[([\s\S]*?)\];/u.exec(buildScript)?.[1] ?? '';
check('BUNDLE_TARGETS 不含内容脚本', bundleTargetBlock.length > 0 && !bundleTargetBlock.includes('content-script'));

/*
 * ## Build ownership, split by artifact
 *
 * Three JavaScript files ship and each has exactly ONE producer. This used to be two producers over three files, with `tsc`
 * emitting all of `src/` and esbuild overwriting two of them — and that arrangement had a trap: `tsc` writes a file for every
 * module it compiles, so the moment the worker imported a new local module, that module appeared in `dist/background/` as a script
 * the manifest never names. `exclude` did not prevent it, because `exclude` only filters the root files `include` discovers and a
 * module reached through an import still joins the program. Measured: one added import produced `dist/background/memory-cache.js`.
 *
 * So the ownership is now asserted rather than described.
 */
const extensionDir = resolve(distDir, '..');
/** The compiler binary, resolved from the repository — the same one the build script uses. */
const tscBin = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');

/*
 * The two extension configs are read through `tsc --showConfig` for their COMPILER OPTIONS — TypeScript's own resolver, so
 * `extends` is already applied — and their file lists are read from the config text.
 *
 * `--showConfig` reports `compilerOptions` and `exclude` but NOT `files`/`include`, which is why the program membership below is
 * asserted against the source. Reading the whole file as JSON is not an option either: both configs are JSONC, and stripping
 * comments by hand breaks on globs, which contain slash-star sequences and end in star-dot-ts. That trap was measured; the two
 * checks below therefore look for the declarations they care about instead of parsing the document.
 */
function compilerOptionsOf(configName) {
  const output = execFileSync(process.execPath, [tscBin, '-p', join(extensionDir, configName), '--showConfig'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return JSON.parse(output).compilerOptions ?? {};
}

// The main config covers everything and emits nothing. `noEmit` comes from the compiler, the program membership from the source.
const mainCompilerOptions = compilerOptionsOf('tsconfig.json');
const contentCompilerOptions = compilerOptionsOf('tsconfig.content.json');
const mainTsconfigSource = readFileSync(join(extensionDir, 'tsconfig.json'), 'utf8');
const contentTsconfigSource = readFileSync(join(extensionDir, 'tsconfig.content.json'), 'utf8');

check('主 extension tsconfig 为 typecheck-only（noEmit = true）', mainCompilerOptions.noEmit === true);
check('主 extension tsconfig 覆盖整个 src',
  /"include"\s*:\s*\[\s*"src\/\*\*\/\*\.ts"\s*,\s*"src\/\*\*\/\*\.d\.ts"\s*\]/u.test(mainTsconfigSource));
/*
 * The temporary `exclude` that stepped aside for the memory cache is gone: it was never a real fix, because `exclude` only filters
 * the root files `include` discovers and an imported module joins the program anyway.
 */
check('主 extension tsconfig 不再 exclude 任何源文件', !/"exclude"/u.test(mainTsconfigSource));

/*
 * The content emitter is the only tsc-based JS producer, and its program is exactly four root files.
 *
 * UPDATED IN 16J-H-B1: `recommendation-types.d.ts` joined the list. It is the ONE declaration file in this graph that imports — as a
 * TYPE only — purely to alias the canonical `RecommendationResult` into the global scope, because `chrome.d.ts` cannot import it
 * without becoming a module and losing its ambient declarations. A declaration file emits nothing, so the content script's output
 * stays a classic script; the emitted-artifact checks assert that separately.
 */
check('内容 emit 的根文件恰好是内容脚本与三个声明文件',
  /"files"\s*:\s*\[\s*"src\/content\/content-script\.ts"\s*,\s*"src\/types\/chrome\.d\.ts"\s*,\s*"src\/types\/globals\.d\.ts"\s*,\s*"src\/types\/recommendation-types\.d\.ts"\s*\]/u.test(contentTsconfigSource));
/*
 * `files` and `include` are inherited SEPARATELY, so an inherited `include` would also join the program. Measured: the first
 * version of that config compiled three files and emitted the worker and the panel. An empty `include` is what makes `files` the
 * complete program.
 */
check('内容 emit 的 include 为空（阻止继承 include 再次加入文件）', /"include"\s*:\s*\[\s*\]/u.test(contentTsconfigSource));
check('内容 emit 会产出 JS（noEmit 关闭）', contentCompilerOptions.noEmit === false);
check('构建脚本先用主配置做类型检查', /runTsc\('tsconfig\.json', 'TypeScript 类型检查'\)/u.test(buildScript));
check('构建脚本不再用主配置作为 emit 生产者',
  !/execFileSync\(process\.execPath, \[tsc, '-p', join\(extensionDir, 'tsconfig\.json'\)\]/u.test(buildScript));

/*
 * ## No emitted output may live inside a source tree
 *
 * `.gitignore` is a safety net here, not a detector: an ignored stray file is INVISIBLE in `git status`, so a recurrence would be
 * quieter, not louder. This has already happened twice — four files at the repository root (committed once and then removed), and
 * three more under `apps/extension/src` from a build run before `noEmit` was in place.
 *
 * The check is precise rather than a glob sweep: an emitted `.js` is always a SIBLING of a source file with the same stem, so a
 * hand-written `.js` with no `.ts` counterpart is left alone. `packages/provider/dist` and the extension's `dist` are the intended
 * homes and are outside `src/`.
 */
const strayEmitted = [];
const scanForEmitted = (dir, depth = 0) => {
  if (depth > 8 || !existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) { scanForEmitted(full, depth + 1); continue; }
    if (!/\.(js|d\.ts|js\.map|d\.ts\.map)$/u.test(entry.name)) continue;
    if (!full.split('\\').join('/').includes('/src/')) continue;
    if (existsSync(full.replace(/\.(js|d\.ts|js\.map|d\.ts\.map)$/u, '.ts'))) {
      strayEmitted.push(relative(repoRoot, full).split('\\').join('/'));
    }
  }
};
scanForEmitted(join(repoRoot, 'src'));
scanForEmitted(join(repoRoot, 'apps'));
scanForEmitted(join(repoRoot, 'packages'));

check('任何 src/ 下都不存在编译产物（.js/.d.ts/.map 与同名 .ts 并存）',
  strayEmitted.length === 0, strayEmitted.join(', '));

/*
 * ## The main config really covers every source file
 *
 * `noEmit` and an `include` pattern are declarations. This asks the COMPILER for its program with `--listFiles`, so a file that
 * quietly stopped being checked — excluded, or left out of `include` — is caught rather than assumed to be covered. The memory
 * cache is the case that matters today: nothing imports it yet, so only this makes its coverage real.
 */
const mainProgramFiles = execFileSync(process.execPath, [tscBin, '-p', join(extensionDir, 'tsconfig.json'), '--noEmit', '--listFiles'], {
  cwd: repoRoot,
  encoding: 'utf8',
});
for (const source of [
  'src/background/memory-cache.ts',
  'src/background/service-worker.ts',
  'src/content/content-script.ts',
  'src/sidepanel/sidepanel.ts',
]) {
  check(`主 typecheck program 包含 ${source}`, mainProgramFiles.replace(/\\/gu, '/').includes(source));
}

/*
 * ## Bundle safety
 *
 * A bundle that leaves a bare specifier or reaches a Node built-in would fail in the browser, and esbuild does not consider
 * either an error when the target is a browser — it happily emits the specifier. So the artifact is checked directly.
 *
 * `require(` is checked as a CALL, not as a substring: bundlers legitimately emit helper names containing the word.
 */
for (const [label, artifact] of [['worker', workerSource], ['panel', panelSource]]) {
  const specs = [...artifact.matchAll(/(?:^|\n)\s*import\s[^\n]*from\s*['"]([^'"]+)['"]/gu)].map((match) => match[1] ?? '');
  check(`${label} bundle 无裸模块说明符`, specs.length === 0, specs.join(', '));
  check(`${label} bundle 无 node: 说明符`, !/['"]node:[^'"]+['"]/u.test(artifact));
  check(`${label} bundle 无 CommonJS require 调用`, !/\brequire\s*\(\s*['"]/u.test(artifact));
  check(`${label} bundle 是单文件（无 import./export-from 外部引用）`, !/\bfrom\s*['"]\.\//u.test(artifact));
}
/*
 * Format contracts. The manifest declares the worker a module, so module syntax is legal and required there; the panel must
 * stay classic-parseable because the skeleton applies a classic-script parse to it (see CLASSIC_SCRIPTS above).
 */
check('worker bundle 为 ESM（含模块语法）', /^\s*(?:const|var|let|function|class|import|export)/mu.test(workerSource)
  && (manifest.background?.type === 'module'));
check('manifest 声明 worker 为 ES module', manifest.background?.type === 'module');

/*
 * ## Dist shape
 *
 * The manifest names one worker file and the HTML names one panel file, so a source map, a shared chunk or a sidecar runtime
 * would be a file the browser never loads — and the build's own listing would show it only as an extra line. Bundling is the
 * step most likely to introduce one, so the emitted set is pinned exactly.
 */
const EXPECTED_DIST_FILES = [
  'background/service-worker.js',
  'content/content-script.js',
  'manifest.json',
  'sidepanel/sidepanel.css',
  'sidepanel/sidepanel.html',
  'sidepanel/sidepanel.js',
];
const emittedNow = emitted(distDir);
check('dist 文件集合与契约完全一致', JSON.stringify(emittedNow) === JSON.stringify(EXPECTED_DIST_FILES),
  emittedNow.join(', '));
for (const stray of ['.map', '.chunk.', 'assets/', 'runtime']) {
  check(`dist 无额外产物 ${stray}`, !emittedNow.some((file) => file.includes(stray)));
}

/*
 * ## The core-bundle proof
 *
 * The worker imports ONE core function and calls it once. The call is the point: an unused import is dead code a bundler may
 * legitimately remove, so "the source imports core" cannot stand in for "the artifact contains core" — and this project has
 * already been misled once by a check that could not fail. The probe's result is compared and the comparison throws, so neither
 * the call nor the core module behind it can be elided.
 *
 * The marker is matched with EITHER quote style: esbuild rewrites string literals to double quotes, so a single-quoted probe
 * could never match a bundled artifact by construction.
 */
const CORE_BUNDLE_MARKER = />\s*0\s*\?\s*["']available["']\s*:\s*["']full["']/u;
const workerSourceTs = readFileSync(join(distDir, '..', 'src', 'background', 'service-worker.ts'), 'utf8');
check('worker 源码 import 了 core 的 availabilityFromSeats',
  /import\s*\{[^}]*availabilityFromSeats[^}]*\}\s*from\s*'@course-copilot\/core\/eligibility'/u.test(workerSourceTs));
/*
 * UPDATED IN 16F-C. The worker used to import exactly ONE module, and this asserted that set verbatim. The wiring step added the
 * provider package, a core TYPE, and the worker's own cache, so the assertion now fixes the whole set — which is stronger than
 * the old one, since an unexpected import is a failure rather than something the old check could not see.
 *
 * `@course-copilot/core/course` is a declared public subpath and is imported as a TYPE only, so it adds no runtime edge.
 *
 * UPDATED IN 16I-E for `@course-copilot/recommendation`, IN 16I-F for the extension's own policy module, IN 16I-G for the runner,
 * IN 16J-B for the visible-row sender primitive, IN 16J-E for the composed page reader, IN 16J-F-B for the full composition that
 * SUPERSEDES `./visible-courses.js`, and IN 16J-F-B-R1 which REMOVED `./recommendation-runtime.js` as redundant. The set stays fixed
 * exactly, so an unexpected import fails here rather than passing unnoticed.
 *
 * Note which modules are absent, and why. The worker imports neither the ENGINE nor the RUNNER directly: the runner is the route to
 * the engine and it carries this host's policy binding, and the composition is the route to the runner. Reaching for either one
 * directly would leave the worker holding something it could not legitimately call.
 *
 * The runner import was removed in 16J-F-B-R1 after MEASUREMENT rather than reasoning: with the composition in place and guarded,
 * deleting the direct runner import and its guard left every required symbol in the artifact unchanged — the runner, the adapter,
 * the transport and the engine's own `calculateReviewConfidence` / `calculateCourseScore` / `normalizePreferences` — with exactly one
 * `new MemoryCache(` and one `new WhuCoursesProvider(`, and a 196-byte smaller bundle. The only thing that disappeared was the
 * guard's own text.
 *
 * So the ownership is now: the worker holds the HIGHEST-LEVEL composition, and everything below it arrives by dependency closure.
 */
/*
 * The ninth entry is the teacher-hydration RELAY, added in 16J-PREUI-E4-B2. It is a second forwarding module rather than a generalised one: a relay is a few
 * lines, and the two features' relays differ in nothing but their message names, so a parameterised abstraction would buy those lines at the cost of a
 * framework to follow three string comparisons. It holds no session and knows no selector, which the worker DOM-knowledge gate asserts on the artifact.
 */
check('worker 的 import 集合恰好是这十一个（core 值 / core 类型 / provider / 本地 cache / 出站边界 / 本地 policy / 本地 visible-recommendations / 本地 auto-expand 转发 / 本地 teacher-hydration 转发 / 本地 preparation 转发 / 本地 availability-filter 转发）',
  JSON.stringify([...workerSourceTs.matchAll(/^\s*import\s+[^\n]*?from\s*['"]([^'"]+)['"]/gmu)].map((m) => m[1] ?? '').sort())
    === JSON.stringify([
      '@course-copilot/core/course',
      '@course-copilot/core/eligibility',
      '@course-copilot/provider',
      './memory-cache.js',
      './public-review-fetch.js',
      './recommendation-policy.js',
      './visible-recommendations.js',
      './auto-expand-forward.js',
      './teacher-hydration-forward.js',
      './preparation-forward.js',
      './availability-filter-forward.js',
    ].sort()));
check('worker 真实消费 probe 结果（不可被 tree-shake）', /coreBundleProbe\s*!==\s*["']full["']/u.test(workerSourceTs));
check('core 代码实际进入 worker 产物', CORE_BUNDLE_MARKER.test(workerSource));
check('worker 产物含 availabilityFromSeats 实现', workerSource.includes('availabilityFromSeats'));
/*
 * UPDATED IN 16F-C. `WhuCoursesProvider` and `RequestLimiter` are now SUPPOSED to be present — that is the wiring. What must stay
 * out is the Node host's tier, which is what this check is actually about.
 */
check('worker 未引入 Node 侧 TtlCache 与 Node factory',
  !['TtlCache', 'createNodeWhucoursesProvider'].some((symbol) => workerSource.includes(symbol)));
/*
 * The narrower checks that replace the removed `fetch`/`whucourses` tokens.
 *
 * The BUNDLE necessarily contains both — the provider's `fetchImpl` reference and its origin constant are the implementation. The
 * worker's own SOURCE is what must stay free of them: it constructs the provider and never calls it, so it has no reason to name a
 * URL or invoke `fetch` itself.
 */
{
  const workerCodeTs = workerSourceTs.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1');
  check('worker 源码不调用 fetch（只由 provider 持有引用）',
    !/\bfetch\s*\(/u.test(workerCodeTs) && !/globalThis\.fetch\s*\(/u.test(workerCodeTs));
  /*
   * The SITE ADDRESS, not the bare token: what must never appear is a URL this worker could reach. Matching the token alone would
   * also match unrelated identifiers, which is how a check starts failing for the wrong reason.
   */
  check('worker 源码不出现 whucourses 站点地址', !/whucourses\.(?:cn|com)/iu.test(workerCodeTs));
  /*
   * UPDATED IN 16G-C. This used to forbid every provider query method, because the provider was wired but dormant. The
   * public-review message legitimately calls `searchCourse`, so the statement is now narrower and stronger: that ONE method is
   * called, in exactly ONE place, and the provider's other entry points are still never invoked.
   */
  const searchCourseCalls = workerCodeTs.split(/\.searchCourse\s*\(/u).length - 1;
  check('worker 恰好调用一次 provider.searchCourse（公开评价消息）', searchCourseCalls === 1, String(searchCourseCalls));
  check('worker 不调用 provider 的其它查询方法',
    !/\.isAvailable\s*\(|\.reviews\s*\(/u.test(workerCodeTs));
  /*
   * The wiring must be REAL and cannot be tree-shaken: the source has to construct both, once, and consume the provider's stats in
   * a comparison that throws. An import alone would be dead code a bundler may remove.
   */
  check('worker 构造且仅构造一个 MemoryCache', [...workerCodeTs.matchAll(/new MemoryCache</gu)].length === 1);
  check('worker 构造且仅构造一个 WhuCoursesProvider', [...workerCodeTs.matchAll(/new WhuCoursesProvider\(/gu)].length === 1);
  check('worker 消费 provider 的 cacheStats（不可被 tree-shake）',
    /reviewProvider\.cacheStats/u.test(workerCodeTs) && /initialCacheStats\.hits\s*!==\s*0/u.test(workerCodeTs));
  check('worker 的 TTL 恰为 6 小时', /const REVIEW_CACHE_TTL_MS = 6 \* 60 \* 60 \* 1000;/u.test(workerCodeTs));
  check('worker 未从应用 src/config 取 TTL', !/from\s*['"][^'"]*config\.js['"]/u.test(workerCodeTs));
  check('worker 不把任何东西挂到 globalThis', !/globalThis\./u.test(workerCodeTs.replace(/globalThis\.fetch/gu, '')));
  /*
   * The provider must receive the GUARDED fetch, not the ambient one. Leaving `fetchImpl` at its default would install an
   * unrestricted fetch in the one place that is supposed to be restricted, and the worker would still look correct.
   */
  check('worker 把 guarded fetch 注入 provider',
    /fetchImpl:\s*guardedPublicReviewFetch/u.test(workerCodeTs));
}

/*
 * ## The canonical recommendation engine is CARRIED, not used (16I-E)
 *
 * Two separate properties, and the provider block above already showed why both are needed.
 *
 * The import alone is not enough: esbuild DROPS an unused imported function, so an import with no runtime consumption simply
 * disappears — measured in this step, where replacing the guard with `void recommendCourses;` returned the worker to its exact
 * pre-import size. So the source must CONSUME the symbol in a way a bundler keeps, and the ARTIFACT must then be checked for the
 * engine's real logic, because elision is a decision only the build can be asked about.
 *
 * The `deps.policy` reads are the decisive artifact markers: they exist only after the 16I-C move, so their presence proves this
 * is the canonical package engine rather than a stale or re-implemented copy. The root compatibility boundary must be absent,
 * because it injects the DSH host's policy and the extension is a different host.
 */
{
  const workerCodeTs = workerSourceTs.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1');
  const workerBundleCode = workerSource.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1');

  /*
   * A PATTERN instead of an import. UPDATED IN 16I-G, which moved the worker's engine route to the runner: the worker no longer
   * imports the canonical package directly, because importing the engine would leave it holding an engine it could not
   * legitimately call — the policy has to come from somewhere, and the runner is the one place that binds this host's.
   *
   * What this check is for is unchanged: the worker must never reach the engine through the application's wrapper. That is
   * asserted here and again in the runner block below, where the runner's own dependency is fixed exactly.
   */
  check('worker 不从应用 src/pipeline/recommend 导入',
    !/src\/pipeline\/recommend/u.test(workerCodeTs));
  check('worker 不直接 import canonical engine（16I-G 起经 runner）',
    !/from\s*['"]@course-copilot\/recommendation['"]/u.test(workerCodeTs));
  check('worker 不出现引擎符号（16I-G 起经 runner）',
    !workerCodeTs.includes('recommendCourses'));
  check('worker 不调用 planQueries / lookupReviews / explainCourse',
    !/\b(?:planQueries|lookupReviews|explainCourse)\s*\(/u.test(workerCodeTs));
  check('worker 尚未定义自己的 recommendation policy（16I-F 起由 owner 文件持有）',
    !/export const \w*POLICY\w* = /u.test(workerCodeTs));
  check('worker 仍不构造第二个 cache/provider（各恰好 1 个）',
    [...workerCodeTs.matchAll(/new MemoryCache</gu)].length === 1
    && [...workerCodeTs.matchAll(/new WhuCoursesProvider\(/gu)].length === 1);

  // The ARTIFACT: the engine's real logic must have survived the bundler.
  check('产物包含 canonical engine 的 policy 读取（4 处）',
    /deps\.policy\.candidateLimit/u.test(workerBundleCode)
    && /deps\.policy\.defaultTopN/u.test(workerBundleCode)
    && /deps\.policy\.defaultPreferences/u.test(workerBundleCode)
    && /Math\.min\(deps\.policy\.maxTopN/u.test(workerBundleCode));
  check('产物包含 engine 的查询规划与打分链路',
    /function planQueries\(/u.test(workerBundleCode)
    && /filterEligible\(/u.test(workerBundleCode)
    && /calculateReviewConfidence\(/u.test(workerBundleCode)
    && /calculateCourseScore\(/u.test(workerBundleCode));
  check('产物不含 root compatibility boundary',
    !/hostPolicy|legacyCandidateLimit/u.test(workerBundleCode));
  check('产物不含 host policy 默认值',
    !/DEFAULT_TOP_N|DEFAULT_PREFERENCES/u.test(workerBundleCode));
  check('产物仍不含 Node 侧符号',
    !['node:', 'Buffer', 'process.', 'require(', 'TtlCache', 'createNodeWhucoursesProvider']
      .some((symbol) => workerBundleCode.includes(symbol)));
  check('产物仍恰好 1 个 MemoryCache / 1 个 WhuCoursesProvider / 1 个 RequestLimiter',
    [...workerBundleCode.matchAll(/new MemoryCache\(/gu)].length === 1
    && [...workerBundleCode.matchAll(/new WhuCoursesProvider\(/gu)].length === 1
    && [...workerBundleCode.matchAll(/new RequestLimiter\(/gu)].length === 1);
}

/*
 * ## Structured evidence across the provider boundary (16I-G-R3)
 *
 * `defaultLookup` is the lookup the recommendation path uses. It merges rows across providers, so it may only publish the
 * provider's structured aggregates when there is ONE source: `dataHygiene` divides by `courseLevel.courseReviewCount`, and a
 * one-source count attached to a multi-source corpus is a ratio whose numerator and denominator come from different rows.
 *
 * The freeze is checked here as well as in the focused tests, because it is a scope statement about the ENGINE: this step repairs
 * `defaultLookup` and nothing else. `lookupReviews` has its own, separate gap — it never lifts `courseSupplementary` to its result
 * — and that is deliberately left alone, since the recommendation path does not consume it.
 */
{
  const enginePath = join(distDir, '..', '..', '..', 'packages', 'recommendation', 'src', 'recommend.ts');
  check('recommendation engine 源文件存在', existsSync(enginePath));
  const engineSource = existsSync(enginePath) ? readFileSync(enginePath, 'utf8') : '';
  const engineCode = engineSource.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1');

  // One source: all three aggregates are read from the single provider.
  check('defaultLookup 透传三个结构化字段',
    ['result.courseLevel', 'result.teachingClassLevel', 'result.courseSupplementary']
      .every((field) => engineCode.includes(field)));
  check('defaultLookup 的透传受 providers.length === 1 约束',
    engineCode.includes('providers.length === 1'));
  // No cross-provider guess.
  check('defaultLookup 不按位置或"canonical"挑 provider',
    !['providers[0]', 'find((provider', 'canonical'].some((bad) => engineCode.includes(bad)));

  // The scope freeze: lookupReviews is untouched by this step — the WHOLE region, not only its writes. A read is a change too.
  const lookupStart = engineCode.indexOf('export async function lookupReviews');
  const lookupEnd = engineCode.indexOf('export function syntheticCourse');
  const lookupSection = lookupStart > 0 && lookupEnd > lookupStart ? engineCode.slice(lookupStart, lookupEnd) : '';
  check('lookupReviews 未被本步改动（整段都不出现 courseSupplementary）',
    lookupSection.includes('result.courseLevel =')
    && lookupSection.includes('result.teachingClassLevel =')
    && !lookupSection.includes('courseSupplementary'));
}

/*
 * ## The full-visible-row sender primitive (16J-B)
 *
 * `COURSE_COPILOT_QUERY_VISIBLE_ROWS` is an EXISTING content-side contract; this step adds the worker-side way to ask, and the
 * worker CARRIES it without calling it. Three things are fixed here:
 *
 * 1. the SCOPE COUNTS, which are the reason this section exists at all. `SERVICE-WORKER FILE` message types stay at 5 — the worker
 *    declares no type for this — while the `BACKGROUND RUNTIME` union gains the type by importing the helper. Reporting a bare
 *    "message types = N" is what made an earlier report read as though a message had gone missing.
 * 2. the primitive is transport ONLY: it validates its tab id, sends one message, shape-checks the reply, and returns rows or an
 *    empty array. It must not cache, and it must not touch the status path's state.
 * 3. it is dormant: no production path calls it.
 */
{
  const workerCodeTs = workerSourceTs.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1');
  const visibleRowsPath = join(distDir, '..', 'src', 'background', 'visible-rows.ts');
  check('visible-rows helper 文件存在', existsSync(visibleRowsPath));
  const helperSource = existsSync(visibleRowsPath) ? readFileSync(visibleRowsPath, 'utf8') : '';
  const helperCode = helperSource.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1');

  /*
   * SCOPE COUNTS, stated with their scope.
   *
   * UPDATED IN 16J-G-B: the worker's own declaration set grew to six when the recommendation handler was added. The transport type
   * is still declared in the helper module instead, which is what makes the background runtime union seven while the worker file
   * count is six.
   *
   * UPDATED IN RELEASE-BLOCKER-B1: both counts grew by one when the worker began RELAYING the preparation report. Its type is now named in the worker, so the
   * file count is seven and the runtime union eight — still with exactly one type (the visible-rows query) coming from the helper. The scope distinction this
   * section exists for is unchanged: naming a type to relay it is not the same as owning the session it describes.
   */
  const workerDeclared = [...workerCodeTs.matchAll(/const \w+_MESSAGE = '([^']+)'/gu)].map((m) => m[1]).sort();
  check('SERVICE-WORKER FILE 消息类型 = 7',
    JSON.stringify(workerDeclared) === JSON.stringify([
      'COURSE_COPILOT_FULL_PREPARATION_EVENT',
      'COURSE_COPILOT_PAGE_STATUS',
      'COURSE_COPILOT_PANEL_COUNT',
      'COURSE_COPILOT_PING',
      'COURSE_COPILOT_QUERY_PUBLIC_REVIEWS',
      'COURSE_COPILOT_QUERY_RECOMMENDATIONS',
      'COURSE_COPILOT_QUERY_STATUS',
    ].sort()),
    JSON.stringify(workerDeclared));
  check('BACKGROUND RUNTIME 消息并集 = 8（helper 带入 QUERY_VISIBLE_ROWS）',
    [...new Set([
      ...workerDeclared,
      ...[...helperCode.matchAll(/'(COURSE_COPILOT_[A-Z_]+)'/gu)].map((m) => m[1]),
    ])].length === 8
    && helperCode.includes('COURSE_COPILOT_QUERY_VISIBLE_ROWS'));
  check('helper 只声明这一个消息类型',
    [...helperCode.matchAll(/'(COURSE_COPILOT_[A-Z_]+)'/gu)].length === 1);

  // Transport only.
  check('helper 发送点唯一且形状正确',
    [...helperCode.matchAll(/chrome\.tabs\.sendMessage\(/gu)].length === 1
    && /\{ type: QUERY_VISIBLE_ROWS_MESSAGE \}/u.test(helperCode));
  check('helper 用 Number.isInteger 校验 tabId（非 typeof）',
    helperCode.includes('Number.isInteger(tabId)'));
  check('helper 形状校验：对象且 rows 为数组',
    helperCode.includes('typeof reply !==') && helperCode.includes('Array.isArray(record.rows)'));
  check('helper 不缓存、不落盘、不读取页面信息',
    !['storage', 'localStorage', 'sessionStorage', 'indexedDB', 'new Map', '.query('].some((bad) => helperCode.includes(bad)));
  check('helper 不触碰 worker 的 status 状态',
    !['knownStatus', 'knownPanelCount', 'reportingTabIds'].some((name) => helperCode.includes(name)));
  check('helper 不做任何推荐/网络计算',
    !['recommend', 'provider', 'fetch(', 'searchCourse'].some((bad) => helperCode.includes(bad)));

  /*
   * Dormant in production: in the bundle, called nowhere.
   *
   * UPDATED IN 16J-E. The worker used to import this primitive directly and hold it behind a `typeof` guard. It now imports the
   * COMPOSITION one level up, so the primitive reaches the bundle as that module's dependency. The old assertions — a direct
   * worker import and a worker-level `typeof` guard — would now be false statements about the code, and checking them would be
   * checking for a shape the design deliberately moved away from.
   *
   * What still matters is unchanged and asserted: the worker's own source never names the primitive, and the primitive IS in the
   * artifact with the message type reachable from production code.
   */
  check('worker 不直接 import transport primitive（改由组合携带）',
    !workerCodeTs.includes('requestVisibleRows') && !workerCodeTs.includes("from './visible-rows.js'"));
  check('transport primitive 仍在 bundle 中',
    existsSync(join(distDir, 'background', 'service-worker.js'))
    && readFileSync(join(distDir, 'background', 'service-worker.js'), 'utf8').includes('COURSE_COPILOT_QUERY_VISIBLE_ROWS'));

  check('未产生独立的 visible-rows.js', !existsSync(join(distDir, 'background', 'visible-rows.js')));
  check('panel 尚未接入 full-visible 请求',
    !readFileSync(join(distDir, '..', 'src', 'sidepanel', 'sidepanel.ts'), 'utf8').includes('VISIBLE_ROWS'));
}

/*
 * ## The RowIdentity → NormalizedCourse adapter (16J-D)
 *
 * A pure field mapping living in the extension, because the application's canonical `toNormalizedCourse` reaches into root `src/`
 * and the extension's boundary forbids that. What this gate fixes is that the adapter decides NOTHING the engine already decides:
 * availability comes from the core helper, the teacher cell stays whole, no competition fact is manufactured, and sections are not
 * merged.
 *
 * The worker does not import it yet, so this step changes no production artifact — asserted separately by the build's hashes.
 */
{
  // Redeclared: `const` in the blocks above is scoped to them, and this block reads its own comment-stripped copy.
  const workerCodeTs = workerSourceTs.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1');
  const adapterPath = join(distDir, '..', 'src', 'background', 'row-to-course.ts');
  check('row-to-course adapter 文件存在', existsSync(adapterPath));
  const adapterSource = existsSync(adapterPath) ? readFileSync(adapterPath, 'utf8') : '';
  const adapterCode = adapterSource.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1');

  // The import boundary: three canonical core subpaths, nothing else.
  const adapterImports = [...adapterCode.matchAll(/from\s*['"]([^'"]+)['"]/gu)].map((m) => m[1] ?? '').sort();
  check('adapter 只依赖三个 canonical core 子路径',
    JSON.stringify(adapterImports) === JSON.stringify([
      '@course-copilot/core/course',
      '@course-copilot/core/eligibility',
      '@course-copilot/core/normalize',
    ].sort()),
    JSON.stringify(adapterImports));
  check('adapter 不触达 root src / 其它 workspace package',
    !['src/', 'adapters/table', 'dom/html', '@course-copilot/provider', '@course-copilot/recommendation']
      .some((bad) => adapterCode.includes(bad)));

  // The decisions it must delegate.
  check('adapter 用 canonical availabilityFromSeats 派生可用性',
    adapterCode.includes('availabilityFromSeats(')
    && !/remainingSeats\s*[<>]=?\s*0/u.test(adapterCode));
  check('adapter 用 canonical normalizeCourseName / normalizeTeacherName',
    adapterCode.includes('normalizeCourseName(') && adapterCode.includes('normalizeTeacherName('));
  check('adapter 不 split teacher（保留整格字符串）',
    !adapterCode.includes('teacherNames') && !/teacher\.split\(/u.test(adapterCode));
  /*
   * UPDATED IN PRE-RELEASE-UX-A5. `selectedThisRound` came OFF this list, because the adapter now carries it as a second raw seat FACT
   * read from its own granted leaf. The boundary the rule protects is unchanged — no interpretation happens here — so the replacement
   * is sharper rather than looser: the seat assignments must stay plain assignments, with no derived quantity and no comparison between
   * 余量 and 本轮已选. Comments are stripped first, because the surrounding prose names those concepts while forbidding them and would
   * otherwise fail the rule on its own explanation.
   */
  check('adapter 不制造 competition fact（seat 字段只做赋值，不派生/比较）',
    !['roundQuota', 'competition', 'page_native', 'risk'].some((bad) => adapterCode.includes(bad))
    && adapterCode
      .split('\n')
      .map((line) => line.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, ''))
      .filter((line) => line.includes('remainingSeats') || line.includes('selectedThisRound'))
      .every((line) => !['/', '*', '+', 'ratio', 'percent', 'Math.', ' > ', ' < '].some((derived) => line.includes(derived))));
  check('adapter 不去重 / 不聚合 section',
    !['dedupe', 'new Set', 'new Map', 'unique('].some((bad) => adapterCode.includes(bad))
    && /\.map\(/u.test(adapterCode) && /\.filter\(/u.test(adapterCode));
  check('adapter 不做 ranking / review / 过滤',
    !['rank', 'score', 'confidence', 'searchCourse', 'filterEligible', 'matchCourse'].some((bad) => adapterCode.includes(bad)));
  check('adapter credits 只保存不参与判断', !/credits\s*[<>]/u.test(adapterCode));

  /*
   * The adapter is reached TRANSITIVELY, through the composition the worker imports — never named by the worker itself.
   *
   * This replaced a 16J-D check that the worker does not import the adapter at all. That check would now be a statement about
   * nothing, because the adapter IS in the bundle. What still matters, and is asserted, is that the worker's own source does not
   * name it: the dependency runs one way, through `visible-courses`.
   */
  check('worker 不直接 import adapter（只经组合传递）',
    !workerCodeTs.includes('row-to-course'));
  check('adapter 已进入 bundle（经组合传递）',
    existsSync(join(distDir, 'background', 'service-worker.js'))
    && readFileSync(join(distDir, 'background', 'service-worker.js'), 'utf8').includes('rowIdentityToCourse'));
  check('未产生独立的 row-to-course.js',
    !existsSync(join(distDir, 'background', 'row-to-course.js')));
}

/*
 * ## The composed page reader (16J-E)
 *
 * `requestVisibleCourses(tabId)` joins the transport to the adapter, so the worker now CARRIES the whole path from a tab to
 * canonical courses. The composition must stay two delegated steps: no second transport, no second mapping, no cache, and — the
 * boundary this step exists to protect — no reach into the recommendation engine.
 */
{
  // Redeclared: `const` in the block above is scoped to it.
  const workerCodeTs = workerSourceTs.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1');
  const composePath = join(distDir, '..', 'src', 'background', 'visible-courses.ts');
  check('visible-courses 组合文件存在', existsSync(composePath));
  const composeSource = existsSync(composePath) ? readFileSync(composePath, 'utf8') : '';
  const composeCode = composeSource.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1');

  check('组合只依赖两个本地模块 + 一个 canonical 类型',
    JSON.stringify([...composeCode.matchAll(/from\s*['"]([^'"]+)['"]/gu)].map((m) => m[1] ?? '').sort())
      === JSON.stringify(['./row-to-course.js', './visible-rows.js', '@course-copilot/core/course'].sort()));
  check('组合委托 transport（调用 requestVisibleRows）', composeCode.includes('requestVisibleRows('));
  check('组合委托 adapter（调用 rowIdentitiesToCourses）', composeCode.includes('rowIdentitiesToCourses('));
  check('组合不重写 transport（不碰 chrome / tabId / 消息类型）',
    !['chrome', 'sendMessage', 'QUERY_VISIBLE_ROWS', 'Number.isInteger', 'Array.isArray'].some((bad) => composeCode.includes(bad)));
  check('组合不重写 mapping（不 normalize / 不处理 teacher / 不算 availability）',
    !['normalizeCourseName', 'normalizeTeacherName', 'availabilityFromSeats', 'remainingSeats', 'teacher', 'credits', 'source:']
      .some((bad) => composeCode.includes(bad)));
  check('组合与 recommendation 完全分离',
    !['recommendExtensionCourses', 'recommendCourses', 'recommendation-runtime', 'recommendation-policy',
      'EXTENSION_RECOMMENDATION_POLICY', 'reviewProvider', 'WhuCoursesProvider', 'MemoryCache', 'provider',
      'src/', 'presentation', '@course-copilot/recommendation'].some((bad) => composeCode.includes(bad)));
  check('组合无缓存无状态',
    !['new Map', 'new Set', 'storage', 'cache', 'knownStatus', 'knownPanelCount', 'reportingTabIds'].some((bad) => composeCode.includes(bad)));
  check('组合不声明消息类型', !composeCode.includes('COURSE_COPILOT_'));

  /*
   * The worker carries the composition set. UPDATED IN 16J-F-B: the worker imports the FULL composition
   * (`visible-recommendations`), so it names neither `visible-courses` nor the transport primitive. The invariants that still
   * hold, and are asserted, are that the worker imports SOME composed module inertly and calls none of them.
   */
  check('worker import 某个组合模块而非链路中间层',
    /import \{ requestVisibleRecommendations \} from '\.\/visible-recommendations\.js'/u.test(workerCodeTs)
    && !workerCodeTs.includes("from './visible-courses.js'")
    && !workerCodeTs.includes("from './visible-rows.js'"));
  check('worker 以此前定义的 typeof 守卫消费组合',
    /typeof requestVisibleRecommendations !== 'function'/u.test(workerCodeTs));
  /*
   * UPDATED IN 16J-G-B, which gave the composition its one real caller. The old rule — "it appears only in its import and its guard" —
   * is superseded: the symbol also appears in the handler branch, and that is the point of the step. What replaces it, stated so it
   * can actually fail: exactly ONE call in the whole worker, it lives inside the handler branch, and it disappears when that branch
   * is removed — so nothing calls it at module scope.
   */
  const composeGuard = /if \(typeof requestVisibleRecommendations !== 'function'\) \{[\s\S]*?\n\}/u.exec(workerCodeTs)?.[0] ?? '';
  const recommendationsBranch = /if \(type === QUERY_RECOMMENDATIONS_MESSAGE\) \{[\s\S]*?\n    \}/u.exec(workerCodeTs)?.[0] ?? '';
  check('组合在 worker 中恰好被调用一次，且只在该 handler 分支内',
    composeGuard.includes('typeof requestVisibleRecommendations')
    && recommendationsBranch.includes('requestVisibleRecommendations(')
    && [...workerCodeTs.matchAll(/requestVisibleRecommendations\(/gu)].length === 1
    && !workerCodeTs.split(recommendationsBranch).join('').includes('requestVisibleRecommendations('));

  // The bundle contains the whole chain, still browser-safe.
  const bundle = existsSync(join(distDir, 'background', 'service-worker.js'))
    ? readFileSync(join(distDir, 'background', 'service-worker.js'), 'utf8')
    : '';
  check('bundle 含完整链（compose / page-reader / transport / adapter / runner）',
    ['requestVisibleRecommendations', 'requestVisibleCourses', 'requestVisibleRows', 'rowIdentityToCourse', 'recommendExtensionCourses']
      .every((symbol) => bundle.includes(symbol)));
  check('bundle 仍无 node/root-src 依赖',
    !['node:', 'Buffer', 'require(', 'src/adapters', 'dom/html'].some((bad) => bundle.includes(bad)));
  check('未产生任何独立链路模块',
    !['visible-recommendations.js', 'visible-courses.js', 'visible-rows.js', 'row-to-course.js', 'recommendation-runtime.js']
      .some((m) => existsSync(join(distDir, 'background', m))));
}

/*
 * ## The page-to-recommendation composition (16J-F-B)
 *
 * `requestVisibleRecommendations(tabId, { provider })` joins the page reader to the runner. It is the LAST join in the internal
 * chain and must stay a join: no provider construction, no policy, no coverage, no empty-list shortcut, no error envelope. Each
 * omission is a decision recorded in the module, so each is asserted here.
 */
{
  // Redeclared: `const` in the block above is scoped to it.
  const workerCodeTs = workerSourceTs.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1');
  const joinPath = join(distDir, '..', 'src', 'background', 'visible-recommendations.ts');
  const joinCode = existsSync(joinPath)
    ? readFileSync(joinPath, 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1')
    : '';
  check('visible-recommendations 组合文件存在', existsSync(joinPath));

  check('组合只依赖两个本地模块 + 三个 canonical 类型',
    JSON.stringify([...joinCode.matchAll(/from\s*['"]([^'"]+)['"]/gu)].map((m) => m[1] ?? '').sort())
      === JSON.stringify([
        './recommendation-runtime.js',
        './visible-courses.js',
        '@course-copilot/core/course',
        '@course-copilot/provider',
        '@course-copilot/recommendation',
      ].sort()));
  check('组合委托页面读取（调用 requestVisibleCourses）', joinCode.includes('requestVisibleCourses('));
  check('组合委托 runner（调用 recommendExtensionCourses）', joinCode.includes('recommendExtensionCourses('));
  check('组合不构造 provider / cache / limiter',
    !['WhuCoursesProvider', 'MemoryCache', 'RequestLimiter', 'guardedPublicReviewFetch', 'new '].some((bad) => joinCode.includes(bad)));
  check('组合不知道 policy',
    !['EXTENSION_RECOMMENDATION_POLICY', 'RecommendationPolicy', 'recommendation-policy', 'defaultPreferences',
      'defaultTopN', 'maxTopN', 'candidateLimit'].some((bad) => joinCode.includes(bad)));
  check('组合不制造 coverage',
    !['coverage', 'coursesDiscovered', 'sectionsDiscovered', 'sectionsHydrated', 'exhausted'].some((bad) => joinCode.includes(bad)));
  check('组合不短路空输入 / 不自造结果 / 不包错误',
    !/length\s*===\s*0/u.test(joinCode)
    && !['recommendations:', 'dataCoverage', 'try', 'catch', 'ok:'].some((bad) => joinCode.includes(bad)));
  check('组合不触达 provider.searchCourse / root src / presentation',
    !['searchCourse', 'src/', 'presentation'].some((bad) => joinCode.includes(bad)));

  check('worker import 完整组合',
    /import \{ requestVisibleRecommendations \} from '\.\/visible-recommendations\.js'/u.test(workerCodeTs));
  check('worker 不直接 import visible-courses',
    !workerCodeTs.includes("from './visible-courses.js'"));
  /*
   * UPDATED IN 16J-F-B-R1. This used to require the runner to keep its own direct import and guard. Measurement showed that was
   * redundant once the composition existed and was guarded: removing it left the runner, the adapter, the transport and the engine's
   * own logic all present, with a 196-byte smaller bundle. So the requirement is inverted — the worker must NOT reach for the runner
   * directly, because everything below the composition arrives by dependency.
   */
  check('worker 不直接 import runner（经组合闭包携带）',
    !workerCodeTs.includes("from './recommendation-runtime.js'")
    && !workerCodeTs.includes('recommendExtensionCourses'));
  check('worker 以 typeof 守卫消费完整组合',
    /typeof requestVisibleRecommendations !== 'function'/u.test(workerCodeTs));
  /*
   * UPDATED IN 16J-G-B: the composition now has exactly one caller, inside the recommendation handler. The old "zero calls outside the
   * guard" rule would fail on that deliberately, so it is replaced by the sharper statement: one call, in that branch, none at module
   * scope. The 16J-G-B message tests drive the branch end to end.
   */
  const joinGuard = /if \(typeof requestVisibleRecommendations !== 'function'\) \{[\s\S]*?\n\}/u.exec(workerCodeTs)?.[0] ?? '';
  const joinBranch = /if \(type === QUERY_RECOMMENDATIONS_MESSAGE\) \{[\s\S]*?\n    \}/u.exec(workerCodeTs)?.[0] ?? '';
  check('完整组合在 worker 中恰好被调用一次且仅在该 handler 内',
    joinGuard.includes('typeof requestVisibleRecommendations')
    && joinBranch.includes('requestVisibleRecommendations(')
    && [...workerCodeTs.matchAll(/requestVisibleRecommendations\(/gu)].length === 1
    && !workerCodeTs.split(joinBranch).join('').includes('requestVisibleRecommendations('));
  /*
   * UPDATED IN PRE-RELEASE-UX-A18. The branch now also reads the user's own importance weights, which is the one field a caller is entitled to supply.
   * The rule therefore becomes an exact list rather than a single name: a branch that started reading anything else — a provider, a policy, a topN — fails
   * here.
   */
  check('handler 只从 message 读取 tabId 与用户偏好', (() => {
    const read = [...joinBranch.matchAll(/message\.(\w+)/gu)].map((m) => m[1]);
    return read.length > 0 && [...new Set(read)].sort().join(',') === 'preferences,tabId';
  })());
  check('handler 不触碰 worker status 状态',
    joinBranch.length > 0
    && !['knownStatus', 'knownPanelCount', 'reportingTabIds'].some((binding) => joinBranch.includes(binding)));
  check('handler 不缓存结果',
    !['recommendationsCache', 'cachedRecommendations', 'lastRecommendations', 'cachedCourses', 'cachedRows']
      .some((bad) => workerCodeTs.includes(bad)));
  /*
   * UPDATED IN 16J-PREUI-E4-C2-B3-A. This asserted the panel had NO recommendation entry point at all, which held while the controller was inert. It is wired
   * now, so the requirement inverts into the rules that actually protect the design: exactly ONE controller instance, and the request's expected tab taken from
   * the PREPARATION's own record rather than from a fresh tab query — because a fresh query at handoff time is exactly what would aim the request at a page the
   * preparation never read.
   */
  const panelSourceTs = readFileSync(join(distDir, '..', 'src', 'sidepanel', 'sidepanel.ts'), 'utf8');
  check('panel 恰好创建一个 recommendation controller',
    [...panelSourceTs.matchAll(/createRecommendationRequestController\(/gu)].length === 1);
  check('panel 的推荐请求用 preparation 的 operationTabId 作为 expectedTabId',
    /*
     * UPDATED IN 16J-REAL-E2E-1. The sink now reaches both collaborators through lazy accessors rather than bare bindings, because it runs DURING the preparation
     * controller's construction and a direct `const` reference threw `Cannot access 'handoff' before initialization` — which killed the shipped panel script in a
     * real browser and left the approved button inert. The guarantee checked here is unchanged: the tab comes from the preparation, and the request receives it.
     */
    panelSourceTs.includes('deferredPreparation()?.operationTabId()')
    && /request:\s*\(expectedTabId\)\s*=>\s*recommendation\.request\(expectedTabId\)/u.test(panelSourceTs));
  // The only tab query the panel may make is the page-identity one; the handoff must not add a second.
  check('handoff 不新增 active tab 查询', [...panelSourceTs.matchAll(/chrome\.tabs\.query\(/gu)].length === 1);
}

/*
 * ## The extension's own recommendation policy (16I-F)
 *
 * The engine owns no policy values, so each host states its own. This is the extension's owner file, and the checks below fix
 * three separate things: that it exists and is complete, that it is the ONLY policy owner in the extension, and that it is
 * bundled rather than shipped as a separate artifact the manifest would never load.
 *
 * There is deliberately NO check that these numbers equal the application's. The two hosts currently agree by choice; requiring
 * them to agree would turn a coincidence into a contract and prevent either host from changing its mind.
 */
{
  // Redeclared here: `const` in the block above is scoped to it, and this block is separate on purpose so the policy checks read
  // against a fresh comment-stripped copy rather than one computed for other assertions.
  const workerCodeTs = workerSourceTs.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1');
  const workerBundleCode = workerSource.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1');

  const policyPath = join(distDir, '..', 'src', 'background', 'recommendation-policy.ts');
  check('extension policy owner 文件存在', existsSync(policyPath));
  const policySource = existsSync(policyPath) ? readFileSync(policyPath, 'utf8') : '';
  const policyCode = policySource.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1');

  check('policy 使用 canonical RecommendationPolicy 类型',
    /import type \{ RecommendationPolicy \} from '@course-copilot\/recommendation'/u.test(policyCode));
  check('policy 导出唯一实例 EXTENSION_RECOMMENDATION_POLICY',
    /export const EXTENSION_RECOMMENDATION_POLICY = /u.test(policyCode)
    && [...policyCode.matchAll(/export const \w*POLICY\w* = /gu)].length === 1);
  check('policy 四项字段全部显式写出',
    ['defaultPreferences', 'defaultTopN', 'maxTopN', 'candidateLimit'].every((field) => policyCode.includes(`${field}:`)));
  check('policy 完整四项偏好权重（非 Partial，无兜底）',
    ['gradeFriendliness', 'workloadFriendliness', 'attendanceFriendliness', 'overallScore']
      .every((weight) => policyCode.includes(weight))
    && !/\?\?|Partial</u.test(policyCode));
  check('policy 不从应用 src/config 取值（两 host 各持己见）',
    !/from\s*['"][^'"]*config\.js['"]/u.test(policyCode) && !/src\/config/u.test(policyCode));

  /*
   * The OWNER is the file that EXPORTS a policy — not every file that names the type. The worker imports the constant and would
   * otherwise be counted as a second owner, which is a statement about imports rather than about ownership.
   */
  const policyOwners = [];
  const policyWalk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { policyWalk(full); continue; }
      if (!entry.name.endsWith('.ts')) continue;
      const text = readFileSync(full, 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1');
      if (/export const \w*POLICY\w* = /u.test(text)) policyOwners.push(full.slice(repoRoot.length + 1).split('\\').join('/'));
    }
  };
  policyWalk(join(distDir, '..', 'src'));
  check('extension 中恰好一个 policy owner（导出 policy 的文件）',
    policyOwners.length === 1 && policyOwners[0].endsWith('background/recommendation-policy.ts'),
    JSON.stringify(policyOwners));

  check('worker runtime import 该 policy', /import \{ EXTENSION_RECOMMENDATION_POLICY \} from '\.\/recommendation-policy\.js'/u.test(workerCodeTs));
  check('worker 侧的 policy 不流向 recommendCourses（不执行推荐）',
    !/recommendCourses\s*\([^)]*policy/iu.test(workerCodeTs));

  // Bundled, not emitted as a seventh artifact.
  check('未产生独立的 recommendation-policy.js',
    !existsSync(join(distDir, 'background', 'recommendation-policy.js')));
  check('产物包含 extension policy 的取值', /EXTENSION_RECOMMENDATION_POLICY/u.test(workerBundleCode));
  check('产物仍不含 root policy 默认值符号', !/DEFAULT_PREFERENCES|DEFAULT_TOP_N|MAX_TOP_N|REVIEW_CANDIDATE_LIMIT/u.test(workerBundleCode));
}

/*
 * ## The extension recommendation RUNNER (16I-G)
 *
 * The runner is this host's adapter: it binds the extension's policy and hands the injected provider to the canonical engine. The
 * worker CARRIES it and never calls it, so the two properties checked below are separate — that the runner exists and is
 * orchestration only, and that production initialisation does not execute it.
 */
{
  // Redeclared: `const` in the blocks above is scoped to them, and this block reads its own comment-stripped copies.
  const workerCodeTs = workerSourceTs.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1');
  const workerBundleCode = workerSource.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1');

  const runnerPath = join(distDir, '..', 'src', 'background', 'recommendation-runtime.ts');
  check('extension runner 文件存在', existsSync(runnerPath));
  const runnerSource = existsSync(runnerPath) ? readFileSync(runnerPath, 'utf8') : '';
  const runnerCode = runnerSource.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1');

  check('runner 调用 canonical recommendCourses',
    /from '@course-copilot\/recommendation'/u.test(runnerCode) && /recommendCourses\(/u.test(runnerCode));
  check('runner 绑定 extension policy', /EXTENSION_RECOMMENDATION_POLICY/u.test(runnerCode));
  /*
   * Orchestration only: none of the algorithm may be reimplemented here. A copy of any of these in the host adapter would be a
   * second implementation of the engine that could drift from the canonical one.
   */
  check('runner 未重新实现算法',
    !['calculateCourseScore', 'calculateReviewConfidence', 'matchCourse', 'filterEligible', 'planQueries',
      'partitionCleanRows', 'summarizeCleanRows', 'teacherSetRelation', 'normalizePreferences', 'compareDecisions']
      .some((symbol) => runnerCode.includes(symbol)));
  // The provider is injected: the runner neither constructs nor queries one.
  check('runner 不构造 provider/cache，也不直接查询 provider',
    !['new WhuCoursesProvider', 'new MemoryCache', 'new RequestLimiter', '.searchCourse(']
      .some((symbol) => runnerCode.includes(symbol)));
  check('runner 不重述任何 policy 数值',
    !['gradeFriendliness:', 'workloadFriendliness:', 'defaultTopN:', 'maxTopN:', 'candidateLimit:']
      .some((literal) => runnerCode.includes(literal)));

  /*
   * UPDATED IN 16J-F-B-R1. These three checks used to require the worker to import the runner directly and guard it, on the strength
   * of 16I-E's measurement — which was taken BEFORE the page-to-recommendation composition existed. Once the composition was itself
   * imported and guarded, the direct runner import became a second guard protecting something already reachable.
   *
   * That was MEASURED, not reasoned: with the direct import and its guard removed, the runner, the adapter, the transport and the
   * engine's own logic all remained in the artifact, the constructors stayed at one each, and the bundle shrank by 196 bytes. So the
   * requirement is inverted, and the structural check below is what now proves the runner and the engine really are present.
   *
   * The old "runner appears only in its import and guard" invariant is superseded rather than dropped: the equivalent statement for
   * the composition is asserted in the 16J-F-B block above.
   */
  check('worker 不再直接 import runner（由组合闭包携带）',
    !/from '\.\/recommendation-runtime\.js'/u.test(workerCodeTs)
    && !workerCodeTs.includes('recommendExtensionCourses'));

  // The engine is still reachable, through the runner, and the worker holds no direct engine binding.
  check('worker 不再直接 import canonical engine（由 runner 承载）',
    !/from '@course-copilot\/recommendation'/u.test(workerCodeTs) && !workerCodeTs.includes('recommendCourses'));

  check('未产生独立的 recommendation-runtime.js',
    !existsSync(join(distDir, 'background', 'recommendation-runtime.js')));
  check('产物包含 runner 与 canonical engine 的真实逻辑',
    /recommendExtensionCourses/u.test(workerBundleCode)
    && /deps\.policy\.candidateLimit/u.test(workerBundleCode)
    && /function planQueries\(/u.test(workerBundleCode));
}

/*
 * ## The outbound boundary itself
 *
 * This is the file that decides what may leave the extension. Its rules are asserted structurally here and behaviourally in
 * `test/step42PublicReviewBoundary.test.ts`; the checks below are the ones a reviewer should be able to read as a contract.
 */
{
  const boundaryPath = join(distDir, '..', 'src', 'background', 'public-review-fetch.ts');
  check('出站边界文件存在', existsSync(boundaryPath));
  const boundarySource = existsSync(boundaryPath) ? readFileSync(boundaryPath, 'utf8') : '';
  const boundaryCode = boundarySource.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1');

  // Destination, method and credential rules are present as constants rather than inline literals scattered around.
  check('边界只允许 https', /ALLOWED_PROTOCOL = 'https:'/u.test(boundaryCode));
  check('边界只允许 whucourses.cn', /ALLOWED_HOSTNAME = 'whucourses\.cn'/u.test(boundaryCode));
  check('边界只允许 /api/search', /ALLOWED_PATHNAME = '\/api\/search'/u.test(boundaryCode));
  check('边界拒绝任何端口', /url\.port !== ''/u.test(boundaryCode));
  check('边界拒绝 URL 内嵌凭据', /url\.username !== ''/u.test(boundaryCode));
  check('边界要求 course_name', /REQUIRED_QUERY_KEYS = \['course_name'\]/u.test(boundaryCode));
  check('边界仅额外允许 instructor', /OPTIONAL_QUERY_KEYS = \['instructor'\]/u.test(boundaryCode));
  check('边界拒绝额外查询参数（而非丢弃）', /extra\.length > 0/u.test(boundaryCode));
  check('边界只允许 GET', /method !== 'GET'/u.test(boundaryCode));
  check('边界拒绝请求体', /init\?\.body !== undefined/u.test(boundaryCode));
  check('边界强制 credentials omit', /credentials: 'omit'/u.test(boundaryCode));
  check('边界转发 signal（取消/超时不被破坏）', /signal: init\?\.signal/u.test(boundaryCode));

  /*
   * And it must not be a channel for WHU private data. Checked against CODE, so the file's own prose explaining why it reads
   * nothing is not mistaken for a read.
   */
  for (const forbidden of [
    'location.search', 'location.hash', 'location.href',
    'document.cookie', 'chrome.cookies',
    'localStorage', 'sessionStorage', 'indexedDB', 'XMLHttpRequest',
  ]) {
    check(`边界不读取 ${forbidden}`, !boundaryCode.includes(forbidden));
  }
}
for (const forbiddenProbeType of ['CORE_PROBE', 'TEST_CORE', 'DEBUG_CORE']) {
  check(`未新增 ${forbiddenProbeType} message`, !workerSource.includes(forbiddenProbeType));
}

// ------------------------------------------------ course identity output ----
/*
 * The DATA-EXPORT contract: which fields, and how much, may leave the page.
 *
 * ## Two exits, deliberately different sizes
 *
 * 1. the STATUS reply — a bounded diagnostic SAMPLE, capped at `MAX_ROW_SAMPLES`;
 * 2. the VISIBLE-ROWS query — every valid row currently loaded, answered only when asked for by name.
 *
 * They are separate message types so the second cannot quietly widen the first. Neither is a broadcast, neither is cached, and
 * neither fetches anything: both read the DOM that is already there, so "all rows" means all rows of the CURRENT snapshot, not
 * every teaching class WHU offers.
 *
 * ## Fields allowed to travel
 *
 * `courseCode`, `courseName`, `teacher`, `credits` and `remainingSeats` — five, and no more. Still excluded: `capacity` and
 * `selectedThisRound` (the other two numbers in the seat cell, outside the grant), `availability` (derived downstream from
 * `remainingSeats`), and any remark, status, raw heading, HTML or URL.
 *
 * An earlier version of this comment said "no teacher, credit, seat", which stopped being true after those fields were added.
 * A contract that misdescribes itself is worse than a terse one, so it is stated exactly above.
 *
 * The behavioural half — that the ported parser reproduces the baseline's extraction on the real-page capture, and that the
 * keys are exactly the allowed set — is in `test/step42CourseIdentityParity.test.ts` and
 * `test/step42VisibleRowScanner.test.ts`.
 */
const identityWorker = codeOf(workerSource);

check('worker 转发 rows 字段', /rows:/u.test(identityWorker));
check('worker 不缓存课程样本（恢复时从页面重取）', !/knownCourses|courseCache|storedCourses/u.test(identityWorker));
/*
 * The full-row query must not give the worker a second data source. Checked here as well as behaviourally, because a cache is
 * exactly the kind of "helpful" addition that would otherwise look harmless.
 */
for (const forbiddenCache of ['visibleRowsCache', 'cachedVisibleRows', 'lastVisibleRows', 'fullRowsCache', 'storedRows']) {
  check(`worker 不缓存全量行（${forbiddenCache}）`, !identityWorker.includes(forbiddenCache));
}
/*
 * The panel is the only place the identities are rendered, so it is checked for the two allowed fields and nothing else.
 */
/*
 * `status` is deliberately NOT in this list: it appears as an ordinary identifier in unrelated code, so including it produced a
 * false positive. The page's own 状态 field is asserted absent by its Chinese token instead, which cannot collide this way.
 *
 * UPDATED IN 16J-PREUI-E4-C2-B3-B2. `credits` and `remainingSeats` were on this list, which held while the panel showed only a bounded identity sample. The
 * recommendation cards now legitimately show both — read from the FROZEN presentation model — so a blanket ban would ban the feature. `capacity` and `remark`
 * stay forbidden because no card shows them.
 *
 * What the ban was protecting is that the panel does not read PAGE fields itself, and that is now asserted where it applies: the card renderer consumes the
 * mapper's output and must not reach into a course object at all.
 */
for (const forbidden of ['capacity', 'remark']) {
  /*
   * Checked against the panel's own SOURCE, not the bundle: the bundle also contains the card renderer, whose vocabulary is not the panel's. The prose legitimately
   * discusses the page's capacity field — a section hydration reports it — so this is the comment-stripped source.
   */
  check(`面板不引用 ${forbidden}`, !new RegExp(`\\b${forbidden}\\b`, 'u').test(panelSourceCode));
}
for (const forbidden of ['course.credits', 'course.remainingSeats', 'course.availability', 'course.teacher', 'course.courseName', 'course.courseCode']) {
  check(`卡片渲染器不直接读页面字段（${forbidden}）`, !cardRendererCode.includes(forbidden));
}
/*
 * The panel keeps using the BOUNDED path: it must not consume the full-row query, which would make a refresh a bulk export.
 */
check('面板不请求全量行', !codeOf(panelSource).includes('QUERY_VISIBLE_ROWS'));

/*
 * The content script must not read a table body cell at all. These class names are the ones the baseline uses for teacher,
 * title, seats and rows; their absence is what makes "identity only" checkable rather than merely intended.
 */
const contentCode = codeOf(readFileSync(join(distDir, 'content', 'content-script.js'), 'utf8'));
for (const forbiddenClass of ['rsxx', 'wdrsxx', 'jxbxf', 'jxbmc', 'sksj', 'kkxymc', 'do_jxb_id', 'jxbzls', 'kklxdm']) {
  check(`内容脚本不引用表格类名 ${forbiddenClass}`, !contentCode.includes(forbiddenClass));
}
for (const forbiddenRead of ['innerHTML', 'innerText', 'dataset', 'getElementsByClassName']) {
  check(`内容脚本不读取 ${forbiddenRead}`, !contentCode.includes(forbiddenRead));
}
/*
 * The identity reader may only read these three things from an element: its class tokens, an attribute, and its text. Any
 * other read would be a new kind of access that this step did not sanction.
 */
check('内容脚本只通过 classList / getAttribute / textContent 读元素',
  contentCode.includes('classList.contains') && contentCode.includes('getAttribute') && contentCode.includes('textContent'));
check('内容脚本的教学班上限为 3', /MAX_ROW_SAMPLES\s*=\s*3/u.test(contentCode));

// ------------------------------------------------ two data-export exits ----
/*
 * The double contract, as executable statements.
 *
 * Each exit is pinned to its own scanner call, so swapping them is caught: a status reply that scanned without a bound would
 * export the whole list on every refresh, and a full query that kept the three-row bound would not be a full query at all.
 */
check('QUERY_STATUS 使用有界扫描（scanVisibleRows(MAX_ROW_SAMPLES)）',
  contentCode.includes('scanVisibleRows(MAX_ROW_SAMPLES)'));
check('QUERY_VISIBLE_ROWS 使用无界扫描（scanVisibleRows()）',
  /scanVisibleRows\(\s*\)/u.test(contentCode));
check('两个出口复用同一个 scanner（不新增第二套 parser）',
  // Exactly one scanner declaration, and exactly the two documented call forms.
  (contentCode.match(/function scanVisibleRows\s*\(/gu) ?? []).length === 1);
check('全量出口是独立 message 类型', contentCode.includes('COURSE_COPILOT_QUERY_VISIBLE_ROWS'));
for (const forbiddenAlias of ['QUERY_FULL_ROWS', 'FULL_VISIBLE_ROWS']) {
  check(`不新增同义 message ${forbiddenAlias}`, !contentCode.includes(forbiddenAlias));
}
/*
 * The full reply carries `rows` and nothing else: no count (the length IS the count for a complete snapshot), no truncation
 * flag, no capture metadata, no raw page data.
 *
 * These match the COMPILED artifact, where the `: VisibleRowsResponse` annotation is erased — so each pattern must anchor on
 * the object's own contents rather than on its type name.
 */
check('全量响应只含 supported 与 rows 字段',
  /const response = \{\s*supported,\s*rows:/u.test(contentCode));
/*
 * `courseCount` is no longer forbidden: the page-read status legitimately reports how many rows became courses, and that count lives on the
 * WORKER side. What must stay out of the CONTENT script is page metadata it has no way to know.
 *
 * UPDATED IN 16J-PREUI-E4-C1: `rowCount` was on this list as a FILE-WIDE ban, which stopped being the right question once a second feature reported a row
 * count of its own. The preparation status carries `finalPage.rowCount` — the number of VISIBLE TEACHING-CLASS ROWS it read back, the same meaning the
 * worker's `PageReadStatus.rowCount` has — and a file-wide ban would forbid a legitimate, differently-scoped field.
 *
 * The rule that matters is unchanged and is now checked where it applies: the VISIBLE-ROWS REPLY carries the rows and nothing describing them, because its
 * length IS the count and a second field could disagree with it.
 */
for (const forbiddenField of ['totalVisibleRows', 'isTruncated', 'capturedAt']) {
  check(`全量响应不含 ${forbiddenField}`, !contentCode.includes(forbiddenField));
}
check('全量响应不含 rowCount（其长度就是行数，第二个字段可能与它不一致）',
  !/const response = \{[^}]*rowCount/u.test(contentCode));
check('StatusResponse 字段未变（supported / panelCount / rows）',
  /const response = \{\s*supported,\s*panelCount:/u.test(contentCode));
// ------------------------------------------------ row-level teacher gates ----
/*
 * The teacher is a ROW-level field, and the page publishes academic titles in a separate cell. Both facts are checked here
 * because getting either wrong would corrupt downstream matching rather than merely mis-render a line.
 */
const contentForTeacher = codeOf(readFileSync(join(distDir, 'content', 'content-script.js'), 'utf8'));
/*
 * Decoded, because the two checks below are about the WORDING the panel shows the user, and the bundler escapes non-ASCII
 * literals. `codeOf` still strips comments first, so both filters apply.
 */
const panelForTeacher = codeOf(decodedText(panelSource));

check('按行读取教师（tr.body_tr）', /ROW_CLASS\s*=\s*'body_tr'/u.test(contentForTeacher) && /matchingDescendants\(panel, 'tr'/u.test(contentForTeacher));
check('教师来源是 td.jsxm', /TEACHER_CELL_CLASS\s*=\s*'jsxm'/u.test(contentForTeacher));
/*
 * The visible combined cell and the title cell must never be used as the teacher source: `jsxmzc` mixes teachers with titles.
 */
check('不读取可见合并单元格 jsxmzc', !contentForTeacher.includes('jsxmzc'));
check('不读取职称单元格 jszc', !contentForTeacher.includes('jszc'));
check('教师缺失时省略字段而非填空值', /teacher === undefined \? \{\} : \{ teacher \}/u.test(contentForTeacher));
/*
 * No ROW-level hydration flag may exist: the baseline's `wholeRowHydrated` also depends on schedule, which is not read yet, so a teacher-only
 * approximation would be a NEW and wrong meaning.
 *
 * UPDATED IN 16J-PREUI-E4-B2. The bare word `hydrated` was on this list, and it stopped being the right probe once panel-level teacher hydration became a
 * real feature: its counters are honestly named `hydrated` / `hydrationClicks`, they describe PANELS rather than rows, and no row-level completeness is
 * claimed by them. The tokens below are the ones that actually carry the forbidden meaning — a flag asserted about a teaching-class ROW.
 */
for (const forbiddenFlag of ['wholeRowHydrated', 'rowHydrated', 'rowIsHydrated', 'teacherLoaded', 'teacherKnown']) {
  check(`未引入 ${forbiddenFlag} 字段`, !contentForTeacher.includes(forbiddenFlag));
}
check('教师为多值时原样保留（无 split/dedupe）', !/\bteacher\b[^\n]*\.split\(/u.test(contentForTeacher) && !contentForTeacher.includes('dedupe'));

/*
 * Output keys: a row sample may carry exactly courseCode, courseName and teacher.
 */
check('面板不引用职称字段名 title', !/\btitle\b/u.test(panelSourceCode));
check('面板不声称「没有教师」', !panelForTeacher.includes('没有教师'));
/*
 * The 「教师字段缺失」 wording lived in the panel's diagnostic block, which PRE-RELEASE-UX-A14 removed, so it is NOT required anywhere any more and requiring it would
 * have kept a removed feature alive through its test.
 *
 * The rule it encoded is not lost: the canonical missing-teacher sentence lives in the presentation model, and the content script reports an absent teacher by
 * OMITTING the field rather than by filling in a placeholder. Both halves are asserted here, so "an absent teacher is missing page DATA, not a teacherless class"
 * still has a failing test behind it.
 */
check('缺失教师的措辞在表现层单点定义（非诊断面板）',
  readFileSync(join(repoRoot, 'apps', 'extension', 'src', 'sidepanel', 'course-presentation.ts'), 'utf8').includes('TEACHER_NOT_PUBLISHED_TEXT'));
check('缺失教师时省略字段而非填空值', /teacher === undefined \? \{\} : \{ teacher \}/u.test(contentForTeacher));
/*
 * MOVED IN PRE-RELEASE-UX-A14. The rule here used to REQUIRE 「教学班识别样本」 in the built document, because the parser was verified by eye from a three-row
 * development block. The product owner removed that block from the release panel, so the requirement is now the opposite one — and the two checks below are
 * deliberately split:
 *
 *   1. the BUILT document must not contain the block, so it cannot ship;
 *   2. the SOURCE panel must not contain its wording or its ids either, so it cannot come back through an edit that forgets to rebuild.
 *
 * `教师字段缺失` is checked separately above and REMAINS required in the content script: the wording rule — an absent teacher is missing page data, not a
 * teacherless class — is a rule of the canonical model, not of the removed panel.
 */
check('产物面板不含开发用「教学班识别样本」区块', !readFileSync(join(distDir, 'sidepanel', 'sidepanel.html'), 'utf8').includes('教学班识别样本'));
for (const gone of ['教学班识别样本', 'course-samples']) {
  check(`面板源码不含已移除的诊断 UI（${gone}）`, !panelSourceCode.includes(gone));
}
// ---------------------------------------------------------------- report ----

console.log('');
const files = emitted(distDir);
console.log(`  产物文件（${files.length}）: ${files.join(', ')}`);
console.log('');
let failed = 0;
for (const { label, ok, detail } of checks) {
  const suffix = detail === '' || ok ? '' : `  (${detail})`;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${suffix}`);
  if (!ok) failed += 1;
}
console.log('');
if (failed === 0) {
  console.log(`EXTENSION_SKELETON_OK（${checks.length} 项检查通过）`);
  process.exit(0);
}
console.log(`EXTENSION_SKELETON_FAIL: ${failed} 项检查失败（共 ${checks.length} 项）`);
process.exit(1);
