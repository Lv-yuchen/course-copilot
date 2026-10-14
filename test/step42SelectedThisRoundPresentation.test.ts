/**
 * PRE-RELEASE-UX-A6 — `selectedThisRound` reaches the presentation MODELS, and nothing else.
 *
 * ## What this proves, and the line it refuses to cross
 *
 * A5 carried 本轮已选 into `NormalizedCourse`. This slice makes the same fact available to the three presentation models the cards are built from. It does NOT
 * render it: the DOM negative assertion at the end is what keeps the slice from becoming the UI slice by accident, and it is asserted against the BUILT panel as
 * well as the sources, because the artifact is what a reader would actually see.
 *
 * ## Why the three models are tested together
 *
 * All three extend one `CourseIdentityPresentation`, so the shared identity mapper is the only place the fact is written. Testing recommended AND
 * rated-but-not-recommended is the release requirement — 本轮已选 must not be restricted to recommended courses — and the insufficient model is checked because it
 * shares the same half rather than because its card is being redesigned.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  toInsufficientCoursePresentation,
  toRatedCoursePresentation,
  toRecommendedCoursePresentation,
} from '../apps/extension/src/sidepanel/course-presentation.js';
import { CARD_TEXT, renderCourseCards } from '../apps/extension/src/sidepanel/course-cards.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mapperPath = join(repoRoot, 'apps', 'extension', 'src', 'sidepanel', 'course-presentation.ts');
const mapperSource = readFileSync(mapperPath, 'utf8');
const mapperCode = mapperSource.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1');
/** The card renderer's source and its comment-stripped code, for the styling assertion. */
const rendererSource = readFileSync(join(repoRoot, 'apps', 'extension', 'src', 'sidepanel', 'course-cards.ts'), 'utf8');
const rendererCode = rendererSource.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1');

/**
 * The built panel with esbuild's `\uXXXX` escaping undone.
 *
 * esbuild rewrites non-ASCII string literals as escape sequences, so a raw `includes('本轮已选')` against the bundle answers `false`
 * for text that IS present. Measured: the raw panel does not contain 竞争较高, while the decoded panel contains the whole sentence.
 * A forbidden-vocabulary scan over the RAW bundle therefore passes vacuously — it would report "no forbidden label" even if every
 * label were there. Every string assertion against a bundled artifact must decode first.
 */
