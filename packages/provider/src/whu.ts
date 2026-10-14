/**
 * WHU review-corpus data rules: teacher-cell parsing and grade classification.
 *
 * whucourses.cn is free text entered by students, and two of its columns are
 * unreliable in ways that matter to every downstream number:
 *
 * - `授课老师` sometimes holds a whole comment, sometimes names two teachers.
 *   Such a row must **not** be deleted — its text is real student evidence — but
 *   it must never create a bogus teacher bucket or influence teacher matching.
 * - `课程成绩` mixes real grades with sentinels (`未知`, `Unknown`), junk
 *   (`-1`, `1270000000000000000`), and small numbers that are not percentages.
 *
 * ## Grade bands are scale questions, not pass/fail questions
 *
 * Classifying `grade < 60` as unusable would be survivorship bias: a real 55 or
 * 48 is *evidence about how hard the course grades*, and dropping it would make
 * every course look more generous than it is. So the split here is by **scale
 * plausibility**, never by the pass line:
 *
 * | cell | scale | validity | why |
 * |---|---|---|---|
 * | `95`, `59`, `48`, `20` | `percentage` | `usable` | a real percentage, high or low |
 * | `0`…`9` (integer) | `unknown` | `ambiguous` | too low to be a percentage, could be a 10-point scale or a placeholder; **kept and counted**, never averaged into percentages |
 * | `4.0`, `3.7` (decimal ≤ 5) | `gpa` | `ambiguous` | a GPA-like scale |
 * | `未知`, `Unknown`, `-1`, `1.2e18`, `""` | `unknown` | `invalid` | sentinel or unparseable |
 *
 * The observed 高等数学 corpus (851 rows) contains **no** value between 10 and
 * 59, and 18 rows of `0`…`9` — consistent with the band above. A future corpus
 * with a genuine 55 is kept as a usable percentage.
 *
 * @module course-selection-copilot/core/whu
 */

import { normalizeTeacherName } from '@course-copilot/core/normalize';
import type { GradeScale, GradeValidity, TeacherValidity } from '@course-copilot/core/course';
import type { GradeCalibration } from '@course-copilot/core/aspects';

/** Highest cell still plausible as a percentage. */
export const GRADE_MAX = 100;

/**
 * The pass line, tracked only so the output can report how many usable
 * percentages fell below it.
 *
 * Deliberately **not** a classification boundary: a 48 is a usable percentage
 * (see {@link GRADE_PERCENTAGE_FLOOR}) and stays in the statistics.
 */
export const GRADE_PASS_LINE = 60;

/**
 * Values at or below this (as an integer) are not plausible percentages.
 *
 * A real course grade of `4` would be 4%, which no WHU system issues; a `4` is
 * far more likely a GPA or a placeholder. These stay in the data as
 * `ambiguous` — counted, quoted, never averaged into percentage statistics.
 */
export const GRADE_PERCENTAGE_FLOOR = 10;

/** Upper bound of a GPA-style scale when a decimal is present. */
export const GRADE_GPA_MAX = 5;

/**
 * WHU's grade distribution, as `[grade, friendliness]` interpolation anchors.
 *
 * These are the campus's own numbers, not an algorithm constant: the observed distribution is strongly
 * skewed high (median ≈ 90), so a 90 is "normal" here rather than "excellent" and the scale only
 * saturates at 96+. A different campus needs different anchors, which is why the calibration is
 * injected into the grade-signal algorithm rather than living inside it.
 *
 * This constant used to be a local literal inside the grade-conversion function. It moved here in
 * Step 21 so the engine stops carrying one institution's distribution while still producing identical
 * numbers for this one.
 */
export const WHU_GRADE_CALIBRATION: GradeCalibration = [
  [60, 0.5], [70, 1.5], [75, 3], [80, 4.5], [85, 6], [88, 7], [90, 8], [93, 9], [96, 10],
];

/** Sequences that never appear in a person's name but do appear in prose. */
const PROSE_PUNCTUATION = /[。！？；，、：；!?…—～~「」【】〈〉《》“”‘’（）[\]{}]/u;

/**
 * Whether a cell carries sentence-ending ASCII punctuation.
 *
 * `'` and `"` are excluded when they sit between ASCII letters, because
 * `O'Brien` and `O"Neil` are names — the shape check must not be vetoed by a
 * character that is normal inside one.
 */
