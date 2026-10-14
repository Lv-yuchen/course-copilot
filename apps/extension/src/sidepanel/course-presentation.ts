/**
 * The presentation model for course results: what a card MAY show, per result kind.
 *
 * ## Why this is frozen before any card exists
 *
 * The canonical result holds three DIFFERENT shapes, and they do not carry the same fields. A `recommended` course has a score, a confidence, per-aspect evidence
 * strength and grade aggregates. A `ratedButNotRecommended` entry has a score and a rank and NOTHING else — no confidence, no evidence tiers, no grade
 * aggregates. An `insufficientData` entry has a reason, a match and a review source, and no score at all.
 *
 * A single card component drawn first and made to fit all three would have to invent the missing half of two of them: a default confidence, an empty evidence
 * list read as "no evidence", a score of zero for a course that was never scored. So the contract is written first, one type per result kind, each naming the
 * canonical fields it is allowed to read, and the mappers below simply do not have access to the others.
 *
 * ## The teacher rule, which is the one most likely to be broken
 *
 * `NormalizedCourse.teacher` is `string`, and that string is the PAGE'S OWN TEXT. It is opaque: on the real page a co-taught course publishes something like
 * `"周奕华、刘兴海"` in ONE field, so a `string` type says nothing whatever about how many teachers there are. Splitting it, taking its first element, sorting it,
 * or replacing it with the review corpus's own teacher set would each destroy page text the user can verify against the page itself. It is carried through
 * verbatim, and a consumer renders it as-is.
 *
 * @module
 */

import type {
  GradeAggregate,
  HydratableField,
  NormalizedCourse,
  Recommendation,
  RecommendationGradeAggregates,
  RecommendationResult,
  RatedButNotRecommendedEntry,
  ReviewContext,
  ReviewExcerpt,
  ReviewSourceHealth,
  SectionHydration,
  SectionHydrationStatus,
} from '@course-copilot/core/course';

/**
 * The disclosure that must accompany any self-reported grade figure.
 *
 * A fixed string in the model rather than a rendering decision, because a grade average presented without it is read as an official course statistic — and these
 * are self-reported percentages from a review site, which is a different and much weaker claim.
 */
export const GRADE_DISCLAIMER = '学生评价中的自报成绩统计，不是武汉大学官方课程平均成绩';

/** What to say when the page has published no teacher for this row. */
export const TEACHER_NOT_PUBLISHED_TEXT = '任课老师：尚未加载/页面未提供';

/**
 * The teacher as the page published it, or `null`.
 *
 * Returned VERBATIM. There is deliberately no splitting, no trimming of names out of a list, no sorting and no fallback to any other source: the only correct
 * transformation of page text is none.
 *
 * @param course - the canonical course.
 * @returns the page's own teacher text, or `null` when there is none.
 */
export function teacherText(course: NormalizedCourse): string | null {
  /*
   * An empty string is treated as missing rather than shown as a blank label: the page renders an empty cell before a row is expanded, and "有老师，名字是空的" is
   * not a statement anybody can act on. What is NOT done here is deciding the course has no teacher — the caller says the field was not published.
   */
  return typeof course.teacher === 'string' && course.teacher.length > 0 ? course.teacher : null;
}

/** The Chinese label for a canonical confidence tier. */
const CONFIDENCE_TIER_TEXT: Readonly<Record<'low' | 'medium' | 'high', string>> = {
  low: '低',
  medium: '中',
  high: '高',
};

/**
 * The Chinese label for one aspect key.
 *
 * Declared here, beside the evidence mapping, because an evidence tier is only meaningful with the aspect it belongs to. The words are the product's own: they mirror
 * the canonical `aspectLabel` table rather than inventing a second vocabulary, and a card that named the same aspect differently from the explanation beside it
 * would be describing two different things.
 */
