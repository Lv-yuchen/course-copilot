/**
 * The course-card renderer: three kinds of result, three sections, no re-deciding.
 *
 * ## It renders the frozen model and decides nothing
 *
 * Every semantic choice — which teacher text, which grade aggregate is primary, what a confidence tier is called, what an evidence level means, whether a seat
 * count is unknown or zero — was frozen in `course-presentation.ts`. This module takes that output and puts it on screen. It does not parse a teacher string,
 * choose a grade scope, re-map a tier, or derive a seat count, because a second copy of any of those rules is a second answer that can disagree with the first.
 *
 * ## Why the result is a SNAPSHOT and says so
 *
 * A recommendation describes the page as it was when the approved tab was read. If the user switches tabs afterwards, the numbers are still valid — for that tab,
 * at that moment — but they are not "this page right now", and there is deliberately no `tabs.onActivated` refreshing them. So the area is titled 推荐快照.
 *
 * ## Text is never built as markup
 *
 * Teacher names and review text come from a page this extension does not control, so every string here is written with `textContent`. Nothing is assembled into
 * `innerHTML`, which is the one mistake that would turn page text into executable markup.
 *
 * @module
 */

import type { RecommendationResult } from '@course-copilot/core/course';
import {
  GRADE_DISCLAIMER,
  toInsufficientCoursePresentation,
  toRatedCoursePresentation,
  toRecommendedCoursePresentation,
  type InsufficientCoursePresentation,
  type RatedCoursePresentation,
  type RecommendedCoursePresentation,
} from './course-presentation.js';

/** The words a card uses. One label per fact, and the two grade scopes are named differently on purpose. */
export const CARD_TEXT = {
  /** The area's own title, which claims a snapshot rather than live state. */
  title: '推荐快照',
  sections: {
    recommended: '推荐课程',
    rated: '有评价，但未进入推荐',
    insufficient: '评价证据不足',
  },
  teacher: '任课老师',
  courseCode: '课程代码',
  credits: '学分',
  /** Shown when the page stated no credits. Never a zero credit value. */
  creditsUnknown: '学分：暂无数据',
  remainingSeats: '余量',
  /** A zero seat count is a fact about a full course, and is labelled as one. */
  seatsFull: '余量：0（已满）',
  seatsUnknown: '余量：未知',
  /**
   * How many students had already signed up in this round — the page's own 「本轮已选」.
   *
   * The label is the school's own wording, and the label is the whole point: any synonym that dropped the round, or that described the course's popularity instead of a
   * count of sign-ups, would state something the page never published. The specific rejected synonyms are named in `step42SelectedThisRoundPresentation.test.ts`
   * rather than here, because this comment is preserved into the shipped bundle and a reader scanning the artifact for a forbidden label must not find one in prose.
   */
  selectedThisRound: '本轮已选',
  /** A zero here means nobody has signed up YET — a real answer, said as `0` rather than as unknown. */
  selectedThisRoundUnknown: '本轮已选：未知',
  /** The admission status, as three separate words plus the label they hang off. */
  availabilityLabel: '可选状态',
  availabilityAvailable: '有余量',
  availabilityFull: '已满',
  availabilityUnknown: '状态未知',
  rank: '推荐排名',
  rankPrefix: '#',
  score: '推荐分',
  confidence: '置信度',
  evidence: '证据',
  reviewScope: {
    teacher: '评价范围：当前教师',
    course: '评价范围：课程整体',
  },
  reviewCount: '评价样本',
  /**
   * The self-reported grade line, rendered as ONE row per course.
   *
   * PRE-RELEASE-UX-A12 replaced a block of seven or eight rows — a scope heading, an average, a sample count, then the same three again for the whole-course
   * reference, then per-card boilerplate — with a single sentence. The SCOPE survives, because a teaching-class average and a whole-course average are different
   * claims and the frozen rule forbids presenting one as the other; what is gone is the repetition, not the qualification.
   *
   * The three scope labels are distinct on purpose and `course` is named 参考 so a reader cannot mistake the whole-course figure for this class's own.
   */
  grade: {
    /** The single label on every grade row. */
    label: '学生自报平均成绩',
    /** Shown when no aggregate carries a usable mean. */
    unavailable: '暂无数据',
    scope: {
      teacher: '当前教师',
      teachingClass: '当前教学班',
      course: '课程整体参考',
    },
  },
  reviewSource: {
    healthy: null,
    partial: '部分评价数据暂时不可用',
    unavailable: '该课程公开评价暂时不可用',
  },
  /**
   * The collapsible student-review module.
   *
   * PRE-RELEASE-UX-A17. The count is appended from the number of excerpts actually rendered, so the heading cannot promise more than the list
   * holds; the parentheses are full-width because the rest of this panel's counts are.
   */
  reviews: {
    /** The disclosure heading, before its count. */
    buttonLabel: '查看学生评价',
    /** The count, in the panel's own punctuation. */
    countSuffix: (count: number): string => `（${count}）`,
  },
  insufficientReviewSource: {
    healthy: null,
    partial: '部分公开评价暂时不可用',
    unavailable: '公开评价源暂时不可用',
  },
  /** The matcher's number, named so it cannot be read as a recommendation confidence. */
  matchConfidence: '评价匹配置信',
  matchMethod: '匹配方式',
  /**
   * The ONE interpretation this panel makes, and the only place it states a judgement rather than a page fact.
   *
   * It describes a comparison a reader can verify from the two rows directly above it: this round's sign-ups already exceed the places
   * that were free entering the round. It says nothing about the OUTCOME — the last clause hands that back to the selection system —
   * and the second sentence states outright that it is not a probability. Both halves are required: a warning asserting a risk without
   * that caveat would be claiming a prediction nobody made.
   */
  competitionWarning: '竞争较高：本轮已选人数已超过本轮余量，最终结果仍以选课系统为准。',
  competitionWarningNote: '此提示仅反映当前人数与余量关系，不代表选中概率。',
} as const;