function hasSentencePunctuation(value: string): boolean {
  return /[()[\]]/u.test(value) || /['"]/u.test(value.replace(/[A-Za-z]['"](?=[A-Za-z])/gu, ''));
}

/** Tokens that are fields, not people. */
const NON_NAME_TOKENS = /^(?:未知|不详|无|没有|待定|其他|其它|外聘|外教团队|教学组|团队|多人|若干|各老师|多个老师|老师|教师|教师组|教学团队|未注明|未填写)$/u;

/** Maximum plausible length of one person's name with titles/separators. */
const MAX_NAME_LENGTH = 14;

/**
 * Unmistakable sentence markers.
 *
 * Checked as substrings because Chinese prose frequently has no punctuation:
 * `神，期末分90多的话，平时分直接拉满` would otherwise read as a long name. They
 * are deliberately *specific* — generic praise such as `很好` is **not** here,
 * because a short cell carrying it is more plausibly a real name in an
 * unexpected script, and mislabelling a real name costs more than tolerating one
 * odd cell.
 */
const PROSE_TAIL = /(?:的话|无需多言|直接拉满|拉满|平时分|期末分|给分|念PPT|上课|讲得|教学|同学|老师人|不用多言|永远的神|没问题|作业|很[好棒透彻清楚仔细认真负责难快慢多]|得也)/u;

/**
 * The **strict** name shape used when splitting a cell into several teachers.
 *
 * Only 2–4 ideographs (or an interpunct form) qualify, because a longer CJK run
 * inside a separated cell is prose far more often than it is a name: without this
 * narrow rule `老师会挑重点，讲得也比较认真，兼具减负和教学质量。` produced a
 * "teacher" named `兼具减负`. Single-name cells are checked with the looser
 * {@link isNameShape}, so a long legitimate name is still accepted on its own.
 */
const SPLIT_NAME_SHAPE = /^[\p{Script=Han}\u3400-\u4DBF]{2,4}(?:[·•][\p{Script=Han}]{1,8})?$/u;

/**
 * Whether `value` is name-shaped enough to be **one of several** split teachers.
 *
 * Must be a single token: a cell that still contains whitespace is a *group* of
 * candidates, not a candidate, and letting it pass here is what once made
 * `张三 李四` parse as one person named `张三 李四`.
 *
 * Only 2–4 ideographs (or an interpunct form) qualify for CJK, because a longer
 * CJK run inside a separated cell is prose far more often than it is a name:
 * without this narrow rule `老师会挑重点，讲得也比较认真，兼具减负和教学质量。` produced
 * a "teacher" named `兼具减负`. Single-name cells are checked with the looser
 * {@link isNameShape}, so a long legitimate name is still accepted on its own.
 */
function isSplitNameShape(value: string): boolean {
  if (value.length === 0 || value.includes(' ') || looksLikeProse(value)) return false;
  if (LATIN_NAME.test(value) && /[A-Za-z]{2}/u.test(value)) return true;
  return SPLIT_NAME_SHAPE.test(value);
}

/**
 * Latin-name variants of the same rules, used for a *separator-delimited segment*
 * such as `Zhang San`, which is one person even though it contains a space.
 */
const SPLIT_LATIN_NAME = /^[A-Za-z]{2,}[A-Za-z.'\- ]*[A-Za-z.]$/u;

/** Whether a separator-delimited segment is a complete Latin name on its own. */
function isSplitLatinName(value: string): boolean {
  if (!/[A-Za-z]{2}/u.test(value) || looksLikeProse(value)) return false;
  return SPLIT_LATIN_NAME.test(value);
}

/**
 * Whether `value` matches a recognised single-name shape.
 *
 * Shape first, prose second: `O'Brien` contains an apostrophe that is perfectly
 * normal in a Latin name, so a punctuation blacklist must never decide before the
 * shape does. The pattern checks are anchored, so prose that *contains* a
 * punctuation mark simply fails to match rather than being explicitly banned.
 */
function isNameShape(value: string): boolean {
  if (value.length === 0) return false;
  if ([...value].length > MAX_NAME_LENGTH) return false;
  if (LATIN_NAME.test(value)) return true;
  if (CJK_NAME.test(value.replace(/ /gu, ''))) return true;
  return false;
}

/**
 * Latin/international name shape, e.g. `John Smith`, `J. Smith`, `Smith Jr.`,
 * `Van der Berg`, `O'Brien`.
 */
const LATIN_NAME = /^[A-Za-z][A-Za-z.'\- ]*$/u;

/**
 * Chinese name shape: 2–8 CJK ideographs of any script region, optionally
 * separated by an interpunct (covers compound surnames and transliterations
 * such as `阿卜杜拉·买买提`).
 */
const CJK_NAME = /^[\p{Script=Han}\u3400-\u4DBF]{2,8}(?:[·•.][\p{Script=Han}]{1,8})?$/u;

/**
 * Separators that reliably join co-teachers, e.g. `张三、李四`, `张三 / 李四`,
 * `Zhang San; Li Si`, `张三 和 李四`.
 *
 * A **bare space is deliberately not a separator**: `John Smith` and
 * `Van der Berg` are single names, and reading their words as co-teachers would
 * be a worse error than missing a space-separated co-teaching cell. Prose
 * punctuation is absent for the same reason — a split is additionally required to
 * leave every part a complete name.
 */
const TEACHER_SEPARATOR_SPLIT = /[、,，/\\;；&+和与及]/u;

/** Whitespace, used only to split an already-separated name list further. */
const NAME_PART_SPLIT = /[\s\u3000]+/u;

/** Outcome of parsing a published teacher cell. */
export interface TeacherParse {
  validity: TeacherValidity;
  /** The single valid name, when `validity === 'valid'`. */
  teacher?: string;
  /** Recognised names, when `validity === 'valid_multiple'`. */
  names: string[];
}

/**
 * Whether a value reads as prose rather than as a name.
 *
 * Applied to the whole cell *and* to each candidate part of a split, so a
 * sentence can never be decomposed into pieces that each happen to look
 * name-shaped (`老师很好，给分也高` would otherwise yield the "teacher" `给分也高`).
 *
 * @param value - a cell or a candidate part.
 * @returns true when it must not be treated as a person's name.
 */
function looksLikeProse(value: string): boolean {
  if (value.length === 0) return true;
  if ([...value].length > MAX_NAME_LENGTH) return true;
  if (PROSE_TAIL.test(value)) return true;
  return PROSE_PUNCTUATION.test(value) || hasSentencePunctuation(value);
}

/**
 * Parse a published teacher cell into zero, one, or several teachers.
 *
 * A multi-teacher cell is **not** `missing`: co-taught courses are real, the
 * selection system shows them too, and downstream matching must be able to see
 * that this row belongs to more than one person. The split is only accepted when
 * the cell is separated structurally and every part is a complete, non-prose
 * name, so prose commas cannot manufacture a teacher list.
 *
 * @param teacher - the raw cell, or `undefined` when the column is absent.
 * @returns the parsed names plus the validity classification.
 */
export function parseTeacher(teacher: string | undefined): TeacherParse {
  if (teacher === undefined) return { validity: 'missing', names: [] };
  const value = teacher
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF\u00AD]/gu, '')
    .replace(/[\s\u3000]+/gu, ' ')
    .trim();
  if (value.length === 0) return { validity: 'missing', names: [] };
  if (NON_NAME_TOKENS.test(value)) return { validity: 'missing', names: [] };

  // 1. A Latin full name is decided by shape, not by its words: `John Smith`,
  //    `Van der Berg` and `J. Smith` are one person each, and no whitespace or
  //    separator rule may split them. A space-separated *CJK* cell is deliberately
  //    not this case, because `张三 李四` names two people.
  if (LATIN_NAME.test(value) && /[A-Za-z]{2}/u.test(value)) {
    return { validity: 'valid', teacher: value, names: [value] };
  }

  // 2. Structural separation wins over "one long name": a cell separated into
  //    several complete names is co-teaching. Each segment is offered as a whole
  //    name first (`Zhang San`), and only a segment that is not a name on its own
  //    is broken on whitespace. Prose never becomes a teacher, so
  //    `老师很好，给分也高` yields nothing here.
  const separatorSplit = value.split(TEACHER_SEPARATOR_SPLIT).map((part) => part.trim()).filter((part) => part.length > 0);
  if (separatorSplit.length > 1 || value.includes(' ')) {
    const candidates = separatorSplit.flatMap((part) => {
      // A segment that is already a complete name on its own stays whole:
      // `Zhang San` is one person, while `张三 李四` is a group to be split.
      if (isSplitLatinName(part) || (/[A-Za-z]/u.test(part) && isSplitNameShape(part))) return [part];
      return part.split(NAME_PART_SPLIT).filter((piece) => piece.length > 0);
    });
    const named = candidates.filter((part) => isSplitNameShape(part) || isSplitLatinName(part));
    if (named.length > 1) {
      return { validity: 'valid_multiple', names: named };
    }
  }

  // 3. One name. `李 明` reaches here because a single-character token is not a
  //    name on its own, so the space-token rule above declined to split it.
  if (!looksLikeProse(value) && isNameShape(value)) {
    return { validity: 'valid', teacher: value, names: [value] };
  }

  // 4. A name shape must not be able to bless a sentence that merely happens to
  //    be CJK. Anything reaching here is prose, a field token, or an unnameable
  //    cell, and every one of those is `malformed` rather than a teacher.
  return { validity: 'malformed', names: [] };
}

/**
 * Classify a published teacher cell, collapsing multi-teacher cells to `missing`.
 *
 * Retained for callers that only need "can this anchor one teacher bucket".
 * Prefer {@link parseTeacher}, which keeps the co-teaching information.
 *
 * @param teacher - the raw cell.
 * @returns the teacher validity, where `valid_multiple` counts as `missing`.
 * @deprecated Use `parseTeacher`.
 */
export function classifyTeacher(teacher: string | undefined): TeacherValidity {
  const parsed = parseTeacher(teacher);
  return parsed.validity === 'valid_multiple' ? 'missing' : parsed.validity;
}
/**
 * The teacher cell to send as a provider query filter, or `undefined` to query by course name alone.
 *
 * ## Why a co-taught class must NOT be filtered by teacher
 *
 * The provider's `instructor` parameter is a substring filter on a column that holds ONE teacher per review row. A cell like
 * `翟显、廖冬梅、滕芸、余伟、蔡天富、杨尚尚、葛东升` is a published list, not a person's name, so sending it whole matches
 * nothing and the class loses every review. Sending only the first name would be worse in a different way: it silently
 * treats a seven-person class as one person's class.
 *
 * So a single-teacher cell keeps the filter (it is exact and narrows the corpus), and a multi-teacher cell drops it and
 * relies on the course-name query plus local set-overlap matching, which is able to see all the named teachers.
 *
 * The names come from {@link parseTeacher}, the one place that knows every separator rule, so the query layer and the
 * matching layer cannot disagree about who teaches a class.
 *
 * @param teacher - the published teacher cell, if any.
 * @returns the single teacher name, or `undefined` for a co-taught, missing, or unusable cell.
 */
export function queryTeacherFilter(teacher: string | undefined): string | undefined {
  const parsed = parseTeacher(teacher);
  if (parsed.validity !== 'valid') return undefined;
  return parsed.teacher;
}

/**
 * The names a course's teacher cell refers to, for set-overlap matching.
 *
 * Unlike {@link queryTeacherFilter} this keeps EVERY name, including on a co-taught cell, because matching has to be able to
 * recognise any one of them. `normalizeTeacherName` is applied per name rather than to the whole cell: normalizing the cell
 * first would keep only the first person, which is the defect that made co-taught classes unmatchable.
 *
 * @param teacher - the published teacher cell, if any.
 * @returns distinct normalized names; empty when the cell names nobody.
 */
export function teacherNamesOfCourse(teacher: string | undefined): string[] {
  const out: string[] = [];
  for (const name of parseTeacher(teacher).names) {
    const key = normalizeTeacherName(name);
    if (key.length > 0 && !out.includes(key)) out.push(key);
  }
  return out;
}

/** Outcome of classifying one grade cell. */
export interface GradeClassification {
  scale: GradeScale;
  validity: GradeValidity;
  /** Parsed number, present for `usable` and `ambiguous` rows. */
  value?: number;
}

/**
 * Classify a published grade cell by scale plausibility.
 *
 * @param grade - the raw `课程成绩` cell.
 * @returns the scale, the validity, and the parsed value when there is one.
 */
export function classifyGrade(grade: string | undefined): GradeClassification {
  if (grade === undefined) return { scale: 'unknown', validity: 'invalid' };
  const text = grade.normalize('NFKC').trim();
  if (text.length === 0) return { scale: 'unknown', validity: 'invalid' };
  if (/未知|unknown|不详|无/u.test(text)) return { scale: 'unknown', validity: 'invalid' };
  if (!/^-?\d+(?:\.\d+)?$/u.test(text)) return { scale: 'unknown', validity: 'invalid' };
  const number = Number.parseFloat(text);
  if (!Number.isFinite(number) || number < 0 || number > GRADE_MAX) {
    return { scale: 'unknown', validity: 'invalid' };
  }
  const decimals = text.includes('.');
  // A decimal inside a GPA-sized range is a GPA, not a percentage.
  if (decimals && number <= GRADE_GPA_MAX) return { scale: 'gpa', validity: 'ambiguous', value: number };
  // Too low to be a percentage: a 10-point scale, a GPA, or a placeholder.
  if (!decimals && number < GRADE_PERCENTAGE_FLOOR) {
    return { scale: 'unknown', validity: 'ambiguous', value: number };
  }
  return { scale: 'percentage', validity: 'usable', value: number };
}

/**
 * Bucket a usable percentage grade into its decade for the histogram.
 *
 * @param grade - a usable percentage on the 0..100 scale.
 * @returns the decade lower bound as a string, e.g. `"90"`.
 */
export function gradeDecade(grade: number): string {
  const floor = Math.floor(grade / 10) * 10;
  return String(floor);
}
