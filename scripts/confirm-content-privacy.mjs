/**
 * Final privacy confirmation for the content script: read the BUILT artifact and report, in code only, exactly what it
 * touches.
 *
 * ## Why comments are stripped
 *
 * A naive text search over this file reports `location.search`, `querySelectorAll`, `textContent` and `cookie` as present —
 * because the file's own comments explain what it does and does not do. Reporting those as violations would be wrong, and
 * reporting them as "clean" without saying why would be unverifiable. So both columns are printed: what the raw text
 * contains, and what the executable code contains.
 *
 * Usage: node scripts/confirm-content-privacy.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

/**
 * Reads forbidden outright, with the reason each is forbidden.
 *
 * The first group is about things a content script must never touch at all — credentials, storage, network, bulk element
 * content. The second group is about which DOM the extension is GRANTED to read, which is the part that changed here.
 */
const FORBIDDEN = [
  ['location.search', '查询字符串'],
  ['location.hash', 'URL hash'],
  ['location.href', '完整 URL'],
  ['URLSearchParams', '解析查询字符串'],
  ['document.cookie', 'cookie'],
  ['localStorage', '本地存储'],
  ['sessionStorage', '会话存储'],
  ['indexedDB', '数据库'],
  ['fetch', '网络请求'],
  ['XMLHttpRequest', '网络请求'],
  ['innerHTML', '元素内容'],
  ['innerText', '元素内容'],
  ['dataset', '元素属性'],
  ['getElementById', '读取单个元素'],
  ['querySelector(', '读取单个元素'],
  /*
   * LOAD-STATE MARKERS (granted in PART 16J-PREUI-E3-A).
   *
   * The content script needs exactly two single-element reads: `#more` and `#endsign`. The live page states whether its course list is fully loaded
   * by toggling the display of those two nodes and by nothing else, so without them the extension cannot honestly tell a reader whether the list it
   * just ranked was complete.
   *
   * The exemption is deliberately narrow, and the checks below enforce it rather than trusting this comment:
   *
   *   granted   `#more`     → presence + computed visibility only
   *   granted   `#endsign`  → presence + computed visibility only
   *   forbidden any other selector — `GRANTED_SELECTORS` is closed and each entry must appear exactly once
   *   forbidden reading their text, attributes or child content — the marked elements carry `点此查看更多` and
   *             `......已到最后......`, and matching on that wording would break the moment the site rewords it anyway
   *
   * What makes this safe is that neither marker is personal data: they are two page-chrome elements whose only meaning is "there are more rows" and
   * "that was the last batch". Nothing about the user, their identity or their course list is read to obtain that.
   */
  /*
   * SEAT-RELATED CELLS. This is an explicit DOM-read GRANT list, not a claim that seat data is sensitive: the counts are
   * teaching-class-level aggregate numbers, not personal data. What is granted here is deliberately narrower than what the
   * page could give, because a static gate cannot re-check a read it has already allowed.
   *
   *   granted   `blzyl`  → remainingSeats (余量), the teaching class's own remaining-seat count
   *   granted   `blyxrs` → selectedThisRound (本轮已选人数), the count of students who have already signed up in this
   *                        round. GRANTED IN 16J-PRE-RELEASE-UX-A4, at the product owner's direction, and narrower than
   *                        the page offers: capacity is still out.
   *   forbidden `jxbzrl` → capacity. NOT approved in A4 — the user-facing feature needs 余量 + 本轮已选人数, so least
   *                        privilege keeps capacity out of the contract until a feature actually requires it.
   *   forbidden `wdrsxx` → the cell holding ALL THREE numbers; granting it would authorise capacity and
   *                        selectedThisRound in the same breath, which the grant does not cover
   *   forbidden `rsxx`   → the baseline's superseded capacity cell
   *   forbidden `jxbxf`  → credits; those come from the `.kcmc` heading instead
   *
   * `jxbzrl` is named here even though nothing reads it today, so capacity is excluded by the contract rather than only by
   * the accident that no code touches it yet.
   *
   * ## Why `blyxrs` moved from this list to the grant, and why that is not a widening of `wdrsxx`
   *
   * The grant names LEAF cells one at a time. `blyxrs` becoming readable says nothing about its siblings: `jxbzrl` and the
   * `wdrsxx` container that holds them both stay forbidden, so a read of either still fails here. The self-test below pins
   * exactly that, because "granting one child" quietly becoming "granting the container" is the failure this architecture
   * exists to prevent.
   */
  ['jszc', '职称类名'],
  ['rsxx', '容量类名'],
  ['wdrsxx', '余量与容量的共同容器类名'],
  ['jxbzrl', '容量内层类名'],
  ['jxbxf', '学分类名'],
];

/**
 * The class names the content script is ALLOWED to read by class.
 *
 * Kept as data so the same set can be applied to the artifact and to a synthetic snippet — a grant that cannot be exercised
 * is only a comment. `blzyl` was granted before anything read it, so a later change consumed an existing grant instead of
 * widening the contract; `blyxrs` joined the same way in A4.
 */
