/**
 * PRE-RELEASE-UX-A8 — the conservative oversubscription warning.
 *
 * ## The one interpretation this panel makes
 *
 * Every other row on a card reports something the page published. This one states a comparison: more students have signed up this
 * round than there were places free entering it. The rule is frozen at `selectedThisRound > remainingSeats` with both values
 * present — no threshold, no ratio, no percentage, no probability, and no tier in either direction. When the rule does not hold,
 * the card says NOTHING about competition: a "low risk" or "safe" label would be a reassurance nobody can support.
 *
 * ## What this suite refuses to let in
 *
 * The warning must not smuggle in arithmetic or a prediction, and it must not move anything the ranking decided. Both are asserted
 * directly, on rendered text and on the models, rather than left to review.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CARD_TEXT, isOversubscribed, renderCourseCards } from '../apps/extension/src/sidepanel/course-cards.js';
import {
  toRecommendedCoursePresentation,
} from '../apps/extension/src/sidepanel/course-presentation.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rendererSource = readFileSync(join(repoRoot, 'apps', 'extension', 'src', 'sidepanel', 'course-cards.ts'), 'utf8');
const rendererCode = rendererSource.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1');
const cssSource = readFileSync(join(repoRoot, 'apps', 'extension', 'src', 'sidepanel', 'sidepanel.css'), 'utf8');

/** A canonical course carrying both seat facts, with the given overrides. */
function course(overrides: Record<string, unknown> = {}): never {
  const merged: Record<string, unknown> = {
    source: 'whu',
    courseName: '(2024-2025-1)-MATH101-01 高等数学',
    normalizedName: '高等数学',
    teacher: '周奕华',
    credits: 2,
    remainingSeats: 12,
    selectedThisRound: 27,
    ...overrides,
  };
  const seats = merged['remainingSeats'];
  merged['availability'] = typeof seats === 'number' ? (seats > 0 ? 'available' : 'full') : 'unknown';
  return merged as never;
}

/** A canonical review context. */
function reviewContext(): never {
  return {
    scope: 'teacher',
    reviewCount: 17,
    teacherSpecified: true,
    teacher: '周奕华',
    teacherMatchConfidence: 0.9,
    aggregationNote: '这些数字描述该教师。',
  } as never;
}

/** A recommendation entry. */
function recommendation(overrides: Record<string, unknown> = {}): never {
  return {
    rank: 1,
    course: course(),
    reviewContext: reviewContext(),
    sectionHydration: { status: 'full', available: [], missing: [], rawHydrated: true },
    gradeAggregates: { teacherSet: { names: ['周奕华'] }, teacher: { meanGrade: 88.5, gradedSampleCount: 12 }, course: { meanGrade: 85.1, gradedSampleCount: 254 } },
    reviewSource: { status: 'healthy', queries: 1, rows: 4, empty: 0, unavailable: 0 },
    reviewExcerpts: [],
    recommendationStatus: 'recommended',
    score: 8.42,
    confidence: { value: 0.71, tier: 'high', components: {}, missing: [] },
    reasons: ['给分友好'],
    warnings: [],
    match: { method: 'name_teacher', confidence: 0.95, trusted: true },
    evidenceStrength: [],
    ...overrides,
  } as never;
}

/**
 * A rated-but-not-recommended entry.
 *
 * PRE-RELEASE-UX-A11 added `gradeAggregates` to this canonical entry, so the fixture carries it: the rated mapper now reads it, and a fixture without the field
 * fails loudly rather than rendering nothing.
 */
function ratedEntry(overrides: Record<string, unknown> = {}): never {
  return {
    course: course(),
    rank: 2,
    score: 6.1,
    reviewContext: reviewContext(),
    sectionHydration: { status: 'full', available: [], missing: [], rawHydrated: true },
    gradeAggregates: { teacherSet: { names: ['周奕华'] }, teacher: { meanGrade: 88.5, gradedSampleCount: 12 } },
    reviewExcerpts: [],
    ...overrides,
  } as never;
}

