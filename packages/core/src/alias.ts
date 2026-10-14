/**
 * Course and teacher aliases.
 *
 * ## Why this is separate from `normalizeCourseName()`
 *
 * Normalization answers "are these two strings the same name?". An alias answers
 * "could these two strings be the same *course*?" — a strictly weaker claim that
 * belongs to the matcher, not the normalizer. Folding `上`/`下`/`A`/`B`/`I`/`II`
 * into the matching key would make `高等数学A`, `高等数学B`, and `高等数学C` a single
 * course, which is a real and common registration mistake. So the base
 * normalization keeps every qualifier, and this module generates aliases that are
 * tried *after* exact matching has failed and are reported as their own match
 * method.
 *
 * ## Conservation rules
 *
 * 1. Only qualifiers on a **reviewed allow-list** may be removed: parts
 *    (`上`/`下`, `上册`/`下册`), volumes (`第一册`), and Roman numerals (`I`/`II`/`Ⅰ`).
 * 2. A letter, digit, or section marker is **never** removable. `高等数学A` produces
 *    no alias.
 * 3. An alias is only used when it identifies **one** course. If stripping the
 *    qualifier would match several real courses, the result is
 *    `ambiguous` and the caller must not bind it.
 *
 * @module @course-copilot/core/alias
 */

import { normalizeTeacherName } from './normalize.js';

/**
 * Qualifier forms that may be removed to form an alias, longest first.
 *
 * Deliberately an explicit list rather than a general "strip trailing suffix"
 * rule: a general rule is how `高等数学A` silently becomes `高等数学`.
 */
const COURSE_ALIAS_QUALIFIERS: readonly string[] = [
  '上册', '下册', '上篇', '下篇',
  '第一册', '第二册', '第三册', '第四册',
  '一册', '二册', '三册', '四册',
  '(上)', '(下)', '(中)', '(一)', '(二)', '(三)',
  '(i)', '(ii)', '(iii)', '(iv)',
  '(1)', '(2)',
  '上', '下',
  'iii', 'ii', 'iv', 'i',
  'Ⅲ', 'Ⅱ', 'Ⅳ', 'Ⅰ',
];

/** Titles that may be dropped from a teacher name. */
const TEACHER_TITLES: readonly string[] = ['教授', '副教授', '讲师', '助教', '老师', '教师', '先生', '女士'];

/**
 * Explicit, hand-verified teacher alias groups.
 *
 * The outer key is the canonical normalized name; the inner keys are accepted
 * spellings. **No automatic cross-language transliteration**: guessing that
 * `Zhang San` is `张三` needs evidence, and a wrong teacher binding attributes one
 * person's reviews to another. Anything not listed here falls back to
 * {@link safeTeacherVariants}, which only removes formatting differences.
 */
export const TEACHER_ALIAS_MAP: Readonly<Record<string, readonly string[]>> = {
  // Formatting variants only — the same characters, written differently.
  // Populated as real duplicates are confirmed; empty by default so nothing is
  // merged on a guess.
};

/** One alias candidate for a course name. */
export interface CourseAlias {
  /** The matching key with the qualifier removed. */
  key: string;
  /** The qualifier that was removed, for provenance. */
  removedQualifier: string;
  /** The full key this alias was derived from. */
  baseKey: string;
}

/** Outcome of alias generation for one course name. */
export interface CourseAliasResult {
  /** Every alias key, de-duplicated, in generation order. */
  aliases: CourseAlias[];
  /**
   * True when the qualifier is one that *cannot* be removed, so no alias exists.
   * `高等数学A` sets this, and callers must not invent an alias for it.
   */
  qualifierIsSignificant: boolean;
}

/** Fold width, drop invisible characters, and case-fold. */
function fold(input: string): string {
  return input
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF\u00AD]/gu, '')
    .toLowerCase();
}

