/**
 * Bounded review excerpts — the ONE place a student's comment is turned into something shippable.
 *
 * ## Why this lives in the provider
 *
 * The provider already partitions a course's corpus into `matched` / `disjoint` / `unassigned` before it fans rows out into
 * teacher buckets, and that partition is the authoritative answer to "which rows relate to this class". Everything downstream —
 * the engine, the presentation model, the renderer — receives teacher identities rather than recomputing them, and this module
 * exists so that rule holds for comment text too. A renderer that had to decide whether a comment belongs to 张三 or to the whole
 * course would be re-doing teacher matching, badly and in three places.
 *
 * ## Why the rows are projected rather than transported
 *
 * A cleaned row carries the untouched provider payload, the raw grade cell and the assessment and attendance cells. Measured on a
 * realistic corpus, one such row serialises to about 627 bytes of which the excerpt itself is 61 — so shipping rows for 133
 * courses would move roughly 408 KiB across the extension's message boundary instead of about 24 KiB, and would publish page data
 * no excerpt needs. The projection keeps the comment and the provenance, and drops the rest.
 *
 * ## What is deliberately NOT here
 *
 * No teacher matching: the partition arrives as an argument. No dedupe key in the output: the key is internal bookkeeping and a
 * transported key would be a stable identifier for a student's comment, which this project does not create. No score, grade,
 * review id or synthetic student id.
 *
 * @module
 */

import type { CleanReview, ReviewExcerpt, ReviewExcerptScope } from '@course-copilot/core/course';

/**
 * How many excerpts one course may carry, in total.
 *
 * A cap on the COURSE, not on each scope: three slots compete, so a course with three class-related comments publishes no
 * course-level context at all. Relevance order decides who gets them.
 */
export const MAX_REVIEW_EXCERPTS = 3;

/**
 * The longest text one excerpt may carry, counted in Unicode code points.
 *
 * Counted in code points rather than UTF-16 units so that a truncated excerpt cannot end in half a surrogate pair, which would
 * render as a replacement character. 120 fits a full Chinese comment of the length students actually write, and provider
 * normalization leaves no cap of its own — measured, a 5000-character comment arrives intact — so this bound is the only one.
 */
export const MAX_REVIEW_EXCERPT_CHARS = 120;

/**
 * The order scopes compete for the excerpt budget in.
 *
 * What the current class said outranks what the rest of the course said, which outranks comments that name nobody. Exported so a
 * test can assert the order rather than restate it.
 */
export const REVIEW_EXCERPT_SCOPE_ORDER: readonly ReviewExcerptScope[] = ['current_class', 'course_reference', 'supplementary'];

/**
 * The parts of one row that identify it for de-duplication.
 *
 * ## Why this tuple and not an id
 *
 * `CleanReview` has no id, and inventing one would either be unstable across the extension's message boundary or claim a
 * per-student identity this project must not create. Four published primitive fields are enough: two rows agreeing on all four
 * are the same review twice, and merging them loses nothing a reader could see. Two DIFFERENT comments never collide, because
 * `commentText` is part of the key.
 *
 * ## Why object identity is not used
 *
 * It survives a single render pass and nothing else. The result is serialised through `chrome.runtime.sendMessage` before a
 * renderer sees it, so a structurally identical row would arrive as a different object and de-duplication would silently stop.
 *
 * @param row - a cleaned row.
 * @returns the serialisable key.
 */
function dedupeKeyOf(row: CleanReview): string {
  // A JSON array rather than a joined string: a delimiter could occur inside a comment and merge two distinct rows.
  return JSON.stringify([row.courseName, row.teacherRaw ?? '', row.commentText ?? '', row.rawGrade ?? '']);
}

/**
 * Bound one comment to {@link MAX_REVIEW_EXCERPT_CHARS} code points.
 *
 * A comment at or under the cap is returned unchanged — no trimming, no rewriting, no punctuation work. One over the cap keeps
 * its first `cap - 1` code points and a `…`, which is why the result is at most `cap` code points. HTML-like text is NOT
 * interpreted or stripped: it is student prose and stays literal.
 *
 * @param text - the normalized comment.
 * @param cap - maximum code points in the result.
 * @returns the text, bounded.
 */
export function boundExcerptText(text: string, cap: number = MAX_REVIEW_EXCERPT_CHARS): string {
  /*
   * `Array.from` splits on code points, so an emoji or any other astral character counts as one and cannot be cut in half.
   * `slice` on the string itself would count UTF-16 units and could split a surrogate pair.
   */
  const points = Array.from(text);
  if (points.length <= cap) return text;
  return `${points.slice(0, Math.max(0, cap - 1)).join('')}…`;
}

/**
 * Project ONE row into an excerpt, or `undefined` when it has nothing to show.
 *
 * A row whose comment is absent, empty or whitespace-only produces no excerpt. An empty string is not a quotation, and a
 * placeholder would be text no student wrote.
 *
 * @param row - a cleaned row from an authoritative partition.
 * @param scope - which partition it came from.
 * @returns the excerpt, or `undefined` when the row carries no usable comment.
 */
