/**
 * The aspect lexicon: every Chinese phrase rule in one reviewable table.
 *
 * Kept centralized on purpose. The provider must never grow its own ad-hoc
 * keyword lists, because a scattered rule is a rule nobody reviews — and an
 * unreviewed rule is how `作业很多` once scored *better* than `作业多`.
 *
 * Conventions:
 *
 * - **Longest phrase wins.** `作业很多` is listed explicitly and matched before
 *   `作业`, so specificity is never overwritten by a shorter, generic rule.
 * - **`preNegated`** marks phrases whose surface form already carries the
 *   negation (`不签到`), so a preceding `不` cannot flip them twice.
 * - **One phrase, several aspects** is expressed as several rows, e.g. `水` for
 *   both `workloadFriendliness` (positive) and `teachingQuality` (negative).
 *
 * @module @course-copilot/core/aspects/lexicon
 */

import type { AspectKey, ExamFormat, LexiconEntry, Polarity, Strength } from './types.js';

/** Shorthand builder so the table below stays readable. */
function entry(
  phrase: string,
  aspect: AspectKey,
  polarity: Polarity,
  strength: Strength = 'normal',
  extra: { preNegated?: boolean; note?: string } = {},
): LexiconEntry {
  const result: LexiconEntry = { phrase, aspect, polarity, strength };
  if (extra.preNegated === true) result.preNegated = true;
  if (extra.note !== undefined) result.note = extra.note;
  return result;
}

/**
 * Grade friendliness — how generously the course is marked.
 *
 * Deliberately about *marking behaviour*, not about the score a student got: a
 * 95 says the student did well, `给分高` says the course is generous. Phase 2
 * keeps the two signals separate and combines them explicitly.
 */
const GRADE_ENTRIES: readonly LexiconEntry[] = [
  entry('平时分给很高', 'gradeFriendliness', 'positive', 'strong'),
  entry('平时分会给很高', 'gradeFriendliness', 'positive', 'strong'),
  entry('平时分拉满', 'gradeFriendliness', 'positive', 'strong'),
  entry('平时分给满', 'gradeFriendliness', 'positive', 'strong'),
  entry('给分超高', 'gradeFriendliness', 'positive', 'strong'),
  entry('给分很高', 'gradeFriendliness', 'positive', 'strong'),
  entry('给分挺高', 'gradeFriendliness', 'positive', 'strong'),
  entry('给分高', 'gradeFriendliness', 'positive', 'normal'),
  entry('给分很好', 'gradeFriendliness', 'positive', 'strong'),
  entry('给分挺好', 'gradeFriendliness', 'positive', 'strong'),
  entry('给分不错', 'gradeFriendliness', 'positive', 'strong'),
  entry('给分好', 'gradeFriendliness', 'positive', 'normal'),
  entry('不压分', 'gradeFriendliness', 'positive', 'strong', { preNegated: true }),
  entry('不卡分', 'gradeFriendliness', 'positive', 'strong', { preNegated: true }),
  entry('会捞', 'gradeFriendliness', 'positive', 'normal', { note: '“老师最后会捞” = 提高不及格边缘的分数' }),
  entry('捞人', 'gradeFriendliness', 'positive', 'normal'),
  entry('给分大方', 'gradeFriendliness', 'positive', 'normal'),
  entry('给分松', 'gradeFriendliness', 'positive', 'normal'),
  entry('给分水', 'gradeFriendliness', 'positive', 'mild'),

  entry('压分', 'gradeFriendliness', 'negative', 'strong'),
  entry('卡分', 'gradeFriendliness', 'negative', 'strong'),
  entry('给分很低', 'gradeFriendliness', 'negative', 'strong'),
  entry('给分低', 'gradeFriendliness', 'negative', 'normal'),
  entry('给分不高', 'gradeFriendliness', 'negative', 'normal', {
    note: '显式条目：`不高` 不是本模块的否定词（否定词是 不/没/无…），所以这条必须自己声明',
  }),
  entry('平时分低', 'gradeFriendliness', 'negative', 'normal'),
  entry('平时分很低', 'gradeFriendliness', 'negative', 'strong'),
  entry('给分迷', 'gradeFriendliness', 'negative', 'normal', { note: '武汉方言：给分不透明/看运气' }),
  entry('给分迷之', 'gradeFriendliness', 'negative', 'normal'),
  entry('给分抠', 'gradeFriendliness', 'negative', 'normal'),
  entry('绩点杀手', 'gradeFriendliness', 'negative', 'strong'),
  // Deliberately no bare `不高` row: the negation rule handles a *positive* rule
  // preceded by a negator (`不难` over `难`), while Chinese forms that embed the
  // negation inside the phrase (`给分不高`, `不签到`) are listed explicitly.
];

