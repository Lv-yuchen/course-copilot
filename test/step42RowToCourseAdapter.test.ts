/**
 * PART 16J-D — the extension-local `RowIdentity` → `NormalizedCourse` adapter.
 *
 * ## What this file pins
 *
 * The adapter is a field mapping and nothing more, and every boundary of that "nothing more" is asserted here: it derives
 * availability with the CORE's helper rather than restating the rule, it keeps a co-taught teacher cell as one string, it writes
 * no field the row did not supply, it converts no seat count into a competition fact, and it does not dedupe sections.
 *
 * ## Why the shapes are asserted exactly
 *
 * `toEqual` on the whole object, not on individual fields. A mapping that quietly added `sourceCourseId` or defaulted
 * `remainingSeats` to `0` would satisfy per-field assertions while changing what the engine sees, and "the row did not say that"
 * is exactly what the engine relies on.
 *
 * Chinese literals are written as escapes so this file survives any tooling that is careless with UTF-8.
 */
/// <reference path="../apps/extension/src/types/chrome.d.ts" />

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { rowIdentitiesToCourses, rowIdentityToCourse } from '../apps/extension/src/background/row-to-course.js';
import { normalizeCourseName, normalizeTeacherName } from '@course-copilot/core/normalize';
import { availabilityFromSeats } from '@course-copilot/core/eligibility';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const adapterPath = join(repoRoot, 'apps', 'extension', 'src', 'background', 'row-to-course.ts');
const adapterSource = readFileSync(adapterPath, 'utf8');
const adapterCode = adapterSource.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1');

/** A course name with CJK text and punctuation, so normalization is actually exercised. */
const NAME = '\u5de5\u4e1a\u9769\u547d\u4e0e\u4eba\u7c7b\u53d1\u5c55';
const TEACHER_A = '\u5468\u5955\u534e';
const TEACHER_B = '\u5218\u5174\u6d77';

describe('16J-D A the minimal row produces exactly the required shape', () => {
  it('sets the four required fields and nothing else', () => {
    const course = rowIdentityToCourse({ courseName: NAME });

    expect(course).toEqual({
      source: 'whu',
      courseName: NAME,
      normalizedName: normalizeCourseName(NAME),
      availability: 'unknown',
    });
    // Exactly four keys: no optional field was invented, and `remainingSeats` was not defaulted to 0.
    expect(Object.keys(course ?? {}).sort()).toEqual(['availability', 'courseName', 'normalizedName', 'source']);
    // In particular, an unstated seat count stays ABSENT — never 0, which would read as "full".
    expect(Object.hasOwn(course ?? {}, 'remainingSeats')).toBe(false);
  });
});

describe('16J-D B a complete row passes every field through by rule', () => {
  it('carries code, teacher, credits and seats as stated', () => {
    const course = rowIdentityToCourse({
      courseCode: '2321950011001',
      courseName: NAME,
      credits: 2,
      remainingSeats: 27,
      teacher: TEACHER_A,
    });

    expect(course).toEqual({
      source: 'whu',
      courseCode: '2321950011001',
      courseName: NAME,
      normalizedName: normalizeCourseName(NAME),
      teacher: TEACHER_A,
      normalizedTeacher: normalizeTeacherName(TEACHER_A),
      credits: 2,
      remainingSeats: 27,
      availability: 'available',
    });
  });

  it('does not copy courseCode into sourceCourseId', () => {
    // `sourceCourseId` means "an id the page exposes for the ROW"; this page exposes none, so the field must stay absent.
    const course = rowIdentityToCourse({ courseCode: 'CODE-1', courseName: NAME });
    expect(Object.hasOwn(course ?? {}, 'sourceCourseId')).toBe(false);
  });

  it('writes the trimmed code, and omits an all-whitespace one', () => {
    // The hidden-input fallback is raw DOM text, so this is the one field the scanner does not guarantee hygienic.
    expect(rowIdentityToCourse({ courseCode: '  C-1  ', courseName: NAME })?.courseCode).toBe('C-1');
    const blank = rowIdentityToCourse({ courseCode: '   ', courseName: NAME });
    expect(Object.hasOwn(blank ?? {}, 'courseCode')).toBe(false);
  });
});

