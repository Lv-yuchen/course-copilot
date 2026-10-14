/**
 * PRE-RELEASE-UX-A18 — the importance controls, as a pure model.
 *
 * ## Why 10 and not 3
 *
 * An earlier version of this product exposed four tiers 0..3. That could not express the shipped defaults, and the reason is arithmetic rather than
 * preference: the engine's own default weighting is `0.5 / 0.3 / 0.15 / 0.05`, and `0.5 : 0.3 : 0.15 : 0.05` reduces to `10 : 6 : 3 : 1`. A 0..3 scale has no
 * integers in that ratio — an exhaustive check of all 256 combinations finds NONE that normalises to the defaults — so a tier control would have changed the
 * default ranking the moment the editor was opened. `10 / 6 / 3 / 1` is exact.
 *
 * ## What this file is responsible for
 *
 * The four values, their bounds, the all-zero refusal, the displayed proportion and the engine payload. Everything here is a pure function of the numbers, so
 * nothing in it can depend on the DOM or on a request.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PREFERENCE_CONTROLS,
  PREFERENCE_DEFAULTS,
  PREFERENCE_MAX,
  PREFERENCE_MIN,
  PREFERENCE_PROBLEM_TEXT,
  PREFERENCE_STEP,
  defaultPreferenceValues,
  isUsableImportance,
  preferencePayloadOf,
  preferencePercentagesOf,
  preferenceProblemOf,
  samePreferenceValues,
} from '../apps/extension/src/sidepanel/preferences.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('PRE-RELEASE-UX-A18 the control table', () => {
  it('C. names exactly the four rankable dimensions, in the frozen order', () => {
    expect(PREFERENCE_CONTROLS.map((control) => control.key)).toEqual([
      'gradeFriendliness',
      'workloadFriendliness',
      'attendanceFriendliness',
      'overallScore',
    ]);
  });

  it('G. exposes the frozen labels and nothing else', () => {
    expect(PREFERENCE_CONTROLS.map((control) => control.label)).toEqual(['成绩友好', '工作量轻松', '考勤宽松', '学生评价']);
    /*
     * The two dimensions that cannot move a course up or down must have no control, and the duplicate name for overallScore must not appear. A control for
     * either would be a control that does nothing, which is worse than no control.
     */
    const keys = PREFERENCE_CONTROLS.map((control) => control.key).join(',');
    for (const forbidden of ['teachingQuality', 'examFriendliness', 'studentSentiment', 'preset', 'minReviewCount', 'requireAvailableSeats']) {
      expect(keys.includes(forbidden), forbidden).toBe(false);
    }
    // And no label names them either.
    const labels = PREFERENCE_CONTROLS.map((control) => control.label).join(',');
    for (const forbidden of ['教学质量', '考试友好', '综合口碑']) {
      expect(labels.includes(forbidden), forbidden).toBe(false);
    }
  });

  it('the bounds are the frozen 0..10 whole-number scale', () => {
    expect(PREFERENCE_MIN).toBe(0);
    expect(PREFERENCE_MAX).toBe(10);
    expect(PREFERENCE_STEP).toBe(1);
  });
});

describe('PRE-RELEASE-UX-A18 the defaults', () => {
  it('D. are the ratio that reproduces the engine\'s own default weighting', () => {
    expect(PREFERENCE_DEFAULTS).toEqual({
      gradeFriendliness: 10,
      workloadFriendliness: 6,
      attendanceFriendliness: 3,
      overallScore: 1,
    });
    /*
     * The arithmetic the choice rests on, asserted rather than described: the sum is 20, and each share is the engine's default weight exactly. If any of
     * these four numbers changed, the default ranking would change with it.
     */
    const defaults = PREFERENCE_DEFAULTS;
    const total = defaults.gradeFriendliness + defaults.workloadFriendliness + defaults.attendanceFriendliness + defaults.overallScore;
    expect(total).toBe(20);
    expect(defaults.gradeFriendliness / total).toBe(0.5);
    expect(defaults.workloadFriendliness / total).toBeCloseTo(0.3, 10);
    expect(defaults.attendanceFriendliness / total).toBeCloseTo(0.15, 10);
    expect(defaults.overallScore / total).toBeCloseTo(0.05, 10);
  });

  it('F. 恢复默认 yields a fresh copy, so an edit cannot corrupt the table', () => {
    const values = defaultPreferenceValues();
    expect(values).toEqual(PREFERENCE_DEFAULTS);
    values.gradeFriendliness = 0;
    expect(PREFERENCE_DEFAULTS.gradeFriendliness).toBe(10);
    expect(defaultPreferenceValues()).toEqual(PREFERENCE_DEFAULTS);
    // The table itself is frozen.
    expect(Object.isFrozen(PREFERENCE_DEFAULTS)).toBe(true);
  });

  it('the displayed defaults are the numbers a user sees', () => {
    // 10/6/3/1 out of 20 is 50% / 30% / 15% / 5% — the four figures the markup shows.
    expect(preferencePercentagesOf(PREFERENCE_DEFAULTS)).toEqual([50, 30, 15, 5]);
  });
});

