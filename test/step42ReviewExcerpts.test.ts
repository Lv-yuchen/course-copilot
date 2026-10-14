/**
 * PRE-RELEASE-UX-A16 — bounded review excerpt transport.
 *
 * ## What this file proves
 *
 * A student's comment can now travel from the provider to a recommendation without any layer between them re-deciding WHO the
 * comment is about. The provider partitions the corpus (that decision is already made and already tested), projects each relevant
 * row into a small DTO, and the engine carries that array verbatim.
 *
 * ## Why the partition is not re-tested here
 *
 * `partitionCleanRows` is provider-internal and stays that way. These cases assert the PROJECTION of it — scope, attribution,
 * order, cap, de-duplication, text bound — and the end-to-end section asserts through the REAL `WhuCoursesProvider` with only its
 * transport faked, so the partition under test is the shipped one.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_REVIEW_EXCERPTS,
  MAX_REVIEW_EXCERPT_CHARS,
  REVIEW_EXCERPT_SCOPE_ORDER,
  boundExcerptText,
  capReviewExcerpts,
  dedupeReviewExcerpts,
  projectExcerpt,
  selectReviewExcerpts,
} from '@course-copilot/provider';
import type { CleanReview, ReviewExcerpt } from '@course-copilot/core/course';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const COURSE = '数据结构';
const ZHANG = '张三';
const LI = '李四';
const WANG = '王五';

/**
 * A cleaned row, built directly.
 *
 * The unit cases below are about the PROJECTION, so they construct the input the projection is documented to receive rather than
 * running the text pipeline first. Provider normalization is asserted separately, through the real provider, where it applies.
 */
function row(options: {
  comment?: string | undefined;
  teacherNames?: string[];
  teacherRaw?: string;
  rawGrade?: string;
  validity?: CleanReview['teacherValidity'];
  courseName?: string;
}): CleanReview {
  return {
    courseName: options.courseName ?? COURSE,
    teacherValidity: options.validity ?? 'valid',
    gradeScale: 'percentage',
    gradeValidity: 'usable',
    raw: { provider: 'whucourses', courseName: options.courseName ?? COURSE, raw: {}, teacher: options.teacherRaw ?? '', content: options.comment ?? '' },
    ...(options.teacherNames === undefined ? {} : { teacherNames: options.teacherNames }),
    ...(options.teacherRaw === undefined ? {} : { teacherRaw: options.teacherRaw }),
    ...(options.rawGrade === undefined ? {} : { rawGrade: options.rawGrade }),
    ...(options.comment === undefined ? {} : { commentText: options.comment }),
  };
}

const EMPTY = { matched: [], disjoint: [], unassigned: [] };