/** Per-course review-source wording, chosen for the kind of card it sits on. */
type ReviewSourceWording = { readonly healthy: null; readonly partial: string; readonly unavailable: string };

/** Compose one labelled fact row. `kind` adds a marker class so a test can count a specific group of rows. */
function fact(label: string, value: string, kind?: string): HTMLElement {
  const row = document.createElement('p');
  row.className = kind === undefined ? 'course-card-fact' : `course-card-fact course-card-${kind}`;
  const labelSpan = document.createElement('span');
  labelSpan.className = 'course-card-label';
  // Every string reaches the DOM as TEXT. Page text is data, never markup.
  labelSpan.textContent = `${label}：`;
  const valueSpan = document.createElement('span');
  valueSpan.className = 'course-card-value';
  valueSpan.textContent = value;
  row.append(labelSpan, valueSpan);
  return row;
}

/** Compose the card shell with its title and kind label. */
function shell(kindClass: string, title: string, statusText: string): { card: HTMLElement; body: HTMLElement } {
  const card = document.createElement('li');
  card.className = `course-card ${kindClass}`;
  const heading = document.createElement('p');
  heading.className = 'course-card-title';
  heading.textContent = title;
  const status = document.createElement('p');
  status.className = 'course-card-status';
  status.textContent = statusText;
  const body = document.createElement('div');
  body.className = 'course-card-body';
  card.append(heading, status, body);
  return { card, body };
}

