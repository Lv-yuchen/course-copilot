/**
 * Course/teacher name normalization.
 *
 * The goal is a stable matching key that survives the cosmetic differences
 * between a selection-system page and a review site, WITHOUT destroying the
 * original string (callers always keep `courseName` untouched).
 *
 * What is normalized:
 * - Unicode full-width forms -> half-width (NFKC), including full-width digits,
 *   Latin letters, and punctuation such as `（）：，`.
 * - Whitespace: collapsed, trimmed, and zero-width/invisible characters removed.
 * - Bracket styles: `（`)`【】[]` all become `()` so `高等数学（上）` and
 *   `高等数学(上)` agree.
 * - Case: Latin letters are lowercased.
 * - Punctuation noise: separators like `·`, `、`, `,`, `-`, `—`, `_`, `/` that
 *   carry no identifier meaning are dropped.
 * - A leading course code (`MATH101 高等数学` / `[MATH101]高等数学`) is stripped
 *   from the *matching key only*.
 * - A trailing section suffix (`-01`, `(1)`, `第3班`) is moved into a separate
 *   field rather than destroyed.
 * - A redundant semester marker (`2024-2025学年第一学期`) is stripped.
 *
 * @module @course-copilot/core/normalize
 */

/** Result of splitting a raw course name into a matching key plus metadata. */
export interface NormalizedName {
  /** The raw input, echoed back for convenience. */
  original: string;
  /** Matching key: normalized, code-stripped, section-stripped. */
  key: string;
  /** Course code removed from the front, when present. */
  codePrefix?: string;
  /** Section marker removed from the end, when present. */
  sectionSuffix?: string;
  /** Semester marker removed, when present. */
  semesterMarker?: string;
  /** Bracketed qualifier kept from the name, e.g. `上` from `高等数学(上)`. */
  qualifier?: string;
}

const ZERO_WIDTH = /[\u200B-\u200D\uFEFF\u00AD]/gu;