describe('PRE-RELEASE-UX-A16 the excerpt DTO carries provenance and nothing else', () => {
  it('exposes exactly text, scope, teacherNames and teacherValidity', () => {
    const excerpt = projectExcerpt(row({ comment: '老师讲得很清楚', teacherNames: [ZHANG], teacherRaw: ZHANG, rawGrade: '90' }), 'current_class');
    expect(excerpt).toBeDefined();
    expect(Object.keys(excerpt ?? {}).sort()).toEqual(['scope', 'teacherNames', 'teacherValidity', 'text']);
    /*
     * And none of the things the DTO exists to keep out of the extension's message boundary. Asserted by name so a later addition has to
     * delete an assertion rather than slip past one.
     */
    for (const forbidden of ['raw', 'rawGrade', 'teacherRaw', 'assessment', 'attendance', 'examMethodText', 'attendanceWorkloadText', 'score', 'grade', 'id', 'studentId']) {
      expect(Object.hasOwn(excerpt ?? {}, forbidden), forbidden).toBe(false);
    }
  });

  it('publishes the row\'s own teacher names, never a synthesised set', () => {
    const excerpt = projectExcerpt(row({ comment: '还行', teacherNames: [ZHANG, LI] }), 'current_class');
    expect(excerpt?.teacherNames).toEqual([ZHANG, LI]);
    // A copy, so a later mutation of the excerpt cannot reach back into the row's array.
    const source = row({ comment: '还行', teacherNames: [ZHANG] });
    const one = projectExcerpt(source, 'current_class');
    one?.teacherNames.push(WANG);
    expect(source.teacherNames).toEqual([ZHANG]);
  });

  it('keeps how usable the teacher cell was', () => {
    for (const validity of ['valid', 'valid_multiple', 'missing', 'malformed'] as const) {
      expect(projectExcerpt(row({ comment: '内容', validity }), 'supplementary')?.teacherValidity).toBe(validity);
    }
  });

  it('produces nothing for a row with no usable comment', () => {
    for (const comment of [undefined, '', '   ', '\n\t ']) {
      expect(projectExcerpt(row({ comment }), 'current_class'), JSON.stringify(comment)).toBeUndefined();
    }
  });

  it('freezes the scope order rather than leaving it implicit', () => {
    expect([...REVIEW_EXCERPT_SCOPE_ORDER]).toEqual(['current_class', 'course_reference', 'supplementary']);
    expect(MAX_REVIEW_EXCERPTS).toBe(3);
    expect(MAX_REVIEW_EXCERPT_CHARS).toBe(120);
  });
});

describe('PRE-RELEASE-UX-A16 source partition decides the scope', () => {
  it('A and B and C. matched, disjoint and unassigned map to the three scopes', () => {
    const excerpts = selectReviewExcerpts({
      matched: [row({ comment: '本班的话', teacherNames: [ZHANG] })],
      disjoint: [row({ comment: '别的老师的话', teacherNames: [WANG] })],
      unassigned: [row({ comment: '教师列没写', validity: 'missing' })],
    });
    expect(excerpts.map((excerpt) => excerpt.scope)).toEqual(['current_class', 'course_reference', 'supplementary']);
    expect(excerpts.map((excerpt) => excerpt.text)).toEqual(['本班的话', '别的老师的话', '教师列没写']);
    // Each still states who its own row named, so a later label cannot borrow the scope's name.
    expect(excerpts[0]?.teacherNames).toEqual([ZHANG]);
    expect(excerpts[1]?.teacherNames).toEqual([WANG]);
    expect(excerpts[2]?.teacherNames).toEqual([]);
    expect(excerpts[2]?.teacherValidity).toBe('missing');
  });

  it('D. a co-taught class keeps a single-teacher row as that person\'s, not the class\'s', () => {
    /*
     * THE semantic this slice exists to protect. `teacherSetRelation` treats partial overlap as agreement, so a row naming only 张三
     * is this class's evidence — but it is 张三 speaking, and labelling it with the class's two names would put his words in 李四's
     * mouth. The scope says "this class"; `teacherNames` says who actually wrote it.
     */
    const [excerpt] = selectReviewExcerpts({ ...EMPTY, matched: [row({ comment: '只说张三', teacherNames: [ZHANG] })] });
    expect(excerpt?.scope).toBe('current_class');
    expect(excerpt?.teacherNames).toEqual([ZHANG]);
    expect(excerpt?.teacherNames).not.toEqual([ZHANG, LI]);
  });

  it('E. a joint row produces ONE excerpt naming both teachers', () => {
    const excerpts = selectReviewExcerpts({ ...EMPTY, matched: [row({ comment: '两人一起说', teacherNames: [ZHANG, LI], validity: 'valid_multiple' })] });
    expect(excerpts).toHaveLength(1);
    expect(excerpts[0]?.teacherNames).toEqual([ZHANG, LI]);
    expect(excerpts[0]?.teacherValidity).toBe('valid_multiple');
  });
});