/** The identity facts every kind shares: name, teacher, code, credits, seats, admission status. */
function appendIdentity(body: HTMLElement, presentation: {
  readonly courseCode: string | null;
  readonly teacher: string | null;
  readonly teacherFallback: string;
  readonly credits: number | null;
  readonly remainingSeats: number | null;
  readonly selectedThisRound: number | null;
  readonly availability: 'available' | 'full' | 'unknown';
}): void {
  /*
   * The teacher is the presentation's own field, verbatim. When the page published none, the model's fixed sentence is used — which states that the field is
   * missing rather than that the course has no teacher.
   */
  body.append(fact(
    CARD_TEXT.teacher,
    presentation.teacher ?? presentation.teacherFallback.replace(/^[^：]*：/u, ''),
  ));
  // An absent course code is simply not shown: a blank row reads as a value that exists and is empty.
  if (presentation.courseCode !== null) body.append(fact(CARD_TEXT.courseCode, presentation.courseCode));
  /*
   * Credits absent is stated in words, never as `0`. A `0` here would be read as a zero-credit course.
   */
  body.append(presentation.credits === null
    ? textRow(CARD_TEXT.creditsUnknown)
    : fact(CARD_TEXT.credits, String(presentation.credits)));
  /*
   * Seats: `0` is a FULL course and is said so; only `null` is unknown. The `=== 0` comparison is the whole point — `!remainingSeats` would turn a full course
   * into an unknown one.
   */
  if (presentation.remainingSeats === 0) body.append(textRow(CARD_TEXT.seatsFull));
  else if (presentation.remainingSeats === null) body.append(textRow(CARD_TEXT.seatsUnknown));
  else body.append(fact(CARD_TEXT.remainingSeats, String(presentation.remainingSeats)));
  /*
   * The second seat fact, rendered RAW and beside the first.
   *
   * `0` is a real answer — nobody has signed up yet — so the `=== null` test is what selects the unknown wording, and `=== 0` deliberately falls through to the
   * numeric row. A truthiness test would erase a real zero.
   *
   * Nothing is computed from the two numbers: no ratio, no percentage, no comparison, no tier, no colour. They are two facts the page published, shown as two
   * facts. Combining them into a "competition" reading is a later product decision, not this slice.
   */
  if (presentation.selectedThisRound === null) body.append(textRow(CARD_TEXT.selectedThisRoundUnknown));
  else body.append(fact(CARD_TEXT.selectedThisRound, String(presentation.selectedThisRound)));
  // Admission status is its own fact and never a ranking input.
  body.append(fact(CARD_TEXT.availabilityLabel, availabilityText(presentation.availability)));
  /*
   * The one interpretation on the card, and it sits AFTER both facts it is derived from, so a reader meets the numbers before the reading of them.
   *
   * It is placed here, in the shared identity block, because it depends only on the two WHU seat facts and not on review quality — so it belongs on every card kind
   * that shows those facts, not only on the ones a review pipeline happened to score.
   */
  appendCompetitionWarning(body, presentation);
}

/** The admission status in the reader's words. */
function availabilityText(availability: 'available' | 'full' | 'unknown'): string {
  if (availability === 'available') return CARD_TEXT.availabilityAvailable;
  if (availability === 'full') return CARD_TEXT.availabilityFull;
  return CARD_TEXT.availabilityUnknown;
}

/**
 * Whether this round is already oversubscribed: more students have signed up than there were places free entering it.
 *
 * ## The frozen rule, and why it is exactly this
 *
 * `selectedThisRound > remainingSeats`, with BOTH values present. Nothing else is consulted and nothing is computed from them: no
 * ratio, no percentage, no threshold on either number, no comparison against a constant. It reports one observable state — more
 * people than places — which a reader can check from the two rows on the card.
 *
 * ## Why "not enough information" means NO warning
 *
 * Either value missing answers `false`. The card then says nothing about competition rather than guessing: an unknown 余量 is not
 * evidence of a shortage, and inventing a warning from it would be the first step toward the probability claim this rule exists to
 * avoid.
 *
 * ## Why equality is not a warning
 *
 * `selectedThisRound === remainingSeats` means sign-ups exactly fill the free places — the page's own accounting, not an excess. A
 * warning there would be crying wolf on the boundary, so only a strict excess triggers it.
 *
 * @param presentation - the seat facts already carried by the card.
 * @returns whether to render the oversubscription warning.
 */
export function isOversubscribed(presentation: {
  readonly remainingSeats: number | null;
  readonly selectedThisRound: number | null;
}): boolean {
  if (presentation.remainingSeats === null || presentation.selectedThisRound === null) return false;
  return presentation.selectedThisRound > presentation.remainingSeats;
}