/** Normalize a course name into its full (unalised) matching key. */
function fullKey(courseName: string): string {
  return fold(courseName)
    .replace(/[\s\u3000]+/gu, '')
    .replace(/[·•・、,，;；:：\-—–_/\\|~^'"`“”‘’*#()[\]【】（）]/gu, '');
}

/**
 * Qualifiers that look removable but are not: a trailing Latin letter or digit is
 * a course variant identifier (A/B/C streams, 1/2 sections), so removing it would
 * merge genuinely different courses.
 */
const SIGNIFICANT_TAIL = /[a-z0-9]$/u;

/**
 * Generate conservative alias candidates for a course name.
 *
 * @param courseName - raw course name from any source.
 * @returns the alias candidates plus whether the name carries a significant
 *   qualifier that must block aliasing.
 */
export function courseAliases(courseName: string): CourseAliasResult {
  const key = fullKey(courseName);
  if (key.length === 0) return { aliases: [], qualifierIsSignificant: false };

  // A trailing letter/digit is an identifier, not a volume marker.
  if (SIGNIFICANT_TAIL.test(key)) return { aliases: [], qualifierIsSignificant: true };

  const aliases: CourseAlias[] = [];
  for (const qualifier of COURSE_ALIAS_QUALIFIERS) {
    const folded = fold(qualifier);
    if (!key.endsWith(folded)) continue;
    const stripped = key.slice(0, key.length - folded.length);
    // Never alias down to nothing: `上` alone is not a course.
    if (stripped.length === 0) continue;
    if (!aliases.some((entry) => entry.key === stripped)) {
      aliases.push({ key: stripped, removedQualifier: qualifier, baseKey: key });
    }
  }
  return { aliases, qualifierIsSignificant: false };
}

/**
 * Formatting-only variants of a teacher name.
 *
 * Applied in order of decreasing safety: exact normalized form, then honourific
 * removed, then spacing/case variants. No transliteration, no surname guessing.
 *
 * @param teacher - raw teacher text.
 * @returns de-duplicated variants, most specific first.
 */
export function safeTeacherVariants(teacher: string | undefined): string[] {
  if (teacher === undefined) return [];
  const variants: string[] = [];
  const push = (value: string): void => {
    const normalized = value.trim().toLowerCase();
    if (normalized.length > 0 && !variants.includes(normalized)) variants.push(normalized);
  };

  // The standard normalizer's key.
  push(normalizeTeacherName(teacher));

  // Honourific removed anywhere it appears, not just at the end.
  let stripped = fold(teacher);
  for (const title of TEACHER_TITLES) stripped = stripped.replaceAll(title, '');
  push(stripped.replace(/[\s\u3000]+/gu, '').replace(/[·•・、,，;；:：\-—–_/\\|]/gu, ''));

  // CJK spacing variant: `张 三` and `张三`.
  push(fold(teacher).replace(/[\s\u3000]+/gu, ''));

  return variants;
}

/**
 * Every teacher key a query should be compared against.
 *
 * @param teacher - raw teacher text.
 * @returns normalized keys plus any explicit aliases registered for them.
 */
export function teacherKeys(teacher: string | undefined): string[] {
  const keys = new Set<string>();
  for (const variant of safeTeacherVariants(teacher)) {
    keys.add(variant);
    for (const alias of TEACHER_ALIAS_MAP[variant] ?? []) {
      keys.add(normalizeTeacherName(alias) || alias.toLowerCase());
    }
  }
  return [...keys];
}

/**
 * Whether two teacher strings refer to the same person.
 *
 * @param left - first teacher text.
 * @param right - second teacher text.
 * @returns `true` when the two share any key.
 */
export function teachersMatch(left: string | undefined, right: string | undefined): boolean {
  const leftKeys = teacherKeys(left);
  if (leftKeys.length === 0) return false;
  const rightKeys = new Set(teacherKeys(right));
  if (rightKeys.size === 0) return false;
  return leftKeys.some((key) => rightKeys.has(key));
}

/** One ambiguous alias resolution: several real courses share a base name. */
export interface AliasAmbiguity {
  /** The alias key that could not be resolved. */
  aliasKey: string;
  /** The distinct qualified names it would have absorbed. */
  candidates: string[];
}

/**
 * Resolve an alias only when it points at exactly one real name.
 *
 * @param aliasKey - the stripped key produced by {@link courseAliases}.
 * @param knownNames - every course name (raw) the corpus actually holds.
 * @returns the single matching name, or the ambiguity describing why not.
 */
export function resolveAliasUniquely(
  aliasKey: string,
  knownNames: readonly string[],
): { resolved: string } | { ambiguity: AliasAmbiguity } | undefined {
  const matches = knownNames.filter((name) => fullKey(name) === aliasKey);
  if (matches.length === 0) return undefined;
  if (matches.length > 1) {
    return { ambiguity: { aliasKey, candidates: [...new Set(matches)].sort() } };
  }
  return { resolved: matches[0] as string };
}

/**
 * Whether a qualifier is on the removable allow-list.
 *
 * Exposed so tests can assert the allow-list directly rather than through the
 * behaviour of {@link courseAliases}.
 *
 * @param qualifier - a candidate qualifier such as `上` or `A`.
 * @returns `true` when removing it is permitted.
 */
export function isRemovableQualifier(qualifier: string): boolean {
  const folded = fold(qualifier);
  return COURSE_ALIAS_QUALIFIERS.some((entry) => fold(entry) === folded);
}

/**
 * Whether a name ends in a *significant* qualifier — a stream or section marker.
 *
 * `高等数学A` and `高等数学B` are different courses that are 76% similar by
 * bigram overlap, so no similarity threshold can separate them. Where similarity
 * would fail, this check succeeds: two names that both carry a significant
 * qualifier are only the same course when those qualifiers **agree**.
 *
 * @param courseName - raw course name.
 * @returns the trailing marker, or `undefined` when there is none.
 */
export function significantQualifier(courseName: string): string | undefined {
  const key = fullKey(courseName);
  if (key.length === 0) return undefined;
  // A removable qualifier means the marker is not significant.
  for (const qualifier of COURSE_ALIAS_QUALIFIERS) {
    const folded = fold(qualifier);
    if (key.endsWith(folded) && key.length > folded.length) return undefined;
  }
  const match = /([a-z]|\d{1,2})$/u.exec(key);
  return match?.[1];
}

/**
 * Whether two course names disagree about a significant qualifier.
 *
 * Used by the matcher to veto *both* aliasing and fuzzy matching: a stream letter
 * is a real discriminator, and treating it as noise is how a recommender sends a
 * student to the wrong section.
 *
 * @param left - first course name.
 * @param right - second course name.
 * @returns `true` when both carry a marker and the markers differ.
 */
export function qualifiersConflict(left: string, right: string): boolean {
  const leftMarker = significantQualifier(left);
  const rightMarker = significantQualifier(right);
  if (leftMarker === undefined || rightMarker === undefined) return false;
  return leftMarker !== rightMarker;
}

/** The allow-list itself, exposed for documentation and tests. */
export const REMOVABLE_QUALIFIERS: readonly string[] = COURSE_ALIAS_QUALIFIERS;