/** Workload — how heavy the assignments and continuous assessment are. */
const WORKLOAD_ENTRIES: readonly LexiconEntry[] = [
  entry('几乎没有作业', 'workloadFriendliness', 'positive', 'strong'),
  entry('基本没有作业', 'workloadFriendliness', 'positive', 'strong'),
  entry('没有平时作业', 'workloadFriendliness', 'positive', 'strong'),
  entry('几乎没作业', 'workloadFriendliness', 'positive', 'strong'),
  entry('基本没作业', 'workloadFriendliness', 'positive', 'strong'),
  entry('没什么作业', 'workloadFriendliness', 'positive', 'strong'),
  entry('没有作业', 'workloadFriendliness', 'positive', 'strong'),
  entry('无作业', 'workloadFriendliness', 'positive', 'strong', { preNegated: true }),
  // `no_exam` is credited here, with provenance naming exam format as its origin:
  // an exam-free course is genuinely low-effort, but that is a workload fact and
  // must not be laundered into "the exam was easy".
  entry('没有期末考试', 'workloadFriendliness', 'positive', 'strong', { note: '来源为 exam format（no_exam）' }),
  entry('没有考试', 'workloadFriendliness', 'positive', 'strong', { note: '来源为 exam format（no_exam）' }),
  entry('无考试', 'workloadFriendliness', 'positive', 'strong', { preNegated: true, note: '来源为 exam format（no_exam）' }),
  entry('不考试', 'workloadFriendliness', 'positive', 'strong', { preNegated: true, note: '来源为 exam format（no_exam）' }),
  entry('作业很少', 'workloadFriendliness', 'positive', 'strong'),
  entry('作业不多', 'workloadFriendliness', 'positive', 'normal'),
  entry('作业少', 'workloadFriendliness', 'positive', 'normal'),
  entry('任务量很小', 'workloadFriendliness', 'positive', 'strong'),
  entry('任务很轻', 'workloadFriendliness', 'positive', 'strong'),
  entry('负担很轻', 'workloadFriendliness', 'positive', 'strong'),
  entry('压力很小', 'workloadFriendliness', 'positive', 'strong'),
  entry('轻松', 'workloadFriendliness', 'positive', 'normal'),
  entry('水', 'workloadFriendliness', 'positive', 'mild', { note: '对 workload 正面；对 teachingQuality 负面，见下表' }),

  entry('每周两次作业', 'workloadFriendliness', 'negative', 'mild', { note: '频率信号：比“作业很多”轻' }),
  entry('每周一次作业', 'workloadFriendliness', 'negative', 'mild'),
  entry('每周都有作业', 'workloadFriendliness', 'negative', 'normal'),
  entry('每节课都有作业', 'workloadFriendliness', 'negative', 'strong'),
  entry('作业特别多', 'workloadFriendliness', 'negative', 'strong'),
  entry('作业非常多', 'workloadFriendliness', 'negative', 'strong'),
  entry('作业很多', 'workloadFriendliness', 'negative', 'strong'),
  entry('作业比较多', 'workloadFriendliness', 'negative', 'normal'),
  entry('作业太多了', 'workloadFriendliness', 'negative', 'strong'),
  entry('作业多', 'workloadFriendliness', 'negative', 'normal'),
  entry('作业量大', 'workloadFriendliness', 'negative', 'strong'),
  entry('大作业', 'workloadFriendliness', 'negative', 'normal'),
  entry('小组作业', 'workloadFriendliness', 'negative', 'normal'),
  entry('课堂展示', 'workloadFriendliness', 'negative', 'normal'),
  entry('小组展示', 'workloadFriendliness', 'negative', 'normal'),
  entry('presentation', 'workloadFriendliness', 'negative', 'normal'),
  entry('pre', 'workloadFriendliness', 'negative', 'mild'),
  entry('读书报告', 'workloadFriendliness', 'negative', 'normal'),
  entry('实验报告', 'workloadFriendliness', 'negative', 'normal'),
  entry('小论文', 'workloadFriendliness', 'negative', 'normal'),
  entry('论文', 'workloadFriendliness', 'negative', 'normal'),
  entry('任务量很大', 'workloadFriendliness', 'negative', 'strong'),
  entry('任务很重', 'workloadFriendliness', 'negative', 'strong'),
  entry('负担很重', 'workloadFriendliness', 'negative', 'strong'),
  entry('压力很大', 'workloadFriendliness', 'negative', 'strong'),
  entry('作业', 'workloadFriendliness', 'negative', 'mild', { note: '兜底：仅在更具体的作业短语未命中时才起作用' }),
];

