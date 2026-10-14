/**
 * Text similarity helpers used by the course matcher.
 *
 * Deterministic by construction: no randomness, no locale-dependent collation,
 * and no third-party dependency.
 *
 * @module @course-copilot/core/similarity
 */

/**
 * Extract the character bigrams of a string.
 *
 * Bigrams are used instead of tokens because Chinese course names have no word
 * boundaries; bigram overlap is the standard cheap approach for this case and
 * behaves acceptably for the ASCII course codes that appear alongside them.
 *
 * @param input - already-normalized string.
 * @returns the multiset of bigrams; a single character yields one "bigram" of
 *   itself so short names still compare meaningfully.
 */
export function bigrams(input: string): string[] {
  const chars = [...input];
  if (chars.length <= 1) return chars.length === 1 ? [chars[0] as string] : [];
  const out: string[] = [];
  for (let index = 0; index < chars.length - 1; index += 1) {
    out.push(`${chars[index]}${chars[index + 1]}`);
  }
  return out;
}

/**
 * Sorensen-Dice coefficient over character bigrams.
 *
 * @param left - normalized string.
 * @param right - normalized string.
 * @returns `0..1`, where `1` means identical bigram multisets.
 */
export function diceCoefficient(left: string, right: string): number {
  if (left.length === 0 || right.length === 0) return 0;
  if (left === right) return 1;

  const leftGrams = bigrams(left);
  const rightGrams = bigrams(right);
  if (leftGrams.length === 0 || rightGrams.length === 0) return 0;

  const counts = new Map<string, number>();
  for (const gram of leftGrams) counts.set(gram, (counts.get(gram) ?? 0) + 1);

  let overlap = 0;
  for (const gram of rightGrams) {
    const remaining = counts.get(gram) ?? 0;
    if (remaining > 0) {
      overlap += 1;
      counts.set(gram, remaining - 1);
    }
  }
  return (2 * overlap) / (leftGrams.length + rightGrams.length);
}

/**
 * Longest-common-substring length ratio, an order-sensitive complement to Dice.
 *
 * @param left - normalized string.
 * @param right - normalized string.
 * @returns `0..1` ratio of the longest common substring to the shorter input.
 */
export function longestCommonSubstringRatio(left: string, right: string): number {
  if (left.length === 0 || right.length === 0) return 0;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;

  let best = 0;
  let previous = new Array<number>(longer.length + 1).fill(0);
  for (let i = 1; i <= shorter.length; i += 1) {
    const current = new Array<number>(longer.length + 1).fill(0);
    for (let j = 1; j <= longer.length; j += 1) {
      if (shorter[i - 1] === longer[j - 1]) {
        const cell = (previous[j - 1] ?? 0) + 1;
        current[j] = cell;
        if (cell > best) best = cell;
      }
    }
    previous = current;
  }
  return best / shorter.length;
}

/**
 * Combine both similarity measures into one fuzzy score.
 *
 * A substring relationship (`乒乓球` inside `乒乓球（高级）`) is strong evidence
 * but weaker than equality, so the LCS ratio contributes a bounded bonus rather
 * than dominating.
 *
 * @param left - normalized string.
 * @param right - normalized string.
 * @returns `0..1` similarity, and `1` for an exact match.
 */
export function fuzzyNameScore(left: string, right: string): number {
  if (left.length === 0 || right.length === 0) return 0;
  if (left === right) return 1;
  const dice = diceCoefficient(left, right);
  const lcs = longestCommonSubstringRatio(left, right);
  // Dice is containment-sensitive; LCS breaks ties toward contiguous matches.
  const blended = 0.7 * dice + 0.3 * lcs;
  // A full containment of the shorter name is meaningful on its own.
  const containment = left.includes(right) || right.includes(left)
    ? Math.min(left.length, right.length) / Math.max(left.length, right.length)
    : 0;
  return Math.max(blended, 0.5 + 0.5 * containment);
}
