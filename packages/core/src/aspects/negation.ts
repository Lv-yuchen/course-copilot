/**
 * Local negation for aspect phrases.
 *
 * ## Why `10 - score` is not good enough
 *
 * A blanket inversion is wrong in both directions:
 *
 * - `不签到` is already negated *in the lexicon*, so seeing a `不` and flipping it
 *   again would turn "no attendance checks" into "strict attendance".
 * - `不作业多` is not Chinese. Mechanically inverting `作业多` there would award a
 *   high workload-friendliness score for a sentence nobody wrote.
 *
 * So negation is: explicit rules first, then a **bounded** prefix flip that only
 * fires when a negator sits immediately before the phrase, and never for a phrase
 * marked {@link LexiconEntry.preNegated} or listed in {@link NEGATION_EXCEPTIONS}.
 * When the situation is unclear, no flip happens — a missing signal is much
 * cheaper than a wrong one.
 *
 * @module @course-copilot/core/aspects/negation
 */

import type { LexiconEntry, Polarity } from './types.js';

/**
 * Surface forms that already contain their own negation.
 *
 * A `不` in front of these must not flip them a second time. This is a
 * belt-and-braces list next to {@link LexiconEntry.preNegated}: the flag covers
 * the lexicon, and this covers phrases that reach the extractor from elsewhere.
 */
export const NEGATION_EXCEPTIONS: readonly string[] = [
  '不签到',
  '不点名',
  '不查考勤',
  '不用签到',
  '无考勤',
  '没有考勤',
  '不压分',
  '不卡分',
  '不考试',
  '没有考试',
  '无考试',
  '不推荐',
  '强烈不推荐',
  '不好',
  '不怎么样',
];

/**
 * Negators that can precede a phrase.
 *
 * Deliberately short and local: `没` and `无` cover `没什么作业` / `无作业`, `别`
 * covers `别选`, and the frequency negators cover `几乎不点名`.
 */
const NEGATORS: readonly string[] = [
  '几乎不',
  '基本上不',
  '基本不',
  '从来不',
  '从来不',
  '从不',
  '很少',
  '不怎么',
  '不怎么',
  '没什么',
  '没什么',
  '没有',
  '不用',
  '不需要',
  '不会',
  '不算',
  '不是',
  '不太',
  '不',
  '没',
  '无',
  '别',
];

/**
 * How far left of a phrase a negator may sit and still apply.
 *
 * Five, not three: the longest negator here is two characters (`没有`, `没什么`),
 * and Chinese routinely puts a short subject in between — `老师没有口音` has the
 * negator three characters before the phrase. Five still stays local enough that
 * a `不` from a previous clause cannot reach across.
 */
const NEGATION_WINDOW = 5;

/** Result of looking for a negator in front of a matched phrase. */
export interface NegationCheck {
  negated: boolean;
  /** The negator that applied, when one did. */
  negator?: string;
}

/**
 * Whether a matched phrase is negated by its left context.
 *
 * @param text - the text that was scanned.
 * @param entry - the lexicon rule that matched.
 * @param index - character offset of the match.
 * @returns the decision, including which negator applied.
 */
export function detectNegation(text: string, entry: LexiconEntry, index: number): NegationCheck {
  // An explicitly pre-negated rule can never be flipped again.
  if (entry.preNegated === true) return { negated: false };
  if (NEGATION_EXCEPTIONS.includes(entry.phrase)) return { negated: false };

  const windowStart = Math.max(0, index - NEGATION_WINDOW);
  const before = text.slice(windowStart, index);
  if (before.length === 0) return { negated: false };

  for (const negator of NEGATORS) {
    if (!before.endsWith(negator)) continue;
    // `不作业多`: a negator in front of a *negative* rule would invert it into
    // praise, and that construction does not occur as a real opinion. Only a
    // positive rule may be negated into criticism.
    if (entry.polarity === 'negative') return { negated: false };
    return { negated: true, negator };
  }
  return { negated: false };
}

/**
 * Apply a negation decision to a rule's polarity.
 *
 * @param polarity - the rule's own polarity.
 * @param negated - whether the left context negates it.
 * @returns the effective polarity.
 */
export function applyNegation(polarity: Polarity, negated: boolean): Polarity {
  if (!negated) return polarity;
  return polarity === 'positive' ? 'negative' : 'positive';
}
