/**
 * PART 16J-PREUI-E4-C2-B3-B2 — the three course-card kinds, rendered from the frozen presentation model.
 *
 * ## What this proves
 *
 * The renderer decides nothing: every semantic choice was frozen in `course-presentation.ts`, and these tests are about what reaches the DOM. So they concentrate
 * on the ways a card can lie — a page teacher string split into its first name, a full course turned into "unknown", a zero-credit course, an invented confidence
 * for a rated entry, an invented score for a course that was never scored, and a previous answer's cards left on screen during a new run.
 *
 * The DOM is a minimal stub, so the tests drive the real renderer with real presentations.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CARD_TEXT, renderCourseCards, setRatedCollapsed } from '../apps/extension/src/sidepanel/course-cards.js';
import { REVIEW_LABEL_TEXT, toRatedCoursePresentation } from '../apps/extension/src/sidepanel/course-presentation.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rendererSource = readFileSync(join(repoRoot, 'apps', 'extension', 'src', 'sidepanel', 'course-cards.ts'), 'utf8');
const rendererCode = rendererSource.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1');
const sidepanelHtml = readFileSync(join(repoRoot, 'apps', 'extension', 'src', 'sidepanel', 'sidepanel.html'), 'utf8');
const sidepanelSource = readFileSync(join(repoRoot, 'apps', 'extension', 'src', 'sidepanel', 'sidepanel.ts'), 'utf8');

// ---------------------------------------------------------------------------- a minimal DOM, enough for the renderer

class StubNode {
  readonly children: StubNode[] = [];
  readonly attributes: Record<string, string> = {};
  /** Listeners registered on this node, so a test can click it the way a reader would. */
  readonly listeners: Record<string, Array<() => void>> = {};
  textContent = '';
  className = '';
  id = '';
  hidden = false;

  append(...nodes: StubNode[]): void { this.children.push(...nodes); }

  replaceChildren(...nodes: StubNode[]): void { this.children.length = 0; this.children.push(...nodes); }

  setAttribute(name: string, value: string): void { this.attributes[name] = value; }

  /** Read back what `setAttribute` wrote, which is how the disclosure's announced state is asserted. */
  getAttribute(name: string): string | null { return this.attributes[name] ?? null; }

  /**
   * Register a listener.
   *
   * Added in PRE-RELEASE-UX-A17: a course card now owns one interactive control — the student-review disclosure — so a test has to be able to activate it
   * rather than only inspect it. Nothing here emulates event propagation: `click()` invokes exactly this node's own handlers, which is what makes the nested
   * rated-section/ review-module assertions meaningful.
   */
  addEventListener(type: string, handler: () => void): void {
    (this.listeners[type] ??= []).push(handler);
  }

  /** Activate this node, as a real click would. */
  click(): void {
    for (const handler of this.listeners.click ?? []) handler();
  }

  /** The node's own class list check, since className is a plain string here. */
  hasClass(name: string): boolean {
    return this.className.split(/\s+/u).includes(name);
  }

  /** Whether the cards container is currently visible as the DOM would render it. */
  get isRendered(): boolean { return !this.hidden; }

  /** Every descendant, depth first, so a test can assert on the whole subtree. */
  all(): StubNode[] {
    const out: StubNode[] = [];
    for (const child of this.children) { out.push(child, ...child.all()); }
    return out;
  }

  /** All text in the subtree, concatenated the way adjacent inline elements read. */
  text(): string {
    return this.textContent + this.children.map((child) => child.text()).join('');
  }

  /** This node's direct children, for a test that must not descend into nested cards. */
  ownChildren(): StubNode[] {
    return this.children;
  }

  /** The rows this node owns directly, by class. */
  ownRows(className: string): StubNode[] {
    return this.children.filter((child) => child.className === className);
  }
}

/** Install the stub `document` for the duration of one render. */
function withDom(run: () => void): void {
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = globals.document;
  globals.document = { createElement: () => new StubNode() };
  try {
    run();
  } finally {
    globals.document = previous;
  }
}

/** The review disclosure inside one card, or `undefined` when the card has none. */
function reviewModuleOf(card: StubNode): { toggle: StubNode; list: StubNode; items: StubNode[] } | undefined {
  const module = card.all().find((node) => node.hasClass('course-card-reviews'));
  if (module === undefined) return undefined;
  const toggle = module.all().find((node) => node.hasClass('course-card-reviews-toggle'));
  const list = module.all().find((node) => node.hasClass('course-card-reviews-list'));
  if (toggle === undefined || list === undefined) return undefined;
  return { toggle, list, items: list.children.filter((child) => child.hasClass('course-card-review')) };
}

describe('PRE-RELEASE-UX-A20 the document: no leaked developer text, one disclaimer above the cards', () => {
  /*
   * ## Why the document itself is the subject
   *
   * Both defects this block guards were invisible to every renderer test, because neither is about a renderer: one was malformed COMMENT SYNTAX that the
   * browser treated as body text, and the other is the POSITION of an element inside the document. The sidepanel document is therefore asserted directly,
   * in both its source and its built form.
   */
  const builtHtml = readFileSync(join(repoRoot, 'apps', 'extension', 'dist', 'sidepanel', 'sidepanel.html'), 'utf8');
  /** The one grade label, so the case below cannot drift from the renderer's own wording. */
  const AVG = CARD_TEXT.grade.label;

  /**
   * The line numbers of `-->` markers that a parser would treat as TEXT.
   *
   * A closing marker renders only when no `<!--` precedes it unclosed, so this walks the file exactly as a parser does rather than counting markers — a
   * count would pass on a file with two errors that cancel out.
   */
  function orphanedCommentClosers(html: string): number[] {
    const orphans: number[] = [];
    let cursor = 0;
    let open = 0;
    while (cursor < html.length) {
      const nextOpen = html.indexOf('<!--', cursor);
      const nextClose = html.indexOf('-->', cursor);
      if (nextOpen < 0 && nextClose < 0) break;
      if (nextOpen >= 0 && (nextClose < 0 || nextOpen < nextClose)) {
        open += 1;
        cursor = nextOpen + 4;
        continue;
      }
      open -= 1;
      if (open < 0) {
        orphans.push(html.slice(0, nextClose).split(/\r?\n/u).length);
        open = 0;
      }
      cursor = nextClose + 3;
    }
    return orphans;
  }

  it('1 and 2. the developer explanation is INSIDE a comment, and no "-->" renders as text', () => {
    /*
     * THE defect. A `<!--` opening tag was lost while this document was restructured, which left the closing tag on its own; the browser then rendered the
     * block's prose as a paragraph and ended it with a visible `-->`. It reproduced in the shipped panel, which is where a reader saw it.
     */
    for (const [label, html] of [['source', sidepanelHtml], ['built', builtHtml]] as const) {
      expect(orphanedCommentClosers(html), label).toEqual([]);
      // And the markers balance, so an orphan cannot be cancelled out by a second error.
      expect((html.match(/<!--/gu) ?? []).length, label).toBe((html.match(/-->/gu) ?? []).length);
    }
    // The paragraph exists as prose but only as COMMENT prose, in both forms.
    for (const [label, html] of [['source', sidepanelHtml], ['built', builtHtml]] as const) {
      const at = html.indexOf('It is titled');
      expect(at, label).toBeGreaterThan(-1);
      expect(html.lastIndexOf('<!--', at), label).toBeGreaterThan(html.lastIndexOf('-->', at));
    }
  });

  it('3. the user-facing 推荐快照 heading is still rendered, so the fix did not remove the feature', () => {
    // The comment above it explains WHY it is called that; the element itself must survive.
    for (const [label, html] of [['source', sidepanelHtml], ['built', builtHtml]] as const) {
      expect(html.includes('<h2 class="panel-recommendation-title">推荐快照</h2>'), label).toBe(true);
    }
  });

  it('4 and 5 and 6. one disclaimer, above the counts and above every card list', () => {
    const ids = ['card-list-recommended', 'card-list-rated', 'card-list-insufficient'];
    for (const [label, html] of [['source', sidepanelHtml], ['built', builtHtml]] as const) {
      // Exactly ONE element and ONE closing tag: the sentence is written once by the renderer.
      expect((html.match(/id="grade-disclaimer"/gu) ?? []).length, label).toBe(1);
      const disclaimer = html.indexOf('id="grade-disclaimer"');
      // Before the counts, so it qualifies every figure in the result area rather than trailing it.
      expect(disclaimer, label).toBeLessThan(html.indexOf('id="recommendation-counts"'));
      // Before each card list and before each of the three sections that hold them.
      for (const id of [...ids, 'cards-recommended', 'cards-rated', 'cards-insufficient']) {
        expect(disclaimer, `${label} vs ${id}`).toBeLessThan(html.indexOf(`id="${id}"`));
      }
      // After the result area's own heading, so it is inside that area and not above it.
      expect(disclaimer, label).toBeGreaterThan(html.indexOf('panel-recommendation-title'));
      // And NOT inside any card list: a position inside an `<ol>` would put it back among the cards.
      for (const id of ids) {
        const start = html.indexOf(`id="${id}"`);
        expect(disclaimer > start && disclaimer < html.indexOf('</ol>', start), `${label} inside ${id}`).toBe(false);
      }
    }
  });

  it('the disclaimer sentence is still the renderer\'s to write, not the document\'s', () => {
    // Position is markup; wording and visibility belong to the renderer, and this block must not have changed that.
    expect(sidepanelHtml.includes('学生评价中的自报成绩统计')).toBe(false);
    expect(builtHtml.includes('学生评价中的自报成绩统计')).toBe(false);
    expect(rendererCode.includes('GRADE_DISCLAIMER')).toBe(true);
  });

  it('7. the card grade UI is untouched by the move', () => {
    // The compact line and its three scopes are exactly as A12 left them, and the verbose block is still absent.
    const view = render(result({ recommendations: [recommendation({
      gradeAggregates: { teacherSet: { names: ['周奕华'] }, teacher: grade(97.3333, 30) },
    })] }));
    const text = view.recommended.children[0]?.text() ?? '';
    expect(text).toContain(`${AVG}：97.3（30份，${CARD_TEXT.grade.scope.teacher}）`);
    for (const gone of ['当前教师自报成绩', '当前教学班自报成绩', '课程整体自报成绩参考', '有效样本']) {
      expect(text.includes(gone), gone).toBe(false);
    }
  });
});