/**
 * Append the oversubscription warning, when the rule above holds.
 *
 * Rendered as ordinary TEXT, so it is readable by assistive technology and not conveyed by colour alone; the colour is emphasis on
 * top of a sentence that already says what it means. The primary sentence is bold and the caveat is normal weight, both inside one
 * block so a reader sees the claim and its limit together.
 */
function appendCompetitionWarning(body: HTMLElement, presentation: {
  readonly remainingSeats: number | null;
  readonly selectedThisRound: number | null;
}): void {
  if (!isOversubscribed(presentation)) return;
  const block = document.createElement('div');
  block.className = 'course-card-competition-warning';
  const primary = document.createElement('p');
  primary.className = 'course-card-competition-warning-primary';
  primary.textContent = CARD_TEXT.competitionWarning;
  const note = document.createElement('p');
  note.className = 'course-card-competition-warning-note';
  note.textContent = CARD_TEXT.competitionWarningNote;
  block.append(primary, note);
  body.append(block);
}

/** A row that is a whole sentence rather than a label/value pair. */
function textRow(text: string): HTMLElement {
  const row = document.createElement('p');
  row.className = 'course-card-fact';
  row.textContent = text;
  return row;
}

/** Append the review scope and sample size, when the entry has a review context. */
function appendReviewContext(body: HTMLElement, context: { readonly scopeText: string; readonly reviewCount: number }): void {
  // The scope sentence comes from the model, so a course-level roll-up cannot be presented as this teacher's evidence.
  body.append(textRow(context.scopeText));
  // `reviewCount` is a number of REVIEWS, and is labelled as such: calling it a student count would be a different claim.
  body.append(fact(CARD_TEXT.reviewCount, String(context.reviewCount)));
}

/** Append per-aspect evidence rows, one per aspect, with no overall level. */
function appendEvidence(body: HTMLElement, evidence: readonly { readonly aspectText: string; readonly levelText: string; readonly reviewsWithEvidence: number; readonly corpusReviews: number }[]): void {
  /*
   * One row per aspect and nothing else. An "overall evidence" line would be a number the engine never produced, and an aspect that is absent stays absent rather
   * than being filled in with 无.
   */
  for (const entry of evidence) {
    body.append(fact(entry.aspectText, `${CARD_TEXT.evidence}${entry.levelText}（${entry.reviewsWithEvidence}/${entry.corpusReviews}）`, 'evidence'));
  }
}

/**
 * The values a grade line needs, which is not quite the whole presentation model.
 *
 * Stated separately so the wording function can be called with a hand-built object by a test, and so it cannot accidentally depend on the disclaimer — the
 * disclaimer moved to the result area in PRE-RELEASE-UX-A12 and must never be read from inside a card.
 */
interface GradeLineInput {
  readonly primaryScope: 'teacher' | 'teachingClass' | null;
  readonly primaryGrade: { readonly meanGrade?: number; readonly gradedSampleCount: number } | null;
  readonly courseGrade: { readonly meanGrade?: number; readonly gradedSampleCount: number } | null;
}

/**
 * Compose the ONE grade sentence a course shows, with its scope as a qualifier.
 *
 * ## The selection rule, stated once
 *
 * A candidate-specific aggregate wins when the model resolved one; otherwise the whole-course figure is used and labelled 课程整体参考 so it can never be read as
 * this class's own average. Exactly ONE aggregate is displayed — they are never averaged together, because a blend of two different row sets is a number no
 * provider produced. When neither carries a usable mean the answer is 暂无数据 rather than a figure.
 *
 * ## Why `meanGrade` is tested with `typeof`
 *
 * `0` is a legitimate average. A truthiness test would replace it with 暂无数据, and `gradedSampleCount: 0` legitimately has NO mean — those two cases look alike
 * to `if (meanGrade)` and mean opposite things.
 *
 * ## Why the renderer decides nothing
 *
 * The scope comes from the model, which applied the frozen rule; the wording lives here; and the number is formatted, never recomputed.
 *
 * @param grade - the presentation figures, without the disclaimer.
 * @returns the sentence to render.
 */