const GRANTED_CLASSES = [
  'panel', 'panel-info', // COURSE_PANEL_SELECTOR
  'kc_head', // HEADING_CLASS
  'kcmc', // COURSE_NAME_SPAN_CLASS (credits come from this heading, not from `jxbxf`)
  'body_tr', // ROW_CLASS
  'jsxm', // TEACHER_CELL_CLASS
  'blzyl', // remainingSeats — granted in PART 13C; read by the row scanner
  'blyxrs', // selectedThisRound (本轮已选人数) — granted in PRE-RELEASE-UX-A4; not read by any code yet
];

/**
 * The single-element selectors the content script is granted, each with the read it performs and the constant naming it.
 *
 * Closed, and asserted per entry: each granted read must appear EXACTLY once, so a future change cannot quietly add a third single-element read.
 *
 * The constant name is part of the entry because the bundler does not inline it: the artifact contains `document.querySelector(LOAD_MORE_SELECTOR)`,
 * not `document.querySelector('#more')`. The exemption therefore has to name both halves — the constant declaration carrying the granted selector,
 * and the one call site that reads through it — so a grant cannot be claimed by pointing the call at some other constant.
 */
const GRANTED_SELECTORS = [
  // Read twice: the completeness detector and the step watcher each locate this marker.
  { selector: '#more', constant: 'LOAD_MORE_SELECTOR', purpose: 'morePresent + moreVisible', calls: 2 },
  { selector: '#endsign', constant: 'END_SIGN_SELECTOR', purpose: 'endSignPresent + endSignVisible', calls: 2 },
  /*
   * BOUNDED AUTO-EXPAND (granted in PART 16J-PREUI-E3-B2).
   *
   * The expansion needs two more single-element reads, and no others:
   *
   *   `#contentBox` → the container the page appends new course panels into. Observed, never read: only added nodes matter, and only whether one of
   *                   them is a course panel. The panel selector itself is already granted by class above.
   *   `#more a`     → the load-more ANCHOR. It is read to confirm a click target exists, and it is the only thing this script may click.
   *
   * Both are page chrome, not user data. Nothing about the user, their identity or their course list is obtained by locating them.
   */
  /*
   * UPDATED IN 16J-PREUI-E4-B2-R1: this entry used to name `#contentBox`, which is a SUPERSET of the real course list — the page holds
   * `div.panel.panel-info` elements inside `#contentBox` but outside `.tjxk_list`. The constant now names the whole path, so the selector here has to match it;
   * a stale expectation here is exactly the kind of drift the grant exists to catch.
   */
  { selector: '#contentBox .tjxk_list', constant: 'COURSE_LIST_CONTAINER_SELECTOR', purpose: 'the REAL course list: the only source of course panels', calls: 6 },
  { selector: '#more a', constant: 'LOAD_MORE_ANCHOR_SELECTOR', purpose: 'the only clickable target, read to confirm it exists', calls: 1 },
  /*
   * BOUNDED TEACHER HYDRATION (granted in PART 16J-PREUI-E4-B2).
   *
   * One more read, and it is the expansion's click target:
   *
   *   `a.expand1` → the collapse/expand control INSIDE one course panel. Read relative to that panel, clicked once per panel, and the only thing the
   *                 hydration adapter may activate. Measured on the live page: it carries no `onclick` and lives in `.panel-heading`, while the enroll
   *                 button lives in `.panel-body > table`, so the two sit in different branches of the same panel.
   *
   * `panel.querySelector(EXPAND_CONTROL_SELECTOR)` is element-level, which is why the document-level count below does not include it — but it is granted
   * here so the constant itself is checked against its value.
   */
  { selector: 'a.expand1', constant: 'EXPAND_CONTROL_SELECTOR', purpose: 'the per-panel expand control, the only hydration click target', calls: 0 },
  /*
   * BOUNDED AVAILABILITY FILTER (granted in PRE-RELEASE-UX-A9).
   *
   * One document-level read, and it is the panel that scopes everything else:
   *
   *   `#searchBox` → the page's own filter panel. The option group, the 「有」 option and the query button are all resolved THROUGH it rather than by a
   *                  page-wide query, which is what keeps `button[name=query]` — a generic name on a page carrying 192 enrollment controls — from being
   *                  confused with anything that is not the filter's submit.
   *
   * It is read exactly once per session start and once per status question, hence two call sites; the remaining filter reads are element-relative and are
   * enumerated in GRANTED_ELEMENT_QUERIES below.
   *
   * UPDATED IN PRE-RELEASE-UX-A9: the course-list container's count rose from 4 to 6, because the rebuild wait asks whether the list exists while the page
   * removes and recreates it. A transient absence is the page's normal behaviour on submit, not a read failure.
   */
  { selector: '#searchBox', constant: 'SEARCH_BOX_SELECTOR', purpose: 'the page filter panel that scopes every availability-filter read', calls: 1 },
];