/** Attendance — how strictly presence is checked. */
const ATTENDANCE_ENTRIES: readonly LexiconEntry[] = [
  entry('从不签到', 'attendanceFriendliness', 'positive', 'strong'),
  entry('从来不签到', 'attendanceFriendliness', 'positive', 'strong'),
  entry('从来不点名', 'attendanceFriendliness', 'positive', 'strong'),
  entry('从不点名', 'attendanceFriendliness', 'positive', 'strong'),
  entry('没有考勤', 'attendanceFriendliness', 'positive', 'strong'),
  entry('几乎不考勤', 'attendanceFriendliness', 'positive', 'strong'),
  entry('不用签到', 'attendanceFriendliness', 'positive', 'strong'),
  entry('不查考勤', 'attendanceFriendliness', 'positive', 'strong'),
  entry('不签到', 'attendanceFriendliness', 'positive', 'strong', { preNegated: true }),
  entry('不点名', 'attendanceFriendliness', 'positive', 'strong', { preNegated: true }),
  entry('无考勤', 'attendanceFriendliness', 'positive', 'strong', { preNegated: true }),
  entry('几乎不点名', 'attendanceFriendliness', 'positive', 'strong'),
  entry('很少点名', 'attendanceFriendliness', 'positive', 'normal'),
  entry('很少签到', 'attendanceFriendliness', 'positive', 'normal'),
  entry('偶尔点名', 'attendanceFriendliness', 'positive', 'mild'),
  entry('偶尔签到', 'attendanceFriendliness', 'positive', 'mild'),
  entry('偶尔考勤', 'attendanceFriendliness', 'positive', 'mild'),
  entry('管得很松', 'attendanceFriendliness', 'positive', 'strong'),
  entry('管得松', 'attendanceFriendliness', 'positive', 'normal'),
  entry('不管', 'attendanceFriendliness', 'positive', 'normal'),
  entry('散养', 'attendanceFriendliness', 'positive', 'normal'),

  entry('每节课都点名', 'attendanceFriendliness', 'negative', 'strong'),
  entry('每次都点名', 'attendanceFriendliness', 'negative', 'strong'),
  entry('每节课都签到', 'attendanceFriendliness', 'negative', 'strong'),
  entry('每次都签到', 'attendanceFriendliness', 'negative', 'strong'),
  entry('每节课签到', 'attendanceFriendliness', 'negative', 'strong'),
  entry('堂堂点名', 'attendanceFriendliness', 'negative', 'strong'),
  entry('点名频繁', 'attendanceFriendliness', 'negative', 'strong'),
  entry('经常点名', 'attendanceFriendliness', 'negative', 'normal'),
  entry('随机点名', 'attendanceFriendliness', 'negative', 'normal'),
  entry('随机签到', 'attendanceFriendliness', 'negative', 'normal'),
  entry('抽查点名', 'attendanceFriendliness', 'negative', 'normal'),
  entry('点名回答问题', 'attendanceFriendliness', 'negative', 'normal'),
  entry('点名严格', 'attendanceFriendliness', 'negative', 'strong'),
  entry('考勤严格', 'attendanceFriendliness', 'negative', 'strong'),
  entry('必须签到', 'attendanceFriendliness', 'negative', 'strong'),
  entry('签到', 'attendanceFriendliness', 'negative', 'mild'),
  entry('点名', 'attendanceFriendliness', 'negative', 'mild'),
  entry('考勤', 'attendanceFriendliness', 'negative', 'mild'),
];