export function gradeLineOf(grade: GradeLineInput): string {
  const primary = grade.primaryGrade;
  const reference = grade.courseGrade;
  /*
   * A candidate-specific figure is used only when the model both resolved a scope AND produced a mean. A primary grade with zero samples has no mean, so it falls
   * through to the reference rather than rendering as a zero.
   */
  const selected = typeof primary?.meanGrade === 'number' && grade.primaryScope !== null
    ? { mean: primary.meanGrade, count: primary.gradedSampleCount, scope: grade.primaryScope }
    : typeof reference?.meanGrade === 'number'
      ? { mean: reference.meanGrade, count: reference.gradedSampleCount, scope: 'course' as const }
      : null;
  if (selected === null) return `${CARD_TEXT.grade.label}：${CARD_TEXT.grade.unavailable}`;
  const scopeText = CARD_TEXT.grade.scope[selected.scope];
  return `${CARD_TEXT.grade.label}：${selected.mean.toFixed(1)}（${selected.count}份，${scopeText}）`;
}

/**
 * Append the course's grade line. ONE row, whatever the data looks like.
 *
 * @param body - the card body.
 * @param grade - the presentation figures.
 */
function appendGrade(body: HTMLElement, grade: GradeLineInput): void {
  body.append(textRow(gradeLineOf(grade)));
}

/** Append the review-source disclosure for a card, if the source is not healthy. */
function appendReviewSource(body: HTMLElement, health: { readonly status: string }, wording: ReviewSourceWording): void {
  /*
   * A HEALTHY source emits nothing. It is the one status that needs no qualification, and the run-level shell above already explains a healthy source that
   * legitimately returned nothing — so a per-course line here would duplicate it and, worse, imply the course was affected.
   */
  if (health.status === 'partial') body.append(textRow(wording.partial));
  if (health.status === 'unavailable') body.append(textRow(wording.unavailable));
}

/**
 * The next card-local sequence number for a disclosure target.
 *
 * ## Why a counter rather than the course name
 *
 * `aria-controls` needs a real element id, and ids must be unique across a result that can hold well over a hundred cards. A course name is
 * the obvious source and the wrong one twice over: it can repeat (two classes of one course), and it is PAGE TEXT — inserting it into an id
 * means a name with a space, a quote or a slash has to be escaped correctly or it produces a broken selector. A counter has neither problem,
 * and `renderCourseCards` resets it, so the ids a render produces are a deterministic function of the result.
 */
let disclosureSerial = 0;

/**
 * Append the collapsible student-review module, or nothing at all.
 *
 * ## Presence
 *
 * A card with no excerpts gets NO module — not a collapsed one, not 「暂无评价」. A reader who can open something that then says nothing has
 * been told there was something to find, which is the opposite of the truth.
 *
 * ## Why each excerpt is rendered as two text nodes
 *
 * The label and the comment are separate elements so the label can be styled as secondary provenance without touching the comment. Both are
 * written with `textContent`, because the text is student prose: A16 preserves HTML-looking text literally, so `<b>事少</b>` must be visible
 * as those characters and must not become markup.
 *
 * ## Why the state is local
 *
 * The disclosure holds its own `expanded` flag and toggles it. There is no lookup of whether the course is current, no comparison against any
 * teacher name, and no request: the text is already in the committed result, so opening the module is a DOM change and nothing else. A fresh
 * render builds fresh elements, so a new result always starts collapsed.
 *
 * @param body - the card body.
 * @param excerpts - the model's excerpt pairs, in the provider's own order.
 * @param options - `labelPrefix` is the module's visible heading text.
 */