/**
 * The selector arguments the grant permits for non-`document` queries, enumerated.
 *
 * These are read RELATIVE to an element the page already handed the script, so they cannot reach anything outside it. `COURSE_PANEL_SELECTOR` is the
 * expansion watcher's, `ROW_SELECTOR` and `TEACHER_CELL_SELECTOR` are the hydration adapter's, and `'input'` is the identity reader's.
 */
const GRANTED_ELEMENT_QUERIES = [
  'COURSE_PANEL_SELECTOR', 'ROW_SELECTOR', 'TEACHER_CELL_SELECTOR', 'EXPAND_CONTROL_SELECTOR', "'input'", "'tr'", "'td'", 'selector',
  /*
   * PRE-RELEASE-UX-A9. The availability filter is resolved by DESCENDING from the panel and the option group, never by a page-wide query:
   *
   *   panel.querySelector(AVAILABILITY_GROUP_SELECTOR)   → the 「有无余量」 group inside the filter panel
   *   group.querySelector(AVAILABILITY_OPTION_SELECTOR)  → the 「有」 anchor inside that group
   *   panel.querySelector(FILTER_QUERY_BUTTON_SELECTOR)  → the panel's own submit
   *   panel.querySelector(FILTER_EXPAND_CONTROL_SELECTOR) → the panel's own reveal control
   *
   * Every one is relative to a node the page already handed the script, and the panel itself came from the granted `#searchBox` read. A page-wide
   * `button[name=query]` would be reachable too, which is exactly why the scoped form is the one granted.
   */
  'AVAILABILITY_GROUP_SELECTOR', 'AVAILABILITY_OPTION_SELECTOR', 'FILTER_QUERY_BUTTON_SELECTOR', 'FILTER_EXPAND_CONTROL_SELECTOR', "'ul'",
];

/**
 * The ONLY element this extension may click, and the only way it may click it.
 *
 * Asserted as data for the same reason the selector grant is: a rule that lives only in a comment cannot fail. This is checked by requiring the exact
 * `target.click()` call to appear exactly once, and by forbidding every other click form — a second target, a text search, a parent element, or the
 * page's own handler called by name.
 */
const GRANTED_CLICK = {
  /* The anchor variable the adapter assigns from the granted `#more a` read. */
  variable: 'target',
  selector: '#more a',
  /* The page's internal handler. Calling it directly would couple this extension to a private function name. */
  forbidden: ['loadCoursesByPaged', 'dispatchEvent', 'submit(', 'requestSubmit'],
};

/**
 * Traversal the script must NOT perform, because it would defeat the leaf-cell grant in `GRANTED_CLASSES`.
 *
 * ## Why this became necessary in PRE-RELEASE-UX-A4
 *
 * The seat grant names leaf cells one at a time: `blzyl`, and now `blyxrs`. A5's requirement is that granting the second
 * leaf must not implicitly grant the `wdrsxx` container or its remaining child, and the token ban DOES cover every read that
 * names those classes — reading `td.wdrsxx`, or selecting the container by attribute, still fails.
 *
 * What the token ban could NOT cover is reaching a sibling WITHOUT naming it. A granted `font` cell can walk up with
 * `parentElement` and take the node next to it, and that snippet passed the scan. This was measured, not assumed: the
 * positional-sibling self-test below was written first, and it failed.
 *
 * All four constructs are banned rather than only `parentElement`, because each is an equivalent route upward or sideways.
 * The ban costs nothing today: the shipped content script contains ZERO occurrences of any of them — it reaches every granted
 * node by descending from `document` or from a node the page already handed it, which is what the grant assumes.
 *
 * `children` is deliberately NOT banned. It walks down, not up, and down is already closed by the class grant and by
 * `GRANTED_ELEMENT_QUERIES`.
 */
const FORBIDDEN_TRAVERSAL = [
  ['parentElement', '向上遍历（可绕开叶单元授权触及兄弟槽位）'],
  ['parentNode', '向上遍历（同上）'],
  ['.closest(', '向上匹配祖先（同上）'],
  ['nextElementSibling', '横向遍历（同上）'],
  ['previousElementSibling', '横向遍历（同上）'],
];

/**
 * How many times the granted read for one entry appears in `code`.
 *
 * Counts the DECLARATION and the CALLS separately: a call through a constant that was never declared with the granted selector must not count, so the
 * result is the smaller of the two. The expected call count is per entry rather than assumed to be one, because two of these constants are read from
 * two places for a real reason — the detector and the step watcher each locate the same two markers — and a grant that could not express that would
 * have to be widened into a bare count, which is exactly the tolerance this grant exists to avoid.
 *
 * @param code - the comment-stripped artifact.
 * @param entry - one granted selector.
 * @returns the number of complete granted reads.
 */
function grantedReadCount(code, entry) {
  const declarations = code.split(`const ${entry.constant} = '${entry.selector}'`).length - 1;
  const calls = code.split(`document.querySelector(${entry.constant})`).length - 1;
  if (declarations === 0) return 0;
  return calls;
}