/**
 * Exam friendliness — the **difficulty** of the final assessment.
 *
 * Format lives in {@link EXAM_FORMAT_PATTERNS} and is never scored: `闭卷`
 * describes how the exam is run, not how hard it is, and treating it as a
 * difficulty signal made every closed-book course look brutal. Only statements
 * *about* difficulty or convenience belong here.
 *
 * The core rule is the bare difficulty adjective (`简单`, `难`). Qualified forms
 * (`考试很简单`, `期末很难`) are matched by longest-phrase rules where the qualifier
 * itself carries meaning, and by the prefix-negation rule for `不难`/`简单不了`.
 */
const EXAM_ENTRIES: readonly LexiconEntry[] = [
  entry('考试比较简单', 'examFriendliness', 'positive', 'normal'),
  entry('考试很简单', 'examFriendliness', 'positive', 'strong'),
  entry('期末很简单', 'examFriendliness', 'positive', 'strong'),
  entry('很容易过', 'examFriendliness', 'positive', 'strong'),
  entry('很好过', 'examFriendliness', 'positive', 'normal'),
  entry('不算难', 'examFriendliness', 'positive', 'normal'),
  entry('不难', 'examFriendliness', 'positive', 'strong'),
  entry('简单', 'examFriendliness', 'positive', 'normal'),
  entry('难度不大', 'examFriendliness', 'positive', 'normal'),
  entry('划重点', 'examFriendliness', 'positive', 'normal'),
  entry('原题多', 'examFriendliness', 'positive', 'normal'),
  entry('有题库', 'examFriendliness', 'positive', 'normal'),
  entry('开题库', 'examFriendliness', 'positive', 'normal'),
  entry('题库', 'examFriendliness', 'positive', 'mild'),
  entry('给分题', 'examFriendliness', 'positive', 'normal'),

  entry('考试特别难', 'examFriendliness', 'negative', 'strong'),
  entry('考试很难', 'examFriendliness', 'negative', 'strong'),
  entry('考试好难', 'examFriendliness', 'negative', 'strong'),
  entry('期末考试很难', 'examFriendliness', 'negative', 'strong'),
  entry('期末很难', 'examFriendliness', 'negative', 'strong'),
  entry('题很难', 'examFriendliness', 'negative', 'strong'),
  entry('特别难', 'examFriendliness', 'negative', 'strong'),
  entry('非常难', 'examFriendliness', 'negative', 'strong'),
  entry('很难过', 'examFriendliness', 'negative', 'strong'),
  entry('不好过', 'examFriendliness', 'negative', 'strong'),
  entry('容易挂', 'examFriendliness', 'negative', 'strong'),
  entry('挂科多', 'examFriendliness', 'negative', 'strong'),
  entry('挂科率高', 'examFriendliness', 'negative', 'strong'),
  entry('题量大', 'examFriendliness', 'negative', 'normal'),
  entry('考试难', 'examFriendliness', 'negative', 'normal'),
  entry('期末难', 'examFriendliness', 'negative', 'normal'),
  entry('难', 'examFriendliness', 'negative', 'normal', {
    note: '兜底难度词：`不难` 已显式列出，`简单` 是独立的正向词',
  }),
];