function appendReviewExcerpts(
  body: HTMLElement,
  excerpts: readonly { readonly text: string; readonly label: string }[],
  options: { readonly buttonLabel: string; readonly countSuffix: (count: number) => string },
): void {
  // An empty array means no excerpts: no module, no placeholder, no empty state.
  if (excerpts.length === 0) return;

  disclosureSerial += 1;
  const targetId = `course-review-${disclosureSerial}`;

  const module = document.createElement('div');
  module.className = 'course-card-reviews';

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'course-card-reviews-toggle';
  /*
   * The count is the number of excerpts ACTUALLY rendered, so the heading cannot promise more than the list holds. `false` here and the
   * container's `hidden` below are the initial state, and the click handler is the only thing that changes either.
   */
  toggle.textContent = `${options.buttonLabel}${options.countSuffix(excerpts.length)}`;
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', targetId);

  const list = document.createElement('div');
  list.className = 'course-card-reviews-list';
  list.id = targetId;
  list.hidden = true;

  for (const excerpt of excerpts) {
    const item = document.createElement('div');
    item.className = 'course-card-review';
    /*
     * The provenance first, the words second — and the provenance is the MODEL's label, not something derived here. This renderer knows
     * nothing about scopes or teachers, which is what keeps teacher matching in one place.
     */
    const label = document.createElement('p');
    label.className = 'course-card-review-label';
    label.textContent = excerpt.label;
    const text = document.createElement('p');
    text.className = 'course-card-review-text';
    // `textContent`, never `innerHTML`: this is the student's own prose and it may contain HTML-looking characters.
    text.textContent = excerpt.text;
    item.append(label, text);
    list.append(item);
  }

  let expanded = false;
  toggle.addEventListener('click', () => {
    expanded = !expanded;
    toggle.setAttribute('aria-expanded', String(expanded));
    list.hidden = !expanded;
  });

  module.append(toggle, list);
  body.append(module);
}

/** Build one recommended card. */
function recommendedCard(presentation: RecommendedCoursePresentation): HTMLElement {
  const { card, body } = shell('course-card-recommended', presentation.courseName, '推荐课程');
  appendIdentity(body, presentation);
  body.append(fact(CARD_TEXT.rank, `${CARD_TEXT.rankPrefix}${presentation.rank}`));
  /*
   * Score and confidence are two rows. They are never combined: the canonical risk-adjusted figure is deliberately not carried into the DOM, because presenting it
   * as the score would reward being easy to identify rather than being good.
   */
  body.append(presentation.score === null
    ? textRow(`${CARD_TEXT.score}：无`)
    : fact(CARD_TEXT.score, String(presentation.score)));
  if (presentation.confidence !== null) body.append(fact(CARD_TEXT.confidence, presentation.confidence.tierText));
  appendEvidence(body, presentation.evidenceStrength);
  appendReviewContext(body, presentation.reviewContext);
  appendGrade(body, presentation.grade);
  appendReviewSource(body, presentation.reviewSource, CARD_TEXT.reviewSource);
  /*
   * The engine's own reasons and warnings are already Chinese sentences written for a reader, so they are shown verbatim. They are NOT reworded here: a
   * paraphrase would be a second description of the same run, and the two could disagree.
   */
  for (const reason of presentation.reasons) body.append(textRow(reason));
  for (const warning of presentation.warnings) body.append(textRow(warning));
  /*
   * The student comments go LAST, in the card's lowest position: they are the one part of the card a reader chooses to open, and putting them after the
   * engine's own summary keeps the summary where it was rather than burying it under quotations.
   */
  appendReviewExcerpts(body, presentation.reviewExcerpts, CARD_TEXT.reviews);
  return card;
}

/** Build one rated-but-not-recommended card. */
function ratedCard(presentation: RatedCoursePresentation): HTMLElement {
  const { card, body } = shell('course-card-rated', presentation.courseName, presentation.statusText);
  appendIdentity(body, presentation);
  body.append(fact(CARD_TEXT.rank, `${CARD_TEXT.rankPrefix}${presentation.rank}`));
  // This entry HAS a score, unlike an insufficient one.
  body.append(fact(CARD_TEXT.score, String(presentation.score)));
  appendReviewContext(body, presentation.reviewContext);
  /*
   * The SAME compact grade line a recommended card shows, from the same helper and the same presentation shape.
   *
   * PRE-RELEASE-UX-A12. A reader could see a self-reported average on a recommended card and nothing on a rated one, which made the figure look like a property of
   * being recommended rather than a property of the course. The scope qualifier travels with it, so a rated course's whole-course reference is still labelled as
   * one.
   */
  appendGrade(body, presentation.grade);
  /*
   * Still NO confidence and NO evidence: the canonical entry carries neither, and rendering an empty module for either would tell a reader the extension checked
   * and found nothing — a different and false statement.
   *
   * NO per-card disclaimer either. It moved to the result area, where it is stated ONCE for every grade line rather than repeated on each card.
   */
  /*
   * The SAME review module a recommended card gets, from the same builder and the same model field.
   *
   * PRE-RELEASE-UX-A17. A rated course's comments were carried by the result from A16 onward and rendered nowhere, so the quotations looked like a property of
   * being recommended rather than a property of the course.
   *
   * NESTED DISCLOSURE: this card sits inside the rated section, which A13 made collapsed by default, so it is a disclosure inside a disclosure. The two are
   * independent because each owns its own flag and its own listener — opening the outer section cannot reach this button, and this button only ever touches its
   * own list.
   */
  appendReviewExcerpts(body, presentation.reviewExcerpts, CARD_TEXT.reviews);
  return card;
}