/** Strip block and line comments, leaving executable code. */
function codeOnly(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/(^|[^:])\/\/[^\n]*/gu, '$1');
}

const target = join(repoRoot, 'apps', 'extension', 'dist', 'content', 'content-script.js');

/**
 * Judge a content script: which forbidden tokens it uses, and which class names it reads.
 *
 * Pure, so the same judgement can be applied to the artifact and to a synthetic snippet. Without that, a rule about tokens
 * that no code uses yet could not be shown to work at all.
 *
 * @param text - the script's source text.
 * @returns the verdict for that text.
 */
function judge(text) {
  const codeText = codeOnly(text);
  /*
   * The two granted single-element reads are removed BEFORE the token scan, so `querySelector(` is exempt for exactly those selector strings and
   * for nothing else. No wildcard, no count tolerance: the literal call has to appear verbatim, and the count assertions below require each one
   * exactly once.
   */
  let scanned = codeText;
  for (const entry of GRANTED_SELECTORS) {
    /*
     * EVERY occurrence, not just the first. A constant read from two places is granted for both, and splitting only once left the second call in the
     * scanned text, so the token scan reported a violation that the per-entry count check had already approved.
     */
    scanned = scanned.split(`document.querySelector(${entry.constant})`).join('');
  }
  /*
   * The element-level reads, exempted here for the same reason: the expansion watcher asks whether an added subtree holds a course panel, and the hydration
   * adapter asks a ROW for its teacher cell and a PANEL for its expand control. Each is granted as its own capability — counted separately below and
   * asserted per call form — and each can only look inside a node the page already provided.
   *
   * The receiver names are written out rather than looped, because naming them is what makes the exemption narrow: a receiver not on this list calling
   * `querySelector` on a page node is still caught. `group` joined in PRE-RELEASE-UX-A9 for the availability filter, and it is the narrowest of the four —
   * it can only look inside the option group, which itself came from the granted panel.
   */
  for (const argument of GRANTED_ELEMENT_QUERIES) {
    scanned = scanned
      .split(`node.querySelector(${argument})`).join('')
      .split(`row.querySelector(${argument})`).join('')
      .split(`panel.querySelector(${argument})`).join('')
      .split(`group.querySelector(${argument})`).join('')
      .split(`ul.querySelector(${argument})`).join('');
  }
  /*
   * Traversal is judged on the SAME text, so a read that names a granted leaf still fails if it then walks up to its container.
   * Merging it into the one violation list is deliberate: a caller that checked only `FORBIDDEN` would otherwise see a clean
   * verdict for code that defeats the leaf grant.
   */
  const violations = [
    ...FORBIDDEN.filter(([token]) => scanned.includes(token)).map(([token, why]) => `${token}（${why}）`),
    ...FORBIDDEN_TRAVERSAL.filter(([token]) => scanned.includes(token)).map(([token, why]) => `${token}（${why}）`),
  ];
  return { violations };
}

/**
 * The class names the grant EXCLUDES, asserted as data.
 *
 * The token ban is what enforces this — naming `jxbzrl`, `wdrsxx` or `rsxx` in order to read it puts the token in the code,
 * which is exactly what fails. Deriving the exclusion from the same list keeps this from drifting away from the ban, and it
 * fails if someone ever adds a capacity number or the container to the grant by mistake.
 *
 * UPDATED IN PRE-RELEASE-UX-A4. `blyxrs` was removed from this derivation because it moved into the grant. Note what did NOT
 * change: capacity (`jxbzrl`) and the container (`wdrsxx`) are still derived as excluded, so the invariant still fails if
 * either reaches `GRANTED_CLASSES`. The count is 3 rather than 4 for that reason, and no other exclusion was dropped.
 */
const EXCLUDED_BY_GRANT = FORBIDDEN
  .map(([token]) => token)
  .filter((token) => token === 'jxbzrl' || token === 'wdrsxx' || token === 'rsxx');
const GRANT_IS_NARROW = GRANTED_CLASSES.includes('blzyl')
  && GRANTED_CLASSES.includes('blyxrs')
  && EXCLUDED_BY_GRANT.length === 3
  && EXCLUDED_BY_GRANT.every((token) => !GRANTED_CLASSES.includes(token));

const raw = readFileSync(target, 'utf8');
const code = codeOnly(raw);
const artifact = judge(raw);

console.log('  产物: dist/content/content-script.js');
console.log('');
/*
 * The diagnostic table has to use the SAME judgement as the check, or it reports a violation the check does not see. That is exactly what happened
 * on the first run of this grant: the table scanned the raw code, counted the two granted `querySelector` calls as violations, and printed FAIL while
 * the assertion — which scans the code with the granted reads removed — passed. The table now derives each row from the artifact verdict.
 */