/** Whether the recommended section in a targets object is hidden. */
function recommendedSectionHidden(sections: { readonly recommended: StubNode }): boolean {
  return sections.recommended.hidden;
}

/** The three lists and sections, and a render of the given result. */
function render(result: unknown): {
  recommended: StubNode; rated: StubNode; insufficient: StubNode;
  recommendedSection: StubNode; ratedSection: StubNode; insufficientSection: StubNode;
  /** The ONE shared grade disclaimer the renderer now owns, text and visibility alike. */
  disclaimer: StubNode;
  /** The rated section's collapse control, so a test can click it and read its announced state. */
  ratedToggle: StubNode;
  /** Where the exact rated count is written. */
  ratedCount: StubNode;
  /** The container hidden while the rated section is collapsed. */
  ratedCards: StubNode;
} {
  const recommended = new StubNode();
  const rated = new StubNode();
  const insufficient = new StubNode();
  const recommendedSection = new StubNode();
  const ratedSection = new StubNode();
  const insufficientSection = new StubNode();
  const disclaimer = new StubNode();
  const ratedToggle = new StubNode();
  const ratedCount = new StubNode();
  const ratedCards = new StubNode();
  withDom(() => {
    renderCourseCards(
      {
        recommended: recommended as unknown as HTMLElement,
        rated: rated as unknown as HTMLElement,
        insufficient: insufficient as unknown as HTMLElement,
        sections: {
          recommended: recommendedSection as unknown as HTMLElement,
          rated: ratedSection as unknown as HTMLElement,
          insufficient: insufficientSection as unknown as HTMLElement,
        },
        disclaimer: disclaimer as unknown as HTMLElement,
        disclosure: {
          toggle: ratedToggle as unknown as HTMLElement,
          count: ratedCount as unknown as HTMLElement,
          panel: ratedCards as unknown as HTMLElement,
        },
      },
      result as never,
    );
  });
  return { recommended, rated, insufficient, recommendedSection, ratedSection, insufficientSection, disclaimer, ratedToggle, ratedCount, ratedCards };
}

// ---------------------------------------------------------------------------- canonical fixtures

/** A canonical course. */
function course(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: 'whu',
    courseName: '(2024-2025-1)-MATH101-01 高等数学',
    normalizedName: '高等数学',
    teacher: '周奕华',
    credits: 2,
    remainingSeats: 12,
    availability: 'available',
    ...overrides,
  };
}

/** A canonical review context. */
function reviewContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { scope: 'teacher', reviewCount: 17, teacherSpecified: true, teacher: '周奕华', teacherMatchConfidence: 0.9, aggregationNote: 'n', ...overrides };
}

/** A canonical grade aggregate. */
function grade(meanGrade: number | undefined, gradedSampleCount: number): Record<string, unknown> {
  return { meanGrade, medianGrade: meanGrade, gradedSampleCount, gradeDistribution: {} };
}

/** A canonical recommendation. */
function recommendation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    rank: 1,
    course: course(),
    reviewContext: reviewContext(),
    sectionHydration: { status: 'full', available: [], missing: [], rawHydrated: true },
    gradeAggregates: { teacherSet: { names: ['周奕华'] }, teacher: grade(88.5, 12), course: grade(85.1, 254) },
    reviewSource: { status: 'healthy', queries: 1, rows: 4, empty: 0, unavailable: 0 },
    reviewExcerpts: [],
    recommendationStatus: 'recommended',
    score: 8.42,
    confidence: { value: 0.71, tier: 'high', components: {}, missing: [] },
    reasons: [],
    warnings: [],
    match: { method: 'name_teacher', confidence: 0.95, trusted: true },
    aspects: { aspects: [], decisionScore: 8.42, appliedWeights: {}, missingDimensions: [], notes: [] },
    missingDimensions: [],
    topAspects: [],
    components: [],
    appliedWeights: {},
    redistributed: [],
    riskAdjustedScore: 7.6,
    effectiveWeights: {},
    defaultWeights: {},
    effectiveWeightNotes: [],
    evidenceStrength: [],
    ...overrides,
  };
}

/**
 * A canonical rated-but-not-recommended entry.
 *
 * PRE-RELEASE-UX-A11 gave this entry `gradeAggregates`, so every fixture that builds one must carry it — the mapper now reads `gradeAggregates.teacherSet` and
 * would fail on a missing object rather than quietly rendering nothing. One helper keeps the fixtures honest and makes the shape explicit.
 */
function ratedEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    course: course(),
    rank: 2,
    score: 6.1,
    reviewContext: reviewContext(),
    sectionHydration: { status: 'full', available: [], missing: [], rawHydrated: true },
    gradeAggregates: { teacherSet: { names: ['周奕华'] }, teacher: grade(88.5, 12), course: grade(85.1, 254) },
    reviewExcerpts: [],
    ...overrides,
  };
}

/** A canonical result with the given entries. */
function result(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { recommendations: [], ratedButNotRecommended: [], insufficientData: [], ...overrides };
}