const ASPECT_TEXT: Readonly<Record<string, string>> = {
  gradeFriendliness: '成绩友好度',
  workloadFriendliness: '工作量友好度',
  attendanceFriendliness: '考勤友好度',
  examFriendliness: '考核友好度',
  teachingQuality: '教学质量',
  studentSentiment: '学生评价',
};

/** The Chinese label for one aspect key, falling back to the key so an unknown aspect is visible rather than blank. */
export function aspectText(aspect: string): string {
  return ASPECT_TEXT[aspect] ?? aspect;
}

/** The Chinese label for a canonical evidence tier. */
const EVIDENCE_LEVEL_TEXT: Readonly<Record<'strong' | 'moderate' | 'limited' | 'none', string>> = {
  strong: '充分',
  moderate: '中等',
  limited: '偏少',
  none: '无',
};

/** The Chinese label for a hydratable section field. */
const HYDRATABLE_FIELD_TEXT: Readonly<Record<HydratableField, string>> = {
  teacher: '任课老师',
  schedule: '上课时间',
  location: '上课地点',
  department: '开课院系',
  capacity: '容量',
};

/** The Chinese label for a section hydration status. */
const HYDRATION_STATUS_TEXT: Readonly<Record<SectionHydrationStatus, string>> = {
  full: '课程详情已加载',
  basic: '仅读取到列表行',
};

/** What the review evidence covers, in the reader's terms. */
const REVIEW_SCOPE_TEXT = {
  teacher: '当前教师评价证据',
  course: '课程整体评价证据',
} as const;

/** The shared half of every course presentation: what the page itself said. */
export interface CourseIdentityPresentation {
  /** The course name exactly as the page showed it. Never rewritten. */
  readonly courseName: string;
  /** The page's teacher text, verbatim, or `null` when the page published none. */
  readonly teacher: string | null;
  /** The label to show when {@link teacher} is `null`. */
  readonly teacherFallback: string;
  /** University course code, when the page states one. */
  readonly courseCode: string | null;
  /** Credits, or `null` when the page states none. NEVER defaulted to `0`. */
  readonly credits: number | null;
  /**
   * Seats still free, or `null` when unknown.
   *
   * `0` is a REAL VALUE — a full course — and is carried through as `0`. Only `null` means the page did not say, which is a different statement.
   */
  readonly remainingSeats: number | null;
  /**
   * How many students had already signed up for this teaching class in the current round, or `null` when unknown.
   *
   * The page's own label is 「本轮已选」 and its definition is 「本轮次已选人数」. NOT the course's total enrolment, NOT capacity,
   * and NOT a derived quantity: this is the raw second seat fact, carried exactly as the page and the core model state it.
   *
   * `0` is a REAL VALUE — nobody has signed up yet — and is carried through as `0`, unlike the legacy capacity placeholder rule
   * where zero meant "not loaded". Only `null` means the page did not say.
   */
  readonly selectedThisRound: number | null;
  /** Canonical admission status. NEVER derived from the score, and never fed back into it. */
  readonly availability: 'available' | 'full' | 'unknown';
}

/** One aspect's evidence tier, kept per aspect. */
export interface AspectEvidencePresentation {
  readonly aspect: string;
  /** The aspect in the reader's words. */
  readonly aspectText: string;
  readonly level: 'strong' | 'moderate' | 'limited' | 'none';
  readonly levelText: string;
  readonly reviewsWithEvidence: number;
  readonly corpusReviews: number;
  /** Why this tier was chosen, as the canonical engine wrote it. */
  readonly note: string;
}

/** How much of the course section the page had loaded. */
export interface SectionHydrationPresentation {
  readonly status: SectionHydrationStatus;
  readonly statusText: string;
  /** Fields the extraction produced, in the reader's words. */
  readonly available: string[];
  /** Fields that are absent, in the reader's words. */
  readonly missing: string[];
  /** The page's own hydration answer, or `null` when the source could not report one. */
  readonly rawHydrated: boolean | null;
}