const violationTokens = new Set(artifact.violations.map((entry) => entry.split('（')[0]));
console.log('  项                      原文   代码  说明');
for (const [token, why] of FORBIDDEN) {
  const inRaw = raw.includes(token);
  const inCode = violationTokens.has(token);
  console.log(`  ${token.padEnd(22)} ${inRaw ? '有  ' : '无  '} ${inCode ? '⚠ 有' : '无  '}  ${why}`);
}
const codeViolations = artifact.violations.length;

/*
 * The class names the artifact reads, checked against the grant.
 *
 * This is what turns the seat grant into something enforceable: a class that is not on the list fails, so the next change
 * must add `blzyl` deliberately rather than reach any cell it likes.
 */
console.log('');
console.log(`  授权类名数（含 blzyl）       : ${GRANTED_CLASSES.length}`);
console.log(`  由合同排除的 seat 类名数     : ${EXCLUDED_BY_GRANT.length}（${EXCLUDED_BY_GRANT.join(', ')}）`);

/*
 * The granted single-element reads, asserted EXACTLY once each.
 *
 * A count is what keeps the exemption from widening: `querySelector(` is exempt only inside these two literals, so a third read — or a second copy
 * of one of these — appears in the token scan and fails. The checks are on the raw text because that is where the literal call lives.
 */