export function projectExcerpt(row: CleanReview, scope: ReviewExcerptScope): ReviewExcerpt | undefined {
  const text = row.commentText;
  if (text === undefined || text.trim().length === 0) return undefined;
  return {
    text: boundExcerptText(text),
    scope,
    /*
     * The row's OWN names, never the class's set. For a co-taught class a row naming one of them is still this class's evidence, so
     * substituting the class's names here would attribute one teacher's words to their colleague.
     */
    teacherNames: [...(row.teacherNames ?? [])],
    teacherValidity: row.teacherValidity,
  };
}

/**
 * Collapse content-equivalent excerpts, keeping the FIRST occurrence.
 *
 * ## When this is correct, and when it is not
 *
 * It compares the PUBLISHED content, because the richer key a cleaned row offers — `teacherRaw` and `rawGrade` — is deliberately not
 * carried by the DTO. That makes it right for one job and wrong for another:
 *
 * - **Right** for catching genuinely identical projections of one row, which is how a joint-teaching row that reached several
 *   teacher buckets collapses back to one quotation. Both halves of its content are equal by construction.
 * - **WRONG** as a general "are these the same review?" test. Two students can write the same four characters, and the key cannot
 *   see the difference — the richer key could. Merging on content alone therefore risks hiding a real second comment.
 *
 * Within one course the provider selects from a partition whose three sets are already mutually exclusive by construction —
 * `partitionCleanRows` walks the corpus once and pushes each row into exactly one set — so no call in this slice needs it. It is
 * exported for a caller that later merges excerpts from more than one SOURCE, where identical content is the only signal available,
 * and it must not be applied where the richer key is still in hand.
 *
 * @param excerpts - excerpts in preference order.
 * @returns the first occurrence of each distinct published excerpt.
 */
export function dedupeReviewExcerpts(excerpts: readonly ReviewExcerpt[]): ReviewExcerpt[] {
  const out: ReviewExcerpt[] = [];
  const seen = new Set<string>();
  for (const excerpt of excerpts) {
    const key = JSON.stringify([excerpt.text, excerpt.teacherNames, excerpt.teacherValidity]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(excerpt);
  }
  return out;
}

/**
 * Apply the per-course cap to an already-scoped excerpt array, re-establishing scope order.
 *
 * ## Why the engine needs a second half of one rule
 *
 * `MAX_REVIEW_EXCERPTS` is a property of a COURSE, not of a provider, so a run over two providers each offering three excerpts would
 * publish six without this. Scope order is re-applied because concatenation is not order-preserving in the way the rule needs: every
 * provider's `current_class` rows must outrank every provider's `course_reference` rows.
 *
 * ## What it deliberately does NOT do
 *
 * It does not merge anything. De-duplication needs the row-level key, and that key is gone by the time an excerpt exists — merging
 * on published content here could hide a genuinely different comment and, worse, free a slot that a fourth review would then fill,
 * so the cap would ADD a review rather than trim one. The provider already de-duplicated against the richer key; this function only
 * sorts and truncates.
 *
 * @param excerpts - scoped excerpts from any number of providers.
 * @returns at most {@link MAX_REVIEW_EXCERPTS} excerpts, current-class evidence first.
 */
export function capReviewExcerpts(excerpts: readonly ReviewExcerpt[]): ReviewExcerpt[] {
  const ranked = REVIEW_EXCERPT_SCOPE_ORDER.flatMap((scope) => excerpts.filter((excerpt) => excerpt.scope === scope));
  return ranked.slice(0, MAX_REVIEW_EXCERPTS);
}

/**
 * Select the bounded, de-duplicated excerpt array for one course.
 *
 * ## Selection
 *
 * Scopes are visited in {@link REVIEW_EXCERPT_SCOPE_ORDER} and rows in the order the provider returned them, so the result is a
 * deterministic function of the partition. At most {@link MAX_REVIEW_EXCERPTS} survive in TOTAL; once the budget is spent the
 * remaining scopes contribute nothing.
 *
 * ## De-duplication
 *
 * Against {@link dedupeKeyOf} — the four published primitives, `teacherRaw` and `rawGrade` included — so two students who wrote the
 * same words stay two excerpts, while one row that reached this function twice collapses to one. Applied BEFORE the cap, so a
 * duplicate cannot consume one of the three slots.
 *
 * @param partition - the provider's authoritative partition of the course's cleaned corpus.
 * @returns at most {@link MAX_REVIEW_EXCERPTS} excerpts, in scope-then-source order.
 */
export function selectReviewExcerpts(partition: {
  readonly matched: readonly CleanReview[];
  readonly disjoint: readonly CleanReview[];
  readonly unassigned: readonly CleanReview[];
}): ReviewExcerpt[] {
  const byScope: Record<ReviewExcerptScope, readonly CleanReview[]> = {
    current_class: partition.matched,
    course_reference: partition.disjoint,
    supplementary: partition.unassigned,
  };
  const projected: ReviewExcerpt[] = [];
  const seen = new Set<string>();
  for (const scope of REVIEW_EXCERPT_SCOPE_ORDER) {
    for (const row of byScope[scope]) {
      const key = dedupeKeyOf(row);
      if (seen.has(key)) continue;
      const excerpt = projectExcerpt(row, scope);
      // A row with no comment is skipped, and must NOT reserve the key: the same row repeated WITH text must still be shown.
      if (excerpt === undefined) continue;
      seen.add(key);
      projected.push(excerpt);
    }
  }
  // One rule, one implementation: the ordering and cap are the same code the engine runs over a merged array.
  return capReviewExcerpts(projected);
}