/** An insufficient-evidence entry. */
function insufficientEntry(overrides: Record<string, unknown> = {}): never {
  return {
    course: course(),
    reason: '证据不足',
    match: { method: 'unmatched', confidence: 0.1 },
    reviewSource: { status: 'healthy', queries: 1, rows: 0, empty: 0, unavailable: 0 },
    ...overrides,
  } as never;
}

/** A stub element that records what the renderer built. */
class StubNode {
  readonly children: StubNode[] = [];
  textContent = '';
  className = '';
  hidden = false;

  append(...nodes: StubNode[]): void { this.children.push(...nodes); }

  replaceChildren(...nodes: StubNode[]): void { this.children.length = 0; this.children.push(...nodes); }

  setAttribute(): void {}

  text(): string {
    return this.textContent + this.children.map((child) => child.text()).join('');
  }

  /** Every descendant, depth first. */
  all(): StubNode[] {
    const out: StubNode[] = [];
    for (const child of this.children) out.push(child, ...child.all());
    return out;
  }
}

/** Render one canonical result through the REAL renderer, over the stub DOM. */
function render(result: unknown): { recommended: StubNode; rated: StubNode; insufficient: StubNode } {
  const recommended = new StubNode();
  const rated = new StubNode();
  const insufficient = new StubNode();
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = globals['document'];
  globals['document'] = { createElement: () => new StubNode() };
  try {
    renderCourseCards(
      {
        recommended: recommended as unknown as HTMLElement,
        rated: rated as unknown as HTMLElement,
        insufficient: insufficient as unknown as HTMLElement,
        sections: {
          recommended: new StubNode() as unknown as HTMLElement,
          rated: new StubNode() as unknown as HTMLElement,
          insufficient: new StubNode() as unknown as HTMLElement,
        },
      },
      result as never,
    );
  } finally {
    globals['document'] = previous;
  }
  return { recommended, rated, insufficient };
}

/** A canonical result with the given entries. */
function resultWith(entries: { recommended?: unknown; rated?: unknown; insufficient?: unknown }): never {
  return {
    recommendations: entries.recommended === undefined ? [] : [entries.recommended],
    ratedButNotRecommended: entries.rated === undefined ? [] : [entries.rated],
    insufficientData: entries.insufficient === undefined ? [] : [entries.insufficient],
  } as never;
}

const WARNING = '竞争较高';
const CAVEAT = '不代表选中概率';