describe('PRE-RELEASE-UX-A16 order and the course-wide cap', () => {
  it('takes at most three, and only the first three matched', () => {
    const excerpts = selectReviewExcerpts({
      ...EMPTY,
      matched: ['一', '二', '三', '四'].map((comment) => row({ comment, teacherNames: [ZHANG] })),
    });
    expect(excerpts).toHaveLength(3);
    expect(excerpts.map((excerpt) => excerpt.text)).toEqual(['一', '二', '三']);
    expect(excerpts.every((excerpt) => excerpt.scope === 'current_class')).toBe(true);
  });

  it('spends the budget across scopes instead of granting three to each', () => {
    const excerpts = selectReviewExcerpts({
      matched: ['甲', '乙'].map((comment) => row({ comment, teacherNames: [ZHANG] })),
      disjoint: ['丙', '丁'].map((comment) => row({ comment, teacherNames: [WANG] })),
      unassigned: [],
    });
    expect(excerpts.map((excerpt) => [excerpt.scope, excerpt.text])).toEqual([
      ['current_class', '甲'],
      ['current_class', '乙'],
      ['course_reference', '丙'],
    ]);
  });

  it('falls through to the weaker scopes when there is no class evidence', () => {
    const excerpts = selectReviewExcerpts({
      matched: [],
      disjoint: ['甲', '乙'].map((comment) => row({ comment, teacherNames: [WANG] })),
      unassigned: ['丙', '丁'].map((comment) => row({ comment, validity: 'malformed' })),
    });
    expect(excerpts.map((excerpt) => [excerpt.scope, excerpt.text])).toEqual([
      ['course_reference', '甲'],
      ['course_reference', '乙'],
      ['supplementary', '丙'],
    ]);
  });

  it('A. the three-slot order is re-applied when arrays are merged', () => {
    /*
     * A second provider's array is concatenated, not sorted, so without the re-application a provider's `course_reference` entries
     * could outrank another provider's `current_class` ones purely by call order.
     */
    const merged: ReviewExcerpt[] = [
      { text: '别的老师', scope: 'course_reference', teacherNames: [WANG], teacherValidity: 'valid' },
      { text: '本班的话', scope: 'current_class', teacherNames: [ZHANG], teacherValidity: 'valid' },
    ];
    const selected = capReviewExcerpts(merged);
    expect(selected.map((excerpt) => excerpt.text)).toEqual(['本班的话', '别的老师']);
    // And the total stays capped even when every scope is full.
    const flooded: ReviewExcerpt[] = REVIEW_EXCERPT_SCOPE_ORDER.flatMap((scope) =>
      ['1', '2', '3'].map((suffix) => ({ text: `${scope}-${suffix}`, scope, teacherNames: [], teacherValidity: 'valid' as const })));
    expect(capReviewExcerpts(flooded)).toHaveLength(MAX_REVIEW_EXCERPTS);
    // The three survivors are the first three of the strongest scope, not one of each.
    expect(capReviewExcerpts(flooded).map((excerpt) => excerpt.text)).toEqual(['current_class-1', 'current_class-2', 'current_class-3']);
  });

  it('the cap does NOT merge, because merging could free a slot for a fourth review', () => {
    /*
     * Two content-identical excerpts stay two here. If this function de-duplicated on content it would collapse them, and the freed
     * slot would be filled by a LATER review — so the cap would have ADDED a quotation rather than trimmed one. De-duplication
     * belongs where the richer row key still exists, and that is the provider's selection.
     */
    const twins: ReviewExcerpt[] = [
      { text: '还行', scope: 'current_class', teacherNames: [ZHANG], teacherValidity: 'valid' },
      { text: '还行', scope: 'current_class', teacherNames: [ZHANG], teacherValidity: 'valid' },
      { text: '第三', scope: 'current_class', teacherNames: [ZHANG], teacherValidity: 'valid' },
    ];
    expect(capReviewExcerpts(twins)).toHaveLength(3);
    expect(capReviewExcerpts(twins).map((excerpt) => excerpt.text)).toEqual(['还行', '还行', '第三']);
  });

  it('D. no usable comments at all gives an empty array, never a placeholder', () => {
    expect(selectReviewExcerpts(EMPTY)).toEqual([]);
    const silent = selectReviewExcerpts({
      matched: [row({ comment: undefined, teacherNames: [ZHANG] }), row({ comment: '   ', teacherNames: [ZHANG] })],
      disjoint: [row({ comment: '', teacherNames: [WANG] })],
      unassigned: [],
    });
    expect(silent).toEqual([]);
    // Nothing was fabricated to fill the slots.
    expect(silent.some((excerpt) => excerpt.text.length === 0)).toBe(false);
  });
});