/** Which body of reviews produced the figures, and how large it is. */
export interface ReviewContextPresentation {
  readonly scope: 'course' | 'teacher';
  /** The reader-facing statement of what the evidence covers. */
  readonly scopeText: string;
  readonly reviewCount: number;
  readonly teacherSpecified: boolean;
  /** The teacher the matched review belongs to, or `null`. */
  readonly teacher: string | null;
  /** Confidence of the TEACHER-level match, or `null` when no teacher match was attempted. */
  readonly teacherMatchConfidence: number | null;
  /** The canonical one-liner about what the figures do and do not represent. */
  readonly aggregationNote: string;
}

/** Student-reported grade figures, with the scope they came from. */
export interface GradePresentation {
  /** Which aggregate is being shown, or `null` when no candidate-specific one exists. */
  readonly primaryScope: 'teacher' | 'teachingClass' | null;
  /** The aggregate for {@link primaryScope}; `null` when it does not apply. */
  readonly primaryGrade: GradeAggregate | null;
  /** The whole-course aggregate: reference only, never the candidate's own figure. */
  readonly courseGrade: GradeAggregate | null;
  /** Every distinct teacher name the review corpus holds for this class. */
  readonly teacherSetNames: string[];
  /** The fixed disclosure that must accompany any grade figure. */
  readonly disclaimer: string;
}

/**
 * One student comment, ready to render.
 *
 * ## Why the label is built HERE and not by the renderer
 *
 * The provider decided which partition a comment belongs to; this module turns that decision plus the row's OWN teacher names into
 * the one sentence a reader sees, and the renderer only writes it. If the renderer derived the label it would need `teacherNames` and
 * `scope` to compare against, which is teacher matching in disguise — and it would be the second answer to a question the provider
 * already answered.
 *
 * ## What is deliberately absent
 *
 * `teacherValidity` does not travel: it exists to distinguish a blank teacher cell from a prose one, and the two already produce
 * different labels, so exposing the raw union to the DOM would give a renderer a vocabulary it must not branch on.
 *
 * `text` is the transported excerpt verbatim — already bounded by the provider, never re-truncated, never summarised, never
 * re-punctuated. It is student prose and may contain HTML-looking characters, so a renderer must set it with `textContent`.
 */
export interface ReviewExcerptPresentation {
  /** The student's comment, exactly as transported. */
  readonly text: string;
  /** Which teacher(s) this specific comment is about, in the conservative wording frozen for this feature. */
  readonly label: string;
}

/**
 * The frozen provenance labels.
 *
 * ## The rule the labels exist to obey
 *
 * `scope` names the BUCKET a comment was filed in, not who wrote it. `teacherSetRelation` treats partial overlap as agreement, so in a
 * class taught by 张三 and 李四 a comment naming only 张三 is `current_class` evidence — and labelling it 「当前教学班评价」 would present
 * one person's words as the class's. So a `current_class` comment is labelled with its OWN names, and never with the class's.
 *
 * The two course-level scopes are worded to be conservative in the same direction: neither ever claims the comment is about a current
 * teacher, so an unattributable comment cannot be promoted by being displayed near an attributable one.
 */
export const REVIEW_LABEL_TEXT = {
  /** Joins several names the way the rest of the panel does. */
  nameSeparator: '、',
  /** Prefix for anything that is NOT this class's own evidence. */
  courseReferencePrefix: '课程整体参考',
  /** Suffix naming the teachers a course-level comment mentioned. */
  teacherSuffix: '教师',
  /** Used when a course-level comment names nobody, OR when it is supplementary. */
  teacherUnknown: '教师信息未明确',
  /** Assembled form: `课程整体参考 · 教师：王五`. */
  referenceWithTeachers: (names: string): string => `${REVIEW_LABEL_TEXT.courseReferencePrefix} · ${REVIEW_LABEL_TEXT.teacherSuffix}：${names}`,
  /** Assembled form: `课程整体参考 · 教师信息未明确`. */
  referenceWithoutTeachers: (): string => `${REVIEW_LABEL_TEXT.courseReferencePrefix} · ${REVIEW_LABEL_TEXT.teacherUnknown}`,
} as const;