describe('PRE-RELEASE-UX-A18 value validation', () => {
  it('E. accepts only whole numbers inside the range', () => {
    for (const good of [0, 1, 5, 9, 10]) expect(isUsableImportance(good), String(good)).toBe(true);
    for (const bad of [-1, 11, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '5', null, undefined, true]) {
      expect(isUsableImportance(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('reports an unusable value by NAME rather than clamping it', () => {
    // Silently turning a bug into 10 would rank a course by a number the user never chose.
    const problem = preferenceProblemOf({ gradeFriendliness: 11, workloadFriendliness: 6, attendanceFriendliness: 3, overallScore: 1 });
    expect(problem).toEqual({ code: 'unusable_value', key: 'gradeFriendliness' });
    expect(PREFERENCE_PROBLEM_TEXT.unusable_value).toContain('0 到 10');
    // And it is reported before the all-zero check, so a NaN set names the value rather than claiming everything is zero.
    expect(preferenceProblemOf({ gradeFriendliness: Number.NaN, workloadFriendliness: 0, attendanceFriendliness: 0, overallScore: 0 }))
      .toEqual({ code: 'unusable_value', key: 'gradeFriendliness' });
  });

  it('A. refuses an all-zero choice rather than substituting the defaults', () => {
    const zero = { gradeFriendliness: 0, workloadFriendliness: 0, attendanceFriendliness: 0, overallScore: 0 };
    expect(preferenceProblemOf(zero)).toEqual({ code: 'all_zero' });
    expect(PREFERENCE_PROBLEM_TEXT.all_zero).toBe('至少有一项重要程度需要大于 0。');
    expect(preferenceProblemOf(zero)).not.toBeNull();
  });

  it('B. accepts as soon as ONE dimension is non-zero', () => {
    for (const key of ['gradeFriendliness', 'workloadFriendliness', 'attendanceFriendliness', 'overallScore']) {
      const values = { gradeFriendliness: 0, workloadFriendliness: 0, attendanceFriendliness: 0, overallScore: 0, [key]: 1 };
      expect(preferenceProblemOf(values), key).toBeNull();
    }
  });

  it('C. and the refusal clears when the choice becomes valid', () => {
    const values = { gradeFriendliness: 0, workloadFriendliness: 0, attendanceFriendliness: 0, overallScore: 0 };
    expect(preferenceProblemOf(values)).not.toBeNull();
    values.overallScore = 1;
    expect(preferenceProblemOf(values)).toBeNull();
    values.overallScore = 0;
    expect(preferenceProblemOf(values)).not.toBeNull();
  });
});

describe('PRE-RELEASE-UX-A18 the displayed proportion', () => {
  it('is the share of the four values, so nobody has to reach 100', () => {
    expect(preferencePercentagesOf({ gradeFriendliness: 10, workloadFriendliness: 6, attendanceFriendliness: 3, overallScore: 1 })).toEqual([50, 30, 15, 5]);
    // The user's own example: 10 / 10 / 5 / 5 out of 30.
    expect(preferencePercentagesOf({ gradeFriendliness: 10, workloadFriendliness: 10, attendanceFriendliness: 5, overallScore: 5 })).toEqual([33, 33, 17, 17]);
    // A single dimension carries everything.
    expect(preferencePercentagesOf({ gradeFriendliness: 7, workloadFriendliness: 0, attendanceFriendliness: 0, overallScore: 0 })).toEqual([100, 0, 0, 0]);
    // Equal values are equal shares.
    expect(preferencePercentagesOf({ gradeFriendliness: 4, workloadFriendliness: 4, attendanceFriendliness: 4, overallScore: 4 })).toEqual([25, 25, 25, 25]);
  });

  it('reports zero for a zero total rather than dividing by it', () => {
    // `preferenceProblemOf` refuses that set, so this is a guard rather than a state the UI shows.
    expect(preferencePercentagesOf({ gradeFriendliness: 0, workloadFriendliness: 0, attendanceFriendliness: 0, overallScore: 0 })).toEqual([0, 0, 0, 0]);
  });

  it('is derived from the values it is shown beside, so the two cannot disagree', () => {
    const values = { gradeFriendliness: 3, workloadFriendliness: 1, attendanceFriendliness: 1, overallScore: 1 };
    // 3/6 = 50%, 1/6 = 17% each.
    expect(preferencePercentagesOf(values)).toEqual([50, 17, 17, 17]);
  });
});

describe('PRE-RELEASE-UX-A18 the engine payload', () => {
  it('transports exactly the four relative values, unrenamed and unnormalised', () => {
    const values = { gradeFriendliness: 10, workloadFriendliness: 6, attendanceFriendliness: 3, overallScore: 1 };
    const payload = preferencePayloadOf(values);
    expect(Object.keys(payload).sort()).toEqual(['attendanceFriendliness', 'gradeFriendliness', 'overallScore', 'workloadFriendliness']);
    // The whole importance values, NOT percentages and NOT normalised weights: the engine owns that arithmetic.
    expect(payload).toEqual(values);
    for (const value of Object.values(payload)) expect(Number.isInteger(value)).toBe(true);
    // No fifth key, and no second name for overallScore.
    expect(Object.hasOwn(payload, 'studentSentiment')).toBe(false);
    expect(Object.hasOwn(payload, 'preset')).toBe(false);
    expect(Object.hasOwn(payload, 'teachingQuality')).toBe(false);
    expect(Object.hasOwn(payload, 'examFriendliness')).toBe(false);
  });

  it('cannot carry an all-zero payload, because the caller refuses it first', () => {
    const zero = { gradeFriendliness: 0, workloadFriendliness: 0, attendanceFriendliness: 0, overallScore: 0 };
    expect(preferenceProblemOf(zero)).not.toBeNull();
    // The payload function itself is a pure copy, so the refusal has to happen before it — which is what the panel does.
    expect(preferencePayloadOf(zero)).toEqual(zero);
  });
});

describe('PRE-RELEASE-UX-A18 the markup', () => {
  const html = readFileSync(join(repoRoot, 'apps', 'extension', 'src', 'sidepanel', 'sidepanel.html'), 'utf8');

  it('A and B. the section is a collapsed disclosure with a real, worded summary', () => {
    /*
     * `<details>` without `open` is the collapsed default, and `<summary>` is the browser's own disclosure control — keyboard operable, announced with its
     * state, and readable by a test. A hand-rolled div-and-triangle would have to reimplement all three.
     */
    const section = /<details[^>]*id="preferences"[^>]*>([\s\S]*?)<\/details>/u.exec(html)?.[0] ?? '';
    expect(section.length).toBeGreaterThan(0);
    // No `open` attribute, so it starts collapsed and a new panel render cannot inherit an expansion.
    expect(/<details[^>]*id="preferences"[^>]*\sopen/u.test(section)).toBe(false);
    expect(section).toContain('<summary class="panel-preferences-summary">个性化偏好</summary>');
  });

  it('C. carries exactly the four rows the table names, each with its own label', () => {
    /*
     * Cross-checked against {@link PREFERENCE_CONTROLS} rather than restated: a label or a key that drifts between the markup and the model fails here. The
     * rows are static so the controls exist before any script runs, which is exactly why the two could drift.
     */
    const rows = [...html.matchAll(/data-preference="(\w+)"/gu)].map((match) => match[1] ?? '');
    expect(rows).toEqual(PREFERENCE_CONTROLS.map((control) => control.key));
    for (const control of PREFERENCE_CONTROLS) {
      // The visible label, associated with its slider by `for`, so the control is announced with its own name.
      expect(html).toContain(`for="preference-${control.key}">${control.label}</label>`);
      expect(html).toContain(`id="preference-${control.key}"`);
    }
    // And no fifth row for a dimension that cannot rank.
    expect(rows).toHaveLength(4);
  });

  it('D. states each slider\'s default from the model\'s own numbers', () => {
    for (const control of PREFERENCE_CONTROLS) {
      const slider = new RegExp(`<input[^>]*id="preference-${control.key}"[^>]*>`, 'u').exec(html)?.[0] ?? '';
      expect(slider.length, control.key).toBeGreaterThan(0);
      expect(slider, control.key).toContain(`value="${PREFERENCE_DEFAULTS[control.key]}"`);
      // The read-out beside it agrees, and the percentage is the one the model computes for these defaults.
      const index = PREFERENCE_CONTROLS.findIndex((entry) => entry.key === control.key);
      expect(html, control.key).toContain(`id="preference-value-${control.key}">${PREFERENCE_DEFAULTS[control.key]}/${PREFERENCE_MAX}<`);
      expect(html, control.key).toContain(`id="preference-percent-${control.key}">${preferencePercentagesOf(PREFERENCE_DEFAULTS)[index]}%<`);
    }
  });

  it('E. bounds every slider by the model\'s own min, max and step', () => {
    /*
     * The native control enforces this, which is why the markup is the right place to assert it: a slider that allowed 11 would make the model's own
     * validator fire on a value the browser produced.
     */
    for (const control of PREFERENCE_CONTROLS) {
      const slider = new RegExp(`<input[^>]*id="preference-${control.key}"[^>]*>`, 'u').exec(html)?.[0] ?? '';
      expect(slider, control.key).toContain(`min="${PREFERENCE_MIN}"`);
      expect(slider, control.key).toContain(`max="${PREFERENCE_MAX}"`);
      expect(slider, control.key).toContain(`step="${PREFERENCE_STEP}"`);
      expect(slider, control.key).toContain('type="range"');
    }
  });

  it('F. offers 恢复默认 and one explicit update action, both real buttons', () => {
    expect(html).toContain('<button type="button" class="panel-preferences-reset" id="preferences-reset">恢复默认</button>');
    expect(html).toContain('<button type="button" class="panel-preferences-apply" id="preferences-apply">更新推荐</button>');
    // The refusal is its own element, empty and hidden until a choice is unusable.
    expect(/<p class="panel-preferences-problem" id="preferences-problem" hidden><\/p>/u.test(html)).toBe(true);
  });

  it('the panel wires the controls from the model rather than from hard-coded ids', () => {
    const panel = readFileSync(join(repoRoot, 'apps', 'extension', 'src', 'sidepanel', 'sidepanel.ts'), 'utf8');
    // The row addresses are DERIVED from each key, so a fifth dimension could not be addressed inconsistently.
    expect(panel).toContain('`preference-${key}`');
    expect(panel).toContain('`preference-value-${key}`');
    expect(panel).toContain('`preference-percent-${key}`');
    // And the wording comes from the model's table, not from a second copy.
    expect(panel).toContain('PREFERENCE_PROBLEM_TEXT[problem.code]');
    expect(panel).toContain('defaultPreferenceValues()');
    expect(panel).toContain('preferencePayloadOf(values)');
  });
});

describe('PRE-RELEASE-UX-A18 change detection', () => {
  it('tells the defaults from an edited set', () => {
    expect(samePreferenceValues(PREFERENCE_DEFAULTS, defaultPreferenceValues())).toBe(true);
    expect(samePreferenceValues(PREFERENCE_DEFAULTS, { ...PREFERENCE_DEFAULTS, overallScore: 2 })).toBe(false);
    // Order of argument does not matter.
    expect(samePreferenceValues(defaultPreferenceValues(), PREFERENCE_DEFAULTS)).toBe(true);
  });
});