describe('PRE-RELEASE-UX-A16 de-duplication', () => {
  it('collapses the same tuple and keeps the first occurrence', () => {
    const twice = { comment: '同一句话', teacherNames: [ZHANG], teacherRaw: ZHANG, rawGrade: '90' };
    const excerpts = selectReviewExcerpts({ ...EMPTY, matched: [row(twice), row(twice)] });
    expect(excerpts).toHaveLength(1);
    expect(excerpts[0]?.text).toBe('同一句话');
  });

  it('collapses a joint row that reached the selection twice', () => {
    // A co-taught row belongs to every named teacher's bucket by design; a merged array must still show it once.
    const duplicated: ReviewExcerpt[] = [
      { text: '两人一起说', scope: 'current_class', teacherNames: [ZHANG, LI], teacherValidity: 'valid_multiple' },
      { text: '两人一起说', scope: 'current_class', teacherNames: [ZHANG, LI], teacherValidity: 'valid_multiple' },
    ];
    expect(dedupeReviewExcerpts(duplicated)).toHaveLength(1);
  });

  it('does not merge on content alone — the row key is what separates two reviews', () => {
    /*
     * THE case that decided this design. Two students writing the same four characters produced two rows whose published DTOs are
     * identical; the ROW key still separates them, because `teacherRaw` and `rawGrade` differ. The content-only helper would merge
     * them, which is why it is not what the selection runs on.
     */
    const excerpts = selectReviewExcerpts({
      ...EMPTY,
      matched: [
        row({ comment: '还行', teacherNames: [ZHANG], teacherRaw: ZHANG, rawGrade: '90' }),
        row({ comment: '还行', teacherNames: [ZHANG], teacherRaw: '张三老师', rawGrade: '90' }),
        row({ comment: '还行', teacherNames: [ZHANG], teacherRaw: ZHANG, rawGrade: '80' }),
      ],
    });
    expect(excerpts).toHaveLength(3);
    expect(excerpts.every((excerpt) => excerpt.text === '还行')).toBe(true);
    // Three rows in, three identical-looking DTOs out — and the selection still treated them as three.
    expect(new Set(excerpts.map((excerpt) => JSON.stringify(excerpt))).size).toBe(1);
  });

  it('does not let a comment-less row reserve a key', () => {
    // The first row has no comment; the second is otherwise identical and DOES have text, so it must still be published.
    const shared = { teacherNames: [ZHANG], teacherRaw: ZHANG, rawGrade: '90' };
    const excerpts = selectReviewExcerpts({ ...EMPTY, matched: [row({ ...shared, comment: undefined }), row({ ...shared, comment: '有内容' })] });
    expect(excerpts.map((excerpt) => excerpt.text)).toEqual(['有内容']);
  });

  it('the de-duplication key is not part of the published DTO', () => {
    const [excerpt] = selectReviewExcerpts({ ...EMPTY, matched: [row({ comment: '内容', teacherNames: [ZHANG], teacherRaw: ZHANG, rawGrade: '90' })] });
    expect(excerpt).toBeDefined();
    // No hash, no fingerprint, no opaque key: only the four documented fields.
    expect(Object.keys(excerpt ?? {}).sort()).toEqual(['scope', 'teacherNames', 'teacherValidity', 'text']);
  });
});