describe('PRE-RELEASE-UX-A8 the oversubscription warning', () => {
  describe('the rule, as a pure function', () => {
    it('A: 12 remaining / 27 selected warns', () => {
      expect(isOversubscribed({ remainingSeats: 12, selectedThisRound: 27 })).toBe(true);
    });

    it('B: 27 remaining / 13 selected does not warn', () => {
      expect(isOversubscribed({ remainingSeats: 27, selectedThisRound: 13 })).toBe(false);
    });

    it('C: 5 and 5 is NOT an excess, so it does not warn', () => {
      // Equality means sign-ups exactly fill the free places. Warning here would cry wolf on the boundary.
      expect(isOversubscribed({ remainingSeats: 5, selectedThisRound: 5 })).toBe(false);
    });

    it('D: 0 remaining / 1 selected warns', () => {
      expect(isOversubscribed({ remainingSeats: 0, selectedThisRound: 1 })).toBe(true);
    });

    it('E: a missing remaining count does not warn, whatever was selected', () => {
      expect(isOversubscribed({ remainingSeats: null, selectedThisRound: 999 })).toBe(false);
    });

    it('F: a missing selected count does not warn, whatever remains', () => {
      expect(isOversubscribed({ remainingSeats: 5, selectedThisRound: null })).toBe(false);
    });

    it('G: zero selected never warns', () => {
      for (const remaining of [0, 1, 5, 999]) {
        expect(isOversubscribed({ remainingSeats: remaining, selectedThisRound: 0 }), String(remaining)).toBe(false);
      }
    });

    it('rules out arbitrary thresholds: the warning follows the comparison, not a constant', () => {
      /*
       * The same numbers must flip only when the ORDER changes. A threshold like "more than 20 students" or "fewer than 5 seats" would show up as one of these pairs
       * agreeing when it should not.
       */
      expect(isOversubscribed({ remainingSeats: 100, selectedThisRound: 101 })).toBe(true);
      expect(isOversubscribed({ remainingSeats: 1, selectedThisRound: 2 })).toBe(true);
      expect(isOversubscribed({ remainingSeats: 1000, selectedThisRound: 1000 })).toBe(false);
      expect(isOversubscribed({ remainingSeats: 1, selectedThisRound: 1 })).toBe(false);
    });
  });

  describe('the rendered warning', () => {
    it('H: a recommended card warns when oversubscribed, and carries both sentences', () => {
      const { recommended } = render(resultWith({ recommended: recommendation({ course: course({ remainingSeats: 12, selectedThisRound: 27 }) }) }));
      const text = recommended.text();
      expect(text).toContain(WARNING);
      expect(text).toContain(CAVEAT);
      // The primary sentence and its caveat are both present, in the frozen wording.
      expect(text).toContain(CARD_TEXT.competitionWarning);
      expect(text).toContain(CARD_TEXT.competitionWarningNote);
      // And the two facts it is derived from are still shown above it.
      expect(text).toContain('余量：12');
      expect(text).toContain('本轮已选：27');
    });

    it('H2: a recommended card does NOT warn when not oversubscribed', () => {
      const { recommended } = render(resultWith({ recommended: recommendation({ course: course({ remainingSeats: 27, selectedThisRound: 13 }) }) }));
      expect(recommended.text()).not.toContain(WARNING);
    });

    it('I: a rated card warns on the same inputs', () => {
      const oversubscribed = render(resultWith({ rated: ratedEntry({ course: course({ remainingSeats: 12, selectedThisRound: 27 }) }) }));
      expect(oversubscribed.rated.text()).toContain(WARNING);
      expect(oversubscribed.rated.text()).toContain(CAVEAT);

      const notOversubscribed = render(resultWith({ rated: ratedEntry({ course: course({ remainingSeats: 27, selectedThisRound: 13 }) }) }));
      expect(notOversubscribed.rated.text()).not.toContain(WARNING);
    });

    it('J: the insufficient card behaves the same, because it shares the identity block', () => {
      /*
       * The warning depends only on WHU seat facts, never on review quality, so it follows the shared factual block rather than the review outcome. Asserted on BOTH
       * sides so a future change cannot quietly give this card kind a different rule.
       */
      const oversubscribed = render(resultWith({ insufficient: insufficientEntry({ course: course({ remainingSeats: 12, selectedThisRound: 27 }) }) }));
      expect(oversubscribed.insufficient.text()).toContain(WARNING);

      const notOversubscribed = render(resultWith({ insufficient: insufficientEntry({ course: course({ remainingSeats: 27, selectedThisRound: 13 }) }) }));
      expect(notOversubscribed.insufficient.text()).not.toContain(WARNING);
    });

    it('K: the warning block carries BOTH the claim and its limit', () => {
      // Rendering the claim without the caveat would leave a risk assertion standing on its own, which is what the caveat exists to prevent.
      const { recommended } = render(resultWith({ recommended: recommendation({ course: course({ remainingSeats: 0, selectedThisRound: 1 }) }) }));
      const text = recommended.text();
      expect(text).toContain(WARNING);
      expect(text).toContain('本轮已选人数已超过本轮余量');
      expect(text).toContain('最终结果仍以选课系统为准');
      expect(text).toContain(CAVEAT);
    });

    it('L: score, rank and confidence are identical across the oversubscription boundary', () => {
      /*
       * The warning reports a seat relationship. It must not feed back into anything the engine decided, so two runs that differ ONLY in the seat counts must agree
       * on every ranking field.
       */
      const below = toRecommendedCoursePresentation(recommendation({ course: course({ remainingSeats: 100, selectedThisRound: 1 }) }));
      const above = toRecommendedCoursePresentation(recommendation({ course: course({ remainingSeats: 1, selectedThisRound: 100 }) }));
      expect(above.score).toBe(below.score);
      expect(above.rank).toBe(below.rank);
      expect(above.confidence).toEqual(below.confidence);
      // Availability follows remaining seats only, in both directions.
      expect(below.availability).toBe('available');
      expect(above.availability).toBe('available');
    });
  });

  describe('what the warning must never become', () => {
    it('renders no probability claim in the WARNING BLOCK itself', () => {
      /*
       * Scoped to the warning block, not the whole card. The card's other rows legitimately contain `%`-free but probability-adjacent words in their own right, and
       * the caveat sentence necessarily CONTAINS 「概率」 in order to deny it — so a whole-card ban on that word would forbid the very disclaimer this slice requires.
       * What must not happen is a probability or a ratio being ASSERTED, so the check reads the warning's own two sentences.
       */
      const { recommended } = render(resultWith({ recommended: recommendation({ course: course({ remainingSeats: 12, selectedThisRound: 27 }) }) }));
      const block = recommended.all().find((node) => node.className === 'course-card-competition-warning');
      expect(block, 'the warning block must be rendered').toBeDefined();
      const warningText = block?.text() ?? '';
      expect(warningText).toContain(WARNING);
      // The only mention of probability is the one that denies it.
      const probabilityMentions = warningText.split('概率').length - 1;
      expect(probabilityMentions).toBe(1);
      expect(warningText).toContain(CAVEAT);
      // And no numeric claim of any kind.
      for (const forbidden of ['%', '成功率', '占比', '倍', '低风险', '安全', '好抢', '高风险', '中风险', '难抢', '热门', '冷门']) {
        expect(warningText.includes(forbidden), forbidden).toBe(false);
      }
      // No digits at all: a percentage or a ratio would need one.
      expect(/\d/u.test(warningText), `digits in: ${warningText}`).toBe(false);
    });

    it('the renderer performs no division and no percentage formatting', () => {
      // The rule is a comparison. A ratio would appear as arithmetic on the two seat fields, so those lines are read directly.
      const seatLines = rendererCode
        .split('\n')
        .map((line) => line.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, ''))
        .filter((line) => line.includes('remainingSeats') || line.includes('selectedThisRound'));
      expect(seatLines.length).toBeGreaterThan(0);
      for (const line of seatLines) {
        for (const derived of ['/', 'toFixed', 'Math.', 'percent', 'ratio']) {
          expect(line.includes(derived), `${derived} in: ${line.trim()}`).toBe(false);
        }
      }
      // And the warning copy itself states no probability.
      expect(CARD_TEXT.competitionWarning).toContain('最终结果仍以选课系统为准');
      expect(CARD_TEXT.competitionWarningNote).toContain('不代表选中概率');
    });

    it('the styling is red emphasis on real text, not a colour-only signal', () => {
      /*
       * Accessible as ordinary text: the words carry the meaning, and the colour is emphasis on top. A colour-only channel — a red dot, a coloured border standing in
       * for the sentence — would be unreadable with styling disabled, so the block must contain text and the colour must be declared alongside it.
       */
      expect(cssSource.includes('.course-card-competition-warning')).toBe(true);
      // A red hue is declared for the block.
      expect(/\.course-card-competition-warning\s*\{[^}]*#[0-9a-f]{6}/u.test(cssSource)).toBe(true);
      // The primary sentence is bold.
      expect(/\.course-card-competition-warning-primary\s*\{[^}]*font-weight:\s*700/u.test(cssSource)).toBe(true);
      // No meter, badge or scale SELECTOR was introduced. The search is for CSS rule text, not for words: this file's own comment explains that no badge was added,
      // and a substring scan would fail on that explanation rather than on a rule.
      for (const forbidden of ['progress', 'badge', 'heat', 'meter', 'gauge']) {
        expect(new RegExp(`\\.${forbidden}|-${forbidden}`, 'u').test(cssSource), forbidden).toBe(false);
      }
    });
  });
});