/** Build one insufficient-data card. */
function insufficientCard(presentation: InsufficientCoursePresentation): HTMLElement {
  const { card, body } = shell('course-card-insufficient', presentation.courseName, presentation.statusText);
  appendIdentity(body, presentation);
  /*
   * There is deliberately NO score row and no rank row: this course was never scored and has no rank, so the fields do not exist rather than reading "0" or "—".
   */
  // The engine's own reason, verbatim: it is already a written sentence, not an internal code.
  body.append(textRow(presentation.reason));
  /*
   * The matcher's number is labelled as a MATCH fact. It is not a recommendation confidence — there is no recommendation confidence for a course with no score —
   * and a card that labelled it 置信度 would attribute a property the run does not have.
   */
  body.append(fact(CARD_TEXT.matchConfidence, presentation.match.confidence.toFixed(2)));
  appendReviewSource(body, presentation.reviewSource, CARD_TEXT.insufficientReviewSource);
  return card;
}

/**
 * Render a whole recommendation result into three sections.
 *
 * ## The order is the engine's
 *
 * Each section consumes its canonical array in the order given, and nothing is sorted: the ranking is the engine's decision, and re-ordering by score, seats or
 * teacher here would silently replace it with a different one.
 *
 * @param root - the element the three card lists live in.
 * @param result - the canonical result, or `null` to clear every card.
 */