describe('PRE-RELEASE-UX-A16 the text bound', () => {
  it('A and B. text at or under the cap is returned unchanged', () => {
    for (const length of [1, 119, MAX_REVIEW_EXCERPT_CHARS]) {
      const text = '字'.repeat(length);
      expect(boundExcerptText(text), String(length)).toBe(text);
      expect(boundExcerptText(text).length).toBe(length);
    }
  });

  it('C. one code point over the cap keeps 119 and an ellipsis', () => {
    const text = '字'.repeat(121);
    const bounded = boundExcerptText(text);
    expect(bounded).toHaveLength(MAX_REVIEW_EXCERPT_CHARS);
    expect(bounded.endsWith('…')).toBe(true);
    expect(bounded.slice(0, -1)).toBe('字'.repeat(119));
    expect(bounded.slice(0, -1)).toBe(text.slice(0, 119));
  });

  it('D. an astral character is never split', () => {
    /*
     * `slice` on a string counts UTF-16 units, so a naive truncation can cut a surrogate pair in half and render a replacement
     * character. Counted in code points, the result is still `cap` long and every piece is a whole character.
     */
    const emoji = '😀';
    const text = emoji.repeat(200);
    const bounded = boundExcerptText(text);
    expect(Array.from(bounded)).toHaveLength(MAX_REVIEW_EXCERPT_CHARS);
    // Every code point survives a round trip, and the ellipsis is the only non-emoji character.
    const points = Array.from(bounded);
    expect(points.slice(0, -1).every((point) => point === emoji)).toBe(true);
    expect(bounded).not.toContain('\uFFFD');
    expect(JSON.stringify(bounded)).not.toContain('\\ud83d\\ud83d');
  });

  it('E. HTML-like text stays literally what the student typed', () => {
    for (const text of ['<b>事少</b>', '<script>alert(1)</script>', 'a < b && c > d', '<br/>']) {
      const [excerpt] = selectReviewExcerpts({ ...EMPTY, matched: [row({ comment: text, teacherNames: [ZHANG] })] });
      expect(excerpt?.text, text).toBe(text);
    }
    // And the cap applies to it as text, without interpreting anything.
    const long = `<b>${'事'.repeat(200)}</b>`;
    const bounded = boundExcerptText(long);
    expect(bounded.startsWith('<b>事')).toBe(true);
    expect(bounded).toHaveLength(MAX_REVIEW_EXCERPT_CHARS);
  });

  it('F. an already-normalized comment keeps its single-space form', () => {
    // `tidyText` collapsed the newline before this point; the projection must not reintroduce or re-collapse anything.
    const [excerpt] = selectReviewExcerpts({ ...EMPTY, matched: [row({ comment: '第一行 第二行', teacherNames: [ZHANG] })] });
    expect(excerpt?.text).toBe('第一行 第二行');
    expect(excerpt?.text).not.toContain('\n');
  });
});