/**
 * Turn one transported excerpt into its label.
 *
 * Only `scope` and `teacherNames` are read. Nothing here compares against the course's current teacher string, and nothing consults
 * teacher validity: a supplementary comment stays unattributed even if its row happened to name somebody, because the provider filed it
 * as supplementary precisely because that cell was not usable.
 *
 * @param excerpt - the transported excerpt.
 * @returns the label for its text.
 */
export function reviewExcerptLabelOf(excerpt: ReviewExcerpt): string {
  /*
   * `current_class` is the only scope allowed to name a person directly, because it is the only scope where the provider verified the row
   * relates to this class. The name shown is still the ROW's own, which may be a proper subset of the class's teachers.
   */
  if (excerpt.scope === 'current_class') {
    const names = excerpt.teacherNames.filter((name) => name.trim().length > 0);
    if (names.length > 0) return names.join(REVIEW_LABEL_TEXT.nameSeparator);
    // A current-class row that named nobody should be impossible (the partition requires a usable teacher cell), but the wording stays
    // conservative rather than promoting it.
    return REVIEW_LABEL_TEXT.referenceWithoutTeachers();
  }
  /*
   * `course_reference` and `supplementary` share the conservative sentence. A supplementary row's names are NOT promoted: the provider put
   * it here because its teacher cell was missing or was prose, so printing those words as a teacher would present a parser failure as a
   * person.
   */
  if (excerpt.scope === 'course_reference') {
    const names = excerpt.teacherNames.filter((name) => name.trim().length > 0);
    if (names.length > 0) return REVIEW_LABEL_TEXT.referenceWithTeachers(names.join(REVIEW_LABEL_TEXT.nameSeparator));
  }
  return REVIEW_LABEL_TEXT.referenceWithoutTeachers();
}

/**
 * Project the transported excerpts into render-ready pairs, preserving their order exactly.
 *
 * The order is the provider's bounded selection order — current class first, then course reference, then supplementary — and it is
 * carried through unchanged. Sorting by scope, teacher or sentiment here would replace the engine's choice with a different one, and
 * preferring positive comments would be an editorial act this product does not perform.
 *
 * @param excerpts - the transported excerpts.
 * @returns one presentation entry per excerpt, in the same order.
 */
export function reviewExcerptsOf(excerpts: readonly ReviewExcerpt[]): ReviewExcerptPresentation[] {
  return excerpts.map((excerpt) => ({ text: excerpt.text, label: reviewExcerptLabelOf(excerpt) }));
}

/** A course this run recommends. */
export interface RecommendedCoursePresentation extends CourseIdentityPresentation {
  readonly kind: 'recommended';
  readonly rank: number;
  /** The weighted decision score. Kept apart from confidence on purpose. */
  readonly score: number | null;
  /**
   * How sure the engine is, as its own fact.
   *
   * Never combined with {@link score}: `5.5 + confidence × (score − 5.5)` is a real canonical field, but presenting it as THE score would tell a reader a
   * well-evidenced mediocre course beats a thinly-evidenced excellent one.
   */
  readonly confidence: { readonly value: number; readonly tier: 'low' | 'medium' | 'high'; readonly tierText: string } | null;
  /** Per-aspect evidence tiers, as the canonical engine graded them. Never merged into one overall level. */
  readonly evidenceStrength: AspectEvidencePresentation[];
  readonly grade: GradePresentation;
  /**
   * The student comments to offer under 「查看学生评价」, in the provider's bounded order.
   *
   * REQUIRED and possibly empty. `[]` means "there is nothing to show" and the card renders no disclosure at all — not an empty state, not
   * 「暂无评价」. A reader who can open a module that then says nothing has been told there was something to find.
   *
   * PRE-RELEASE-UX-A17 carries this into the presentation. The provider scoped and bounded it in A16; this module only builds the label.
   */
  readonly reviewExcerpts: ReviewExcerptPresentation[];
  readonly reviewContext: ReviewContextPresentation;
  readonly sectionHydration: SectionHydrationPresentation;
  readonly reviewSource: ReviewSourceHealth;
  /** The engine's own reasons, verbatim. */
  readonly reasons: string[];
  /** The engine's own caveats, verbatim. */
  readonly warnings: string[];
}