export function renderCourseCards(root: {
  readonly recommended: HTMLElement;
  readonly rated: HTMLElement;
  readonly insufficient: HTMLElement;
  readonly sections: { readonly recommended: HTMLElement; readonly rated: HTMLElement; readonly insufficient: HTMLElement };
  /**
   * The ONE element that carries the shared grade disclaimer, or `undefined` when the panel has none.
   *
   * PRE-RELEASE-UX-A12 moved the disclaimer here from inside every card. It is optional so a caller that does not render the result area — a test harness, or a
   * future surface — is not forced to provide an element it has no place for; when it IS provided, this function owns its text and its visibility, so the sentence
   * and the cards cannot disagree about whether grade figures are on screen.
   */
  readonly disclaimer?: HTMLElement;
  /**
   * The rated section's collapse control and count, or `undefined` when the panel has none.
   *
   * ## Why the renderer owns the collapsed state
   *
   * The product requirement is that every NEW result starts collapsed. Something has to reset it, and the renderer is the only code that knows a new result has
   * arrived — a click handler cannot. Owning the reset here also makes `aria-expanded` and the panel's `hidden` impossible to desynchronise, because one function
   * sets both.
   */
  readonly disclosure?: {
    /** The button the reader clicks. A real `<button>`, so it is keyboard reachable. */
    readonly toggle: HTMLElement;
    /** Where the exact rated count is shown, so it cannot be hard-coded. */
    readonly count: HTMLElement;
    /** The container holding the rated cards, hidden while collapsed. */
    readonly panel: HTMLElement;
  };
}, result: RecommendationResult | null): void {
  /*
   * Clearing first is what makes a LOADING or failed state safe: the previous answer's cards must not sit beside "正在生成…" looking like this run's result.
   */
  root.recommended.replaceChildren();
  root.rated.replaceChildren();
  root.insufficient.replaceChildren();
  /*
   * Reset the disclosure id sequence, because the three lists were just emptied and every card below is about to be rebuilt. Doing it here rather than letting
   * the counter grow means the ids a given result produces are a deterministic function of that result, and two renders of one result produce the same ids.
   *
   * This is also half of "every newly rendered card starts collapsed": a fresh build creates fresh elements, and the counter restart is what makes that
   * reproducible rather than merely likely.
   */
  disclosureSerial = 0;

  if (result === null) {
    root.sections.recommended.hidden = true;
    root.sections.rated.hidden = true;
    root.sections.insufficient.hidden = true;
    if (root.disclaimer !== undefined) {
      // A cleared result must not leave a sentence about grades behind, explaining a figure that is no longer on screen.
      root.disclaimer.textContent = '';
      root.disclaimer.hidden = true;
    }
    if (root.disclosure !== undefined) {
      // A cleared result has no count to announce and no cards to disclose.
      root.disclosure.count.textContent = '';
    }
    return;
  }

  // One card per canonical entry, in the array's own order. A section is hidden only when its array is empty.
  for (const entry of result.recommendations) root.recommended.append(recommendedCard(toRecommendedCoursePresentation(entry)));
  for (const entry of result.ratedButNotRecommended) root.rated.append(ratedCard(toRatedCoursePresentation(entry)));
  for (const entry of result.insufficientData) root.insufficient.append(insufficientCard(toInsufficientCoursePresentation(entry)));

  root.sections.recommended.hidden = result.recommendations.length === 0;
  root.sections.rated.hidden = result.ratedButNotRecommended.length === 0;
  root.sections.insufficient.hidden = result.insufficientData.length === 0;

  if (root.disclosure !== undefined) {
    /*
     * The count comes from the array, so it is always the number of cards actually rendered. A hard-coded or remembered figure could disagree with what the reader
     * can expand.
     *
     * With NO rated cards the section is hidden, so the count is cleared rather than left reading `（0）` on a control nobody can see: a stale number on a hidden
     * control is exactly the kind of thing a later slice would reveal by accident.
     */
    root.disclosure.count.textContent = result.ratedButNotRecommended.length === 0
      ? ''
      : `（${result.ratedButNotRecommended.length}）`;
    /*
     * EVERY new result starts collapsed — the frozen product decision — so an expansion the reader made while looking at a previous snapshot is deliberately not
     * carried over. A new result is a new question, and it opens the way the first one did.
     */
    setRatedCollapsed(root.disclosure, true);
  }

  /*
   * The shared disclaimer is shown when the cards it qualifies are on screen, and its sentence comes from the presentation model rather than being re-typed here —
   * one definition of what the figures mean.
   *
   * A collapsed rated section does not affect this: the RECOMMENDED cards stay expanded, so as long as any card exists there is a grade line for the sentence to
   * qualify. When no card exists at all there is nothing to explain, so it is omitted rather than shown over an empty area.
   */
  if (root.disclaimer !== undefined) {
    const hasCards = result.recommendations.length > 0 || result.ratedButNotRecommended.length > 0;
    root.disclaimer.textContent = hasCards ? GRADE_DISCLAIMER : '';
    root.disclaimer.hidden = !hasCards;
  }
}

/**
 * Set the rated disclosure's state, keeping the announced state and the rendering in step.
 *
 * One function rather than two assignments in two places: `aria-expanded` without `hidden` would leave a screen reader claiming the section is open while its cards
 * are not rendered, and `hidden` without `aria-expanded` would leave a reader unable to tell what the control is about to do.
 *
 * @param disclosure - the control and the container it governs.
 * @param collapsed - whether the rated cards should be hidden.
 */
export function setRatedCollapsed(
  disclosure: { readonly toggle: HTMLElement; readonly panel: HTMLElement },
  collapsed: boolean,
): void {
  disclosure.toggle.setAttribute('aria-expanded', String(!collapsed));
  disclosure.panel.hidden = collapsed;
}
