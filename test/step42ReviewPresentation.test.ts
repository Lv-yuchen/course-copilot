/**
 * PRE-RELEASE-UX-A17 — the label rules, at the layer that owns them.
 *
 * ## The rule these cases exist to hold
 *
 * `scope` says which BUCKET a comment was filed in, not who wrote it. `teacherSetRelation` treats partial overlap as agreement, so in a class taught
 * by 张三 and 李四 a comment naming only 张三 is `current_class` evidence — and labelling it 「当前教学班评价」 would present one person's words as the
 * class's. Every label therefore comes from the row's OWN `teacherNames`, and the two course-level scopes are worded so that no comment can be promoted
 * into a current-teacher claim by being displayed next to one.
 *
 * ## Why this is a separate file from the card suite
 *
 * The card suite drives the RENDERER, which receives finished `{ text, label }` pairs. These cases drive the MODEL, which is the only place the
 * vocabulary exists at all. Splitting them is what makes "the renderer does not know the scope names" an assertion rather than a hope.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REVIEW_LABEL_TEXT,
  reviewExcerptLabelOf,
  reviewExcerptsOf,
  toRatedCoursePresentation,
  toRecommendedCoursePresentation,
} from '../apps/extension/src/sidepanel/course-presentation.js';
import type { ReviewExcerpt } from '@course-copilot/core/course';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const presentationSource = readFileSync(join(repoRoot, 'apps', 'extension', 'src', 'sidepanel', 'course-presentation.ts'), 'utf8');

/** One transported excerpt. */
const excerpt = (
  text: string,
  scope: ReviewExcerpt['scope'],
  teacherNames: string[] = [],
  teacherValidity: ReviewExcerpt['teacherValidity'] = 'valid',
): ReviewExcerpt => ({ text, scope, teacherNames, teacherValidity });