/** A course that was scored but ranked below the returned cut. */
export interface RatedCoursePresentation extends CourseIdentityPresentation {
  readonly kind: 'ratedButNotRecommended';
  /** Position in the full scored order. */
  readonly rank: number;
  readonly score: number;
  /**
   * The status sentence.
   *
   * Deliberately the ONLY thing said about why it is not in the list: this entry carries no confidence and no evidence tiers, so any explanation would be
   * invented. It is also not `insufficientData` — this course HAS usable evidence and a real score, and the two must not be described alike.
   */
  readonly statusText: string;
  readonly reviewContext: ReviewContextPresentation;
  readonly sectionHydration: SectionHydrationPresentation;
  /**
   * The same grade figures a recommended card receives, chosen by the SAME rule.
   *
   * PRE-RELEASE-UX-A11 carries this into the rated presentation but renders NONE of it yet: the rated card's DOM is deliberately unchanged in this slice. The
   * field exists so the next slice can show the average without re-deriving which scope applies — `primaryGradeOf` decides that once, here, for both kinds of
   * entry.
   *
   * It is the identical {@link GradePresentation} shape the recommended model uses, including `courseGrade` as a separate reference and the frozen disclaimer, so
   * the two card kinds cannot drift into describing grades differently.
   */
  readonly grade: GradePresentation;
  /**
   * The student comments to offer under 「查看学生评价」, chosen by the same provider and carried by the same result a recommended entry
   * receives.
   *
   * REQUIRED and possibly empty, for the same reason as on the recommended presentation: a course below the cut is still a course a
   * reader may open, and an absent array would leave the renderer deciding what a missing field means.
   */
  readonly reviewExcerpts: ReviewExcerptPresentation[];
}

/** A course with no trusted review data. */
export interface InsufficientCoursePresentation extends CourseIdentityPresentation {
  readonly kind: 'insufficientData';
  /**
   * The status sentence: an evidence problem, never a verdict on the course.
   *
   * Matches the canonical definition — "no trusted match, or no aspect carried evidence" — so it never says a course is bad, low-scoring or not recommended.
   */
  readonly statusText: string;
  /** The engine's own reason, verbatim. */
  readonly reason: string;
  /**
   * How the course was matched, if it was.
   *
   * Named as a MATCH fact and never as a recommendation confidence: the review stated no score for this course, so there is no recommendation confidence to
   * report, and borrowing this number for one would be a category error.
   */
  readonly match: { readonly method: string; readonly confidence: number };
  readonly reviewSource: ReviewSourceHealth;
}

/** The three status sentences, frozen here so a renderer cannot reword them into a judgement. */
export const COURSE_STATUS_TEXT = {
  rated: '有评价，但未进入推荐结果',
  insufficient: '评价证据不足，暂不做推荐判断',
} as const;

/** Map the identity half, which every kind shares. */
function identityOf(course: NormalizedCourse): CourseIdentityPresentation {
  return {
    courseName: course.courseName,
    teacher: teacherText(course),
    teacherFallback: TEACHER_NOT_PUBLISHED_TEXT,
    courseCode: typeof course.courseCode === 'string' && course.courseCode.length > 0 ? course.courseCode : null,
    // Absent stays absent: `0` would claim a credit value the page never stated.
    credits: typeof course.credits === 'number' && Number.isFinite(course.credits) ? course.credits : null,
    /*
     * `0` is preserved as `0` and never folded into "missing". A `!remainingSeats` test here is the classic version of this bug, and it turns a full course
     * into an unknown one.
     */
    remainingSeats: typeof course.remainingSeats === 'number' && Number.isFinite(course.remainingSeats) ? course.remainingSeats : null,
    /*
     * The second seat fact, carried with the SAME rule and for the same reason: `0` here means "nobody has signed up yet", which is a real answer, so a
     * truthiness test would erase it. Nothing is derived from it — no ratio against the remaining seats, no tier, no comparison — because the raw fact is all
     * this mapper is allowed to transport.
     */
    selectedThisRound: typeof course.selectedThisRound === 'number' && Number.isFinite(course.selectedThisRound) ? course.selectedThisRound : null,
    availability: course.availability,
  };
}