describe('PRE-RELEASE-UX-A16 the boundary this slice must not cross', () => {
  /**
   * The layers that must never hold teacher-matching code.
   *
   * A renderer that decided which teacher a comment belongs to would be re-answering a question the provider's partition already
   * answered — differently, and in three places. These files are the ones that could plausibly try.
   */
  const PRESENTATION_FILES = [
    ['sidepanel/course-cards.ts', 'apps/extension/src/sidepanel/course-cards.ts'],
    ['sidepanel/course-presentation.ts', 'apps/extension/src/sidepanel/course-presentation.ts'],
    ['sidepanel/sidepanel.ts', 'apps/extension/src/sidepanel/sidepanel.ts'],
  ] as const;

  /**
   * Identifiers that only the partition's owner may name.
   *
   * Matched with a word boundary, because the prose in these files legitimately says "the matched review" — the ordinary English sense — and a bare
   * substring test would have failed on the documentation rather than on code.
   *
   * UPDATED IN PRE-RELEASE-UX-A17. `selectReviewExcerpts` and `commentText` came OFF this list, because the presentation may now READ the excerpts the
   * provider projected — that is the whole point of A16's DTO, and the A17 label builder names `reviewExcerpts` to do it. What must still never appear is
   * the MATCHING machinery: the partition function, the set relation, the cleaned-row type and the validity union. Those are the things a layer could use to
   * answer "whose comment is this?" for itself.
   */
  /**
   * Strip comments, so a rule about CODE cannot be satisfied or broken by prose.
   *
   * Both directions of this file's boundary assertions need this. A "must not appear" test otherwise fails on a doc comment that NAMES the forbidden thing in
   * order to explain why it is forbidden — which is exactly what the label builder's own comment does — and a "must appear" test could otherwise be satisfied
   * by a comment alone.
   */
  const withoutComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1');

  const PARTITION_IDENTIFIERS = ['teacherSetRelation', 'partitionCleanRows', 'CleanReview', 'CleanRowPartition', 'teacherValidity'];

  it('no teacher matching reaches the presentation layer', () => {
    for (const [label, path] of PRESENTATION_FILES) {
      const code = withoutComments(readFileSync(join(repoRoot, path), 'utf8'));
      for (const forbidden of PARTITION_IDENTIFIERS) {
        expect(new RegExp(`\\b${forbidden}\\b`, 'u').test(code), `${label} must not use ${forbidden}`).toBe(false);
      }
      // The partition's three set names as identifiers. `matched` alone is excluded here because it is also an ordinary word.
      for (const forbidden of ['matched:', 'disjoint', 'unassigned']) {
        expect(code.includes(forbidden), `${label} must not reference ${forbidden}`).toBe(false);
      }
      /*
       * And no set intersection over teachers. A label is built from the row's own names; comparing them against the course's teacher string would be the
       * matcher's job done a second time, and these are the shapes such a mistake takes. `teacherNames.filter` is NOT on the list: dropping empty names is not
       * intersection, and it compares nothing against the class.
       */
      for (const forbidden of ['.includes(teacher', 'teacherSetRelation(', '.some((name) =>', '.intersection']) {
        expect(code.includes(forbidden), `${label} must not intersect teacher sets`).toBe(false);
      }
    }
  });

  it('the raw partition row arrays are not exported from the provider', () => {
    /*
     * The provider stays the sole owner of partition semantics. It publishes the PROJECTION — an excerpt array — and never the three
     * row sets, so no caller can build a second interpretation from them.
     */
    const providerIndex = readFileSync(join(repoRoot, 'packages/provider/src/index.ts'), 'utf8');
    expect(providerIndex).not.toContain('partitionCleanRows');
    const excerptModule = readFileSync(join(repoRoot, 'packages/provider/src/review-excerpts.ts'), 'utf8');
    // `partitionCleanRows` is referenced in prose only; the module must not be able to call it, which is what an import would mean.
    expect(/import[^\n]*partitionCleanRows/u.test(excerptModule)).toBe(false);
    expect(/export[^\n]*CleanRowPartition/u.test(excerptModule)).toBe(false);
  });

  it('the excerpt module is provider-internal: no UI file imports it', () => {
    /*
     * The extension's background runtime DOES import the provider, and should — it owns the `WhuCoursesProvider` instance. What no UI file may do is
     * reach for the excerpt MACHINERY, because that would put scoping decisions back in a layer that cannot make them.
     *
     * UPDATED IN PRE-RELEASE-UX-A17. The old form forbade the PRESENTATION from naming `reviewExcerpts` at all, which was right while nothing consumed it
     * and is wrong now: A17's whole purpose is for the presentation to read the DTO and build a label. The boundary is not "never mention the array" — it
     * is "never import the thing that decides what goes in it". So the import ban stays and applies to every UI file, while the field reference is allowed
     * only where the label is built.
     */
    const UI_FILES = [
      ...PRESENTATION_FILES,
      ['background/recommendation-runtime.ts', 'apps/extension/src/background/recommendation-runtime.ts'],
    ] as const;
    for (const [label, path] of UI_FILES) {
      const source = readFileSync(join(repoRoot, path), 'utf8');
      expect(source.includes('review-excerpts'), label).toBe(false);
      /*
       * A TYPE-only import of the provider is fine wherever the type belongs to a contract the file states — the background runtime names `ReviewProvider`
       * because it holds one. What must not happen is importing provider VALUES, which is how a caller would reach the partition, the projection or the
       * limiter. So the ban is on a non-type import.
       */
      const providerImports = [...source.matchAll(/import\s+([^;]*?)\s+from\s+'@course-copilot\/provider'/gu)].map((match) => match[1] ?? '');
      for (const clause of providerImports) {
        expect(clause.trimStart().startsWith('type '), `${label} may only type-import the provider: ${clause.slice(0, 60)}`).toBe(true);
      }
    }
    /*
     * The only file permitted to READ the array is the presentation model, which turns each excerpt into a `{ text, label }` pair. The renderer receives that
     * pair and knows nothing about scopes — so it cannot label a comment by a rule of its own.
     */
    const presentation = readFileSync(join(repoRoot, 'apps/extension/src/sidepanel/course-presentation.ts'), 'utf8');
    expect(presentation).toContain('reviewExcerpts');
    /*
     * The renderer receives `{ text, label }` pairs and must know nothing about the scope vocabulary, so it cannot label a comment by a rule of its own.
     *
     * Checked against CODE, because the renderer's own comments explain the scope rules — which is documentation, not a decision the renderer can make. The
     * forbidden tokens are the three scope NAMES and the raw teacher array: `ReviewExcerpt` as a bare word is deliberately not among them, because the
     * renderer's own function is called `appendReviewExcerpts` and a substring match on the type name would fail on a legitimate identifier.
     */
    const cards = withoutComments(readFileSync(join(repoRoot, 'apps/extension/src/sidepanel/course-cards.ts'), 'utf8'));
    for (const forbidden of ['current_class', 'course_reference', 'supplementary', 'teacherNames', 'ReviewExcerptScope', 'teacherValidity']) {
      expect(cards.includes(forbidden), `the renderer must not know the scope vocabulary: ${forbidden}`).toBe(false);
    }
  });

  it('the DTO has no place to hide a raw payload or an identifier', () => {
    /*
     * A structural check rather than a sample: every key the contract declares is listed, so adding a leaking field means editing this
     * list rather than passing unnoticed.
     */
    const placeholder = projectExcerpt(row({ comment: '内容', teacherNames: [ZHANG] }), 'current_class');
    expect(placeholder).toBeDefined();
    expect(Object.keys(placeholder ?? {}).sort()).toEqual(['scope', 'teacherNames', 'teacherValidity', 'text']);
  });

  it('every excerpt the provider publishes obeys the two bounds', () => {
    // Asserted over the SHIPPED functions rather than a fixture, so a cap change cannot slip past a hand-built sample.
    const excerpts = selectReviewExcerpts({
      matched: Array.from({ length: 5 }, (_, index) => row({ comment: `第${index}条${'长'.repeat(300)}`, teacherNames: [ZHANG] })),
      disjoint: [row({ comment: '别的老师', teacherNames: [WANG] })],
      unassigned: [],
    });
    expect(excerpts.length).toBeLessThanOrEqual(MAX_REVIEW_EXCERPTS);
    for (const excerpt of excerpts) {
      expect(Array.from(excerpt.text).length).toBeLessThanOrEqual(MAX_REVIEW_EXCERPT_CHARS);
    }
  });
});