/** Separators that carry no identity and are removed from the matching key. */
const NOISE_CHARS = /[·•・、,，;；:：\-—–_/\\|~^'"`“”‘’*#]+/gu;

/** Bracket pairs normalized to ASCII parentheses. */
const BRACKET_MAP: ReadonlyArray<readonly [RegExp, string, string]> = [
  [/[（【〔〖「『《]/gu, '(', '('],
  [/[）】〕〗」』》]/gu, ')', ')'],
];

/**
 * Semester-ish markers that never disambiguate a course.
 *
 * The year form is deliberately narrow. A bare `2024101234567` is a WHU course
 * code, not a semester, so `20\d{2}` must only be stripped when something makes
 * the semester reading unambiguous: a `学年`/`学期` suffix nearby, a term
 * character, or a year range.
 */
const SEMESTER_PATTERNS: readonly RegExp[] = [
  // `2024-2025学年`, `2024—2025学年`, `2024~2025`
  /\d{4}\s*[-–—~至]\s*\d{4}\s*(?:学年度|学年|年度)?/gu,
  // `2024学年`, `第一学期`, `第2学期`, `学期`
  /第?\s*[一二三四五六七八九十\d]+\s*学期/gu,
  /(?:19|20)\d{2}\s*(?:学年度|学年)/gu,
  // `2024春`, `2025秋季`
  /(?:19|20)\d{2}\s*[春夏秋冬](?:季)?/gu,
  /\b(?:spring|fall|autumn|winter|summer)\b/giu,
];

/** Section markers such as `-01`, `(3)`, `第2班`, `班号01`. */
const SECTION_PATTERNS: readonly RegExp[] = [
  /[-_\s]*\(\s*(\d{1,2})\s*\)\s*$/u,
  /[-_\s]+(\d{1,2})\s*$/u,
  /第\s*(\d{1,3})\s*(?:班|教学班|课堂)/gu,
  /教学班\s*[-_]?\s*(\d{1,3})/gu,
  /班号\s*[-_]?\s*(\d{1,3})/gu,
];

/** Leading course-code candidates, e.g. `MATH101`, `2024101234567`, `A1B2`. */
const LEADING_CODE = /^\s*[[(【]?\s*([A-Za-z]{1,6}\s?-?\s?\d{2,12}|\d{6,16})\s*[\])】]?\s*[-—:：.]?\s*/u;

/** Full-width to half-width plus compatibility folding. */
function foldWidth(input: string): string {
  return input.normalize('NFKC');
}

/** Collapse every whitespace run (including ideographic space) to one space. */
function collapseWhitespace(input: string): string {
  return input.replace(/[\s\u3000]+/gu, ' ').trim();
}

/**
 * Normalize a teacher name for matching.
 *
 * Teacher names are short; the useful normalizations are width folding, space
 * removal (some pages write `李 明`), and dropping titles such as `教授`.
 *
 * @param teacher - raw teacher text, possibly with a title or multiple names.
 * @returns the normalized key, or an empty string when nothing usable remains.
 */
export function normalizeTeacherName(teacher: string | undefined): string {
  if (teacher === undefined) return '';
  let value = foldWidth(teacher).replace(ZERO_WIDTH, '');
  // Multiple teachers are joined by separators; matching uses the first one,
  // because review sites index one teacher per row.
  value = value.split(/[、,，/\\;；&+]|和|与/u)[0] ?? value;
  value = value.replace(/(?:教授|副教授|讲师|助教|老师|教师|先生|女士)$/u, '');
  value = value.replace(/[\s\u3000]+/gu, '');
  value = value.replace(NOISE_CHARS, '');
  return value.toLowerCase();
}

/**
 * Split a published teacher cell into its individual names.
 *
 * This is the ONLY separator rule in the codebase, and it is deliberately the same one
 * {@link normalizeTeacherName} uses. A co-taught class is published as ONE cell — `翟显、廖冬梅、滕芸、…` — so every caller
 * that needs to reason about *who* teaches a class has to split it, and two slightly different splitter regexes would
 * eventually disagree about which people a class has.
 *
 * Separators only. A cell naming one person yields one name, and prose is returned unchanged for the caller to judge:
 * deciding that a cell is not a name at all is a different question from where the names are.
 *
 * @param teacher - a published teacher cell.
 * @returns the names in published order, trimmed; empty when the cell holds nothing.
 */
export function splitTeacherNames(teacher: string | undefined): string[] {
  if (teacher === undefined) return [];
  const value = foldWidth(teacher).replace(ZERO_WIDTH, '');
  return value
    .split(/[、,，/\\;；&+]|和|与/u)
    .map((part) => part.replace(/[\s\u3000]+/gu, ' ').trim())
    .filter((part) => part.length > 0);
}

/**
 * The distinct normalized names a teacher cell names.
 *
 * Comparison is on the normalized form, so `李 明` and `李明` are the same person and `张三老师` is `张三`. Duplicates
 * collapse, so a cell reading `张三、张三、李四` yields exactly two names.
 *
 * @param teacher - a published teacher cell, or names already in hand.
 * @returns distinct normalized names; empty when the cell names nobody usable.
 */
export function teacherNameSet(teacher: string | readonly string[] | undefined): string[] {
  const names = typeof teacher === 'string' ? splitTeacherNames(teacher) : (teacher ?? []);
  const out: string[] = [];
  for (const name of names) {
    const key = normalizeTeacherName(name);
    if (key.length > 0 && !out.includes(key)) out.push(key);
  }
  return out;
}

/**
 * Whether two teacher cells share at least one person.
 *
 * **Partial overlap is agreement.** Two sides naming the same person is evidence about that person, and demanding equal
 * sets would reject every co-taught class, because the selection page and a review site routinely list different subsets.
 *
 * An empty side is `'unknown'`, never `'disagree'`: a page that has not published the teacher yet says nothing about who
 * teaches the class, and reporting that silence as a contradiction would suppress real matches.
 *
 * @param left - one side's teacher cell or names.
 * @param right - the other side's teacher cell or names.
 * @returns `'agree'` on any overlap, `'disagree'` on disjoint non-empty sets, `'unknown'` when either side is empty.
 */
export function teacherSetRelation(
  left: string | readonly string[] | undefined,
  right: string | readonly string[] | undefined,
): 'agree' | 'disagree' | 'unknown' {
  const leftSet = teacherNameSet(left);
  const rightSet = teacherNameSet(right);
  if (leftSet.length === 0 || rightSet.length === 0) return 'unknown';
  return leftSet.some((name) => rightSet.includes(name)) ? 'agree' : 'disagree';
}

/**
 * Normalize a course name into a matching key plus removable metadata.
 *
 * @param courseName - raw course name from any source.
 * @returns the structured normalization result; `key` may be empty when the
 *   input held nothing but punctuation, in which case callers should treat the
 *   name as unusable for name-based matching.
 */
export function normalizeCourseNameDetailed(courseName: string): NormalizedName {
  const original = courseName;
  let value = foldWidth(courseName).replace(ZERO_WIDTH, '');
  value = collapseWhitespace(value);

  let semesterMarker: string | undefined;
  for (const pattern of SEMESTER_PATTERNS) {
    pattern.lastIndex = 0;
    const match = pattern.exec(value);
    if (match !== null) {
      semesterMarker ??= match[0].trim();
      value = value.replace(pattern, ' ');
    }
  }
  value = collapseWhitespace(value);

  let codePrefix: string | undefined;
  const codeMatch = LEADING_CODE.exec(value);
  if (codeMatch !== null && codeMatch[1] !== undefined) {
    // Guard: only treat a leading token as a code when something remains after
    // it, otherwise `2024101234567` alone would normalize to an empty key.
    const remainder = value.slice(codeMatch[0].length).trim();
    if (remainder.length > 0) {
      codePrefix = codeMatch[1].replace(/\s+/gu, '');
      value = remainder;
    }
  }

  let sectionSuffix: string | undefined;
  for (const pattern of SECTION_PATTERNS) {
    pattern.lastIndex = 0;
    const match = pattern.exec(value);
    if (match === null) continue;
    const candidate = (match[1] ?? '').trim();
    if (candidate.length === 0) continue;
    const stripped = `${value.slice(0, match.index)}${value.slice(match.index + match[0].length)}`;
    // Refuse to strip when it would empty the name entirely (e.g. `高等数学1`
    // where `1` is part of the name, not a section).
    if (collapseWhitespace(stripped).replace(NOISE_CHARS, '').length === 0) continue;
    sectionSuffix = candidate;
    value = stripped;
    break;
  }
  value = collapseWhitespace(value);

  let bracketed = '';
  for (const [pattern, replacement] of BRACKET_MAP) {
    value = value.replace(pattern, replacement);
  }
  // Capture the *last* parenthesized qualifier as a qualifier, but keep it in
  // the key as well: `高等数学(上)` and `高等数学（上）` must match each other,
  // while `高等数学` alone must NOT be treated as identical.
  const qualifierMatches = [...value.matchAll(/\(([^()]*)\)/gu)];
  const lastQualifier = qualifierMatches.at(-1);
  if (lastQualifier !== undefined && lastQualifier[1] !== undefined) {
    const inner = collapseWhitespace(lastQualifier[1]);
    if (inner.length > 0) bracketed = inner;
  }

  value = value
    .toLowerCase()
    .replace(NOISE_CHARS, '')
    .replace(/[()（）]/gu, '')
    .replace(/\s+/gu, '');

  const result: NormalizedName = { original, key: value };
  if (codePrefix !== undefined) result.codePrefix = codePrefix;
  if (sectionSuffix !== undefined) result.sectionSuffix = sectionSuffix;
  if (semesterMarker !== undefined) result.semesterMarker = semesterMarker;
  if (bracketed.length > 0) result.qualifier = bracketed.toLowerCase();
  return result;
}

/**
 * Normalize a course name into its matching key.
 *
 * @param courseName - raw course name.
 * @returns the matching key; empty when the input had no usable content.
 */
export function normalizeCourseName(courseName: string): string {
  return normalizeCourseNameDetailed(courseName).key;
}

/**
 * Build every lookup key a course or review record should be indexed under.
 *
 * Both sides of a match use this so an asymmetry in how one side writes the
 * code cannot create a miss: the code-prefixed form and the bare form are both
 * registered.
 *
 * @param name - raw course name.
 * @returns a de-duplicated list of candidate keys.
 */
export function courseNameKeys(name: string): string[] {
  const detailed = normalizeCourseNameDetailed(name);
  const keys = new Set<string>();
  if (detailed.key.length > 0) keys.add(detailed.key);
  if (detailed.qualifier !== undefined && detailed.qualifier.length > 0) {
    keys.add(`${detailed.key}${detailed.qualifier}`);
  }
  return [...keys];
}