describe('16J-PREUI-E4-C2-B3-B2 A to C. three sections, exact counts, canonical order', () => {
  it('A. the three sections are separate, and each hides when its array is empty', () => {
    const empty = render(result());
    expect(empty.recommendedSection.hidden).toBe(true);
    expect(empty.ratedSection.hidden).toBe(true);
    expect(empty.insufficientSection.hidden).toBe(true);

    const mixed = render(result({
      recommendations: [recommendation()],
      ratedButNotRecommended: [ratedEntry()],
      insufficientData: [{ course: course(), reason: '未找到可信评价匹配', match: { method: 'unmatched', confidence: 0 }, reviewSource: { status: 'healthy', queries: 1, rows: 0, empty: 1, unavailable: 0 } }],
    }));
    expect(mixed.recommendedSection.hidden).toBe(false);
    expect(mixed.ratedSection.hidden).toBe(false);
    expect(mixed.insufficientSection.hidden).toBe(false);
    // Three lists, not one list with three badges.
    expect(mixed.recommended.children).toHaveLength(1);
    expect(mixed.rated.children).toHaveLength(1);
    expect(mixed.insufficient.children).toHaveLength(1);
  });

  it('B. card counts equal the array lengths exactly', () => {
    /*
     * A mapper that failed on one entry must not silently drop its card: the count is the contract, and a missing card would be invisible.
     */
    const counts = { recommended: 4, rated: 3, insufficient: 2 };
    const view = render(result({
      recommendations: Array.from({ length: counts.recommended }, (_, index) => recommendation({ rank: index + 1 })),
      ratedButNotRecommended: Array.from({ length: counts.rated }, (_, index) => ratedEntry({ rank: index + 9, score: 5.5 })),
      insufficientData: Array.from({ length: counts.insufficient }, () => ({ course: course(), reason: 'r', match: { method: 'unmatched', confidence: 0 }, reviewSource: { status: 'healthy', queries: 1, rows: 0, empty: 1, unavailable: 0 } })),
    }));
    expect(view.recommended.children).toHaveLength(counts.recommended);
    expect(view.rated.children).toHaveLength(counts.rated);
    expect(view.insufficient.children).toHaveLength(counts.insufficient);
  });

  it('C. canonical array order is preserved and nothing is sorted', () => {
    // Deliberately given in descending score so a sort by score would visibly reorder them.
    const view = render(result({
      ratedButNotRecommended: [
        ratedEntry({ course: course({ courseName: '甲' }), rank: 2, score: 6.1 }),
        ratedEntry({ course: course({ courseName: '乙' }), rank: 3, score: 6.0 }),
        ratedEntry({ course: course({ courseName: '丙' }), rank: 4, score: 5.9 }),
      ],
    }));
    const names = view.rated.children.map((card) => card.all().find((node) => node.className === 'course-card-title')?.textContent);
    expect(names).toEqual(['甲', '乙', '丙']);
    // And the renderer has no sort at all.
    expect(/\.sort\s*\(/u.test(rendererCode)).toBe(false);
  });
});

describe('16J-PREUI-E4-C2-B3-B2 D to F. the teacher string reaches the DOM verbatim', () => {
  it('D. a multi-teacher page string appears complete in the card', () => {
    const view = render(result({ recommendations: [recommendation({ course: course({ teacher: '周奕华、刘兴海' }) })] }));
    const text = view.recommended.children[0]?.text() ?? '';
    expect(text).toContain('任课老师：');
    expect(text).toContain('周奕华、刘兴海');
  });

  it('E. no first-teacher-only rendering exists anywhere in the renderer', () => {
    /*
     * The split that would produce "周奕华" alone is the single most likely way to destroy verifiable page text, so its absence is asserted on the code as well as
     * on the output.
     */
    for (const forbidden of ['.split(', 'firstTeacher', 'teacher[0]', 'teachers[0]', 'teacherSet']) {
      expect(rendererCode.includes(forbidden), forbidden).toBe(false);
    }
    const view = render(result({ recommendations: [recommendation({ course: course({ teacher: '甲、乙、丙' }) })] }));
    const text = view.recommended.children[0]?.text() ?? '';
    expect(text).toContain('甲、乙、丙');
    expect(text).not.toContain('任课老师：甲 ');
  });

  it('F. a missing teacher shows the model’s honest sentence, never "no teacher"', () => {
    for (const missing of [undefined, null, '']) {
      const view = render(result({ recommendations: [recommendation({ course: course({ teacher: missing }) })] }));
      const text = view.recommended.children[0]?.text() ?? '';
      expect(text, String(missing)).toContain('尚未加载/页面未提供');
      expect(text, String(missing)).not.toContain('无老师');
      expect(text, String(missing)).not.toContain('没有教师');
    }
  });
});

describe('16J-PREUI-E4-C2-B3-B2 G to K. page facts are shown as the page stated them', () => {
  it('G and H. credits are shown when present and never invented when absent', () => {
    const withCredits = render(result({ recommendations: [recommendation({ course: course({ credits: 2 }) })] }));
    expect(withCredits.recommended.children[0]?.text()).toContain('学分：2');

    for (const missing of [undefined, null]) {
      const view = render(result({ recommendations: [recommendation({ course: course({ credits: missing }) })] }));
      const text = view.recommended.children[0]?.text() ?? '';
      expect(text, String(missing)).toContain(CARD_TEXT.creditsUnknown);
      // Not "学分：0", which would claim a zero-credit course.
      expect(text, String(missing)).not.toContain('学分：0');
    }
  });

  it('I. remainingSeats = 0 is visible and labelled as full', () => {
    const view = render(result({ recommendations: [recommendation({ course: course({ remainingSeats: 0, availability: 'full' }) })] }));
    const text = view.recommended.children[0]?.text() ?? '';
    expect(text).toContain('余量：0（已满）');
    // Not hidden, and not presented as unknown.
    expect(text).not.toContain('余量：未知');
  });

  it('J. a missing seat count says unknown, and no competition is inferred', () => {
    const view = render(result({ recommendations: [recommendation({ course: course({ remainingSeats: undefined, availability: 'unknown' }) })] }));
    const text = view.recommended.children[0]?.text() ?? '';
    expect(text).toContain('余量：未知');
    for (const inferred of ['竞争激烈', '录取概率', '容易选上', '选中概率']) {
      expect(text, inferred).not.toContain(inferred);
    }
  });

  it('K. the three admission states are three different words', () => {
    const texts = (['available', 'full', 'unknown'] as const).map((availability) => render(result({
      recommendations: [recommendation({ course: course({ availability }) })],
    })).recommended.children[0]?.text() ?? '');
    expect(texts[0]).toContain(CARD_TEXT.availabilityAvailable);
    expect(texts[1]).toContain(CARD_TEXT.availabilityFull);
    expect(texts[2]).toContain(CARD_TEXT.availabilityUnknown);
    expect(new Set(texts).size).toBe(3);
  });
});

describe('16J-PREUI-E4-C2-B3-B2 L to R. the recommended card separates its facts', () => {
  it('L. the same score with different confidence tiers is shown as two facts', () => {
    const high = render(result({ recommendations: [recommendation({ score: 8.42, confidence: { value: 0.9, tier: 'high', components: {}, missing: [] } })] }));
    const low = render(result({ recommendations: [recommendation({ score: 8.42, confidence: { value: 0.1, tier: 'low', components: {}, missing: [] } })] }));
    const highText = high.recommended.children[0]?.text() ?? '';
    const lowText = low.recommended.children[0]?.text() ?? '';
    expect(highText).toContain('推荐分：8.42');
    expect(lowText).toContain('推荐分：8.42');
    // The confidence differs on screen while the score does not.
    expect(highText).toContain('置信度：高');
    expect(lowText).toContain('置信度：低');
  });

  it('M. the risk-adjusted score never reaches the DOM', () => {
    // The fixture carries `riskAdjustedScore: 7.6`, and no card may show it.
    const view = render(result({ recommendations: [recommendation({ score: 8.42 })] }));
    const text = view.recommended.children[0]?.text() ?? '';
    expect(text).toContain('推荐分：8.42');
    expect(text).not.toContain('7.6');
    expect(rendererCode.includes('riskAdjustedScore')).toBe(false);
    for (const forbidden of ['综合可信推荐分', '调整后得分', 'risk-adjusted']) {
      expect(text, forbidden).not.toContain(forbidden);
      expect(rendererCode.includes(forbidden), forbidden).toBe(false);
    }
  });

  it('N. six aspects render as six independent rows', () => {
    const aspects = ['gradeFriendliness', 'workloadFriendliness', 'attendanceFriendliness', 'examFriendliness', 'teachingQuality', 'studentSentiment'];
    const evidence = aspects.map((aspect, index) => ({ aspect, level: 'limited', reviewsWithEvidence: index + 1, corpusReviews: 20, coverage: 0.1, agreement: 0.5, note: 'n' }));
    const view = render(result({ recommendations: [recommendation({ evidenceStrength: evidence })] }));
    const text = view.recommended.children[0]?.text() ?? '';
    for (const label of ['成绩友好度', '工作量友好度', '考勤友好度', '考核友好度', '教学质量', '学生评价']) {
      expect(text, label).toContain(label);
    }
    // One row per aspect, and each keeps the numbers behind its tier.
    const body = view.recommended.children[0]?.ownChildren().find((node) => node.className === 'course-card-body');
    expect(body?.ownRows('course-card-fact course-card-evidence')).toHaveLength(6);
  });

  it('O. no overall evidence line is produced', () => {
    const view = render(result({ recommendations: [recommendation({ evidenceStrength: [
      { aspect: 'gradeFriendliness', level: 'strong', reviewsWithEvidence: 14, corpusReviews: 17, coverage: 0.8, agreement: 0.9, note: 'n' },
      { aspect: 'attendanceFriendliness', level: 'none', reviewsWithEvidence: 0, corpusReviews: 17, coverage: 0, agreement: 0, note: 'n' },
    ] })] }));
    const text = view.recommended.children[0]?.text() ?? '';
    expect(text).toContain('证据充分');
    expect(text).toContain('证据无');
    for (const synthesised of ['总体证据', '综合证据', '整体证据']) {
      expect(text, synthesised).not.toContain(synthesised);
    }
    // The renderer computes no minimum, maximum or average across aspects.
    for (const forbidden of ['Math.min', 'Math.max', 'reduce(']) {
      expect(rendererCode.includes(forbidden), forbidden).toBe(false);
    }
  });

  it('P and Q. the two review scopes read differently, and a course roll-up is never called the teacher’s', () => {
    /*
     * The sentence comes from the model, which mapped the canonical scope onto its own wording — so what is asserted is that the two scopes produce two different
     * sentences and that the course-level one never claims to be about the teacher.
     */
    const teacherScope = render(result({ recommendations: [recommendation({ reviewContext: reviewContext({ scope: 'teacher' }) })] }));
    const courseScope = render(result({ recommendations: [recommendation({ reviewContext: reviewContext({ scope: 'course' }) })] }));
    const teacherText = teacherScope.recommended.children[0]?.text() ?? '';
    const courseText = courseScope.recommended.children[0]?.text() ?? '';
    expect(teacherText).toContain('当前教师评价证据');
    expect(courseText).toContain('课程整体评价证据');
    expect(courseText).not.toContain('当前教师评价证据');
    expect(teacherText).not.toContain('课程整体评价证据');
  });

  it('R. the review count is called a review sample, never a student count', () => {
    const view = render(result({ recommendations: [recommendation({ reviewContext: reviewContext({ reviewCount: 17 }) })] }));
    const text = view.recommended.children[0]?.text() ?? '';
    expect(text).toContain('评价样本：17');
    for (const forbidden of ['学生人数', '人数：', '选课人数']) {
      expect(text, forbidden).not.toContain(forbidden);
      expect(rendererCode.includes(forbidden), forbidden).toBe(false);
    }
  });
});

describe('PRE-RELEASE-UX-A12 the grade area is ONE line carrying its scope', () => {
  /*
   * ## What replaced what
   *
   * Until A12 a course rendered seven or eight rows for its self-reported grades: a scope heading, an average, a sample count, then the same three again for the
   * whole-course reference, then a per-card copy of the disclaimer. The SCOPE was the part worth keeping — a teaching-class average and a whole-course average are
   * different claims — so it survives as a qualifier inside the sentence, and the repetition is what went.
   *
   * These cases are about the exact sentence, because the sentence is now the whole interface.
   */
  const AVG = CARD_TEXT.grade.label;

  it('A. teacher primary renders 97.3333 as one decimal with its scope', () => {
    const text = render(result({ recommendations: [recommendation({
      gradeAggregates: { teacherSet: { names: ['周奕华'] }, teacher: grade(97.3333, 30), course: grade(85.1, 254) },
    })] })).recommended.children[0]?.text() ?? '';
    // Exactly one decimal place, and the raw long value never reaches the DOM.
    expect(text).toContain(`${AVG}：97.3（30份，${CARD_TEXT.grade.scope.teacher}）`);
    expect(text).not.toContain('97.3333');
  });

  it('B. teaching-class primary rounds UP to one decimal and names the class', () => {
    const text = render(result({ recommendations: [recommendation({
      gradeAggregates: { teacherSet: { names: ['甲', '乙'] }, teachingClass: grade(88, 5), course: grade(85.1, 254) },
    })] })).recommended.children[0]?.text() ?? '';
    // `88` must render as `88.0`, not as a bare integer.
    expect(text).toContain(`${AVG}：88.0（5份，${CARD_TEXT.grade.scope.teachingClass}）`);
    expect(text).not.toContain(`${AVG}：88（`);
  });

  it('C. with NO candidate figure the course aggregate is used and labelled as a reference', () => {
    const card = render(result({ recommendations: [recommendation({
      gradeAggregates: { teacherSet: { names: [] }, course: grade(64.2857, 7) },
    })] })).recommended.children[0];
    const text = card?.text() ?? '';
    expect(text).toContain(`${AVG}：64.3（7份，${CARD_TEXT.grade.scope.course}）`);
    /*
     * The whole-course figure is NEVER described as this teacher's or this class's. Asserted on the GRADE ROW rather than the whole card: a card legitimately
     * contains 任课老师 for the page's teacher cell, and a whole-card scan would fail on a label that has nothing to do with grades.
     *
     * The row is found by its own `course-card-fact` class and its OWN text, because an ancestor's `text()` includes every descendant and would match as well.
     */
    const gradeRow = card?.all().find((node) => node.className === 'course-card-fact' && node.textContent.includes(AVG));
    expect(gradeRow, 'the grade row must exist').toBeDefined();
    const gradeText = gradeRow?.textContent ?? '';
    expect(gradeText).not.toContain(CARD_TEXT.grade.scope.teacher);
    expect(gradeText).not.toContain(CARD_TEXT.grade.scope.teachingClass);
  });

  it('D. no usable grade renders 暂无数据, and still exactly one line', () => {
    const view = render(result({ recommendations: [recommendation({
      gradeAggregates: { teacherSet: { names: ['周奕华'] } },
    })] }));
    const card = view.recommended.children[0];
    const text = card?.text() ?? '';
    expect(text).toContain(`${AVG}：${CARD_TEXT.grade.unavailable}`);
    /*
     * ONE row, whatever the data looks like. Counted by the row's OWN class and OWN text: `all()` also returns the body and the card, whose text contains the
     * label because they wrap the row, so counting every containing node reports more than one for a correct render.
     */
    const rows = card?.all().filter((node) => node.className === 'course-card-fact' && node.textContent.includes(AVG)) ?? [];
    expect(rows).toHaveLength(1);
  });

  it('E. a legitimate mean of 0 renders 0.0, and a zero-sample aggregate does not', () => {
    /*
     * The two cases a truthiness test would confuse. `0` is a real average and must print; `gradedSampleCount: 0` has NO mean and must not become one.
     */
    const realZero = render(result({ recommendations: [recommendation({
      gradeAggregates: { teacherSet: { names: ['周奕华'] }, teacher: grade(0, 3) },
    })] })).recommended.children[0]?.text() ?? '';
    expect(realZero).toContain(`${AVG}：0.0（3份，${CARD_TEXT.grade.scope.teacher}）`);

    const noSamples = render(result({ recommendations: [recommendation({
      gradeAggregates: { teacherSet: { names: ['周奕华'] }, teacher: grade(undefined, 0) },
    })] })).recommended.children[0]?.text() ?? '';
    expect(noSamples).toContain(`${AVG}：${CARD_TEXT.grade.unavailable}`);
    // Never a fabricated zero, in either the figure or the sample count.
    expect(noSamples).not.toContain('0.0');
    expect(noSamples).not.toContain('（0份');
  });

  it('F. the old verbose grade labels are gone from a card', () => {
    const view = render(result({
      recommendations: [recommendation({
        gradeAggregates: { teacherSet: { names: ['周奕华'] }, teacher: grade(88.5, 12), course: grade(85.1, 254) },
      })],
      ratedButNotRecommended: [ratedEntry()],
    }));
    for (const card of [...view.recommended.children, ...view.rated.children]) {
      const text = card.text();
      for (const gone of ['当前教师自报成绩', '当前教学班自报成绩', '课程整体自报成绩参考', '有效样本', '平均：']) {
        expect(text.includes(gone), `${gone} in ${text.slice(0, 40)}`).toBe(false);
      }
    }
    // And the wording table no longer contains them either, so they cannot come back by editing one constant.
    for (const gone of ['当前教师自报成绩', '课程整体自报成绩参考', '有效样本']) {
      expect(rendererCode.includes(gone), gone).toBe(false);
    }
  });

  it('G. the per-card disclaimer is GONE, and the card does not carry it', () => {
    const view = render(result({
      recommendations: [recommendation({
        gradeAggregates: { teacherSet: { names: ['周奕华'] }, teacher: grade(88.5, 12) },
      })],
      ratedButNotRecommended: [ratedEntry()],
    }));
    for (const card of [...view.recommended.children, ...view.rated.children]) {
      expect(card.text()).not.toContain('武汉大学官方课程平均成绩');
    }
    // The renderer no longer reads the disclaimer off the grade model.
    expect(rendererCode).not.toContain('grade.disclaimer');
  });

  it('H. the renderer still does not choose a scope itself', () => {
    // The scope comes from the model; the renderer only looks up wording. A `scope === 'teacher'` test here would be a second copy of the frozen rule.
    expect(rendererCode).toContain('CARD_TEXT.grade.scope[');
    expect(rendererCode.includes("scope === 'teacher'")).toBe(false);
    // And the zero-mean guard is a `typeof` check, never a falsy one that would swallow a real 0.
    expect(rendererCode).toContain("typeof primary?.meanGrade === 'number'");
  });
});

describe('PRE-RELEASE-UX-A12 a rated course shows the same compact grade line', () => {
  /*
   * The gap this closes: a reader could see a self-reported average on a recommended card and nothing on a rated one, which made the figure look like a property of
   * being recommended rather than a property of the course. The line is produced by the same `gradeLineOf`, so the two kinds cannot describe one number differently.
   */
  const AVG = CARD_TEXT.grade.label;
  const ratedText = (gradeAggregates: Record<string, unknown>): string =>
    render(result({ ratedButNotRecommended: [ratedEntry({ gradeAggregates })] })).rated.children[0]?.text() ?? '';

  it('A. teacher primary', () => {
    expect(ratedText({ teacherSet: { names: ['周奕华'] }, teacher: grade(97.3333, 30), course: grade(85.1, 254) }))
      .toContain(`${AVG}：97.3（30份，${CARD_TEXT.grade.scope.teacher}）`);
  });

  it('B. teaching-class primary, with the one-decimal form kept', () => {
    expect(ratedText({ teacherSet: { names: ['甲', '乙'] }, teachingClass: grade(88, 5), course: grade(85.1, 254) }))
      .toContain(`${AVG}：88.0（5份，${CARD_TEXT.grade.scope.teachingClass}）`);
  });

  it('C. course fallback is labelled as a reference, never as the teacher’s own', () => {
    const card = render(result({ ratedButNotRecommended: [ratedEntry({
      gradeAggregates: { teacherSet: { names: [] }, course: grade(64.2857, 7) },
    })] })).rated.children[0];
    expect(card?.text() ?? '').toContain(`${AVG}：64.3（7份，${CARD_TEXT.grade.scope.course}）`);
    const gradeRow = card?.all().find((node) => node.className === 'course-card-fact' && node.textContent.includes(AVG));
    expect(gradeRow?.textContent).not.toContain(CARD_TEXT.grade.scope.teacher);
  });

  it('D. missing grade data renders 暂无数据, not a blank or a zero', () => {
    const text = ratedText({ teacherSet: { names: ['周奕华'] } });
    expect(text).toContain(`${AVG}：${CARD_TEXT.grade.unavailable}`);
    expect(text).not.toContain('0.0');
  });

  it('E. a legitimate mean of 0 survives on the rated card too', () => {
    expect(ratedText({ teacherSet: { names: ['周奕华'] }, teacher: grade(0, 4) }))
      .toContain(`${AVG}：0.0（4份，${CARD_TEXT.grade.scope.teacher}）`);
  });

  it('F. the rated card still says 有评价，但未进入推荐结果, and does not become a verdict', () => {
    const text = ratedText({ teacherSet: { names: ['周奕华'] }, teacher: grade(88.5, 12) });
    expect(text).toContain('有评价，但未进入推荐结果');
    for (const forbidden of ['不推荐', '课程差', '质量低']) {
      expect(text, forbidden).not.toContain(forbidden);
    }
    // And the grade line did not smuggle in a confidence or an evidence tier.
    expect(text).not.toContain('置信度');
    expect(text).not.toContain('证据充分');
  });
});

describe('PRE-RELEASE-UX-A12 the disclaimer is stated ONCE for the whole result', () => {
  const AVG = CARD_TEXT.grade.label;
  /** The exact sentence, which the model owns and the renderer copies rather than re-typing. */
  const SENTENCE = '学生评价中的自报成绩统计，不是武汉大学官方课程平均成绩';

  it('A. many cards produce exactly ONE disclaimer occurrence', () => {
    /*
     * The reason this moved. A real result can hold 130-plus rated cards, and a per-card disclaimer would have repeated the same sentence once per course — noise
     * that buries the figure it is meant to qualify.
     */
    const view = render(result({
      recommendations: [recommendation(), recommendation({ rank: 2 })],
      ratedButNotRecommended: [ratedEntry(), ratedEntry({ rank: 3 }), ratedEntry({ rank: 4 })],
    }));
    expect(view.disclaimer.hidden).toBe(false);
    expect(view.disclaimer.textContent).toBe(SENTENCE);
    // Exactly one occurrence across the whole result: the element itself, and none inside any card.
    expect(view.disclaimer.textContent.split(SENTENCE).length - 1).toBe(1);
    const cardTexts = [...view.recommended.children, ...view.rated.children, ...view.insufficient.children].map((card) => card.text());
    expect(cardTexts.join(' ')).not.toContain(SENTENCE);
  });

  it('B. it does not scale with the card count', () => {
    const one = render(result({ ratedButNotRecommended: [ratedEntry()] }));
    const many = render(result({ ratedButNotRecommended: Array.from({ length: 8 }, (_, index) => ratedEntry({ rank: index + 2 })) }));
    const countIn = (view: ReturnType<typeof render>): number => {
      const all = [view.disclaimer, ...view.recommended.children, ...view.rated.children, ...view.insufficient.children];
      return all.filter((node) => node.text().includes(SENTENCE)).length;
    };
    expect(countIn(one)).toBe(1);
    expect(countIn(many)).toBe(1);
  });

  it('C. a result with no cards shows NO disclaimer and leaves no stale sentence', () => {
    // Nothing on screen to qualify, so the sentence must not be left over from a previous render.
    const view = render(result({ recommendations: [], ratedButNotRecommended: [], insufficientData: [] }));
    expect(view.disclaimer.hidden).toBe(true);
    expect(view.disclaimer.textContent).toBe('');
  });

  it('D. clearing the result clears the disclaimer too', () => {
    const view = render(null);
    expect(view.disclaimer.hidden).toBe(true);
    expect(view.disclaimer.textContent).toBe('');
  });

  it('E. insufficient-only results show no grade disclaimer', () => {
    // An insufficient card has no grade line, so a sentence about grades would describe a figure that is not there.
    const view = render(result({
      insufficientData: [{ course: course(), reason: 'r', match: { method: 'unmatched', confidence: 0 }, reviewSource: { status: 'healthy', queries: 1, rows: 0, empty: 1, unavailable: 0 } }],
    }));
    expect(view.disclaimer.hidden).toBe(true);
    expect(view.disclaimer.textContent).toBe('');
    expect(view.insufficient.children[0]?.text() ?? '').not.toContain(AVG);
  });

  it('F. the panel markup carries exactly one disclaimer element, wired to the renderer', () => {
    // One element in the document, and the panel resolves it — a renderer that owned the sentence but had no element would write nowhere.
    expect(sidepanelHtml.split('id="grade-disclaimer"').length - 1).toBe(1);
    expect(sidepanelHtml.split(SENTENCE).length - 1).toBe(0);
    expect(sidepanelSource).toContain("getElementById('grade-disclaimer')");

    /*
     * RESOLVED **AND** PASSED THROUGH, asserted inside `cardTargets` where both happen.
     *
     * This case exists because a mutation proved it was missing: deleting the `disclaimer,` property from the object `cardTargets` returns left every test green,
     * because the harness above supplies its own disclaimer node and therefore exercises `renderCourseCards` rather than the panel's wiring. Resolving the element
     * and forgetting to hand it over is exactly the kind of half-done work a source-level check has to catch.
     */
    const cardTargetsFn = sidepanelSource.slice(
      sidepanelSource.indexOf('function cardTargets()'),
      sidepanelSource.indexOf('function renderRecommendation('),
    );
    expect(cardTargetsFn.length).toBeGreaterThan(0);
    // A: the element is resolved.
    expect(cardTargetsFn).toContain("document.getElementById('grade-disclaimer')");
    // B: a missing element is REPORTED rather than silently producing a renderer that writes nowhere.
    expect(cardTargetsFn).toContain('disclaimer === null');
    // C: and it is handed to the renderer. Asserted on the property with its trailing comma, which is what passing it through looks like in the returned object.
    expect(cardTargetsFn).toContain('disclaimer,');
  });
});

describe('PRE-RELEASE-UX-A13 the rated section is collapsed by default', () => {
  /*
   * ## The problem this solves
   *
   * A real run produced about 133 rated-but-not-recommended cards, all expanded, so the reader had to scroll past a hundred courses they had not asked for to reach
   * the ones they had. The section now carries its own disclosure, closed on arrival.
   *
   * ## Why the renderer owns the state rather than the click handler
   *
   * Every NEW result must start collapsed, and only the renderer knows a new result has arrived. It sets the count and the collapsed state together, so a stale
   * expansion cannot survive into a new snapshot and `aria-expanded` cannot drift from what is rendered — both are written by one function.
   */
  /** Click the toggle the way a reader does, through the panel's own handler shape. */
  const toggle = (view: ReturnType<typeof render>): void => {
    // Read the current state off the control and ask for the opposite, exactly as `wireRatedDisclosure` does.
    const expanded = view.ratedToggle.getAttribute('aria-expanded') === 'true';
    setRatedCollapsed({ toggle: view.ratedToggle as unknown as HTMLElement, panel: view.ratedCards as unknown as HTMLElement }, expanded);
  };

  it('A and B. with rated cards the section exists and starts COLLAPSED', () => {
    const view = render(result({ ratedButNotRecommended: [ratedEntry(), ratedEntry({ rank: 3 })] }));
    // The section itself is shown...
    expect(view.ratedSection.hidden).toBe(false);
    // ...while the cards inside it are not.
    expect(view.ratedCards.hidden).toBe(true);
    expect(view.ratedToggle.getAttribute('aria-expanded')).toBe('false');
    // The cards are still CONSTRUCTED — this slice solves page length, not renderer work — so expanding is instant.
    expect(view.rated.children).toHaveLength(2);
  });

  it('C. the first click expands, showing the cards and announcing it', () => {
    const view = render(result({ ratedButNotRecommended: [ratedEntry()] }));
    toggle(view);
    expect(view.ratedCards.hidden).toBe(false);
    expect(view.ratedToggle.getAttribute('aria-expanded')).toBe('true');
    // The recommended section is untouched by the toggle.
    expect(view.recommendedSection.hidden).toBe(true); // hidden only because this result has no recommended cards
  });

  it('D. the second click collapses again', () => {
    const view = render(result({ ratedButNotRecommended: [ratedEntry()] }));
    toggle(view);
    toggle(view);
    expect(view.ratedCards.hidden).toBe(true);
    expect(view.ratedToggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('E. the count is the exact rated length, not hard-coded', () => {
    for (const count of [1, 133]) {
      const view = render(result({
        ratedButNotRecommended: Array.from({ length: count }, (_, index) => ratedEntry({ rank: index + 2 })),
      }));
      expect(view.ratedCount.textContent, String(count)).toBe(`（${count}）`);
      expect(view.rated.children).toHaveLength(count);
    }
    // And the label carries no number of its own, so the two cannot disagree.
    expect(sidepanelHtml).toContain('有评价但未进入推荐');
    expect(sidepanelHtml).not.toContain('有评价但未进入推荐（');
  });

  it('F. zero rated cards hide the section and offer no toggle', () => {
    const view = render(result({ recommendations: [recommendation()] }));
    expect(view.ratedSection.hidden).toBe(true);
    // Nothing to expand, so no count is announced and the control stays collapsed rather than claiming content.
    expect(view.ratedCount.textContent).toBe('');
    expect(view.ratedToggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('G. the recommended section is never collapsed by any of this', () => {
    const view = render(result({
      recommendations: [recommendation(), recommendation({ rank: 2 })],
      ratedButNotRecommended: [ratedEntry()],
    }));
    expect(view.recommendedSection.hidden).toBe(false);
    expect(view.recommended.children).toHaveLength(2);
    // Its cards are rendered unconditionally — there is no disclosure on that section at all.
    expect(view.recommendedSection.getAttribute('aria-expanded')).toBeNull();
  });

  it('H. every NEW result resets the section to collapsed', () => {
    const first = render(result({ ratedButNotRecommended: [ratedEntry()] }));
    toggle(first);
    expect(first.ratedCards.hidden).toBe(false);

    /*
     * A new snapshot, rendered into FRESH targets. The expansion a reader made while looking at the previous result is deliberately not carried over.
     */
    const second = render(result({ ratedButNotRecommended: [ratedEntry(), ratedEntry({ rank: 3 })] }));
    expect(second.ratedCards.hidden).toBe(true);
    expect(second.ratedToggle.getAttribute('aria-expanded')).toBe('false');
    expect(second.ratedCount.textContent).toBe('（2）');

    /*
     * And the case the panel actually hits: the SAME elements, re-rendered with a new result while the section is open. This is the assertion a mutation proved was
     * missing — dropping the reset entirely left every test green, because the fresh-target render already starts collapsed and proved nothing about a re-render.
     */
    const toggleNode = new StubNode();
    const countNode = new StubNode();
    const panelNode = new StubNode();
    const disclosure = {
      toggle: toggleNode as unknown as HTMLElement,
      count: countNode as unknown as HTMLElement,
      panel: panelNode as unknown as HTMLElement,
    };
    const targets = {
      recommended: new StubNode() as unknown as HTMLElement,
      rated: new StubNode() as unknown as HTMLElement,
      insufficient: new StubNode() as unknown as HTMLElement,
      sections: {
        recommended: new StubNode() as unknown as HTMLElement,
        rated: new StubNode() as unknown as HTMLElement,
        insufficient: new StubNode() as unknown as HTMLElement,
      },
      disclosure,
    };
    // A first result, then the reader opens the section.
    withDom(() => { renderCourseCards(targets, result({ ratedButNotRecommended: [ratedEntry()] }) as never); });
    expect(panelNode.hidden).toBe(true);
    setRatedCollapsed(disclosure, false);
    expect(panelNode.hidden).toBe(false);
    expect(toggleNode.getAttribute('aria-expanded')).toBe('true');

    // A NEW result arrives into the same elements: it must be collapsed again.
    withDom(() => { renderCourseCards(targets, result({ ratedButNotRecommended: [ratedEntry()] }) as never); });
    expect(panelNode.hidden).toBe(true);
    expect(toggleNode.getAttribute('aria-expanded')).toBe('false');
    expect(countNode.textContent).toBe('（1）');
  });

  it('I. expanding does not touch the canonical result', () => {
    /*
     * The disclosure is presentation. Expanding must not re-rank, re-score or re-derive anything, so the canonical arrays are compared before and after.
     */
    const canonical = result({ ratedButNotRecommended: [ratedEntry(), ratedEntry({ rank: 3 })] });
    const before = JSON.stringify(canonical);
    const view = render(canonical);
    toggle(view);
    toggle(view);
    expect(JSON.stringify(canonical)).toBe(before);
    // And the renderer is still a pure function of the model: no re-derivation, no network, no engine.
    expect(rendererCode.includes('recommendExtensionCourses')).toBe(false);
    expect(rendererCode.includes('fetch(')).toBe(false);
  });

  it('J. an expanded rated card still carries the A12 compact grade line', () => {
    const view = render(result({ ratedButNotRecommended: [ratedEntry()] }));
    toggle(view);
    const text = view.rated.children[0]?.text() ?? '';
    expect(view.ratedCards.hidden).toBe(false);
    // Exactly the A12 line, from the same helper the recommended card uses.
    expect(text).toContain(`学生自报平均成绩：88.5（12份，${CARD_TEXT.grade.scope.teacher}）`);
    // And the disclosure changed nothing else about the card.
    expect(text).toContain('有评价，但未进入推荐结果');
    expect(text).toContain('推荐排名：#2');
    expect(text).toContain('推荐分：6.1');
  });

  it('K. the control is a real button with its state in the DOM, not an inline handler', () => {
    /*
     * A control a reader cannot reach is not a fix. It is a `<button>`, so keyboard activation arrives as a click; the state is `aria-expanded`; and the panel
     * attaches the listener in its own module rather than inline, which the content security policy forbids.
     */
    expect(sidepanelHtml).toContain('id="rated-toggle"');
    expect(/<button[^>]*id="rated-toggle"[^>]*aria-expanded="false"/u.test(sidepanelHtml)).toBe(true);
    expect(sidepanelHtml).toContain('aria-controls="rated-cards"');
    expect(sidepanelHtml).not.toContain('onclick=');
    // The label is text beside the count rather than a triangle alone, so the state is legible without reading the mark.
    expect(sidepanelHtml).toContain('panel-cards-toggle-label');
    expect(sidepanelHtml).toContain('panel-cards-toggle-count');
    // And the panel wires it from its own code.
    expect(sidepanelSource).toContain("getElementById('rated-toggle')");
    expect(sidepanelSource).toContain("getElementById('rated-cards')");
    expect(sidepanelSource).toContain('setRatedCollapsed');
    /*
     * Resolved, GUARDED, and HANDED OVER — the three things `cardTargets` has to do, asserted inside it.
     *
     * A mutation proved the third was missing: deleting the `disclosure` property from what `cardTargets` returns left every test green, because the harness passes
     * its own disclosure straight to the renderer. Resolving a control and never giving it to the code that manages it leaves the section permanently collapsed with
     * no way to open it — the failure mode this slice exists to prevent, inverted.
     */
    const cardTargetsFn = sidepanelSource.slice(
      sidepanelSource.indexOf('function cardTargets()'),
      sidepanelSource.indexOf('function wireRatedDisclosure()'),
    );
    expect(cardTargetsFn.length).toBeGreaterThan(0);
    expect(cardTargetsFn).toContain("document.getElementById('rated-toggle')");
    expect(cardTargetsFn).toContain('ratedToggle === null');
    expect(cardTargetsFn).toContain('disclosure: { toggle: ratedToggle, count: ratedCount, panel: ratedCards }');

    /*
     * And the handler is INSTALLED and does something. A mutation proved this was missing: turning the `wireRatedDisclosure()` call into a bare read of its name left
     * every test green, because the harness never executes the panel — the control would have been inert in the shipped extension and nothing would have said so.
     */
    const wireFn = sidepanelSource.slice(
      sidepanelSource.indexOf('function wireRatedDisclosure()'),
      sidepanelSource.indexOf('wireRatedDisclosure();'),
    );
    expect(wireFn).toContain("addEventListener('click'");
    expect(wireFn).toContain("getAttribute('aria-expanded')");
    expect(wireFn).toContain('setRatedCollapsed(');
    // Called once, at load, so the control works before the first result arrives.
    expect(sidepanelSource.split('wireRatedDisclosure();').length - 1).toBe(1);
  });
});

describe('16J-PREUI-E4-C2-B3-B2 Y to AF. the other two kinds render only what they have', () => {
  /** One canonical rated entry, carrying grade aggregates because PRE-RELEASE-UX-A11 made them part of the entry. */
  const ratedEntry = (): Record<string, unknown> => ({
    course: course(), rank: 6, score: 5.9, reviewContext: reviewContext(),
    sectionHydration: { status: 'full', available: [], missing: [], rawHydrated: true },
    gradeAggregates: { teacherSet: { names: ['周奕华'] }, teacher: grade(88.5, 12), course: grade(85.1, 254) },
    /*
     * REQUIRED since PRE-RELEASE-UX-A17 carries the student comments into the presentation. `[]` is the honest default for this block: these cases
     * are about a rated card's score, rank and absences, and a card with no excerpts renders no review module at all.
     */
    reviewExcerpts: [],
  });

  it('Y. a rated card shows its score and its rank', () => {
    const view = render(result({ ratedButNotRecommended: [ratedEntry()] }));
    const text = view.rated.children[0]?.text() ?? '';
    expect(text).toContain('推荐分：5.9');
    expect(text).toContain('推荐排名：#6');
  });

  it('Z, AA and AB. a rated card renders NO confidence and NO evidence, and DOES render the compact grade line', () => {
    /*
     * UPDATED IN PRE-RELEASE-UX-A12, which completes the second half of the A11 change.
     *
     * A11 carried the grade aggregates into the rated entry and left the DOM alone; A12 renders them, so the old assertion that the card contains no grade line is
     * now the opposite. What is unchanged, and is the substance of these cases, is that a rated card still invents NO confidence and NO evidence tiers: the entry
     * has neither, and an empty module for either would tell a reader the extension checked and found nothing.
     *
     * The per-card DISCLAIMER is also gone — it moved to the result area — so its absence here is still asserted, for a different reason.
     */
    const view = render(result({ ratedButNotRecommended: [ratedEntry()] }));
    const text = view.rated.children[0]?.text() ?? '';
    expect(text).not.toContain('置信度');
    expect(text).not.toContain('证据充分');
    // The compact grade line IS rendered, from the same model the recommended card uses.
    const presentation = toRatedCoursePresentation(ratedEntry() as never);
    expect(presentation.grade.primaryGrade?.meanGrade).toBe(88.5);
    expect(text).toContain('学生自报平均成绩：88.5（12份，当前教师）');
    // And the disclaimer is NOT here: it is stated once for the whole result area.
    expect(text).not.toContain('不是武汉大学官方课程平均成绩');
    // No placeholder stands in for the fields the entry lacks.
    expect(text).not.toContain('置信度：低');
    expect(text).not.toContain('证据：无');
    expect(text).not.toContain('成绩：暂无');
    // Nor any of the verbose grade labels this slice removed.
    expect(text).not.toContain('有效样本');
    expect(text).not.toContain('课程整体自报成绩参考');
  });

  it('AC. a rated card is not described as insufficient or as bad', () => {
    const view = render(result({ ratedButNotRecommended: [ratedEntry()] }));
    const text = view.rated.children[0]?.text() ?? '';
    expect(text).toContain('有评价，但未进入推荐结果');
    for (const forbidden of ['不推荐', '课程差', '质量低', '证据不足']) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });

  /** One canonical insufficient entry. */
  const insufficientEntry = (reviewSource: Record<string, unknown> = { status: 'healthy', queries: 1, rows: 0, empty: 1, unavailable: 0 }): Record<string, unknown> => ({
    course: course(), reason: '未找到可信评价匹配', match: { method: 'unmatched', confidence: 0 }, reviewSource,
  });

  it('AD. an insufficient card has NO score module and no rank module', () => {
    const view = render(result({ insufficientData: [insufficientEntry()] }));
    const text = view.insufficient.children[0]?.text() ?? '';
    // Not "推荐分：0", not "推荐分：—", not "推荐分：暂无" — the field does not exist.
    expect(text).not.toContain('推荐分');
    expect(text).not.toContain('推荐排名');
    expect(text).toContain('评价证据不足，暂不做推荐判断');
  });

  it('AE. the matcher’s number is labelled as a MATCH confidence', () => {
    const view = render(result({ insufficientData: [{ ...insufficientEntry(), match: { method: 'fuzzy_name', confidence: 0.42 } }] }));
    const text = view.insufficient.children[0]?.text() ?? '';
    expect(text).toContain('评价匹配置信：0.42');
    // Never as a recommendation confidence.
    expect(text).not.toContain('置信度：0.42');
    expect(text).not.toContain('推荐置信度');
  });

  it('AF. the insufficiency wording is a data statement, not a verdict', () => {
    const view = render(result({ insufficientData: [insufficientEntry()] }));
    const text = view.insufficient.children[0]?.text() ?? '';
    for (const forbidden of ['不推荐', '课程不好', '低分', '质量差']) {
      expect(text, forbidden).not.toContain(forbidden);
    }
    // The engine's own reason travels verbatim rather than being reworded into a judgement.
    expect(text).toContain('未找到可信评价匹配');
  });

  it('AG and AH. the review-source line follows the canonical status', () => {
    const healthy = render(result({ insufficientData: [insufficientEntry({ status: 'healthy', queries: 1, rows: 0, empty: 1, unavailable: 0 })] }));
    // A healthy source says nothing: the evidence gap is not attributed to a source failure.
    expect(healthy.insufficient.children[0]?.text()).not.toContain('公开评价源暂时不可用');
    expect(healthy.insufficient.children[0]?.text()).not.toContain('部分公开评价暂时不可用');

    const partial = render(result({ insufficientData: [insufficientEntry({ status: 'partial', queries: 2, rows: 1, empty: 0, unavailable: 1 })] }));
    expect(partial.insufficient.children[0]?.text()).toContain('部分公开评价暂时不可用');

    const down = render(result({ insufficientData: [insufficientEntry({ status: 'unavailable', queries: 1, rows: 0, empty: 0, unavailable: 1 })] }));
    expect(down.insufficient.children[0]?.text()).toContain('公开评价源暂时不可用');
  });

  it('a recommended card discloses a partial or unavailable per-course source', () => {
    const partial = render(result({ recommendations: [recommendation({ reviewSource: { status: 'partial', queries: 2, rows: 1, empty: 0, unavailable: 1 } })] }));
    expect(partial.recommended.children[0]?.text()).toContain('部分评价数据暂时不可用');
    const down = render(result({ recommendations: [recommendation({ reviewSource: { status: 'unavailable', queries: 1, rows: 0, empty: 0, unavailable: 1 } })] }));
    expect(down.recommended.children[0]?.text()).toContain('该课程公开评价暂时不可用');
    // A healthy source adds no line at all.
    const healthy = render(result({ recommendations: [recommendation()] }));
    expect(healthy.recommended.children[0]?.text()).not.toContain('暂时不可用');
  });
});

describe('16J-PREUI-E4-C2-B3-B2 AJ to AK. what may and may not have cards', () => {
  it('AJ. an invalid page, a stale answer and an error produce zero cards', () => {
    /*
     * The gate is the SUMMARY the view produced: a page notice means there is no ranking, so the panel passes `null` and every list is emptied. Asserted here at
     * the renderer's own boundary, and asserted again from the panel's side below.
     */
    /*
     * `null` is the renderer's clear signal, and it is what the panel passes for every state that has no ranking to show. `undefined` is not a state the panel can
     * produce, because the controller publishes a discriminated union whose non-success arms carry no result at all.
     */
    for (const nothing of [null]) {
      const view = render(nothing);
      expect(view.recommended.children, String(nothing)).toHaveLength(0);
      expect(view.rated.children, String(nothing)).toHaveLength(0);
      expect(view.insufficient.children, String(nothing)).toHaveLength(0);
      expect(view.recommendedSection.hidden, String(nothing)).toBe(true);
    }
  });

  it('AK. a new render CLEARS the previous cards, which is what makes loading safe', () => {
    const recommended = new StubNode();
    const rated = new StubNode();
    const insufficient = new StubNode();
    const sections = { recommended: new StubNode(), rated: new StubNode(), insufficient: new StubNode() };
    const targets = {
      recommended: recommended as unknown as HTMLElement,
      rated: rated as unknown as HTMLElement,
      insufficient: insufficient as unknown as HTMLElement,
      sections: {
        recommended: sections.recommended as unknown as HTMLElement,
        rated: sections.rated as unknown as HTMLElement,
        insufficient: sections.insufficient as unknown as HTMLElement,
      },
    };

    withDom(() => {
      renderCourseCards(targets, result({ recommendations: [recommendation()] }) as never);
      expect(recommended.children).toHaveLength(1);
      // A new RUN begins: the loading state passes `null`, and the old card must go rather than sit beside "正在生成…".
      renderCourseCards(targets, null);
      expect(recommended.children).toHaveLength(0);
      expect(recommendedSectionHidden(sections)).toBe(true);
    });
  });

  it('the panel passes a result ONLY when the view summarised one', () => {
    /*
     * The rule at the panel's side: `counts === null` means the view explained the page instead of a ranking, so no cards are rendered even though the controller
     * may still be holding a result from earlier in the same session.
     */
    expect(sidepanelSource).toContain('renderCourseCards(targets, view.counts === null ? null : result)');
    // And the held result is cleared by every state that is not a success, so a stale answer cannot leave cards behind.
    expect(sidepanelSource).toContain("state.status === 'success' ? state.result : null");
  });

  it('AL. page and review text is written as text, never as markup', () => {
    /*
     * Teacher names come from a page this extension does not control. Assembling them into markup is the one mistake that would turn page text into executable
     * content, so the renderer has no `innerHTML` at all and writes every string with `textContent`.
     */
    for (const forbidden of ['innerHTML', 'insertAdjacentHTML', 'outerHTML', 'document.write']) {
      expect(rendererCode.includes(forbidden), forbidden).toBe(false);
    }
    // A teacher value that looks like markup arrives as literal text.
    const view = render(result({ recommendations: [recommendation({ course: course({ teacher: '<img src=x onerror=alert(1)>' }) })] }));
    const values = view.recommended.children[0]?.all() ?? [];
    expect(values.some((node) => node.textContent.includes('<img src=x'))).toBe(true);
  });

  it('AM. a card contains no action control that OPERATES on the course', () => {
    /*
     * Cards are display only: the extension performs no course operation, so there is nothing for a link, a form field or a submit control to do.
     *
     * UPDATED IN PRE-RELEASE-UX-A17. This case used to forbid `createElement('button')` and `addEventListener` outright, because a card had no
     * interactive part at all. It has one now — the student-review disclosure — and that control is a disclosure, not an operation: it reveals text
     * already on the page and sends nothing, saves nothing and changes no course. So the rule is narrowed to the controls that WOULD be an operation,
     * and the button that is allowed is named and constrained separately below rather than deleted from the check.
     */
    for (const forbidden of ["createElement('a')", "createElement('input')", "createElement('form')", 'createElement(\'select\')', '.onclick']) {
      expect(rendererCode.includes(forbidden), forbidden).toBe(false);
    }
    /*
     * The one button the renderer may create is the review disclosure, and the only listener it may attach is that disclosure's own toggle. Asserted
     * by name so a second button, or a second listener, has to edit this case.
     */
    const buttonCreations = [...rendererCode.matchAll(/createElement\('button'\)/gu)].length;
    expect(buttonCreations).toBe(1);
    const listeners = [...rendererCode.matchAll(/addEventListener\(/gu)].length;
    expect(listeners).toBe(1);
    expect(rendererCode).toContain("toggle.addEventListener('click'");
    // And nothing in the card renderer reaches the network or a message boundary, which is what makes a disclosure harmless.
    for (const forbidden of ['fetch(', 'chrome.runtime', 'sendMessage', 'XMLHttpRequest']) {
      expect(rendererCode.includes(forbidden), forbidden).toBe(false);
    }
    /*
     * And on the card area's own markup.
     *
     * UPDATED IN PRE-RELEASE-UX-A13: the scan is scoped to the THREE CARD LISTS rather than the whole cards area, because the rated section now legitimately
     * carries a collapse button in its header. That control is not an action on a course — it discloses the section — so the contract this case protects, that a
     * CARD contains no operation, is asserted where a card actually lives.
     */
    for (const listId of ['card-list-recommended', 'card-list-rated', 'card-list-insufficient']) {
      const start = sidepanelHtml.indexOf(`id="${listId}"`);
      const markup = sidepanelHtml.slice(start, sidepanelHtml.indexOf('</ol>', start));
      expect(markup.length, listId).toBeGreaterThan(0);
      expect(/<(?:button|a|input|select|textarea)\b/iu.test(markup), listId).toBe(false);
    }
  });

  it('AN. the result area is titled as a snapshot', () => {
    /*
     * The numbers describe the approved tab as it was when it was read, and nothing refreshes them on a tab switch. "推荐结果" would read as live state for
     * whatever page is in front.
     */
    expect(CARD_TEXT.title).toBe('推荐快照');
    expect(sidepanelHtml).toContain('推荐快照');
    expect(sidepanelHtml).not.toContain('当前推荐');
    expect(sidepanelHtml).not.toContain('推荐结果<');
  });

  it('AO. the renderer sorts nothing, by any key', () => {
    for (const key of ['score', 'confidence', 'remainingSeats', 'teacher', 'rank']) {
      expect(rendererCode.includes(`sort((a, b) => a.${key}`), key).toBe(false);
    }
    expect(/\.sort\s*\(/u.test(rendererCode)).toBe(false);
  });

  it('AP. no raw canonical enum reaches the DOM', () => {
    /*
     * Section hydration is deliberately NOT rendered in this step. Its canonical status describes whether a section's DETAIL row was loaded — teacher, schedule,
     * location, department, capacity — and not how much REVIEW evidence there is, so any label tying it to review coverage would misdescribe the enum.
     */
    expect(rendererCode.includes('sectionHydration')).toBe(false);
    expect(rendererCode.includes('HYDRATION_STATUS_TEXT')).toBe(false);
    /*
     * And no raw canonical status reaches the reader. Asserted on the OUTPUT rather than by scanning the code for the words, because the wording tables legitimately
     * contain them as KEYS — what must never happen is one of them being printed. A source-level scan for the words would flag the table; this checks every kind of
     * card instead.
     */
    const rendered = [
      render(result({ recommendations: [recommendation({ reviewSource: { status: 'partial', queries: 2, rows: 1, empty: 0, unavailable: 1 } })] })),
      render(result({ ratedButNotRecommended: [ratedEntry()] })),
      render(result({ insufficientData: [{ course: course(), reason: 'r', match: { method: 'unmatched', confidence: 0 }, reviewSource: { status: 'unavailable', queries: 1, rows: 0, empty: 0, unavailable: 1 } }] })),
    ];
    for (const view of rendered) {
      const allText = [...view.recommended.children, ...view.rated.children, ...view.insufficient.children].map((card) => card.text()).join(' ');
      for (const rawEnum of ['partial', 'unavailable', 'healthy', 'basic', 'full', 'fuzzy_name', 'unmatched', 'whu']) {
        expect(allText.includes(rawEnum), rawEnum).toBe(false);
      }
    }
    // The scope words and the review-source sentences come from the model's own tables rather than being reinterpreted here.
    expect(rendererCode.includes("scope === '")).toBe(false);
  });

  it('AQ. internal codes are not dumped: only the model’s Chinese text is rendered', () => {
    // The renderer reads its wording from CARD_TEXT and the presentation, and has no fallback that would print a code.
    expect(rendererCode).toContain('CARD_TEXT');
    for (const codeLike of ['match.method', 'aspect]:', 'level}']) {
      expect(rendererCode.includes(codeLike), codeLike).toBe(false);
    }
    // Every user-visible sentence in CARD_TEXT is Chinese rather than an identifier.
    for (const [, value] of Object.entries(CARD_TEXT.sections)) expect(/[\u4e00-\u9fff]/u.test(value)).toBe(true);
    expect(/[\u4e00-\u9fff]/u.test(CARD_TEXT.matchConfidence)).toBe(true);
  });
});

describe('PRE-RELEASE-UX-A17 the collapsible student-review module', () => {
  /*
   * ## Why this block passes CANONICAL excerpts, not presentation pairs
   *
   * `renderCourseCards` maps a canonical result through the presentation model before it builds a card, so the shape crossing this boundary is
   * `{ text, scope, teacherNames, teacherValidity }` — the provider's DTO — and the LABEL is derived by `course-presentation.ts` on the way. The
   * presentation-level label rules are asserted directly in `step42ReviewPresentation.test.ts`; what these cases prove is that the derived label and the
   * text both reach the DOM unchanged.
   *
   * Expectations are read from {@link REVIEW_LABEL_TEXT} rather than retyped, so a case cannot quietly assert a sentence the product does not produce.
   */
  const excerpt = (
    text: string,
    options: { scope?: 'current_class' | 'course_reference' | 'supplementary'; teacherNames?: string[]; teacherValidity?: string } = {},
  ): Record<string, unknown> => ({
    text,
    scope: options.scope ?? 'current_class',
    teacherNames: options.teacherNames ?? ['周奕华'],
    teacherValidity: options.teacherValidity ?? 'valid',
  });

  it('A. the heading carries the EXACT count of excerpts rendered', () => {
    for (const count of [1, 2, 3]) {
      const view = render(result({
        recommendations: [recommendation({
          reviewExcerpts: Array.from({ length: count }, (_, index) => excerpt(`第${index + 1}条`)),
        })],
      }));
      const module = reviewModuleOf(view.recommended.children[0] as never);
      expect(module, String(count)).toBeDefined();
      expect(module?.toggle.textContent).toBe(`${CARD_TEXT.reviews.buttonLabel}${CARD_TEXT.reviews.countSuffix(count)}`);
      expect(module?.items).toHaveLength(count);
    }
    // The wording itself is the frozen one.
    expect(CARD_TEXT.reviews.buttonLabel).toBe('查看学生评价');
    expect(CARD_TEXT.reviews.countSuffix(3)).toBe('（3）');
  });

  it('B. the review text is hidden and announced collapsed on first render', () => {
    const view = render(result({ recommendations: [recommendation({ reviewExcerpts: [excerpt('老师讲得很好')] })] }));
    const module = reviewModuleOf(view.recommended.children[0] as never);
    expect(module?.list.hidden).toBe(true);
    expect(module?.toggle.getAttribute('aria-expanded')).toBe('false');
    // The text is already in the DOM — hidden, not withheld — so opening it needs no query.
    expect(module?.list.text()).toContain('老师讲得很好');
  });

  it('C and D and E. a click expands, a second collapses, and aria-expanded tracks it', () => {
    const view = render(result({ recommendations: [recommendation({ reviewExcerpts: [excerpt('事少')] })] }));
    const module = reviewModuleOf(view.recommended.children[0] as never);
    if (module === undefined) throw new Error('no review module');

    module.toggle.click();
    expect(module.list.hidden).toBe(false);
    expect(module.toggle.getAttribute('aria-expanded')).toBe('true');

    module.toggle.click();
    expect(module.list.hidden).toBe(true);
    expect(module.toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('F. a new render starts collapsed again, even for the SAME targets', () => {
    const targets = {
      recommended: new StubNode(), rated: new StubNode(), insufficient: new StubNode(),
      sections: { recommended: new StubNode(), rated: new StubNode(), insufficient: new StubNode() },
      disclaimer: new StubNode(),
      disclosure: { toggle: new StubNode(), count: new StubNode(), panel: new StubNode() },
    };
    const asTargets = {
      recommended: targets.recommended as unknown as HTMLElement,
      rated: targets.rated as unknown as HTMLElement,
      insufficient: targets.insufficient as unknown as HTMLElement,
      sections: {
        recommended: targets.sections.recommended as unknown as HTMLElement,
        rated: targets.sections.rated as unknown as HTMLElement,
        insufficient: targets.sections.insufficient as unknown as HTMLElement,
      },
      disclaimer: targets.disclaimer as unknown as HTMLElement,
      disclosure: {
        toggle: targets.disclosure.toggle as unknown as HTMLElement,
        count: targets.disclosure.count as unknown as HTMLElement,
        panel: targets.disclosure.panel as unknown as HTMLElement,
      },
    };
    const payload = result({ recommendations: [recommendation({ reviewExcerpts: [excerpt('第一轮')] })] });

    withDom(() => { renderCourseCards(asTargets, payload as never); });
    const first = reviewModuleOf(targets.recommended.children[0] as never);
    first?.toggle.click();
    expect(first?.list.hidden).toBe(false);

    // The SAME elements, re-rendered with a new result: the module is rebuilt, so the expansion cannot survive.
    withDom(() => { renderCourseCards(asTargets, payload as never); });
    const second = reviewModuleOf(targets.recommended.children[0] as never);
    expect(second?.list.hidden).toBe(true);
    expect(second?.toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('G. a card with no excerpts renders no module at all', () => {
    const view = render(result({
      recommendations: [recommendation({ reviewExcerpts: [] })],
      ratedButNotRecommended: [ratedEntry()],
    }));
    for (const card of [view.recommended.children[0], view.rated.children[0]]) {
      expect(reviewModuleOf(card as never)).toBeUndefined();
      // Not a collapsed module, not an empty state: no heading at all.
      expect((card as StubNode).text()).not.toContain(CARD_TEXT.reviews.buttonLabel);
    }
    // And nothing anywhere in the card area claims a review module it does not have.
    expect(view.rated.text()).not.toContain('暂无评价');
  });

  it('H. the insufficient card never gets one, because it carries no excerpts', () => {
    const view = render(result({ insufficientData: [{ course: course(), reason: '公开评价源暂时不可用', match: { method: 'none', confidence: 0 }, reviewSource: { status: 'unavailable', queries: 1, rows: 0, empty: 0, unavailable: 1 } }] }));
    const card = view.insufficient.children[0] as StubNode;
    expect(card).toBeDefined();
    expect(reviewModuleOf(card)).toBeUndefined();
    expect(card.text()).not.toContain(CARD_TEXT.reviews.buttonLabel);
  });

  it('20. the RATED card gets the module, keeps A12/A13 semantics, and nests independently', () => {
    const view = render(result({
      ratedButNotRecommended: [ratedEntry({
        reviewExcerpts: [excerpt('作业多但给分好', { scope: 'course_reference', teacherNames: ['王五'] })],
      })],
    }));
    const card = view.rated.children[0] as StubNode;
    const module = reviewModuleOf(card);
    expect(module).toBeDefined();
    // The A12 compact grade line and the A13 status sentence are untouched by the new module.
    expect(card.text()).toContain('学生自报平均成绩');
    expect(card.text()).toContain('有评价，但未进入推荐结果');
    expect(module?.toggle.textContent).toBe('查看学生评价（1）');
    // The label came from the presentation, in the conservative course-reference wording.
    const expectedLabel = REVIEW_LABEL_TEXT.referenceWithTeachers('王五');
    expect(expectedLabel).toBe('课程整体参考 · 教师：王五');
    expect(module?.list.text()).toContain(expectedLabel);
    expect(module?.list.text()).toContain('作业多但给分好');
    /*
     * The NESTED case. The outer rated disclosure is not part of the card — it is the section's own control — so operating it must not touch the card's
     * module, and operating the card's module must not collapse the section. Asserted by driving both and reading both.
     */
    const outerToggle = new StubNode();
    const outerPanel = new StubNode();
    setRatedCollapsed({ toggle: outerToggle as unknown as HTMLElement, panel: outerPanel as unknown as HTMLElement }, false);
    expect(outerPanel.hidden).toBe(false);
    // Outer expanded, inner still collapsed.
    expect(module?.list.hidden).toBe(true);
    module?.toggle.click();
    expect(module?.list.hidden).toBe(false);
    // Inner expanded, outer unaffected.
    expect(outerPanel.hidden).toBe(false);
    expect(outerToggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('21. HTML-looking review text is inserted as literal text, never as markup', () => {
    const hostile = '<b>事少</b><script>alert(1)</script>';
    const view = render(result({ recommendations: [recommendation({ reviewExcerpts: [excerpt(hostile)] })] }));
    const card = view.recommended.children[0] as StubNode;
    const module = reviewModuleOf(card);
    module?.toggle.click();

    // The characters are visible...
    expect(module?.list.text()).toContain(hostile);
    /*
     * ...and NOTHING was created from them. The stub's `createElement` only ever makes generic nodes, so the honest assertions are that no node's text was
     * parsed into children, that the text node holds the whole string, and that the renderer never reaches for a markup API.
     */
    const textNode = module?.items[0]?.all().find((node) => node.hasClass('course-card-review-text'));
    expect(textNode?.textContent).toBe(hostile);
    expect(textNode?.children).toHaveLength(0);
    // No element in the module has a tag-like class or a child parsed out of the string.
    expect(module?.items[0]?.all().some((node) => node.className.includes('<' ) || node.className.includes('script'))).toBe(false);
    for (const forbidden of ['innerHTML', 'insertAdjacentHTML', 'outerHTML', 'document.write']) {
      expect(rendererCode.includes(forbidden), forbidden).toBe(false);
    }
  });

  it('the label is rendered as its own secondary element, separate from the comment', () => {
    const view = render(result({
      recommendations: [recommendation({
        reviewExcerpts: [excerpt('原话', { scope: 'course_reference', teacherNames: ['王五'] })],
      })],
    }));
    const module = reviewModuleOf(view.recommended.children[0] as never);
    const item = module?.items[0];
    const label = item?.all().find((node) => node.hasClass('course-card-review-label'));
    const text = item?.all().find((node) => node.hasClass('course-card-review-text'));
    expect(label?.textContent).toBe(REVIEW_LABEL_TEXT.referenceWithTeachers('王五'));
    expect(text?.textContent).toBe('原话');
    // Two cells, so the label cannot be styled as part of the quotation.
    expect(label).not.toBe(text);
  });

  it('17. aria-controls targets are unique across many cards, and never built from page text', () => {
    const card = (name: string): Record<string, unknown> => recommendation({
      course: course({ courseName: name, teacher: `同名 <b>${name}</b>` }),
      reviewExcerpts: [excerpt('内容')],
    });
    const view = render(result({
      recommendations: [card('课程甲'), card('课程乙')],
      ratedButNotRecommended: [ratedEntry({ course: course({ courseName: '课程丙' }), reviewExcerpts: [excerpt('内容')] })],
    }));
    const modules = [
      ...view.recommended.children.map((entry) => reviewModuleOf(entry)),
      ...view.rated.children.map((entry) => reviewModuleOf(entry)),
    ].filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
    expect(modules).toHaveLength(3);

    const ids = modules.map((entry) => entry.list.id);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) {
      // Deterministic, and built only from digits: no course name, no teacher, no angle bracket can reach an id.
      expect(id).toMatch(/^course-review-\d+$/u);
      expect(modules.some((entry) => entry.toggle.getAttribute('aria-controls') === id)).toBe(true);
    }
    // And the ids are a function of the render, so two renders of one result agree.
    const again = render(result({
      recommendations: [card('课程甲'), card('课程乙')],
      ratedButNotRecommended: [ratedEntry({ course: course({ courseName: '课程丙' }), reviewExcerpts: [excerpt('内容')] })],
    }));
    const againIds = [
      ...again.recommended.children.map((entry) => reviewModuleOf(entry)?.list.id),
      ...again.rated.children.map((entry) => reviewModuleOf(entry)?.list.id),
    ];
    expect(againIds).toEqual(ids);
  });

  it('13 and 12. the rendered order and text are exactly what the presentation delivered', () => {
    /*
     * Order is the provider's bounded selection order, carried through the presentation. Sorting here — by scope, by teacher, or by preferring a positive
     * comment — would replace the engine's choice with an editorial one, so the array is rendered as given.
     */
    const delivered = [
      { text: '第一条', scope: 'current_class' as const, teacherNames: ['张三'], teacherValidity: 'valid' as const },
      { text: '第二条', scope: 'course_reference' as const, teacherNames: ['王五'], teacherValidity: 'valid' as const },
      { text: '第三条', scope: 'supplementary' as const, teacherNames: [], teacherValidity: 'missing' as const },
    ];
    const view = render(result({ recommendations: [recommendation({ reviewExcerpts: delivered })] }));
    const module = reviewModuleOf(view.recommended.children[0] as never);
    const rendered = (module?.items ?? []).map((item) => item.all().find((node) => node.hasClass('course-card-review-text'))?.textContent);
    expect(rendered).toEqual(['第一条', '第二条', '第三条']);
    // Code point for code point, with no re-truncation and no ellipsis added by the renderer.
    for (const [index, entry] of delivered.entries()) {
      expect(rendered[index]).toBe(entry.text);
    }
    // And the three labels are the three frozen wordings, in the order delivered.
    const labels = (module?.items ?? []).map((item) => item.all().find((node) => node.hasClass('course-card-review-label'))?.textContent);
    expect(labels).toEqual([
      '张三',
      REVIEW_LABEL_TEXT.referenceWithTeachers('王五'),
      REVIEW_LABEL_TEXT.referenceWithoutTeachers(),
    ]);
  });

  it('24. a fourth excerpt is never shown: the renderer renders the array it is given and no more', () => {
    // The cap is the provider's, and the renderer must not add a "show more" affordance or a slice of its own.
    const four = [1, 2, 3, 4].map((index) => excerpt(`第${index}条`));
    const view = render(result({ recommendations: [recommendation({ reviewExcerpts: four })] }));
    const module = reviewModuleOf(view.recommended.children[0] as never);
    expect(module?.items).toHaveLength(4);
    expect(rendererCode.includes('查看更多')).toBe(false);
    expect(rendererCode.includes('slice(')).toBe(false);
  });
});