/** Map the review context, saying in words what the evidence covers. */
function reviewContextOf(context: ReviewContext): ReviewContextPresentation {
  return {
    scope: context.scope,
    // The two scopes are not interchangeable claims, so each gets its own sentence.
    scopeText: REVIEW_SCOPE_TEXT[context.scope],
    reviewCount: context.reviewCount,
    teacherSpecified: context.teacherSpecified,
    teacher: context.teacher,
    teacherMatchConfidence: context.teacherMatchConfidence,
    aggregationNote: context.aggregationNote,
  };
}

/** Map the section hydration, translating the canonical field names into the reader's words. */
function sectionHydrationOf(hydration: SectionHydration): SectionHydrationPresentation {
  return {
    status: hydration.status,
    statusText: HYDRATION_STATUS_TEXT[hydration.status],
    available: hydration.available.map((field) => HYDRATABLE_FIELD_TEXT[field]),
    missing: hydration.missing.map((field) => HYDRATABLE_FIELD_TEXT[field]),
    rawHydrated: hydration.rawHydrated,
  };
}

/**
 * Choose the grade aggregate that describes THIS candidate, if the canonical data supports one.
 *
 * The rule follows the frozen grade semantics: a single-teacher candidate is described by its teacher aggregate, a co-taught candidate by its teaching-class
 * aggregate, and a candidate whose teacher the page never published has NO candidate-specific figure — the whole-course aggregate includes teachers outside this
 * class, so presenting it as this class's average would overstate what is known.
 *
 * When the rule cannot be applied safely the answer is `null` and the aggregates are still carried, rather than a guess being made.
 *
 * @param aggregates - the canonical aggregates.
 * @param teacherCount - how many teachers the review corpus holds for this class.
 * @returns the scope and figure, or `null`s.
 */
function primaryGradeOf(
  aggregates: RecommendationGradeAggregates,
  teacherCount: number,
): { scope: 'teacher' | 'teachingClass' | null; grade: GradeAggregate | null } {
  if (teacherCount === 1 && aggregates.teacher !== undefined) return { scope: 'teacher', grade: aggregates.teacher };
  if (teacherCount > 1 && aggregates.teachingClass !== undefined) return { scope: 'teachingClass', grade: aggregates.teachingClass };
  /*
   * No teacher names, or an aggregate the source did not produce: there is no candidate-specific figure. `null` is the honest answer, and the caller still has
   * `courseGrade` for reference.
   */
  return { scope: null, grade: null };
}

/**
 * Map the canonical aggregates into the display shape, applying the frozen scope rule.
 *
 * Extracted in PRE-RELEASE-UX-A11 so a recommended card and a rated card are given their grades by ONE function. Two inline copies would be two places to change
 * if the scope rule ever moves, and the rule is exactly the thing that must not differ between them: a reader comparing a recommended course with a rated one is
 * entitled to the same answer to "which average is this?".
 *
 * @param aggregates - the canonical aggregates.
 * @returns the display grade figures.
 */