describe('PRE-RELEASE-UX-A17 label rules', () => {
  it('A. current_class labels the ROW\'s own name, never the class', () => {
    expect(reviewExcerptLabelOf(excerpt('只说张三', 'current_class', ['张三']))).toBe('张三');
  });

  it('B. current_class with a co-taught row names both people', () => {
    expect(reviewExcerptLabelOf(excerpt('两人一起说', 'current_class', ['张三', '李四'], 'valid_multiple'))).toBe('张三、李四');
  });

  it('the current_class label is NEVER the generic class wording', () => {
    /*
     * THE semantic. For a co-taught class, a row naming only 张三 is still this class's evidence — so if the label said 「当前教学班评价」 a reader would
     * read one teacher's opinion as both teachers'. The forbidden wordings are named here so the rule cannot be reintroduced by an edit that looks reasonable.
     */
    for (const label of [
      reviewExcerptLabelOf(excerpt('a', 'current_class', ['张三'])),
      reviewExcerptLabelOf(excerpt('b', 'current_class', ['张三', '李四'], 'valid_multiple')),
    ]) {
      expect(label).not.toBe('当前教学班评价');
      expect(label).not.toContain('当前教学班');
      expect(label).not.toContain('当前教师');
      expect(label).not.toContain(REVIEW_LABEL_TEXT.courseReferencePrefix);
    }
  });

  it('C. course_reference names the teacher it mentioned', () => {
    expect(reviewExcerptLabelOf(excerpt('别的老师', 'course_reference', ['王五']))).toBe('课程整体参考 · 教师：王五');
    expect(REVIEW_LABEL_TEXT.referenceWithTeachers('王五')).toBe('课程整体参考 · 教师：王五');
    // Several names read as a list, using the panel's own separator.
    expect(reviewExcerptLabelOf(excerpt('两位', 'course_reference', ['王五', '赵六']))).toBe('课程整体参考 · 教师：王五、赵六');
  });

  it('D. course_reference with no names says the teacher is unclear', () => {
    expect(reviewExcerptLabelOf(excerpt('没写老师', 'course_reference', []))).toBe('课程整体参考 · 教师信息未明确');
    expect(REVIEW_LABEL_TEXT.referenceWithoutTeachers()).toBe('课程整体参考 · 教师信息未明确');
  });

  it('E. supplementary stays conservative even when its row happened to name somebody', () => {
    /*
     * A supplementary row is one whose teacher cell was MISSING or was PROSE. If such a cell happens to parse into a name, printing it would present a
     * parser failure as a person — so the label is the uncertain one either way.
     */
    expect(reviewExcerptLabelOf(excerpt('没写', 'supplementary', [], 'missing'))).toBe('课程整体参考 · 教师信息未明确');
    expect(reviewExcerptLabelOf(excerpt('教师列是评价', 'supplementary', ['王五'], 'malformed'))).toBe('课程整体参考 · 教师信息未明确');
    // Never promoted to a current-teacher claim, and never promoted to a named course-level one either.
    for (const label of [
      reviewExcerptLabelOf(excerpt('a', 'supplementary', [], 'missing')),
      reviewExcerptLabelOf(excerpt('b', 'supplementary', ['王五'], 'malformed')),
    ]) {
      expect(label).not.toContain('当前');
      expect(label).not.toContain('王五');
      expect(label).toBe(REVIEW_LABEL_TEXT.referenceWithoutTeachers());
    }
  });

  it('blank and whitespace names are not treated as a person', () => {
    // A name that is only whitespace would render as an empty label or a dangling separator; it is treated as absent.
    expect(reviewExcerptLabelOf(excerpt('a', 'current_class', ['   ']))).toBe(REVIEW_LABEL_TEXT.referenceWithoutTeachers());
    expect(reviewExcerptLabelOf(excerpt('b', 'course_reference', ['  ', '']))).toBe(REVIEW_LABEL_TEXT.referenceWithoutTeachers());
    expect(reviewExcerptLabelOf(excerpt('c', 'course_reference', ['  ', '王五']))).toBe(REVIEW_LABEL_TEXT.referenceWithTeachers('王五'));
  });

  it('F. the delivered order is preserved exactly', () => {
    const delivered = [
      excerpt('第一', 'supplementary', [], 'missing'),
      excerpt('第二', 'current_class', ['张三']),
      excerpt('第三', 'course_reference', ['王五']),
    ];
    // Deliberately NOT in scope order, so a sort here would be visible.
    expect(reviewExcerptsOf(delivered).map((entry) => entry.text)).toEqual(['第一', '第二', '第三']);
    expect(reviewExcerptsOf(delivered).map((entry) => entry.label)).toEqual([
      REVIEW_LABEL_TEXT.referenceWithoutTeachers(),
      '张三',
      REVIEW_LABEL_TEXT.referenceWithTeachers('王五'),
    ]);
  });

  it('G. the text is carried through code point for code point', () => {
    const hostile = '<b>事少</b><script>alert(1)</script>';
    const long = `${'字'.repeat(119)}…`;
    for (const text of [hostile, long, '「引号」…！！！', '第一行 第二行']) {
      const [mapped] = reviewExcerptsOf([excerpt(text, 'current_class', ['张三'])]);
      expect(mapped?.text).toBe(text);
      // Length is untouched: the bound belongs to the provider and must not be re-applied.
      expect(Array.from(mapped?.text ?? '')).toHaveLength(Array.from(text).length);
    }
  });

  it('produces exactly two fields, so no provenance leaks to the renderer', () => {
    const [mapped] = reviewExcerptsOf([excerpt('内容', 'course_reference', ['王五'])]);
    expect(Object.keys(mapped ?? {}).sort()).toEqual(['label', 'text']);
    // `scope` and `teacherNames` were consumed to build the label and are not re-published.
    expect(Object.hasOwn(mapped ?? {}, 'scope')).toBe(false);
    expect(Object.hasOwn(mapped ?? {}, 'teacherNames')).toBe(false);
    expect(Object.hasOwn(mapped ?? {}, 'teacherValidity')).toBe(false);
  });

  it('an empty array maps to an empty array, which is what suppresses the module', () => {
    expect(reviewExcerptsOf([])).toEqual([]);
  });
});