console.log('');
let selectorGrantOk = true;
for (const entry of GRANTED_SELECTORS) {
  const occurrences = grantedReadCount(code, entry);
  const ok = occurrences === entry.calls;
  if (!ok) selectorGrantOk = false;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  授权单元素读取 ${entry.selector.padEnd(11)} → ${entry.purpose}（实测 ${occurrences} 次，允许 ${entry.calls} 次）`);
}
/*
 * And the markers must not be READ, only located: their visible text is page wording, and depending on it would be both a broader read and a brittle
 * one. The wording is spelled with escape sequences so that this CHECK does not itself put the text in the gate's own source, which would be a
 * confusing way for the rule to look violated.
 */
for (const wording of ['\u70b9\u6b64\u67e5\u770b\u66f4\u591a', '\u5df2\u5230\u6700\u540e']) {
  const present = code.includes(wording);
  if (present) selectorGrantOk = false;
  console.log(`  ${present ? 'FAIL' : 'PASS'}  授权读取不含页面文案 ${wording}`);
}

/*
 * The two clicks, asserted as a closed rule rather than described.
 *
 * Every fact is checked separately, because each can break on its own: each click happens exactly once, each happens on a variable that came from its own
 * granted read, and no forbidden click form appears anywhere in the artifact.
 *
 * TWO click paths exist since 16J-PREUI-E4-B2, and they belong to different features: `#more a` loads the next batch of courses, and a panel-relative
 * `a.expand1` fills in that panel's teacher data. Both are named here so a third cannot appear unnoticed.
 */
console.log('');
const clickPaths = [
  { variable: 'target', selector: '#more a', clicks: 1, source: `document.querySelector(${GRANTED_SELECTORS[3].constant})`, feature: '自动展开（加载更多课程）' },
  { variable: 'target', selector: 'a.expand1', clicks: 1, source: `panel.querySelector(${GRANTED_SELECTORS[4].constant})`, feature: '教师信息补全（展开该课程面板）' },
  /*
   * PRE-RELEASE-UX-A9. THREE more click targets, all inside the page's own filter panel, and each bounded to ONE click per session. They joined here rather
   * than in a separate list for the same reason the first two are together: this is the complete set of things the extension may click, and a sixth could not
   * appear unnoticed.
   *
   * Note what is NOT here: no enrollment control, no drop control, no submit-enrollment button. `button[name=query]` is the panel's SEARCH submit — the
   * button that re-runs the listing — and the tests assert it is resolved through the granted panel rather than page-wide.
   */
  { variable: 'expand', selector: 'a.down', clicks: 1, source: 'panel.querySelector(FILTER_EXPAND_CONTROL_SELECTOR)', feature: '有余量筛选（展开筛选区）' },
  { variable: 'option', selector: 'div.items[name=yl_list] li[index=yl_list_1] a', clicks: 1, source: 'group.querySelector(AVAILABILITY_OPTION_SELECTOR)', feature: '有余量筛选（选择「有」）' },
  { variable: 'query', selector: 'button[name=query]', clicks: 1, source: 'panel.querySelector(FILTER_QUERY_BUTTON_SELECTOR)', feature: '有余量筛选（提交查询）' },
];
let clickIsGranted = true;
/*
 * UPDATED IN PRE-RELEASE-UX-A9, from a positional heuristic to a NAME-based rule.
 *
 * The old form sliced the text from a granted read to the next `const target =`, because both early adapters happened to name their target `target`. That works
 * for two paths and cannot generalise: one of the new clicks is written to a `let` that is REASSIGNED after the expand step, so there is no single declaration
 * to slice to.
 *
 * The replacement proves the same three facts without depending on where anything sits:
 *
 *   1. each path's granted read appears exactly once, so the target comes from that read and no other;
 *   2. each click variable is named exactly once with a `.click()` call, so no path can click twice;
 *   3. the TOTAL number of `X.click()` calls equals the sum of the grants, so no sixth click target can exist.
 *
 * Fact 3 is what keeps the set closed, and it is stronger than the old heuristic: a click that no path claims now fails the total rather than escaping the
 * region scan.
 */
for (const path of clickPaths) {
  /*
   * UPDATED IN PRE-RELEASE-UX-A9, and the honest reason is worth recording: a SEGMENT-based count cannot express this session.
   *
   * The reads and clicks here interleave rather than following the read-then-click shape the first two adapters happen to have — the option's read lives in a
   * helper, so its click sits BEFORE it in the artifact, while the query's click sits AFTER its read. A window between two read sites therefore either misses
   * the click or swallows a neighbour's, and the first two attempts at this rule each failed on a different one of those cases.
   *
   * So the per-path check is NAME-EXACT, and the closure check below carries the bound:
   *
   *   1. this path's granted read appears exactly once, so the target comes from that read;
   *   2. its click variable is named exactly ONCE anywhere in the artifact, so this path cannot click twice — which is the per-click bound, proven by name
   *      rather than by position;
   *   3. and the TOTAL `X.click()` count equals the sum of the grants, so no sixth target exists.
   *
   * `target` is shared by the two early adapters, so its name count is two and the shared bound is carried by the closure check; every other variable is unique.
   */
  const sourceCount = code.split(path.source).length - 1;
  const nameCount = code.split(`${path.variable}.click()`).length - 1;
  const expectedNameCount = path.variable === 'target' ? clickPaths.filter((other) => other.variable === 'target').length : path.clicks;
  const ok = sourceCount === 1 && nameCount === expectedNameCount;
  if (!ok) clickIsGranted = false;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${path.feature}：${path.selector} 读取 ${sourceCount} 次 · click 命名 ${nameCount} 次（应 ${expectedNameCount}）`);
}
/* Fact 3: the click set is CLOSED. Every `X.click()` in the artifact must be one of the granted paths, counted by variable. */
const grantedClickLiterals = new Set(clickPaths.map((path) => `${path.variable}.click()`));
const allClickLiterals = [...code.matchAll(/([A-Za-z_$][\w$]*)\.click\(\)/gu)].map((match) => match[0]);
const ungrantedClicks = allClickLiterals.filter((literal) => !grantedClickLiterals.has(literal));
const clickTotalOk = ungrantedClicks.length === 0
  && allClickLiterals.length === clickPaths.reduce((total, path) => total + path.clicks, 0);
if (!clickTotalOk) clickIsGranted = false;
console.log(`  ${clickTotalOk ? 'PASS' : 'FAIL'}  点击集合封闭：实测 ${allClickLiterals.length} 次，授权合计 ${clickPaths.reduce((total, path) => total + path.clicks, 0)} 次${ungrantedClicks.length === 0 ? '' : `（未授权：${ungrantedClicks.join(', ')}）`}`);
if (!clickIsGranted) selectorGrantOk = false;
for (const forbidden of GRANTED_CLICK.forbidden) {
  const present = code.includes(forbidden);
  if (present) selectorGrantOk = false;
  console.log(`  ${present ? 'FAIL' : 'PASS'}  不出现被禁点击形式 ${forbidden}`);
}
/* And each clicked variable must come from a granted selector, not from somewhere else. */
const clickTargetFromGrantedSelector = clickPaths.every((path) => code.includes(path.source));
if (!clickTargetFromGrantedSelector) selectorGrantOk = false;
console.log(`  ${clickTargetFromGrantedSelector ? 'PASS' : 'FAIL'}  两条点击目标都来自授权读取`);

// What it IS allowed and required to read.
console.log('');
const allowed = ['location.hostname', 'location.pathname'];
let allowedMissing = 0;
for (const token of allowed) {
  const present = code.includes(token);
  if (!present) allowedMissing += 1;
  console.log(`  ${present ? 'PASS' : 'FAIL'}  代码读取 ${token}`);
}

/*
 * Self-test: the SAME judgement applied to synthetic snippets.
 *
 * A rule about tokens that no shipped code contains yet cannot be exercised through the artifact — `jxbzrl` is named in the
 * contract precisely so capacity stays excluded, and proving that needs a snippet that mentions it. This also proves each
 * grant is real: a snippet reading `blzyl` or `blyxrs` must be accepted, while `wdrsxx` must not be.
 *
 * UPDATED IN PRE-RELEASE-UX-A4: `blyxrs` flipped from a rejected case to an authorized one, and two cases were ADDED rather
 * than replaced — a forbidden capacity read through the newly granted cell's own subtree, and a read of an unlisted sibling
 * class. The rejections that remain are the point of the slice: one child becoming readable must not make the container or
 * its remaining child readable.
 */
function selfTest(label, snippet) {
  const verdict = judge(snippet);
  const blocked = verdict.violations.length > 0;
  const shouldAuthorize = label.startsWith('authorize ');

  if (shouldAuthorize) {
    // A granted read must pass: no forbidden token may be needed to perform it.
    console.log(`  ${blocked ? 'FAIL' : 'PASS'}  ${label}${blocked ? `（⚠ 被误拒: ${verdict.violations.join(', ')}）` : ''}`);
    return blocked === false;
  }
  console.log(`  ${blocked ? 'PASS' : 'FAIL'}  ${label}  ${blocked ? `（已拒: ${verdict.violations.join(', ')}）` : '（⚠ 未被拒）'}`);
  return blocked;
}

console.log('');
console.log('  合同自测（对合成片段施加同一判定）:');
const selfTestResults = [
  /*
   * The shape the next change will actually write: name the granted class, then read it. Both halves matter — a snippet that
   * only mentioned the value in a comment would pass the token ban while proving nothing.
   */
  selfTest('authorize 只读 blzyl 的片段', "const REMAINING_SEATS_CLASS = 'blzyl';\nconst cell = firstWithClass(row, 'font', REMAINING_SEATS_CLASS);\nconst remaining = cell === undefined ? undefined : Number(cell.textContent.trim());\n"),
  /*
   * The same shape for the newly granted cell. Writing it exactly as the next slice will means the grant is exercised the way
   * it will actually be used, not merely mentioned.
   */
  selfTest('authorize 只读 blyxrs 的片段', "const SELECTED_THIS_ROUND_CLASS = 'blyxrs';\nconst cell = firstWithClass(row, 'font', SELECTED_THIS_ROUND_CLASS);\nconst selected = cell === undefined ? undefined : Number(cell.textContent.trim());\n"),
  selfTest('reject wdrsxx 容器片段', "const COUNTS_CLASS = 'wdrsxx';\n"),
  selfTest('reject rsxx 片段', "const SUPERSEDED_CAPACITY_CLASS = 'rsxx';\n"),
  selfTest('reject jxbzrl 容量片段', "const CAPACITY_CLASS = 'jxbzrl';\n"),
  selfTest('reject jxbxf 学分类名片段', "const CREDITS_CLASS = 'jxbxf';\n"),
  /*
   * THE CONTAINER-DID-NOT-WIDEN CASES. `blyxrs` is now readable, and these two prove that fact did NOT carry to its parent or
   * to a sibling — the exact inference a reader might make, and the one the contract must refuse.
   *
   * The sibling case reads the NEXT slot positionally rather than by class, because that is the tempting way to get a number
   * out of a cell you were granted part of. It fails because reaching it requires naming `wdrsxx` to find the container at
   * all: the grant names leaf cells one at a time, so a positional reach is still a container read.
   */
  selfTest('reject 经 blyxrs 授权扩展出的 wdrsxx 容器读取', "const SELECTED_CLASS = 'blyxrs';\nconst container = row.querySelector('td.wdrsxx');\nconst triple = container === null ? '' : container.textContent;\n"),
  selfTest('reject 经 blyxrs 授权按位置取到的 wdrsxx 兄弟槽位', "const SELECTED_CLASS = 'blyxrs';\nconst cell = firstWithClass(row, 'font', SELECTED_CLASS);\nconst container = cell === undefined ? undefined : cell.parentElement;\nconst siblings = container === undefined ? [] : container.querySelectorAll('font');\nconst capacity = siblings.length > 0 ? siblings[0].textContent : '';\n"),
];

/*
 * The DOM access is confirmed to be exactly one query, reading only its length.
 *
 * `querySelector` (singular) is checked with the opening parenthesis so it does not match `querySelectorAll`, which is the
 * permitted call.
 */
const queryAllCalls = [...code.matchAll(/querySelectorAll\s*\(/gu)].length;
/** Every argument passed to querySelectorAll, so the set of queried kinds is visible rather than counted. */
    const queryArguments = [...code.matchAll(/querySelectorAll\(\s*([^)\s]+)/gu)].map((match) => match[1] ?? '');
const lengthReads = [...code.matchAll(/querySelectorAll\s*\([^)]*\)\s*\.length/gu)].length;
/*
 * Document-level and element-level single reads are counted SEPARATELY, because they are different capabilities.
 *
 * A document read locates something on the page by selector, which is what the grant enumerates. An element read only asks whether a node the page
 * already handed us contains a particular descendant — the step watcher uses it to decide whether an added subtree holds a course panel — and it
 * cannot reach anything outside that node. Folding the two into one number would have made the grant look violated by a call it never covered.
 */
const documentQueries = [...code.matchAll(/document\.querySelector\s*\(/gu)].length;
const elementQueries = [...code.matchAll(/(?<!document\.)\bquerySelector\s*\(/gu)].length;
const singleQueries = [...code.matchAll(/querySelector\s*\(/gu)].length;
console.log('');
console.log(`  querySelectorAll 调用数      : ${queryAllCalls}`);
console.log(`  其后直接读 .length 的次数    : ${lengthReads}`);
console.log(`  document.querySelector 调用数: ${documentQueries}`);
console.log(`  元素级 querySelector 调用数  : ${elementQueries}`);
console.log(`  querySelector（合计）调用数  : ${singleQueries}`);

// The outbound calls, shown verbatim from the artifact.
console.log('');
const calls = [...code.matchAll(/sendMessage\([\s\S]*?\)/gu)].map((match) => match[0].replace(/\s+/gu, ' '));
for (const call of calls) console.log(`  出站调用（代码中）: ${call}`);
console.log(`  出站调用总数: ${calls.length}`);

const checks = [
  ['代码中不含任何被禁读取', codeViolations === 0],
  ['代码读取 location.hostname 与 location.pathname', allowedMissing === 0],
/*
   * The arguments are CHECKED against an enumerated set rather than counted: a bare count would have to be raised whenever a helper is added while still
   * accepting any selector. The set includes the hydration adapter's two constants, which are element-relative and cannot reach outside the panel.
   */
  ['querySelectorAll 的实参封闭在允许集内',
    queryArguments.length > 0 && queryArguments.every((argument) => GRANTED_ELEMENT_QUERIES.includes(argument))],
  /*
   * UPDATED IN 16J-PREUI-E4-B2-R1. This used to require exactly one `querySelectorAll(...).length`, because the panel count was the only consumer and it was
   * written inline. The count now goes through a shared `coursePanels()` helper that COUNTS by iterating rather than reading `.length`, so the old form is
   * gone — and asserting its absence is the sharper statement now: exactly zero query results may be consumed by `.length`, and every query result must be
   * walked with an index loop.
   *
   * What this protects is unchanged: a query result may not be swept into an array or visitor that makes the whole page readable in one move.
   */
  ['querySelectorAll 结果不以 .length 读取（改为索引遍历）', lengthReads === 0],
  ['querySelectorAll 结果按索引遍历，未使用 map/forEach/Array.from',
    !/Array\.from\s*\(\s*[^)]*querySelectorAll/u.test(code) && !/querySelectorAll[^;]*\.(?:map|forEach)\s*\(/u.test(code)],
  /*
   * The document-level single-element reads: the load-state markers, the list container, and the two click targets. Allowed as an exact, closed set with a
   * per-entry call count, so an extra read or a duplicate of an existing one fails.
   */
  ['没有读取单个元素（除授权的 load-state、自动展开与教师补全标记）',
    documentQueries === GRANTED_SELECTORS.reduce((total, entry) => total + entry.calls, 0)
    && GRANTED_SELECTORS.every((entry) => grantedReadCount(code, entry) === entry.calls)],
  /* The element-level read is the watcher's, and it is granted to exactly one call site. */
  /* The element-level reads are each granted a fixed number of call sites, asserted rather than counted loosely. */
  /*
   * UPDATED IN PRE-RELEASE-UX-A9: 4 → 8.
   *
   * The availability filter adds four element-relative reads, each inside the panel or the option group: the group, the 「有」 option, the query button and the
   * expand control. Every one is named in GRANTED_ELEMENT_QUERIES, and the count is the second half of that grant — an extra element read fails here even if
   * its argument was somehow allowed.
   */
  ['元素级 querySelector 恰为 8 处（1 处观察器 + 2 处教师单元格 + 1 处展开控件 + 4 处有余量筛选）', elementQueries === 8],
  ['授权读取的标记不含任何页面文案，且点击被封闭为唯一一次', selectorGrantOk],
  ['出站调用恰好六处（页面状态 + 面板计数 + 自动展开事件 + 教师补全事件 + 全流程准备事件 + 有余量筛选事件）', calls.length === 6],
  // The seat grant: `blzyl` and `blyxrs` are in; capacity and the shared container are out.
  ['seat 授权 ⊆ {blzyl, blyxrs}，容量与容器均在合同外', GRANT_IS_NARROW],
  // And the grant itself must be real, not just a comment: the two granted tokens accepted, the excluded ones rejected.
  ['合同自测：blzyl / blyxrs 片段被授权，wdrsxx / rsxx / jxbzrl / jxbxf 片段被拒', selfTestResults.every((ok) => ok)],
  /*
   * The traversal ban, asserted separately from its self-tests so a report can tell "the artifact has none" apart from "the
   * rule works". Both matter: the first is the current state, the second keeps the rule from rotting into a comment.
   *
   * `code` is the comment-stripped artifact already computed above, so this reads the same text the violation scan does.
   */
  ['代码不含向上/横向遍历（否则叶单元授权可被绕开）',
    FORBIDDEN_TRAVERSAL.every(([token]) => !code.includes(token))],
];
console.log('');
let failed = 0;
for (const [label, ok] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failed += 1;
}
console.log('');
console.log(failed === 0 ? 'CONTENT_PRIVACY_OK' : `CONTENT_PRIVACY_FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