function gradePresentationOf(aggregates: RecommendationGradeAggregates): GradePresentation {
  const names = aggregates.teacherSet.names;
  const primary = primaryGradeOf(aggregates, names.length);
  return {
    primaryScope: primary.scope,
    primaryGrade: primary.grade,
    courseGrade: aggregates.course ?? null,
    /*
     * The corpus's own teacher names, carried for reference ONLY. They are never a substitute for the page's teacher text: one is what the review site indexed and
     * the other is what the selection page published, and they can legitimately differ.
     */
    teacherSetNames: [...names],
    disclaimer: GRADE_DISCLAIMER,
  };
}

/**
 * Map one recommended course.
 *
 * @param recommendation - the canonical recommendation.
 * @returns the presentation.
 */
export function toRecommendedCoursePresentation(recommendation: Recommendation): RecommendedCoursePresentation {
  return {
    kind: 'recommended',
    ...identityOf(recommendation.course),
    rank: recommendation.rank,
    // Score and confidence are carried as two separate facts, each with its own field.
    score: recommendation.score,
    confidence: {
      value: recommendation.confidence.value,
      tier: recommendation.confidence.tier,
      tierText: CONFIDENCE_TIER_TEXT[recommendation.confidence.tier],
    },
    /*
     * Per aspect, one entry each. No overall level is computed: taking a minimum, a maximum or an average across aspects would be a number the engine never
     * produced, and the canonical type has no such field.
     */
    evidenceStrength: recommendation.evidenceStrength.map((entry) => ({
      aspect: entry.aspect,
      aspectText: aspectText(entry.aspect),
      level: entry.level,
      levelText: EVIDENCE_LEVEL_TEXT[entry.level],
      reviewsWithEvidence: entry.reviewsWithEvidence,
      corpusReviews: entry.corpusReviews,
      note: entry.note,
    })),
    grade: gradePresentationOf(recommendation.gradeAggregates),
    reviewExcerpts: reviewExcerptsOf(recommendation.reviewExcerpts),
    reviewContext: reviewContextOf(recommendation.reviewContext),
    sectionHydration: sectionHydrationOf(recommendation.sectionHydration),
    reviewSource: recommendation.reviewSource,
    reasons: [...recommendation.reasons],
    warnings: [...recommendation.warnings],
  };
}

/**
 * Map one rated-but-not-recommended course.
 *
 * Only the fields this canonical entry actually has are mapped. It carries no confidence and no per-aspect evidence, so the presentation has none either: a card
 * for it must say that it was rated and ranked below the cut, and nothing more.
 *
 * It DOES carry grade aggregates as of PRE-RELEASE-UX-A11, and they are mapped through the same helper the recommended path uses. The card still renders none of
 * them — that is the next slice — so the model is ready while the DOM stays as it was.
 *
 * @param entry - the canonical entry.
 * @returns the presentation.
 */
export function toRatedCoursePresentation(entry: RatedButNotRecommendedEntry): RatedCoursePresentation {
  return {
    kind: 'ratedButNotRecommended',
    ...identityOf(entry.course),
    rank: entry.rank,
    score: entry.score,
    statusText: COURSE_STATUS_TEXT.rated,
    reviewContext: reviewContextOf(entry.reviewContext),
    sectionHydration: sectionHydrationOf(entry.sectionHydration),
    grade: gradePresentationOf(entry.gradeAggregates),
    reviewExcerpts: reviewExcerptsOf(entry.reviewExcerpts),
  };
}

/**
 * Map one insufficient-data course.
 *
 * The canonical entry has no score, so the presentation has none — not `0`, not `null` rendered as a number. And its `match.confidence` is carried under a
 * `match` name so no consumer can mistake it for a recommendation confidence.
 *
 * @param entry - the canonical entry.
 * @returns the presentation.
 */
export function toInsufficientCoursePresentation(
  entry: RecommendationResult['insufficientData'][number],
): InsufficientCoursePresentation {
  return {
    kind: 'insufficientData',
    ...identityOf(entry.course),
    statusText: COURSE_STATUS_TEXT.insufficient,
    reason: entry.reason,
    match: { method: entry.match.method, confidence: entry.match.confidence },
    reviewSource: entry.reviewSource,
  };
}