const builtPanel = ((): string => {
  const raw = readFileSync(join(repoRoot, 'apps', 'extension', 'dist', 'sidepanel', 'sidepanel.js'), 'utf8');
  return raw.replace(/\\u([0-9a-fA-F]{4})/gu, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
})();
/**
 * The mapper with comments removed, for the vocabulary check.
 *
 * Separate from {@link mapperCode} only to make the intent obvious: a token scan must never be run against prose that names the forbidden concepts in order to
 * forbid them.
 */
const mapperCodeWithoutComments = mapperCode;

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
  /*
   * Availability is DERIVED LAST, and from the FINAL `remainingSeats`, because that is what the canonical pipeline guarantees: it is `availabilityFromSeats(remainingSeats)`
   * and nothing else. Two fixture bugs came from getting this wrong — a hardcoded `'available'` made a full course look open, and deriving before the spread let the
   * default `remainingSeats: 12` restore an availability the override had asked to remove.
   */
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

/** A canonical grade aggregate. */
function grade(meanGrade: number, gradedSampleCount: number): never {
  return { meanGrade, gradedSampleCount } as never;
}

/** A recommendation entry. Only the fields the mapper reads. */
function recommendation(overrides: Record<string, unknown> = {}): never {
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
    reasons: ['给分友好'],
    warnings: [],
    match: { method: 'name_teacher', confidence: 0.95, trusted: true },
    // Read per aspect by the mapper; empty is fine, because these cases are about the seat facts.
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
    gradeAggregates: { teacherSet: { names: ['周奕华'] }, teacher: grade(88.5, 12) },
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

/* ------------------------------------------------------------------ a minimal DOM, enough for the card renderer */

/** A stub element that records what the renderer built. */
class StubNode {
  readonly children: StubNode[] = [];
  textContent = '';
  className = '';
  hidden = false;

  append(...nodes: StubNode[]): void { this.children.push(...nodes); }

  replaceChildren(...nodes: StubNode[]): void { this.children.length = 0; this.children.push(...nodes); }

  setAttribute(): void {}

  /** All text in the subtree, concatenated the way adjacent inline elements read. */
  text(): string {
    return this.textContent + this.children.map((child) => child.text()).join('');
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

/** A canonical result with one entry of each kind. */
function resultWith(entries: { recommended?: unknown; rated?: unknown; insufficient?: unknown }): never {
  return {
    recommendations: entries.recommended === undefined ? [] : [entries.recommended],
    ratedButNotRecommended: entries.rated === undefined ? [] : [entries.rated],
    insufficientData: entries.insufficient === undefined ? [] : [entries.insufficient],
  } as never;
}

describe('PRE-RELEASE-UX-A6 selectedThisRound reaches the presentation models', () => {
  it('A: recommended carries both seat facts side by side', () => {
    const view = toRecommendedCoursePresentation(recommendation({ course: course({ remainingSeats: 12, selectedThisRound: 27 }) }));
    expect(view.remainingSeats).toBe(12);
    expect(view.selectedThisRound).toBe(27);
  });

  it('B: recommended preserves a real 0', () => {
    // "Nobody has signed up yet" is a real answer; a truthiness test in the mapper would erase it.
    const view = toRecommendedCoursePresentation(recommendation({ course: course({ remainingSeats: 0, selectedThisRound: 0 }) }));
    expect(view.selectedThisRound).toBe(0);
    expect(view.remainingSeats).toBe(0);
  });

  it('C: recommended reports null when the page did not state it', () => {
    const view = toRecommendedCoursePresentation(recommendation({ course: course({ selectedThisRound: undefined }) }));
    expect(view.selectedThisRound).toBeNull();
    // The OTHER seat fact is unaffected by a missing sibling.
    expect(view.remainingSeats).toBe(12);
  });

  it('D: rated-but-not-recommended carries it too — the requirement is not recommendation-only', () => {
    const view = toRatedCoursePresentation(ratedEntry({ course: course({ remainingSeats: 12, selectedThisRound: 27 }) }));
    expect(view.remainingSeats).toBe(12);
    expect(view.selectedThisRound).toBe(27);
  });

  it('E: rated preserves a real 0', () => {
    expect(toRatedCoursePresentation(ratedEntry({ course: course({ selectedThisRound: 0 }) })).selectedThisRound).toBe(0);
  });

  it('F: rated reports null when the page did not state it', () => {
    expect(toRatedCoursePresentation(ratedEntry({ course: course({ selectedThisRound: undefined }) })).selectedThisRound).toBeNull();
  });

  it('G: the insufficient model carries it on the same rule, because it shares the identity half', () => {
    expect(toInsufficientCoursePresentation(insufficientEntry({ course: course({ selectedThisRound: 0 }) })).selectedThisRound).toBe(0);
    expect(toInsufficientCoursePresentation(insufficientEntry({ course: course({ selectedThisRound: undefined }) })).selectedThisRound).toBeNull();
    expect(toInsufficientCoursePresentation(insufficientEntry({ course: course({ selectedThisRound: 27 }) })).selectedThisRound).toBe(27);
  });

  it('H: the fact changes nothing the ranking or admission decided', () => {
    /*
     * The boundary this slice could most easily break: a large selected-this-round beside free seats must not move the score, the rank, the confidence or the
     * admission reading. Each is asserted against the SAME input with the fact absent.
     */
    const withFact = toRecommendedCoursePresentation(recommendation({ course: course({ remainingSeats: 5, selectedThisRound: 999 }) }));
    const withoutFact = toRecommendedCoursePresentation(recommendation({ course: course({ remainingSeats: 5, selectedThisRound: undefined }) }));
    expect(withFact.score).toBe(withoutFact.score);
    expect(withFact.rank).toBe(withoutFact.rank);
    expect(withFact.confidence).toEqual(withoutFact.confidence);
    expect(withFact.availability).toBe(withoutFact.availability);
    // And availability still follows remaining seats ALONE.
    expect(withFact.availability).toBe('available');
    expect(toRecommendedCoursePresentation(recommendation({ course: course({ remainingSeats: 0, selectedThisRound: 0 }) })).availability).toBe('full');
    expect(toRecommendedCoursePresentation(recommendation({ course: course({ remainingSeats: undefined, selectedThisRound: 7 }) })).availability).toBe('unknown');
  });

  it('the mapper computes nothing from the two seat facts', () => {
    /*
     * A ratio, a percentage or a comparison between 余量 and 本轮已选 is interpretation, and this mapper transports facts. Any arithmetic operator on a line that
     * names either seat field therefore fails here.
     */
    const seatLines = mapperCode
      .split('\n')
      .map((line) => line.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, ''))
      .filter((line) => line.includes('remainingSeats') || line.includes('selectedThisRound'));
    expect(seatLines.length).toBeGreaterThan(0);
    for (const line of seatLines) {
      for (const derived of ['/', '*', '+', 'ratio', 'percent', 'Math.', ' > ', ' < ']) {
        expect(line.includes(derived), `${derived} in: ${line.trim()}`).toBe(false);
      }
    }
    /*
     * And no competition vocabulary is COMPUTED anywhere in the mapper. Comments are stripped first: this file's own prose names the forbidden concepts while
     * forbidding them, and a raw scan would fail on the map's own explanation of what it does not do.
     */
    const forbidden = ['competition', 'risk', 'popularity', 'selectedCount', 'totalSelected'];
    for (const word of forbidden) {
      expect(mapperCodeWithoutComments.includes(word), word).toBe(false);
    }
  });

  it('the built panel carries the label now, because it renders it', () => {
    /*
     * SUPERSEDED IN PRE-RELEASE-UX-A7. A6 asserted the renderer did NOT yet read the fact — the negative assertion that kept the data slice from becoming the UI
     * slice. A7 IS that UI slice, so the assertion is inverted rather than deleted.
     */
    const builtPanel = readFileSync(join(repoRoot, 'apps', 'extension', 'dist', 'sidepanel', 'sidepanel.js'), 'utf8');
    expect(builtPanel.includes('本轮已选')).toBe(true);
  });

  describe('PRE-RELEASE-UX-A7 the card renders 本轮已选 as a raw fact', () => {
    it('A: recommended shows both seat facts side by side', () => {
      const { recommended } = render(resultWith({
        recommended: recommendation({ course: course({ remainingSeats: 12, selectedThisRound: 27 }) }),
      }));
      expect(recommended.text()).toContain('余量：12');
      expect(recommended.text()).toContain('本轮已选：27');
    });

    it('B: a real zero renders as 0, not as unknown', () => {
      const { recommended } = render(resultWith({
        recommended: recommendation({ course: course({ remainingSeats: 5, selectedThisRound: 0 }) }),
      }));
      expect(recommended.text()).toContain('本轮已选：0');
      expect(recommended.text()).not.toContain('本轮已选：未知');
    });

    it('C: missing renders as 未知', () => {
      const { recommended } = render(resultWith({
        recommended: recommendation({ course: course({ selectedThisRound: undefined }) }),
      }));
      expect(recommended.text()).toContain('本轮已选：未知');
    });

    it('D: a full course keeps its existing 余量 wording AND still shows the count', () => {
      const { recommended } = render(resultWith({
        recommended: recommendation({ course: course({ remainingSeats: 0, selectedThisRound: 27 }) }),
      }));
      const text = recommended.text();
      // The existing full-course sentence is untouched by this slice.
      expect(text).toContain('余量：0（已满）');
      // And the new fact is INDEPENDENT of it.
      expect(text).toContain('本轮已选：27');
    });

    it('E: rated cards render both too — nonzero, zero and unknown', () => {
      const nonzero = render(resultWith({ rated: ratedEntry({ course: course({ remainingSeats: 12, selectedThisRound: 27 }) }) }));
      expect(nonzero.rated.text()).toContain('余量：12');
      expect(nonzero.rated.text()).toContain('本轮已选：27');

      const zero = render(resultWith({ rated: ratedEntry({ course: course({ selectedThisRound: 0 }) }) }));
      expect(zero.rated.text()).toContain('本轮已选：0');

      const unknown = render(resultWith({ rated: ratedEntry({ course: course({ selectedThisRound: undefined }) }) }));
      expect(unknown.rated.text()).toContain('本轮已选：未知');
    });

    it('F: the fact is labelled with the school wording, never a synonym', () => {
      const { recommended } = render(resultWith({
        recommended: recommendation({ course: course({ remainingSeats: 999, selectedThisRound: 27 }) }),
      }));
      const text = recommended.text();
      /*
       * UPDATED IN PRE-RELEASE-UX-A8. `总已选`, `已选总数`, `热度` and `竞争人数` remain banned outright. `已选人数` is no longer banned as a BARE string: A8's required
       * warning sentence legitimately contains it inside 「本轮已选人数已超过本轮余量」, where it is qualified by 本轮 and is not standing in as the row's label. So the
       * check is that the label row is the school's short form and that the only occurrence of the longer phrase is the qualified one.
       */
      expect(text).toContain('本轮已选：27');
      for (const wrong of ['总已选', '已选总数', '热度', '竞争人数']) {
        expect(text.includes(wrong), wrong).toBe(false);
      }
      // The only 「已选人数」 present is the qualified one inside the warning; no warning is due here, so there must be none at all.
      expect(text.includes('已选人数')).toBe(false);
      expect(CARD_TEXT.selectedThisRound).toBe('本轮已选');
      /*
       * And the synonyms appear NOWHERE in the shipped panel either — not even in prose.
       *
       * Comments are preserved into the bundle, so a source comment that names a rejected synonym puts that label in the artifact. A reader auditing the shipped
       * file, or a future gate scanning it, would then find the forbidden wording and have to decide whether it was rendered. This keeps that ambiguity out: the
       * rejected synonyms are listed HERE, in a test, and nowhere in the product.
       *
       * The scan reads the DECODED bundle, since esbuild escapes non-ASCII literals — see `builtPanel`. The decode is checked first, so a broken decode fails loudly
       * instead of making every assertion below pass for the wrong reason.
       */
      expect(builtPanel.includes('本轮已选'), 'the decode must produce readable Chinese').toBe(true);
      for (const wrong of ['总已选', '已选总数', '热度', '竞争人数']) {
        expect(builtPanel.includes(wrong), `${wrong} must not appear in the shipped panel`).toBe(false);
      }
      /*
       * `已选人数` is allowed ONLY inside A8's qualified warning phrase. The count is asserted against the decoded bundle, and the phrase is confirmed present, so the
       * comparison cannot pass because both sides are zero.
       */
      const qualified = builtPanel.split('本轮已选人数已超过本轮余量').length - 1;
      expect(qualified, 'the qualified warning phrase must be present').toBeGreaterThan(0);
      expect(builtPanel.split('已选人数').length - 1, 'every 已选人数 must be the qualified warning phrase').toBe(qualified);
    });

    it('G: the raw facts carry no interpretation when this round is NOT oversubscribed', () => {
      /*
       * UPDATED IN PRE-RELEASE-UX-A8. A7 asserted no competition reading at all; A8 introduces exactly ONE, for a strict excess. To keep this test about the FACTS, the
       * inputs here are deliberately below or AT the boundary, so no warning is due and what remains on the card is the two raw rows.
       */
      const { recommended, rated, insufficient } = render(resultWith({
        recommended: recommendation({ course: course({ remainingSeats: 999, selectedThisRound: 5 }) }),
        rated: ratedEntry({ course: course({ remainingSeats: 500, selectedThisRound: 500 }) }),
        insufficient: insufficientEntry({ course: course({ remainingSeats: 300, selectedThisRound: 1 }) }),
      }));
      const rendered = `${recommended.text()}\n${rated.text()}\n${insufficient.text()}`;
      for (const forbidden of ['高风险', '中风险', '低风险', '竞争风险', '竞争激烈', '难抢', '好抢', '热门', '冷门', '%', '概率', '占比', '已占用', '竞争较高']) {
        expect(rendered.includes(forbidden), forbidden).toBe(false);
      }
      expect(rendered).toContain('本轮已选：5');
      expect(rendered).toContain('余量：999');
    });

    it('H: this slice adds no risk-related styling vocabulary', () => {
      /*
       * A colour would arrive as a CSS class, so the renderer's own vocabulary is what is checked.
       *
       * UPDATED IN PRE-RELEASE-UX-A8, which legitimately introduces the word `competition` for its one warning. What stays forbidden is the vocabulary of a TIER or
       * an ALARM: no risk tier, no danger colour, no hot/cold label. `warn` is likewise absent from this list because `presentation.warnings` is the ENGINE's own
       * array of written caveats, rendered verbatim since an earlier part — banning the substring failed on that legitimate code.
       */
      for (const forbidden of ['risk', 'danger', 'hot']) {
        expect(rendererCode.includes(forbidden), forbidden).toBe(false);
      }
      // The warning names itself with the conservative wording, not a tier.
      expect(rendererCode.includes('竞争较高')).toBe(true);
      for (const tier of ['高风险', '中风险', '低风险', '安全']) {
        expect(rendererCode.includes(tier), tier).toBe(false);
      }
    });

    it('I: availability semantics are unchanged by a large count', () => {
      const { recommended } = render(resultWith({
        recommended: recommendation({ course: course({ remainingSeats: 5, selectedThisRound: 999 }) }),
      }));
      // The admission label still follows remaining seats alone.
      expect(recommended.text()).toContain('可选状态：有余量');
    });
  });
});