describe('16J-D C a co-taught cell stays ONE teacher string', () => {
  const CO_TAUGHT = `${TEACHER_A}\u3001${TEACHER_B}`;

  it('preserves the published string verbatim', () => {
    const course = rowIdentityToCourse({ courseName: NAME, teacher: CO_TAUGHT });
    expect(course?.teacher).toBe(CO_TAUGHT);
    // The separator survives: no rewrite, no re-join, no first-teacher truncation.
    expect(course?.teacher?.includes('\u3001')).toBe(true);
    expect(course?.teacher).not.toBe(TEACHER_A);
    expect(course?.normalizedTeacher).toBe(normalizeTeacherName(CO_TAUGHT));
  });

  it('produces no teacherNames field', () => {
    // Splitting is `teacherNamesOfCourse`'s job; a list here would be a second split rule.
    const course = rowIdentityToCourse({ courseName: NAME, teacher: CO_TAUGHT });
    expect(Object.hasOwn(course ?? {}, 'teacherNames')).toBe(false);
    expect(adapterCode.includes('teacherNames')).toBe(false);
  });

  it('leaves the fields absent when the page published no teacher', () => {
    const course = rowIdentityToCourse({ courseName: NAME });
    expect(Object.hasOwn(course ?? {}, 'teacher')).toBe(false);
    expect(Object.hasOwn(course ?? {}, 'normalizedTeacher')).toBe(false);
  });
});

describe('16J-D D availability is derived by the CORE helper, per seat count', () => {
  it('maps 0 to full, a positive count to available, and a missing count to unknown', () => {
    expect(rowIdentityToCourse({ courseName: NAME, remainingSeats: 0 })?.availability).toBe('full');
    expect(rowIdentityToCourse({ courseName: NAME, remainingSeats: 1 })?.availability).toBe('available');
    expect(rowIdentityToCourse({ courseName: NAME, remainingSeats: 27 })?.availability).toBe('available');
    expect(rowIdentityToCourse({ courseName: NAME })?.availability).toBe('unknown');
  });

  it('E: a zero count is kept as zero, not turned into "absent"', () => {
    const course = rowIdentityToCourse({ courseName: NAME, remainingSeats: 0 });
    // 0 is a real answer meaning "no seats left"; dropping it would lose the distinction.
    expect(course?.remainingSeats).toBe(0);
    expect(Object.hasOwn(course ?? {}, 'remainingSeats')).toBe(true);
  });

  it('agrees with the canonical helper on every case, including the ones it does not cover', () => {
    // The adapter must not restate the rule, so its answer must track the core's exactly.
    for (const seats of [undefined, 0, 1, 5, 27]) {
      expect(rowIdentityToCourse({ courseName: NAME, ...(seats === undefined ? {} : { remainingSeats: seats }) })?.availability)
        .toBe(availabilityFromSeats(seats));
    }
  });

  it('calls the canonical helper rather than reimplementing it', () => {
    expect(adapterCode.includes('availabilityFromSeats(')).toBe(true);
    // No hand-rolled seat comparison may exist: that would be a second rule for the same question.
    expect(/remainingSeats\s*[<>]=?\s*0/u.test(adapterCode)).toBe(false);
    expect(/===\s*0\s*\?\s*'full'/u.test(adapterCode)).toBe(false);
  });
});

describe('16J-D F a row that names no course produces nothing', () => {
  it('returns undefined for an empty or whitespace-only name', () => {
    expect(rowIdentityToCourse({ courseName: '' })).toBeUndefined();
    expect(rowIdentityToCourse({ courseName: '   ' })).toBeUndefined();
    expect(rowIdentityToCourse({ courseName: '\u3000\u3000' })).toBeUndefined();
  });

  it('trims a name that arrived padded', () => {
    expect(rowIdentityToCourse({ courseName: `  ${NAME}  ` })?.courseName).toBe(NAME);
  });

  it('skips only the unusable row, not the whole page', () => {
    const courses = rowIdentitiesToCourses([{ courseName: '' }, { courseName: NAME }]);
    expect(courses).toHaveLength(1);
    expect(courses[0]?.courseName).toBe(NAME);
  });
});