/** Teaching quality — how well the material is actually taught. */
const TEACHING_ENTRIES: readonly LexiconEntry[] = [
  entry('讲得特别好', 'teachingQuality', 'positive', 'strong'),
  entry('讲得很好懂', 'teachingQuality', 'positive', 'strong'),
  entry('讲得很好', 'teachingQuality', 'positive', 'strong'),
  entry('讲得挺好', 'teachingQuality', 'positive', 'strong'),
  entry('讲得不错', 'teachingQuality', 'positive', 'strong'),
  entry('讲得很清楚', 'teachingQuality', 'positive', 'strong'),
  entry('讲的很清楚', 'teachingQuality', 'positive', 'strong'),
  entry('讲得清楚', 'teachingQuality', 'positive', 'normal'),
  entry('讲的清楚', 'teachingQuality', 'positive', 'normal'),
  entry('讲得很仔细', 'teachingQuality', 'positive', 'strong'),
  entry('讲的很仔细', 'teachingQuality', 'positive', 'strong'),
  entry('讲得仔细', 'teachingQuality', 'positive', 'normal'),
  entry('讲得认真', 'teachingQuality', 'positive', 'normal'),
  entry('讲得非常认真', 'teachingQuality', 'positive', 'strong'),
  entry('认真负责', 'teachingQuality', 'positive', 'normal'),
  entry('很负责', 'teachingQuality', 'positive', 'normal'),
  entry('干货多', 'teachingQuality', 'positive', 'normal'),
  entry('有意思', 'teachingQuality', 'positive', 'normal'),
  entry('重点明显', 'teachingQuality', 'positive', 'normal'),
  entry('明显', 'teachingQuality', 'positive', 'mild', {
    note: '前缀规则的主要落点之一：`不明显` 由 negation 从此条翻转',
  }),
  entry('幽默', 'teachingQuality', 'positive', 'mild'),
  entry('思路清晰', 'teachingQuality', 'positive', 'normal'),
  entry('很温柔', 'teachingQuality', 'positive', 'mild'),
  entry('很耐心', 'teachingQuality', 'positive', 'normal'),

  entry('照本宣科', 'teachingQuality', 'negative', 'strong'),
  entry('念PPT', 'teachingQuality', 'negative', 'strong'),
  entry('念ppt', 'teachingQuality', 'negative', 'strong'),
  entry('读PPT', 'teachingQuality', 'negative', 'strong'),
  entry('讲得一般', 'teachingQuality', 'negative', 'normal'),
  entry('讲的一般', 'teachingQuality', 'negative', 'normal'),
  entry('讲不清楚', 'teachingQuality', 'negative', 'strong'),
  entry('听不懂', 'teachingQuality', 'negative', 'strong'),
  entry('很难理解', 'teachingQuality', 'negative', 'normal'),
  entry('比较难理解', 'teachingQuality', 'negative', 'normal'),
  entry('学不到东西', 'teachingQuality', 'negative', 'strong'),
  entry('学不到什么', 'teachingQuality', 'negative', 'strong'),
  entry('有点水', 'teachingQuality', 'negative', 'normal'),
  entry('上课有点水', 'teachingQuality', 'negative', 'normal'),
  entry('水课', 'teachingQuality', 'negative', 'normal'),
  entry('口音重', 'teachingQuality', 'negative', 'mild'),
  entry('有口音', 'teachingQuality', 'negative', 'mild'),
  entry('自言自语', 'teachingQuality', 'negative', 'normal'),
  entry('速度快', 'teachingQuality', 'negative', 'mild'),
  entry('进度快', 'teachingQuality', 'negative', 'mild'),
];

/**
 * General sentiment — how students felt, independent of any dimension.
 *
 * Kept separate from the five substantive aspects on purpose: `推荐` is real
 * evidence about a course but says nothing about *why*, so it must not be
 * attributed to workload or teaching.
 */