describe('PRE-RELEASE-UX-A17 the canonical result reaches the model', () => {
  /** A minimal canonical recommendation; only `reviewExcerpts` is under test here. */
  const recommendation = (excerpts: ReviewExcerpt[]): never => ({
    rank: 1,
    course: { source: 'whu', courseName: '数据结构', normalizedName: '数据结构', availability: 'unknown', teacher: '张三' },
    reviewContext: { scopeText: '评价范围：当前教师', reviewCount: 3 },
    sectionHydration: { status: 'full', available: [], missing: [], rawHydrated: true },
    gradeAggregates: { teacherSet: { names: ['张三'] } },
    reviewSource: { status: 'healthy', queries: 1, rows: 3, empty: 0, unavailable: 0 },
    recommendationStatus: 'recommended',
    score: 8,
    /*
     * A real confidence object rather than `null`: the mapper reads `confidence.value` and `confidence.tier`, and these cases are about excerpts, so the
     * fixture supplies the shape the canonical type declares instead of asking the mapper to tolerate a missing one.
     */
    confidence: { value: 0.7, tier: 'high', components: {}, missing: [] },
    evidenceStrength: [], reasons: [], warnings: [],
    reviewExcerpts: excerpts,
  }) as never;

  it('a recommended entry carries its excerpts into the presentation in order', () => {
    const view = toRecommendedCoursePresentation(recommendation([
      excerpt('本班的话', 'current_class', ['张三']),
      excerpt('别人的话', 'course_reference', ['王五']),
    ]));
    expect(view.reviewExcerpts).toEqual([
      { text: '本班的话', label: '张三' },
      { text: '别人的话', label: REVIEW_LABEL_TEXT.referenceWithTeachers('王五') },
    ]);
  });

  it('a rated entry does the same, through the same helper', () => {
    const view = toRatedCoursePresentation({
      course: { source: 'whu', courseName: '数据结构', normalizedName: '数据结构', availability: 'unknown', teacher: '张三' },
      rank: 6, score: 5.9,
      reviewContext: { scopeText: '评价范围：当前教师', reviewCount: 3 },
      sectionHydration: { status: 'full', available: [], missing: [], rawHydrated: true },
      gradeAggregates: { teacherSet: { names: ['张三'] } },
      reviewExcerpts: [excerpt('没写教师', 'supplementary', [], 'missing')],
    } as never);
    expect(view.reviewExcerpts).toEqual([{ text: '没写教师', label: REVIEW_LABEL_TEXT.referenceWithoutTeachers() }]);
  });

  it('an entry with no excerpts produces an empty array, not undefined', () => {
    expect(toRecommendedCoursePresentation(recommendation([])).reviewExcerpts).toEqual([]);
  });

  it('the insufficient presentation has no excerpt field at all', () => {
    /*
     * A course with no trusted review data was never scored, so there is no evidence to quote. The absence is structural: the type has no field to
     * populate, which is stronger than a mapper that happens to leave it empty.
     */
    const insufficient = presentationSource.slice(
      presentationSource.indexOf('export interface InsufficientCoursePresentation'),
      presentationSource.indexOf('export const COURSE_STATUS_TEXT'),
    );
    expect(insufficient.length).toBeGreaterThan(0);
    expect(insufficient.includes('reviewExcerpts')).toBe(false);
  });
});

describe('PRE-RELEASE-UX-A17 the built artifact', () => {
  /** Undo esbuild's non-ASCII escaping; without this every Chinese assertion below would pass vacuously. */
  const decode = (text: string): string => text.replace(/\\u([0-9a-fA-F]{4})/gu, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));

  const builtPanelRaw = readFileSync(join(repoRoot, 'apps', 'extension', 'dist', 'sidepanel', 'sidepanel.js'), 'utf8');
  const builtPanel = decode(builtPanelRaw);

  it('ships the feature wording, and the decode is proven to work first', () => {
    // The sanity check comes FIRST: a broken decode would make the positive assertions fail loudly rather than the negatives pass silently.
    expect(builtPanel.includes('推荐快照')).toBe(true);
    expect(builtPanel).not.toBe(builtPanelRaw);
    for (const text of ['查看学生评价', '课程整体参考', '教师信息未明确']) {
      expect(builtPanel.includes(text), text).toBe(true);
    }
    /*
     * The scope vocabulary IS in the bundle, and should be: `course-presentation.ts` reads `excerpt.scope` to choose a label, and that file is the only
     * place the decision may live. What must not hold the vocabulary is the RENDERER, which is asserted against its source in the card suite — a bundle
     * contains both modules, so a bundle-level claim could not tell them apart.
     */
    expect(builtPanel.includes('current_class')).toBe(true);
  });

  it('the panel bundle contains no HTML-injection API at all', () => {
    /*
     * Scoped to the PANEL bundle, and that precision matters: the content script legitimately contains one `innerHTML` reference, so a global claim would
     * be false. The claim that is both true and load-bearing is that the surface rendering student prose has no way to inject it.
     */
    for (const forbidden of ['innerHTML', 'insertAdjacentHTML', 'outerHTML', 'document.write']) {
      expect(builtPanel.includes(forbidden), forbidden).toBe(false);
    }
  });

  it('the review text is inserted through textContent in the SOURCE renderer', () => {
    const renderer = readFileSync(join(repoRoot, 'apps', 'extension', 'src', 'sidepanel', 'course-cards.ts'), 'utf8');
    // The review text assignment is a `textContent` write, named on the same line as the excerpt's own text.
    expect(/text\.textContent = excerpt\.text/u.test(renderer)).toBe(true);
    expect(/text\.innerHTML/u.test(renderer)).toBe(false);
    // And the label, likewise.
    expect(/label\.textContent = excerpt\.label/u.test(renderer)).toBe(true);
  });
});