describe('16J-D G one row is one section candidate', () => {
  it('two classes of one course produce two candidates', () => {
    const courses = rowIdentitiesToCourses([
      { courseName: NAME, teacher: TEACHER_A, remainingSeats: 5 },
      { courseName: NAME, teacher: TEACHER_B, remainingSeats: 0 },
    ]);
    expect(courses).toHaveLength(2);
    expect(courses.map((c) => c.teacher)).toEqual([TEACHER_A, TEACHER_B]);
    // The per-class availability survives: one class available, the other full.
    expect(courses.map((c) => c.availability)).toEqual(['available', 'full']);
  });

  it('does not dedupe even byte-identical rows', () => {
    const row = { courseName: NAME, teacher: TEACHER_A };
    const courses = rowIdentitiesToCourses([row, row, row]);
    expect(courses).toHaveLength(3);
  });

  it('preserves input order and maps nothing else', () => {
    const courses = rowIdentitiesToCourses([
      { courseName: 'B' },
      { courseName: 'A' },
      { courseName: 'C' },
    ]);
    expect(courses.map((c) => c.courseName)).toEqual(['B', 'A', 'C']);
    // No sort: three keys, in the order given.
    expect(Object.keys(courses[0] ?? {}).sort()).toEqual(['availability', 'courseName', 'normalizedName', 'source']);
  });

  it('an empty page yields an empty list', () => {
    expect(rowIdentitiesToCourses([])).toEqual([]);
  });
});

describe('16J-D the adapter stays inside its boundary', () => {
  it('imports only the canonical core subpaths it needs', () => {
    const specifiers = [...adapterCode.matchAll(/from\s*['"]([^'"]+)['"]/gu)].map((m) => m[1] ?? '').sort();
    expect(specifiers).toEqual([
      '@course-copilot/core/course',
      '@course-copilot/core/eligibility',
      '@course-copilot/core/normalize',
    ]);
  });

  it('reaches no root src path and no other workspace package', () => {
    for (const forbidden of ['src/', '../', '../../', '@course-copilot/provider', '@course-copilot/recommendation', 'adapters/table', 'dom/html']) {
      expect(adapterCode.includes(forbidden), forbidden).toBe(false);
    }
  });

  it('creates no competition fact and names no presentation concept', () => {
    /*
     * `roundQuota` in the presentation layer is documented as a rename of `remainingSeats`, so deriving one from the other would
     * give a single value two identities. The adapter states each seat fact as given and stops.
     *
     * UPDATED IN PRE-RELEASE-UX-A5: `selectedThisRound` came OFF this list, because the adapter now carries it as a second raw seat
     * FACT. The boundary the list protects is unchanged — no interpretation — so the check below replaces it with a sharper one:
     * the seat assignments must stay plain assignments, with no derived quantity and no comparison between the two counts.
     */
    for (const forbidden of ['roundQuota', 'competition', 'Competition', 'page_native', 'presentation', 'risk']) {
      expect(adapterCode.includes(forbidden), forbidden).toBe(false);
    }
    /*
     * Read the LINES that touch a seat fact and require them to be plain assignments. A ratio, a percentage, a sum, or a comparison
     * between 余量 and 本轮已选 would be exactly the competition interpretation this boundary keeps out of the adapter.
     *
     * The comment portion is stripped FIRST. That is not tidiness: this file's own prose names the forbidden concepts while
     * forbidding them, and a version of this check that scanned the raw line failed on its own explanatory text.
     */
    const seatLines = adapterCode
      .split('\n')
      .map((line) => line.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, ''))
      .filter((line) => line.includes('remainingSeats') || line.includes('selectedThisRound'));
    expect(seatLines.length).toBeGreaterThan(0);
    for (const line of seatLines) {
      // Spaced operators only: `course.x = row.x` is the expected shape, and ` > ` / ` < ` catch a comparison without tripping on `=`.
      for (const derived of ['/', '*', '+', 'ratio', 'percent', 'Math.', ' > ', ' < ']) {
        expect(line.includes(derived), `${derived} in: ${line.trim()}`).toBe(false);
      }
    }
  });

  it('does no ranking, filtering or review work', () => {
    const forbiddenWords = ['rank', 'score', 'confidence', 'searchCourse', 'fetch(', 'filterEligible', 'matchCourse'];
    const present = forbiddenWords.filter((word) => adapterCode.includes(word));
    expect(present).toEqual([]);
    /*
     * Credits are stored and never judged. The patterns are COMPARISONS only — `<` and `>` — because the assignment
     * `course.credits = row.credits` legitimately contains `=`, and an earlier version's `[<>!=]` class matched it and failed.
     */
    expect(/credits\s*[<>]/u.test(adapterCode), 'credits compared').toBe(false);
    expect(/credits\s*[<>]=/u.test(adapterCode), 'credits compared with >=').toBe(false);
  });
});