const SENTIMENT_ENTRIES: readonly LexiconEntry[] = [
  entry('强烈推荐', 'studentSentiment', 'positive', 'strong'),
  entry('无脑冲', 'studentSentiment', 'positive', 'strong'),
  entry('神中神', 'studentSentiment', 'positive', 'strong'),
  entry('特别好', 'studentSentiment', 'positive', 'strong'),
  entry('非常好', 'studentSentiment', 'positive', 'strong'),
  entry('挺好的', 'studentSentiment', 'positive', 'normal'),
  entry('推荐', 'studentSentiment', 'positive', 'normal'),
  entry('值得', 'studentSentiment', 'positive', 'normal'),
  entry('满意', 'studentSentiment', 'positive', 'normal'),
  entry('喜欢', 'studentSentiment', 'positive', 'normal'),
  entry('好评', 'studentSentiment', 'positive', 'normal'),
  entry('不错', 'studentSentiment', 'positive', 'mild'),
  entry('很好', 'studentSentiment', 'positive', 'normal'),
  entry('还行', 'studentSentiment', 'positive', 'mild'),
  entry('可以冲', 'studentSentiment', 'positive', 'normal'),

  entry('不推荐', 'studentSentiment', 'negative', 'strong', { preNegated: true }),
  entry('强烈不推荐', 'studentSentiment', 'negative', 'strong', { preNegated: true }),
  entry('千万别选', 'studentSentiment', 'negative', 'strong'),
  entry('很烂', 'studentSentiment', 'negative', 'strong'),
  entry('很差', 'studentSentiment', 'negative', 'strong'),
  entry('不好', 'studentSentiment', 'negative', 'strong', { preNegated: true }),
  entry('后悔', 'studentSentiment', 'negative', 'strong'),
  entry('避雷', 'studentSentiment', 'negative', 'strong'),
  entry('不怎么样', 'studentSentiment', 'negative', 'normal', { preNegated: true }),
  entry('一般', 'studentSentiment', 'negative', 'mild'),
  entry('无聊', 'studentSentiment', 'negative', 'normal'),
  entry('折磨', 'studentSentiment', 'negative', 'strong'),
];

/**
 * The full lexicon.
 *
 * Order is irrelevant to matching (the extractor sorts by phrase length), so
 * entries are grouped by aspect for reviewability.
 */
export const ASPECT_LEXICON: readonly LexiconEntry[] = [
  ...GRADE_ENTRIES,
  ...WORKLOAD_ENTRIES,
  ...ATTENDANCE_ENTRIES,
  ...EXAM_ENTRIES,
  ...TEACHING_ENTRIES,
  ...SENTIMENT_ENTRIES,
];

/** One assessment-format pattern. */
export interface ExamFormatPattern {
  /** The surface phrase. */
  phrase: string;
  /** The format it states. */
  format: ExamFormat;
}

/**
 * Assessment-format phrases, matched longest-first like everything else.
 *
 * Kept apart from {@link ASPECT_LEXICON} because these describe *how* the exam
 * is run and carry no difficulty opinion. `no_exam` is the one format that is
 * also good news, and it is credited as an explicit convenience signal with
 * provenance naming its origin, never as "the exam was easy".
 */
export const EXAM_FORMAT_PATTERNS: readonly ExamFormatPattern[] = [
  { phrase: '学校统一闭卷考试', format: 'closed_book' },
  { phrase: '统一闭卷考试', format: 'closed_book' },
  { phrase: '闭卷考试', format: 'closed_book' },
  { phrase: '闭卷', format: 'closed_book' },
  { phrase: '开卷考试', format: 'open_book' },
  { phrase: '开卷', format: 'open_book' },
  { phrase: '没有期末考试', format: 'no_exam' },
  { phrase: '没有考试', format: 'no_exam' },
  { phrase: '无考试', format: 'no_exam' },
  { phrase: '不考试', format: 'no_exam' },
  { phrase: '免考试', format: 'no_exam' },
  { phrase: '写论文', format: 'paper' },
  { phrase: '交论文', format: 'paper' },
  { phrase: '期末论文', format: 'paper' },
  { phrase: '课程论文', format: 'paper' },
  { phrase: '大论文', format: 'paper' },
  { phrase: '论文结课', format: 'paper' },
  { phrase: '论文', format: 'paper' },
  { phrase: '课程展示', format: 'presentation' },
  { phrase: '期末展示', format: 'presentation' },
  { phrase: '课堂展示', format: 'presentation' },
  { phrase: '小组展示', format: 'presentation' },
  { phrase: 'pre', format: 'presentation' },
  { phrase: 'presentation', format: 'presentation' },
];
