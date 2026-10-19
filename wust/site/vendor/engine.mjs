// packages/core/dist/eligibility.js
function availabilityFromSeats(remainingSeats) {
  if (remainingSeats === void 0 || Number.isNaN(remainingSeats))
    return "unknown";
  return remainingSeats > 0 ? "available" : "full";
}
function hasUsableName(course) {
  return course.normalizedName.length > 0 || course.courseCode !== void 0;
}
function evaluateEligibility(course, preferences = void 0) {
  const reasons = [];
  let eligible = true;
  if (!hasUsableName(course)) {
    eligible = false;
    reasons.push("\u8BFE\u7A0B\u540D\u79F0\u4E0E\u8BFE\u7A0B\u53F7\u5747\u4E3A\u7A7A\uFF0C\u65E0\u6CD5\u8BC6\u522B\u8BE5\u8BFE\u7A0B");
  }
  if (course.availability === "full") {
    let detail;
    if (course.remainingSeats === void 0) {
      detail = "\u9875\u9762\u6807\u8BB0\u4E3A\u5DF2\u6EE1";
    } else if (course.remainingSeats <= 0) {
      detail = `\u4F59\u91CF ${course.remainingSeats}\uFF08<= 0\uFF09`;
    } else {
      detail = `\u9875\u9762\u72B6\u6001\u6807\u8BB0\u4E3A\u5DF2\u6EE1\uFF0C\u4F46\u540C\u65F6\u8BFB\u53D6\u5230\u4F59\u91CF ${course.remainingSeats}\uFF1B\u9875\u9762\u4FE1\u606F\u5B58\u5728\u51B2\u7A81`;
    }
    if (preferences?.requireAvailableSeats === false) {
      reasons.push(`\u5DF2\u6EE1\u4F46\u6309\u504F\u597D\u4FDD\u7559\uFF1A${detail}`);
    } else {
      eligible = false;
      reasons.push(`\u4E0D\u53EF\u9009\uFF1A${detail}`);
    }
  } else if (course.availability === "unknown") {
    reasons.push("\u4F59\u91CF\u672A\u77E5\uFF0C\u672A\u6309\u5DF2\u6EE1\u5904\u7406\uFF08availability=unknown\uFF09");
  } else {
    reasons.push(`\u4F59\u91CF\u5145\u8DB3\uFF1A${course.remainingSeats ?? "?"}`);
  }
  if (course.selectable === false) {
    eligible = false;
    reasons.push("\u9875\u9762\u663E\u793A\u8BE5\u884C\u4E0D\u53EF\u9009\uFF08selectable=false\uFF09");
  }
  return { course, eligible, reasons };
}
function filterEligible(courses, preferences = void 0) {
  const eligible = [];
  const excluded = [];
  for (const course of courses) {
    const decision = evaluateEligibility(course, preferences);
    if (decision.eligible)
      eligible.push(course);
    else
      excluded.push(decision);
  }
  return { eligible, excluded };
}

// packages/provider/dist/types.js
var ReviewProviderError = class extends Error {
  code;
  provider;
  status;
  constructor(provider, code, message, status) {
    super(message);
    this.name = "ReviewProviderError";
    this.provider = provider;
    this.code = code;
    if (status !== void 0)
      this.status = status;
  }
};

// packages/provider/dist/limiter.js
var realSleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});
var RequestLimiter = class {
  concurrency;
  minIntervalMs;
  sleep;
  now;
  active = 0;
  lastStart = Number.NEGATIVE_INFINITY;
  waiting = [];
  constructor(options) {
    this.concurrency = Math.max(1, Math.trunc(options.concurrency));
    this.minIntervalMs = Math.max(0, options.minIntervalMs);
    this.sleep = options.sleep ?? realSleep;
    this.now = options.now ?? (() => Date.now());
  }
  /** Number of tasks currently holding a slot. */
  get inFlight() {
    return this.active;
  }
  /** Acquire a slot, waiting for capacity and for the rate interval. */
  async acquire() {
    while (this.active >= this.concurrency) {
      await new Promise((resolve) => {
        this.waiting.push(resolve);
      });
    }
    this.active += 1;
    const elapsed = this.now() - this.lastStart;
    const wait = this.minIntervalMs - elapsed;
    if (wait > 0)
      await this.sleep(wait);
    this.lastStart = this.now();
  }
  /** Release a slot and wake one waiter. */
  release() {
    this.active -= 1;
    const next = this.waiting.shift();
    if (next !== void 0)
      next();
  }
  /**
   * Run a task under the limits.
   *
   * @param task - the work to perform.
   * @returns the task's result.
   */
  async run(task) {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }
  /**
   * Run several tasks under the limits.
   *
   * @param tasks - thunks to execute.
   * @returns results in input order.
   */
  async map(tasks) {
    return Promise.all(tasks.map((task) => this.run(task)));
  }
};

// packages/provider/dist/defaults.js
var REVIEW_FETCH_CONCURRENCY = 3;
var REVIEW_FETCH_MIN_INTERVAL_MS = 350;

// packages/core/dist/normalize.js
var ZERO_WIDTH = /[\u200B-\u200D\uFEFF\u00AD]/gu;
var NOISE_CHARS = /[·•・、,，;；:：\-—–_/\\|~^'"`“”‘’*#]+/gu;
var BRACKET_MAP = [
  [/[（【〔〖「『《]/gu, "(", "("],
  [/[）】〕〗」』》]/gu, ")", ")"]
];
var SEMESTER_PATTERNS = [
  // `2024-2025学年`, `2024—2025学年`, `2024~2025`
  /\d{4}\s*[-–—~至]\s*\d{4}\s*(?:学年度|学年|年度)?/gu,
  // `2024学年`, `第一学期`, `第2学期`, `学期`
  /第?\s*[一二三四五六七八九十\d]+\s*学期/gu,
  /(?:19|20)\d{2}\s*(?:学年度|学年)/gu,
  // `2024春`, `2025秋季`
  /(?:19|20)\d{2}\s*[春夏秋冬](?:季)?/gu,
  /\b(?:spring|fall|autumn|winter|summer)\b/giu
];
var SECTION_PATTERNS = [
  /[-_\s]*\(\s*(\d{1,2})\s*\)\s*$/u,
  /[-_\s]+(\d{1,2})\s*$/u,
  /第\s*(\d{1,3})\s*(?:班|教学班|课堂)/gu,
  /教学班\s*[-_]?\s*(\d{1,3})/gu,
  /班号\s*[-_]?\s*(\d{1,3})/gu
];
var LEADING_CODE = /^\s*[[(【]?\s*([A-Za-z]{1,6}\s?-?\s?\d{2,12}|\d{6,16})\s*[\])】]?\s*[-—:：.]?\s*/u;
function foldWidth(input) {
  return input.normalize("NFKC");
}
function collapseWhitespace(input) {
  return input.replace(/[\s\u3000]+/gu, " ").trim();
}
function normalizeTeacherName(teacher) {
  if (teacher === void 0)
    return "";
  let value = foldWidth(teacher).replace(ZERO_WIDTH, "");
  value = value.split(/[、,，/\\;；&+]|和|与/u)[0] ?? value;
  value = value.replace(/(?:教授|副教授|讲师|助教|老师|教师|先生|女士)$/u, "");
  value = value.replace(/[\s\u3000]+/gu, "");
  value = value.replace(NOISE_CHARS, "");
  return value.toLowerCase();
}
function splitTeacherNames(teacher) {
  if (teacher === void 0)
    return [];
  const value = foldWidth(teacher).replace(ZERO_WIDTH, "");
  return value.split(/[、,，/\\;；&+]|和|与/u).map((part) => part.replace(/[\s\u3000]+/gu, " ").trim()).filter((part) => part.length > 0);
}
function teacherNameSet(teacher) {
  const names = typeof teacher === "string" ? splitTeacherNames(teacher) : teacher ?? [];
  const out = [];
  for (const name of names) {
    const key = normalizeTeacherName(name);
    if (key.length > 0 && !out.includes(key))
      out.push(key);
  }
  return out;
}
function teacherSetRelation(left, right) {
  const leftSet = teacherNameSet(left);
  const rightSet = teacherNameSet(right);
  if (leftSet.length === 0 || rightSet.length === 0)
    return "unknown";
  return leftSet.some((name) => rightSet.includes(name)) ? "agree" : "disagree";
}
function normalizeCourseNameDetailed(courseName) {
  const original = courseName;
  let value = foldWidth(courseName).replace(ZERO_WIDTH, "");
  value = collapseWhitespace(value);
  let semesterMarker;
  for (const pattern of SEMESTER_PATTERNS) {
    pattern.lastIndex = 0;
    const match = pattern.exec(value);
    if (match !== null) {
      semesterMarker ??= match[0].trim();
      value = value.replace(pattern, " ");
    }
  }
  value = collapseWhitespace(value);
  let codePrefix;
  const codeMatch = LEADING_CODE.exec(value);
  if (codeMatch !== null && codeMatch[1] !== void 0) {
    const remainder = value.slice(codeMatch[0].length).trim();
    if (remainder.length > 0) {
      codePrefix = codeMatch[1].replace(/\s+/gu, "");
      value = remainder;
    }
  }
  let sectionSuffix;
  for (const pattern of SECTION_PATTERNS) {
    pattern.lastIndex = 0;
    const match = pattern.exec(value);
    if (match === null)
      continue;
    const candidate = (match[1] ?? "").trim();
    if (candidate.length === 0)
      continue;
    const stripped = `${value.slice(0, match.index)}${value.slice(match.index + match[0].length)}`;
    if (collapseWhitespace(stripped).replace(NOISE_CHARS, "").length === 0)
      continue;
    sectionSuffix = candidate;
    value = stripped;
    break;
  }
  value = collapseWhitespace(value);
  let bracketed = "";
  for (const [pattern, replacement] of BRACKET_MAP) {
    value = value.replace(pattern, replacement);
  }
  const qualifierMatches = [...value.matchAll(/\(([^()]*)\)/gu)];
  const lastQualifier = qualifierMatches.at(-1);
  if (lastQualifier !== void 0 && lastQualifier[1] !== void 0) {
    const inner = collapseWhitespace(lastQualifier[1]);
    if (inner.length > 0)
      bracketed = inner;
  }
  value = value.toLowerCase().replace(NOISE_CHARS, "").replace(/[()（）]/gu, "").replace(/\s+/gu, "");
  const result = { original, key: value };
  if (codePrefix !== void 0)
    result.codePrefix = codePrefix;
  if (sectionSuffix !== void 0)
    result.sectionSuffix = sectionSuffix;
  if (semesterMarker !== void 0)
    result.semesterMarker = semesterMarker;
  if (bracketed.length > 0)
    result.qualifier = bracketed.toLowerCase();
  return result;
}
function normalizeCourseName(courseName) {
  return normalizeCourseNameDetailed(courseName).key;
}

// packages/provider/dist/whu.js
var GRADE_MAX = 100;
var GRADE_PASS_LINE = 60;
var GRADE_PERCENTAGE_FLOOR = 10;
var GRADE_GPA_MAX = 5;
var WHU_GRADE_CALIBRATION = [
  [60, 0.5],
  [70, 1.5],
  [75, 3],
  [80, 4.5],
  [85, 6],
  [88, 7],
  [90, 8],
  [93, 9],
  [96, 10]
];
var PROSE_PUNCTUATION = /[。！？；，、：；!?…—～~「」【】〈〉《》“”‘’（）[\]{}]/u;
function hasSentencePunctuation(value) {
  return /[()[\]]/u.test(value) || /['"]/u.test(value.replace(/[A-Za-z]['"](?=[A-Za-z])/gu, ""));
}
var NON_NAME_TOKENS = /^(?:未知|不详|无|没有|待定|其他|其它|外聘|外教团队|教学组|团队|多人|若干|各老师|多个老师|老师|教师|教师组|教学团队|未注明|未填写)$/u;
var MAX_NAME_LENGTH = 14;
var PROSE_TAIL = /(?:的话|无需多言|直接拉满|拉满|平时分|期末分|给分|念PPT|上课|讲得|教学|同学|老师人|不用多言|永远的神|没问题|作业|很[好棒透彻清楚仔细认真负责难快慢多]|得也)/u;
var SPLIT_NAME_SHAPE = /^[\p{Script=Han}\u3400-\u4DBF]{2,4}(?:[·•][\p{Script=Han}]{1,8})?$/u;
function isSplitNameShape(value) {
  if (value.length === 0 || value.includes(" ") || looksLikeProse(value))
    return false;
  if (LATIN_NAME.test(value) && /[A-Za-z]{2}/u.test(value))
    return true;
  return SPLIT_NAME_SHAPE.test(value);
}
var SPLIT_LATIN_NAME = /^[A-Za-z]{2,}[A-Za-z.'\- ]*[A-Za-z.]$/u;
function isSplitLatinName(value) {
  if (!/[A-Za-z]{2}/u.test(value) || looksLikeProse(value))
    return false;
  return SPLIT_LATIN_NAME.test(value);
}
function isNameShape(value) {
  if (value.length === 0)
    return false;
  if ([...value].length > MAX_NAME_LENGTH)
    return false;
  if (LATIN_NAME.test(value))
    return true;
  if (CJK_NAME.test(value.replace(/ /gu, "")))
    return true;
  return false;
}
var LATIN_NAME = /^[A-Za-z][A-Za-z.'\- ]*$/u;
var CJK_NAME = /^[\p{Script=Han}\u3400-\u4DBF]{2,8}(?:[·•.][\p{Script=Han}]{1,8})?$/u;
var TEACHER_SEPARATOR_SPLIT = /[、,，/\\;；&+和与及]/u;
var NAME_PART_SPLIT = /[\s\u3000]+/u;
function looksLikeProse(value) {
  if (value.length === 0)
    return true;
  if ([...value].length > MAX_NAME_LENGTH)
    return true;
  if (PROSE_TAIL.test(value))
    return true;
  return PROSE_PUNCTUATION.test(value) || hasSentencePunctuation(value);
}
function parseTeacher(teacher) {
  if (teacher === void 0)
    return { validity: "missing", names: [] };
  const value = teacher.normalize("NFKC").replace(/[\u200B-\u200D\uFEFF\u00AD]/gu, "").replace(/[\s\u3000]+/gu, " ").trim();
  if (value.length === 0)
    return { validity: "missing", names: [] };
  if (NON_NAME_TOKENS.test(value))
    return { validity: "missing", names: [] };
  if (LATIN_NAME.test(value) && /[A-Za-z]{2}/u.test(value)) {
    return { validity: "valid", teacher: value, names: [value] };
  }
  const separatorSplit = value.split(TEACHER_SEPARATOR_SPLIT).map((part) => part.trim()).filter((part) => part.length > 0);
  if (separatorSplit.length > 1 || value.includes(" ")) {
    const candidates = separatorSplit.flatMap((part) => {
      if (isSplitLatinName(part) || /[A-Za-z]/u.test(part) && isSplitNameShape(part))
        return [part];
      return part.split(NAME_PART_SPLIT).filter((piece) => piece.length > 0);
    });
    const named = candidates.filter((part) => isSplitNameShape(part) || isSplitLatinName(part));
    if (named.length > 1) {
      return { validity: "valid_multiple", names: named };
    }
  }
  if (!looksLikeProse(value) && isNameShape(value)) {
    return { validity: "valid", teacher: value, names: [value] };
  }
  return { validity: "malformed", names: [] };
}
function queryTeacherFilter(teacher) {
  const parsed = parseTeacher(teacher);
  if (parsed.validity !== "valid")
    return void 0;
  return parsed.teacher;
}
function teacherNamesOfCourse(teacher) {
  const out = [];
  for (const name of parseTeacher(teacher).names) {
    const key = normalizeTeacherName(name);
    if (key.length > 0 && !out.includes(key))
      out.push(key);
  }
  return out;
}
function classifyGrade(grade) {
  if (grade === void 0)
    return { scale: "unknown", validity: "invalid" };
  const text = grade.normalize("NFKC").trim();
  if (text.length === 0)
    return { scale: "unknown", validity: "invalid" };
  if (/未知|unknown|不详|无/u.test(text))
    return { scale: "unknown", validity: "invalid" };
  if (!/^-?\d+(?:\.\d+)?$/u.test(text))
    return { scale: "unknown", validity: "invalid" };
  const number = Number.parseFloat(text);
  if (!Number.isFinite(number) || number < 0 || number > GRADE_MAX) {
    return { scale: "unknown", validity: "invalid" };
  }
  const decimals = text.includes(".");
  if (decimals && number <= GRADE_GPA_MAX)
    return { scale: "gpa", validity: "ambiguous", value: number };
  if (!decimals && number < GRADE_PERCENTAGE_FLOOR) {
    return { scale: "unknown", validity: "ambiguous", value: number };
  }
  return { scale: "percentage", validity: "usable", value: number };
}
function gradeDecade(grade) {
  const floor = Math.floor(grade / 10) * 10;
  return String(floor);
}

// packages/provider/dist/review-excerpts.js
var MAX_REVIEW_EXCERPTS = 3;
var MAX_REVIEW_EXCERPT_CHARS = 120;
var REVIEW_EXCERPT_SCOPE_ORDER = ["current_class", "course_reference", "supplementary"];
function dedupeKeyOf(row) {
  return JSON.stringify([row.courseName, row.teacherRaw ?? "", row.commentText ?? "", row.rawGrade ?? ""]);
}
function boundExcerptText(text, cap = MAX_REVIEW_EXCERPT_CHARS) {
  const points = Array.from(text);
  if (points.length <= cap)
    return text;
  return `${points.slice(0, Math.max(0, cap - 1)).join("")}\u2026`;
}
function projectExcerpt(row, scope) {
  const text = row.commentText;
  if (text === void 0 || text.trim().length === 0)
    return void 0;
  return {
    text: boundExcerptText(text),
    scope,
    /*
     * The row's OWN names, never the class's set. For a co-taught class a row naming one of them is still this class's evidence, so
     * substituting the class's names here would attribute one teacher's words to their colleague.
     */
    teacherNames: [...row.teacherNames ?? []],
    teacherValidity: row.teacherValidity
  };
}
function capReviewExcerpts(excerpts) {
  const ranked = REVIEW_EXCERPT_SCOPE_ORDER.flatMap((scope) => excerpts.filter((excerpt) => excerpt.scope === scope));
  return ranked.slice(0, MAX_REVIEW_EXCERPTS);
}
function selectReviewExcerpts(partition) {
  const byScope = {
    current_class: partition.matched,
    course_reference: partition.disjoint,
    supplementary: partition.unassigned
  };
  const projected = [];
  const seen = /* @__PURE__ */ new Set();
  for (const scope of REVIEW_EXCERPT_SCOPE_ORDER) {
    for (const row of byScope[scope]) {
      const key = dedupeKeyOf(row);
      if (seen.has(key))
        continue;
      const excerpt = projectExcerpt(row, scope);
      if (excerpt === void 0)
        continue;
      seen.add(key);
      projected.push(excerpt);
    }
  }
  return capReviewExcerpts(projected);
}

// packages/core/dist/aspects/grade.js
function gradeToFriendliness(grade, calibration) {
  const anchors = calibration;
  if (!Number.isFinite(grade))
    return 0;
  const first = anchors[0];
  if (grade <= first[0])
    return first[1];
  const last = anchors[anchors.length - 1];
  if (grade >= last[0])
    return last[1];
  for (let index = 1; index < anchors.length; index += 1) {
    const [rightX, rightY] = anchors[index];
    const [leftX, leftY] = anchors[index - 1];
    if (grade <= rightX) {
      const ratio = (grade - leftX) / (rightX - leftX);
      return Number((leftY + ratio * (rightY - leftY)).toFixed(4));
    }
  }
  return last[1];
}

// packages/core/dist/aspects/lexicon.js
function entry(phrase, aspect, polarity, strength = "normal", extra = {}) {
  const result = { phrase, aspect, polarity, strength };
  if (extra.preNegated === true)
    result.preNegated = true;
  if (extra.note !== void 0)
    result.note = extra.note;
  return result;
}
var GRADE_ENTRIES = [
  entry("\u5E73\u65F6\u5206\u7ED9\u5F88\u9AD8", "gradeFriendliness", "positive", "strong"),
  entry("\u5E73\u65F6\u5206\u4F1A\u7ED9\u5F88\u9AD8", "gradeFriendliness", "positive", "strong"),
  entry("\u5E73\u65F6\u5206\u62C9\u6EE1", "gradeFriendliness", "positive", "strong"),
  entry("\u5E73\u65F6\u5206\u7ED9\u6EE1", "gradeFriendliness", "positive", "strong"),
  entry("\u7ED9\u5206\u8D85\u9AD8", "gradeFriendliness", "positive", "strong"),
  entry("\u7ED9\u5206\u5F88\u9AD8", "gradeFriendliness", "positive", "strong"),
  entry("\u7ED9\u5206\u633A\u9AD8", "gradeFriendliness", "positive", "strong"),
  entry("\u7ED9\u5206\u9AD8", "gradeFriendliness", "positive", "normal"),
  entry("\u7ED9\u5206\u5F88\u597D", "gradeFriendliness", "positive", "strong"),
  entry("\u7ED9\u5206\u633A\u597D", "gradeFriendliness", "positive", "strong"),
  entry("\u7ED9\u5206\u4E0D\u9519", "gradeFriendliness", "positive", "strong"),
  entry("\u7ED9\u5206\u597D", "gradeFriendliness", "positive", "normal"),
  entry("\u4E0D\u538B\u5206", "gradeFriendliness", "positive", "strong", { preNegated: true }),
  entry("\u4E0D\u5361\u5206", "gradeFriendliness", "positive", "strong", { preNegated: true }),
  entry("\u4F1A\u635E", "gradeFriendliness", "positive", "normal", { note: "\u201C\u8001\u5E08\u6700\u540E\u4F1A\u635E\u201D = \u63D0\u9AD8\u4E0D\u53CA\u683C\u8FB9\u7F18\u7684\u5206\u6570" }),
  entry("\u635E\u4EBA", "gradeFriendliness", "positive", "normal"),
  entry("\u7ED9\u5206\u5927\u65B9", "gradeFriendliness", "positive", "normal"),
  entry("\u7ED9\u5206\u677E", "gradeFriendliness", "positive", "normal"),
  entry("\u7ED9\u5206\u6C34", "gradeFriendliness", "positive", "mild"),
  entry("\u538B\u5206", "gradeFriendliness", "negative", "strong"),
  entry("\u5361\u5206", "gradeFriendliness", "negative", "strong"),
  entry("\u7ED9\u5206\u5F88\u4F4E", "gradeFriendliness", "negative", "strong"),
  entry("\u7ED9\u5206\u4F4E", "gradeFriendliness", "negative", "normal"),
  entry("\u7ED9\u5206\u4E0D\u9AD8", "gradeFriendliness", "negative", "normal", {
    note: "\u663E\u5F0F\u6761\u76EE\uFF1A`\u4E0D\u9AD8` \u4E0D\u662F\u672C\u6A21\u5757\u7684\u5426\u5B9A\u8BCD\uFF08\u5426\u5B9A\u8BCD\u662F \u4E0D/\u6CA1/\u65E0\u2026\uFF09\uFF0C\u6240\u4EE5\u8FD9\u6761\u5FC5\u987B\u81EA\u5DF1\u58F0\u660E"
  }),
  entry("\u5E73\u65F6\u5206\u4F4E", "gradeFriendliness", "negative", "normal"),
  entry("\u5E73\u65F6\u5206\u5F88\u4F4E", "gradeFriendliness", "negative", "strong"),
  entry("\u7ED9\u5206\u8FF7", "gradeFriendliness", "negative", "normal", { note: "\u6B66\u6C49\u65B9\u8A00\uFF1A\u7ED9\u5206\u4E0D\u900F\u660E/\u770B\u8FD0\u6C14" }),
  entry("\u7ED9\u5206\u8FF7\u4E4B", "gradeFriendliness", "negative", "normal"),
  entry("\u7ED9\u5206\u62A0", "gradeFriendliness", "negative", "normal"),
  entry("\u7EE9\u70B9\u6740\u624B", "gradeFriendliness", "negative", "strong")
  // Deliberately no bare `不高` row: the negation rule handles a *positive* rule
  // preceded by a negator (`不难` over `难`), while Chinese forms that embed the
  // negation inside the phrase (`给分不高`, `不签到`) are listed explicitly.
];
var WORKLOAD_ENTRIES = [
  entry("\u51E0\u4E4E\u6CA1\u6709\u4F5C\u4E1A", "workloadFriendliness", "positive", "strong"),
  entry("\u57FA\u672C\u6CA1\u6709\u4F5C\u4E1A", "workloadFriendliness", "positive", "strong"),
  entry("\u6CA1\u6709\u5E73\u65F6\u4F5C\u4E1A", "workloadFriendliness", "positive", "strong"),
  entry("\u51E0\u4E4E\u6CA1\u4F5C\u4E1A", "workloadFriendliness", "positive", "strong"),
  entry("\u57FA\u672C\u6CA1\u4F5C\u4E1A", "workloadFriendliness", "positive", "strong"),
  entry("\u6CA1\u4EC0\u4E48\u4F5C\u4E1A", "workloadFriendliness", "positive", "strong"),
  entry("\u6CA1\u6709\u4F5C\u4E1A", "workloadFriendliness", "positive", "strong"),
  entry("\u65E0\u4F5C\u4E1A", "workloadFriendliness", "positive", "strong", { preNegated: true }),
  // `no_exam` is credited here, with provenance naming exam format as its origin:
  // an exam-free course is genuinely low-effort, but that is a workload fact and
  // must not be laundered into "the exam was easy".
  entry("\u6CA1\u6709\u671F\u672B\u8003\u8BD5", "workloadFriendliness", "positive", "strong", { note: "\u6765\u6E90\u4E3A exam format\uFF08no_exam\uFF09" }),
  entry("\u6CA1\u6709\u8003\u8BD5", "workloadFriendliness", "positive", "strong", { note: "\u6765\u6E90\u4E3A exam format\uFF08no_exam\uFF09" }),
  entry("\u65E0\u8003\u8BD5", "workloadFriendliness", "positive", "strong", { preNegated: true, note: "\u6765\u6E90\u4E3A exam format\uFF08no_exam\uFF09" }),
  entry("\u4E0D\u8003\u8BD5", "workloadFriendliness", "positive", "strong", { preNegated: true, note: "\u6765\u6E90\u4E3A exam format\uFF08no_exam\uFF09" }),
  entry("\u4F5C\u4E1A\u5F88\u5C11", "workloadFriendliness", "positive", "strong"),
  entry("\u4F5C\u4E1A\u4E0D\u591A", "workloadFriendliness", "positive", "normal"),
  entry("\u4F5C\u4E1A\u5C11", "workloadFriendliness", "positive", "normal"),
  entry("\u4EFB\u52A1\u91CF\u5F88\u5C0F", "workloadFriendliness", "positive", "strong"),
  entry("\u4EFB\u52A1\u5F88\u8F7B", "workloadFriendliness", "positive", "strong"),
  entry("\u8D1F\u62C5\u5F88\u8F7B", "workloadFriendliness", "positive", "strong"),
  entry("\u538B\u529B\u5F88\u5C0F", "workloadFriendliness", "positive", "strong"),
  entry("\u8F7B\u677E", "workloadFriendliness", "positive", "normal"),
  entry("\u6C34", "workloadFriendliness", "positive", "mild", { note: "\u5BF9 workload \u6B63\u9762\uFF1B\u5BF9 teachingQuality \u8D1F\u9762\uFF0C\u89C1\u4E0B\u8868" }),
  entry("\u6BCF\u5468\u4E24\u6B21\u4F5C\u4E1A", "workloadFriendliness", "negative", "mild", { note: "\u9891\u7387\u4FE1\u53F7\uFF1A\u6BD4\u201C\u4F5C\u4E1A\u5F88\u591A\u201D\u8F7B" }),
  entry("\u6BCF\u5468\u4E00\u6B21\u4F5C\u4E1A", "workloadFriendliness", "negative", "mild"),
  entry("\u6BCF\u5468\u90FD\u6709\u4F5C\u4E1A", "workloadFriendliness", "negative", "normal"),
  entry("\u6BCF\u8282\u8BFE\u90FD\u6709\u4F5C\u4E1A", "workloadFriendliness", "negative", "strong"),
  entry("\u4F5C\u4E1A\u7279\u522B\u591A", "workloadFriendliness", "negative", "strong"),
  entry("\u4F5C\u4E1A\u975E\u5E38\u591A", "workloadFriendliness", "negative", "strong"),
  entry("\u4F5C\u4E1A\u5F88\u591A", "workloadFriendliness", "negative", "strong"),
  entry("\u4F5C\u4E1A\u6BD4\u8F83\u591A", "workloadFriendliness", "negative", "normal"),
  entry("\u4F5C\u4E1A\u592A\u591A\u4E86", "workloadFriendliness", "negative", "strong"),
  entry("\u4F5C\u4E1A\u591A", "workloadFriendliness", "negative", "normal"),
  entry("\u4F5C\u4E1A\u91CF\u5927", "workloadFriendliness", "negative", "strong"),
  entry("\u5927\u4F5C\u4E1A", "workloadFriendliness", "negative", "normal"),
  entry("\u5C0F\u7EC4\u4F5C\u4E1A", "workloadFriendliness", "negative", "normal"),
  entry("\u8BFE\u5802\u5C55\u793A", "workloadFriendliness", "negative", "normal"),
  entry("\u5C0F\u7EC4\u5C55\u793A", "workloadFriendliness", "negative", "normal"),
  entry("presentation", "workloadFriendliness", "negative", "normal"),
  entry("pre", "workloadFriendliness", "negative", "mild"),
  entry("\u8BFB\u4E66\u62A5\u544A", "workloadFriendliness", "negative", "normal"),
  entry("\u5B9E\u9A8C\u62A5\u544A", "workloadFriendliness", "negative", "normal"),
  entry("\u5C0F\u8BBA\u6587", "workloadFriendliness", "negative", "normal"),
  entry("\u8BBA\u6587", "workloadFriendliness", "negative", "normal"),
  entry("\u4EFB\u52A1\u91CF\u5F88\u5927", "workloadFriendliness", "negative", "strong"),
  entry("\u4EFB\u52A1\u5F88\u91CD", "workloadFriendliness", "negative", "strong"),
  entry("\u8D1F\u62C5\u5F88\u91CD", "workloadFriendliness", "negative", "strong"),
  entry("\u538B\u529B\u5F88\u5927", "workloadFriendliness", "negative", "strong"),
  entry("\u4F5C\u4E1A", "workloadFriendliness", "negative", "mild", { note: "\u515C\u5E95\uFF1A\u4EC5\u5728\u66F4\u5177\u4F53\u7684\u4F5C\u4E1A\u77ED\u8BED\u672A\u547D\u4E2D\u65F6\u624D\u8D77\u4F5C\u7528" })
];
var ATTENDANCE_ENTRIES = [
  entry("\u4ECE\u4E0D\u7B7E\u5230", "attendanceFriendliness", "positive", "strong"),
  entry("\u4ECE\u6765\u4E0D\u7B7E\u5230", "attendanceFriendliness", "positive", "strong"),
  entry("\u4ECE\u6765\u4E0D\u70B9\u540D", "attendanceFriendliness", "positive", "strong"),
  entry("\u4ECE\u4E0D\u70B9\u540D", "attendanceFriendliness", "positive", "strong"),
  entry("\u6CA1\u6709\u8003\u52E4", "attendanceFriendliness", "positive", "strong"),
  entry("\u51E0\u4E4E\u4E0D\u8003\u52E4", "attendanceFriendliness", "positive", "strong"),
  entry("\u4E0D\u7528\u7B7E\u5230", "attendanceFriendliness", "positive", "strong"),
  entry("\u4E0D\u67E5\u8003\u52E4", "attendanceFriendliness", "positive", "strong"),
  entry("\u4E0D\u7B7E\u5230", "attendanceFriendliness", "positive", "strong", { preNegated: true }),
  entry("\u4E0D\u70B9\u540D", "attendanceFriendliness", "positive", "strong", { preNegated: true }),
  entry("\u65E0\u8003\u52E4", "attendanceFriendliness", "positive", "strong", { preNegated: true }),
  entry("\u51E0\u4E4E\u4E0D\u70B9\u540D", "attendanceFriendliness", "positive", "strong"),
  entry("\u5F88\u5C11\u70B9\u540D", "attendanceFriendliness", "positive", "normal"),
  entry("\u5F88\u5C11\u7B7E\u5230", "attendanceFriendliness", "positive", "normal"),
  entry("\u5076\u5C14\u70B9\u540D", "attendanceFriendliness", "positive", "mild"),
  entry("\u5076\u5C14\u7B7E\u5230", "attendanceFriendliness", "positive", "mild"),
  entry("\u5076\u5C14\u8003\u52E4", "attendanceFriendliness", "positive", "mild"),
  entry("\u7BA1\u5F97\u5F88\u677E", "attendanceFriendliness", "positive", "strong"),
  entry("\u7BA1\u5F97\u677E", "attendanceFriendliness", "positive", "normal"),
  entry("\u4E0D\u7BA1", "attendanceFriendliness", "positive", "normal"),
  entry("\u6563\u517B", "attendanceFriendliness", "positive", "normal"),
  entry("\u6BCF\u8282\u8BFE\u90FD\u70B9\u540D", "attendanceFriendliness", "negative", "strong"),
  entry("\u6BCF\u6B21\u90FD\u70B9\u540D", "attendanceFriendliness", "negative", "strong"),
  entry("\u6BCF\u8282\u8BFE\u90FD\u7B7E\u5230", "attendanceFriendliness", "negative", "strong"),
  entry("\u6BCF\u6B21\u90FD\u7B7E\u5230", "attendanceFriendliness", "negative", "strong"),
  entry("\u6BCF\u8282\u8BFE\u7B7E\u5230", "attendanceFriendliness", "negative", "strong"),
  entry("\u5802\u5802\u70B9\u540D", "attendanceFriendliness", "negative", "strong"),
  entry("\u70B9\u540D\u9891\u7E41", "attendanceFriendliness", "negative", "strong"),
  entry("\u7ECF\u5E38\u70B9\u540D", "attendanceFriendliness", "negative", "normal"),
  entry("\u968F\u673A\u70B9\u540D", "attendanceFriendliness", "negative", "normal"),
  entry("\u968F\u673A\u7B7E\u5230", "attendanceFriendliness", "negative", "normal"),
  entry("\u62BD\u67E5\u70B9\u540D", "attendanceFriendliness", "negative", "normal"),
  entry("\u70B9\u540D\u56DE\u7B54\u95EE\u9898", "attendanceFriendliness", "negative", "normal"),
  entry("\u70B9\u540D\u4E25\u683C", "attendanceFriendliness", "negative", "strong"),
  entry("\u8003\u52E4\u4E25\u683C", "attendanceFriendliness", "negative", "strong"),
  entry("\u5FC5\u987B\u7B7E\u5230", "attendanceFriendliness", "negative", "strong"),
  entry("\u7B7E\u5230", "attendanceFriendliness", "negative", "mild"),
  entry("\u70B9\u540D", "attendanceFriendliness", "negative", "mild"),
  entry("\u8003\u52E4", "attendanceFriendliness", "negative", "mild")
];
var EXAM_ENTRIES = [
  entry("\u8003\u8BD5\u6BD4\u8F83\u7B80\u5355", "examFriendliness", "positive", "normal"),
  entry("\u8003\u8BD5\u5F88\u7B80\u5355", "examFriendliness", "positive", "strong"),
  entry("\u671F\u672B\u5F88\u7B80\u5355", "examFriendliness", "positive", "strong"),
  entry("\u5F88\u5BB9\u6613\u8FC7", "examFriendliness", "positive", "strong"),
  entry("\u5F88\u597D\u8FC7", "examFriendliness", "positive", "normal"),
  entry("\u4E0D\u7B97\u96BE", "examFriendliness", "positive", "normal"),
  entry("\u4E0D\u96BE", "examFriendliness", "positive", "strong"),
  entry("\u7B80\u5355", "examFriendliness", "positive", "normal"),
  entry("\u96BE\u5EA6\u4E0D\u5927", "examFriendliness", "positive", "normal"),
  entry("\u5212\u91CD\u70B9", "examFriendliness", "positive", "normal"),
  entry("\u539F\u9898\u591A", "examFriendliness", "positive", "normal"),
  entry("\u6709\u9898\u5E93", "examFriendliness", "positive", "normal"),
  entry("\u5F00\u9898\u5E93", "examFriendliness", "positive", "normal"),
  entry("\u9898\u5E93", "examFriendliness", "positive", "mild"),
  entry("\u7ED9\u5206\u9898", "examFriendliness", "positive", "normal"),
  entry("\u8003\u8BD5\u7279\u522B\u96BE", "examFriendliness", "negative", "strong"),
  entry("\u8003\u8BD5\u5F88\u96BE", "examFriendliness", "negative", "strong"),
  entry("\u8003\u8BD5\u597D\u96BE", "examFriendliness", "negative", "strong"),
  entry("\u671F\u672B\u8003\u8BD5\u5F88\u96BE", "examFriendliness", "negative", "strong"),
  entry("\u671F\u672B\u5F88\u96BE", "examFriendliness", "negative", "strong"),
  entry("\u9898\u5F88\u96BE", "examFriendliness", "negative", "strong"),
  entry("\u7279\u522B\u96BE", "examFriendliness", "negative", "strong"),
  entry("\u975E\u5E38\u96BE", "examFriendliness", "negative", "strong"),
  entry("\u5F88\u96BE\u8FC7", "examFriendliness", "negative", "strong"),
  entry("\u4E0D\u597D\u8FC7", "examFriendliness", "negative", "strong"),
  entry("\u5BB9\u6613\u6302", "examFriendliness", "negative", "strong"),
  entry("\u6302\u79D1\u591A", "examFriendliness", "negative", "strong"),
  entry("\u6302\u79D1\u7387\u9AD8", "examFriendliness", "negative", "strong"),
  entry("\u9898\u91CF\u5927", "examFriendliness", "negative", "normal"),
  entry("\u8003\u8BD5\u96BE", "examFriendliness", "negative", "normal"),
  entry("\u671F\u672B\u96BE", "examFriendliness", "negative", "normal"),
  entry("\u96BE", "examFriendliness", "negative", "normal", {
    note: "\u515C\u5E95\u96BE\u5EA6\u8BCD\uFF1A`\u4E0D\u96BE` \u5DF2\u663E\u5F0F\u5217\u51FA\uFF0C`\u7B80\u5355` \u662F\u72EC\u7ACB\u7684\u6B63\u5411\u8BCD"
  })
];
var TEACHING_ENTRIES = [
  entry("\u8BB2\u5F97\u7279\u522B\u597D", "teachingQuality", "positive", "strong"),
  entry("\u8BB2\u5F97\u5F88\u597D\u61C2", "teachingQuality", "positive", "strong"),
  entry("\u8BB2\u5F97\u5F88\u597D", "teachingQuality", "positive", "strong"),
  entry("\u8BB2\u5F97\u633A\u597D", "teachingQuality", "positive", "strong"),
  entry("\u8BB2\u5F97\u4E0D\u9519", "teachingQuality", "positive", "strong"),
  entry("\u8BB2\u5F97\u5F88\u6E05\u695A", "teachingQuality", "positive", "strong"),
  entry("\u8BB2\u7684\u5F88\u6E05\u695A", "teachingQuality", "positive", "strong"),
  entry("\u8BB2\u5F97\u6E05\u695A", "teachingQuality", "positive", "normal"),
  entry("\u8BB2\u7684\u6E05\u695A", "teachingQuality", "positive", "normal"),
  entry("\u8BB2\u5F97\u5F88\u4ED4\u7EC6", "teachingQuality", "positive", "strong"),
  entry("\u8BB2\u7684\u5F88\u4ED4\u7EC6", "teachingQuality", "positive", "strong"),
  entry("\u8BB2\u5F97\u4ED4\u7EC6", "teachingQuality", "positive", "normal"),
  entry("\u8BB2\u5F97\u8BA4\u771F", "teachingQuality", "positive", "normal"),
  entry("\u8BB2\u5F97\u975E\u5E38\u8BA4\u771F", "teachingQuality", "positive", "strong"),
  entry("\u8BA4\u771F\u8D1F\u8D23", "teachingQuality", "positive", "normal"),
  entry("\u5F88\u8D1F\u8D23", "teachingQuality", "positive", "normal"),
  entry("\u5E72\u8D27\u591A", "teachingQuality", "positive", "normal"),
  entry("\u6709\u610F\u601D", "teachingQuality", "positive", "normal"),
  entry("\u91CD\u70B9\u660E\u663E", "teachingQuality", "positive", "normal"),
  entry("\u660E\u663E", "teachingQuality", "positive", "mild", {
    note: "\u524D\u7F00\u89C4\u5219\u7684\u4E3B\u8981\u843D\u70B9\u4E4B\u4E00\uFF1A`\u4E0D\u660E\u663E` \u7531 negation \u4ECE\u6B64\u6761\u7FFB\u8F6C"
  }),
  entry("\u5E7D\u9ED8", "teachingQuality", "positive", "mild"),
  entry("\u601D\u8DEF\u6E05\u6670", "teachingQuality", "positive", "normal"),
  entry("\u5F88\u6E29\u67D4", "teachingQuality", "positive", "mild"),
  entry("\u5F88\u8010\u5FC3", "teachingQuality", "positive", "normal"),
  entry("\u7167\u672C\u5BA3\u79D1", "teachingQuality", "negative", "strong"),
  entry("\u5FF5PPT", "teachingQuality", "negative", "strong"),
  entry("\u5FF5ppt", "teachingQuality", "negative", "strong"),
  entry("\u8BFBPPT", "teachingQuality", "negative", "strong"),
  entry("\u8BB2\u5F97\u4E00\u822C", "teachingQuality", "negative", "normal"),
  entry("\u8BB2\u7684\u4E00\u822C", "teachingQuality", "negative", "normal"),
  entry("\u8BB2\u4E0D\u6E05\u695A", "teachingQuality", "negative", "strong"),
  entry("\u542C\u4E0D\u61C2", "teachingQuality", "negative", "strong"),
  entry("\u5F88\u96BE\u7406\u89E3", "teachingQuality", "negative", "normal"),
  entry("\u6BD4\u8F83\u96BE\u7406\u89E3", "teachingQuality", "negative", "normal"),
  entry("\u5B66\u4E0D\u5230\u4E1C\u897F", "teachingQuality", "negative", "strong"),
  entry("\u5B66\u4E0D\u5230\u4EC0\u4E48", "teachingQuality", "negative", "strong"),
  entry("\u6709\u70B9\u6C34", "teachingQuality", "negative", "normal"),
  entry("\u4E0A\u8BFE\u6709\u70B9\u6C34", "teachingQuality", "negative", "normal"),
  entry("\u6C34\u8BFE", "teachingQuality", "negative", "normal"),
  entry("\u53E3\u97F3\u91CD", "teachingQuality", "negative", "mild"),
  entry("\u6709\u53E3\u97F3", "teachingQuality", "negative", "mild"),
  entry("\u81EA\u8A00\u81EA\u8BED", "teachingQuality", "negative", "normal"),
  entry("\u901F\u5EA6\u5FEB", "teachingQuality", "negative", "mild"),
  entry("\u8FDB\u5EA6\u5FEB", "teachingQuality", "negative", "mild")
];
var SENTIMENT_ENTRIES = [
  entry("\u5F3A\u70C8\u63A8\u8350", "studentSentiment", "positive", "strong"),
  entry("\u65E0\u8111\u51B2", "studentSentiment", "positive", "strong"),
  entry("\u795E\u4E2D\u795E", "studentSentiment", "positive", "strong"),
  entry("\u7279\u522B\u597D", "studentSentiment", "positive", "strong"),
  entry("\u975E\u5E38\u597D", "studentSentiment", "positive", "strong"),
  entry("\u633A\u597D\u7684", "studentSentiment", "positive", "normal"),
  entry("\u63A8\u8350", "studentSentiment", "positive", "normal"),
  entry("\u503C\u5F97", "studentSentiment", "positive", "normal"),
  entry("\u6EE1\u610F", "studentSentiment", "positive", "normal"),
  entry("\u559C\u6B22", "studentSentiment", "positive", "normal"),
  entry("\u597D\u8BC4", "studentSentiment", "positive", "normal"),
  entry("\u4E0D\u9519", "studentSentiment", "positive", "mild"),
  entry("\u5F88\u597D", "studentSentiment", "positive", "normal"),
  entry("\u8FD8\u884C", "studentSentiment", "positive", "mild"),
  entry("\u53EF\u4EE5\u51B2", "studentSentiment", "positive", "normal"),
  entry("\u4E0D\u63A8\u8350", "studentSentiment", "negative", "strong", { preNegated: true }),
  entry("\u5F3A\u70C8\u4E0D\u63A8\u8350", "studentSentiment", "negative", "strong", { preNegated: true }),
  entry("\u5343\u4E07\u522B\u9009", "studentSentiment", "negative", "strong"),
  entry("\u5F88\u70C2", "studentSentiment", "negative", "strong"),
  entry("\u5F88\u5DEE", "studentSentiment", "negative", "strong"),
  entry("\u4E0D\u597D", "studentSentiment", "negative", "strong", { preNegated: true }),
  entry("\u540E\u6094", "studentSentiment", "negative", "strong"),
  entry("\u907F\u96F7", "studentSentiment", "negative", "strong"),
  entry("\u4E0D\u600E\u4E48\u6837", "studentSentiment", "negative", "normal", { preNegated: true }),
  entry("\u4E00\u822C", "studentSentiment", "negative", "mild"),
  entry("\u65E0\u804A", "studentSentiment", "negative", "normal"),
  entry("\u6298\u78E8", "studentSentiment", "negative", "strong")
];
var ASPECT_LEXICON = [
  ...GRADE_ENTRIES,
  ...WORKLOAD_ENTRIES,
  ...ATTENDANCE_ENTRIES,
  ...EXAM_ENTRIES,
  ...TEACHING_ENTRIES,
  ...SENTIMENT_ENTRIES
];
var EXAM_FORMAT_PATTERNS = [
  { phrase: "\u5B66\u6821\u7EDF\u4E00\u95ED\u5377\u8003\u8BD5", format: "closed_book" },
  { phrase: "\u7EDF\u4E00\u95ED\u5377\u8003\u8BD5", format: "closed_book" },
  { phrase: "\u95ED\u5377\u8003\u8BD5", format: "closed_book" },
  { phrase: "\u95ED\u5377", format: "closed_book" },
  { phrase: "\u5F00\u5377\u8003\u8BD5", format: "open_book" },
  { phrase: "\u5F00\u5377", format: "open_book" },
  { phrase: "\u6CA1\u6709\u671F\u672B\u8003\u8BD5", format: "no_exam" },
  { phrase: "\u6CA1\u6709\u8003\u8BD5", format: "no_exam" },
  { phrase: "\u65E0\u8003\u8BD5", format: "no_exam" },
  { phrase: "\u4E0D\u8003\u8BD5", format: "no_exam" },
  { phrase: "\u514D\u8003\u8BD5", format: "no_exam" },
  { phrase: "\u5199\u8BBA\u6587", format: "paper" },
  { phrase: "\u4EA4\u8BBA\u6587", format: "paper" },
  { phrase: "\u671F\u672B\u8BBA\u6587", format: "paper" },
  { phrase: "\u8BFE\u7A0B\u8BBA\u6587", format: "paper" },
  { phrase: "\u5927\u8BBA\u6587", format: "paper" },
  { phrase: "\u8BBA\u6587\u7ED3\u8BFE", format: "paper" },
  { phrase: "\u8BBA\u6587", format: "paper" },
  { phrase: "\u8BFE\u7A0B\u5C55\u793A", format: "presentation" },
  { phrase: "\u671F\u672B\u5C55\u793A", format: "presentation" },
  { phrase: "\u8BFE\u5802\u5C55\u793A", format: "presentation" },
  { phrase: "\u5C0F\u7EC4\u5C55\u793A", format: "presentation" },
  { phrase: "pre", format: "presentation" },
  { phrase: "presentation", format: "presentation" }
];

// packages/core/dist/aspects/negation.js
var NEGATION_EXCEPTIONS = [
  "\u4E0D\u7B7E\u5230",
  "\u4E0D\u70B9\u540D",
  "\u4E0D\u67E5\u8003\u52E4",
  "\u4E0D\u7528\u7B7E\u5230",
  "\u65E0\u8003\u52E4",
  "\u6CA1\u6709\u8003\u52E4",
  "\u4E0D\u538B\u5206",
  "\u4E0D\u5361\u5206",
  "\u4E0D\u8003\u8BD5",
  "\u6CA1\u6709\u8003\u8BD5",
  "\u65E0\u8003\u8BD5",
  "\u4E0D\u63A8\u8350",
  "\u5F3A\u70C8\u4E0D\u63A8\u8350",
  "\u4E0D\u597D",
  "\u4E0D\u600E\u4E48\u6837"
];
var NEGATORS = [
  "\u51E0\u4E4E\u4E0D",
  "\u57FA\u672C\u4E0A\u4E0D",
  "\u57FA\u672C\u4E0D",
  "\u4ECE\u6765\u4E0D",
  "\u4ECE\u6765\u4E0D",
  "\u4ECE\u4E0D",
  "\u5F88\u5C11",
  "\u4E0D\u600E\u4E48",
  "\u4E0D\u600E\u4E48",
  "\u6CA1\u4EC0\u4E48",
  "\u6CA1\u4EC0\u4E48",
  "\u6CA1\u6709",
  "\u4E0D\u7528",
  "\u4E0D\u9700\u8981",
  "\u4E0D\u4F1A",
  "\u4E0D\u7B97",
  "\u4E0D\u662F",
  "\u4E0D\u592A",
  "\u4E0D",
  "\u6CA1",
  "\u65E0",
  "\u522B"
];
var NEGATION_WINDOW = 5;
function detectNegation(text, entry2, index) {
  if (entry2.preNegated === true)
    return { negated: false };
  if (NEGATION_EXCEPTIONS.includes(entry2.phrase))
    return { negated: false };
  const windowStart = Math.max(0, index - NEGATION_WINDOW);
  const before = text.slice(windowStart, index);
  if (before.length === 0)
    return { negated: false };
  for (const negator of NEGATORS) {
    if (!before.endsWith(negator))
      continue;
    if (entry2.polarity === "negative")
      return { negated: false };
    return { negated: true, negator };
  }
  return { negated: false };
}
function applyNegation(polarity, negated) {
  if (!negated)
    return polarity;
  return polarity === "positive" ? "negative" : "positive";
}

// packages/core/dist/aspects/types.js
var ASPECT_KEYS = [
  "gradeFriendliness",
  "workloadFriendliness",
  "attendanceFriendliness",
  "examFriendliness",
  "teachingQuality",
  "studentSentiment"
];
var STRENGTH_WEIGHT = {
  strong: 1.5,
  normal: 1,
  mild: 0.5
};
var EXAM_FORMATS = [
  "no_exam",
  "open_book",
  "closed_book",
  "paper",
  "presentation",
  "unknown"
];

// packages/core/dist/aspects/scoring.js
var NEUTRAL = 5.5;
var RANGE = 4.5;
var SLOPE = 1.2;
var SENTIMENT_PRIOR = 1;
function priorFor(aspect) {
  return aspect === "studentSentiment" ? SENTIMENT_PRIOR : 0;
}
var SIGNAL_UNIT = STRENGTH_WEIGHT.strong;
function signedWeight(polarity, strength) {
  const weight = STRENGTH_WEIGHT[strength] / SIGNAL_UNIT;
  return polarity === "positive" ? weight : -weight;
}
function meanSignalToScore(meanSignal2) {
  const score = NEUTRAL + RANGE * Math.tanh(SLOPE * meanSignal2);
  return Number(Math.max(0, Math.min(10, score)).toFixed(4));
}
function meanSignal(signals, prior = 0) {
  if (signals.length === 0)
    return void 0;
  const sum = signals.reduce((total, value) => total + value, 0);
  const denominator = signals.length + prior * 2;
  return Number((sum / denominator).toFixed(6));
}
function scoreAspect(aspect, reviews) {
  const mentions = [];
  const signals = [];
  let positiveReviewCount = 0;
  let negativeReviewCount = 0;
  let mixedReviewCount = 0;
  for (const review of reviews) {
    const mine = review.mentions.filter((mention) => mention.aspect === aspect && mention.formatOnly !== true);
    if (mine.length === 0)
      continue;
    mentions.push(...mine);
    const weights = mine.map((mention) => signedWeight(mention.polarity, mention.strength));
    const strongest = weights.reduce((best, weight) => Math.abs(weight) > Math.abs(best) ? weight : best, weights[0] ?? 0);
    signals.push(strongest);
    const hasPositive = mine.some((mention) => mention.polarity === "positive");
    const hasNegative = mine.some((mention) => mention.polarity === "negative");
    if (hasPositive && hasNegative)
      mixedReviewCount += 1;
    else if (hasPositive)
      positiveReviewCount += 1;
    else
      negativeReviewCount += 1;
  }
  const positiveMentions = mentions.filter((mention) => mention.polarity === "positive").length;
  const matchedTerms = [...new Set(mentions.map((mention) => mention.phrase))];
  const evidenceReviewCount = signals.length;
  const mean2 = meanSignal(signals, priorFor(aspect));
  const score = {
    aspect,
    positiveMentions,
    negativeMentions: mentions.length - positiveMentions,
    sampleCount: mentions.length,
    evidenceReviewCount,
    mentionCount: mentions.length,
    positiveReviewCount,
    negativeReviewCount,
    mixedReviewCount,
    matchedTerms,
    note: evidenceReviewCount === 0 ? "\u6CA1\u6709\u547D\u4E2D\u4EFB\u4F55\u8BE5\u7EF4\u5EA6\u7684\u6587\u672C\u8BC1\u636E" : `\u4F9D\u636E ${evidenceReviewCount} \u6761\u542B\u8BC1\u636E\u8BC4\u4EF7\uFF08\u6B63\u9762 ${positiveReviewCount}\u3001\u8D1F\u9762 ${negativeReviewCount}\u3001\u6DF7\u5408 ${mixedReviewCount}\uFF09\uFF0C\u5171 ${mentions.length} \u5904\u63D0\u53CA\uFF1B\u6309\u8BC4\u8BBA\u53D6\u5E73\u5747\u4FE1\u53F7\u540E\u6620\u5C04\uFF1A5.5 + 4.5\xD7tanh(${SLOPE}\xD7${(mean2 ?? 0).toFixed(3)})`
  };
  if (evidenceReviewCount > 0 && mean2 !== void 0) {
    score.rawMeanSignal = mean2;
    score.score = meanSignalToScore(mean2);
  }
  return score;
}
function scoreAspectReviews(reviews) {
  return ASPECT_KEYS.map((aspect) => scoreAspect(aspect, reviews));
}
function tallyExamFormats(reviews) {
  const tally = Object.fromEntries(EXAM_FORMATS.map((format) => [format, 0]));
  for (const review of reviews) {
    if (review.examFormat !== void 0)
      tally[review.examFormat] += 1;
  }
  return tally;
}
function analyzeAspects(reviews) {
  const mentions = reviews.flatMap((review) => review.mentions);
  const positiveMentions = mentions.filter((mention) => mention.polarity === "positive").length;
  return {
    scores: scoreAspectReviews(reviews),
    positiveMentions,
    negativeMentions: mentions.length - positiveMentions,
    mixedReviewCount: reviews.filter((review) => review.mixed).length,
    coveredReviewCount: reviews.filter((review) => review.mentions.length > 0).length,
    reviewCount: reviews.length,
    examFormats: tallyExamFormats(reviews)
  };
}

// packages/core/dist/aspects/extractor.js
function buildIndex(entries) {
  const ordered = [...entries].sort((left, right) => {
    const leftLength = [...left.phrase].length;
    const rightLength = [...right.phrase].length;
    if (leftLength !== rightLength)
      return rightLength - leftLength;
    if (left.aspect !== right.aspect)
      return left.aspect < right.aspect ? -1 : 1;
    return left.phrase < right.phrase ? -1 : left.phrase > right.phrase ? 1 : 0;
  });
  const byFirstChar = /* @__PURE__ */ new Map();
  for (const entry2 of ordered) {
    const first = [...entry2.phrase][0];
    if (first === void 0)
      continue;
    const bucket = byFirstChar.get(first) ?? [];
    bucket.push(entry2);
    byFirstChar.set(first, bucket);
  }
  return { ordered, byFirstChar };
}
var INDEX = buildIndex(ASPECT_LEXICON);
function claimed(spans, start, end) {
  return spans.some((span) => start < span.end && end > span.start);
}
function normalizeReviewText(text) {
  return text.normalize("NFKC").replace(/[\u200B-\u200D\uFEFF\u00AD]/gu, "").toLowerCase().replace(/[\s\u3000]+/gu, " ");
}
function extractMentions(text) {
  const normalized = normalizeReviewText(text);
  if (normalized.length === 0)
    return [];
  const spans = [];
  const mentions = [];
  for (let index = 0; index < normalized.length; index += 1) {
    const first = normalized[index];
    if (first === void 0)
      continue;
    const candidates = INDEX.byFirstChar.get(first);
    if (candidates === void 0)
      continue;
    for (const entry2 of candidates) {
      const phrase = normalizeReviewText(entry2.phrase);
      if (!normalized.startsWith(phrase, index))
        continue;
      const end = index + phrase.length;
      if (claimed(spans, index, end))
        continue;
      const negation = detectNegation(normalized, entry2, index);
      const polarity = applyNegation(entry2.polarity, negation.negated);
      const strength = entry2.strength ?? "normal";
      spans.push({ start: index, end });
      const mention = {
        aspect: entry2.aspect,
        polarity,
        strength,
        phrase: entry2.phrase,
        surface: normalized.slice(Math.max(0, index - (negation.negator?.length ?? 0)), end),
        index,
        negated: negation.negated
      };
      if (entry2.formatOnly === true)
        mention.formatOnly = true;
      mentions.push(mention);
      break;
    }
  }
  return mentions.sort((left, right) => left.index - right.index);
}
var FORMAT_INDEX = (() => {
  const ordered = [...EXAM_FORMAT_PATTERNS].sort((left, right) => {
    const leftLength = [...left.phrase].length;
    const rightLength = [...right.phrase].length;
    if (leftLength !== rightLength)
      return rightLength - leftLength;
    return left.phrase < right.phrase ? -1 : 1;
  });
  const byFirstChar = /* @__PURE__ */ new Map();
  for (const pattern of ordered) {
    const first = [...pattern.phrase][0];
    if (first === void 0)
      continue;
    const bucket = byFirstChar.get(first) ?? [];
    bucket.push(pattern);
    byFirstChar.set(first, bucket);
  }
  return { ordered, byFirstChar };
})();
function detectExamFormat(text) {
  const normalized = normalizeReviewText(text);
  if (normalized.length === 0)
    return void 0;
  for (let index = 0; index < normalized.length; index += 1) {
    const first = normalized[index];
    if (first === void 0)
      continue;
    const candidates = FORMAT_INDEX.byFirstChar.get(first);
    if (candidates === void 0)
      continue;
    for (const pattern of candidates) {
      if (normalized.startsWith(normalizeReviewText(pattern.phrase), index))
        return pattern.format;
    }
  }
  return void 0;
}
function extractReviewAspects(parts) {
  const mentions = [];
  let examFormat;
  for (const part of parts) {
    if (part === void 0 || part.length === 0)
      continue;
    mentions.push(...extractMentions(part));
    if (examFormat === void 0)
      examFormat = detectExamFormat(part);
  }
  const aspects = {};
  const signals = {};
  for (const mention of mentions) {
    if (mention.formatOnly === true)
      continue;
    const bucket = aspects[mention.aspect] ?? { positive: 0, negative: 0 };
    if (mention.polarity === "positive")
      bucket.positive += 1;
    else
      bucket.negative += 1;
    aspects[mention.aspect] = bucket;
    const weight = STRENGTH_WEIGHT[mention.strength] / SIGNAL_UNIT;
    const signed = mention.polarity === "positive" ? weight : -weight;
    const current = signals[mention.aspect];
    if (current === void 0 || Math.abs(signed) > Math.abs(current))
      signals[mention.aspect] = signed;
  }
  for (const key of Object.keys(signals)) {
    const value = signals[key] ?? 0;
    signals[key] = Math.max(-1, Math.min(1, value));
  }
  const scored = mentions.filter((mention) => mention.formatOnly !== true);
  const positive = scored.filter((mention) => mention.polarity === "positive").length;
  const negative = scored.length - positive;
  const review = { aspects, mixed: positive > 0 && negative > 0, mentions, signals };
  if (examFormat !== void 0)
    review.examFormat = examFormat;
  return review;
}
function analyzeReviewRowsDetailed(rows) {
  const reviews = rows.map((row) => extractReviewAspects([
    row.examMethodText,
    row.attendanceWorkloadText,
    row.commentText
  ]));
  return { analysis: analyzeAspects(reviews), mentions: reviews.flatMap((review) => review.mentions), reviews };
}

// packages/core/dist/config.js
var REVIEW_MATCH_THRESHOLD = 0.72;
var CONFIDENCE_HIGH = 0.75;
var CONFIDENCE_MEDIUM = 0.45;
var CONFIDENCE_WEIGHTS = {
  /** Is this the same course? (from the matcher) */
  matching: 0.3,
  /** How much evidence backs the scope actually used. */
  evidence: 0.3,
  /** Does the corpus agree about the teacher? */
  teacherAgreement: 0.15,
  /** How many of the six aspects had any evidence. */
  aspectCoverage: 0.15,
  /** How much of the teacher column was parseable. */
  dataHygiene: 0.1
};
var CONFIDENCE_FALLBACK_PENALTY = 0.6;
var CONFIDENCE_ALIAS_PENALTY = 0.85;
var EVIDENCE_GATE_SATURATION = 8;
var REVIEW_COUNT_SATURATION = 20;
var METRIC_KEYS = [
  "gradeFriendliness",
  "workloadFriendliness",
  "attendanceFriendliness",
  "overallScore"
];

// packages/core/dist/recommendation.js
var NEUTRAL_SCORE = 5.5;
var RANKABLE_ASPECTS = [
  "gradeFriendliness",
  "workloadFriendliness",
  "attendanceFriendliness",
  "studentSentiment"
];
var WEIGHTABLE_ASPECTS = [
  ...RANKABLE_ASPECTS,
  "examFriendliness",
  "teachingQuality"
];
var ASPECT_PRESETS = {
  /** The default: light workload and generous marking. */
  easy_grade: {
    gradeFriendliness: 0.5,
    workloadFriendliness: 0.3,
    attendanceFriendliness: 0.15,
    studentSentiment: 0.05
  },
  /** Care about the teaching itself, not only the outcome. */
  balanced: {
    gradeFriendliness: 0.3,
    workloadFriendliness: 0.2,
    attendanceFriendliness: 0.1,
    teachingQuality: 0.25,
    studentSentiment: 0.15
  },
  /** Optimise for actually learning something. */
  learn_something: {
    teachingQuality: 0.45,
    studentSentiment: 0.2,
    gradeFriendliness: 0.15,
    workloadFriendliness: 0.1,
    attendanceFriendliness: 0.1
  },
  /** Explicitly opt exam difficulty into the ranking. */
  exam_light: {
    gradeFriendliness: 0.35,
    workloadFriendliness: 0.25,
    examFriendliness: 0.25,
    attendanceFriendliness: 0.1,
    studentSentiment: 0.05
  }
};
var DEFAULT_ASPECT_WEIGHTS = ASPECT_PRESETS.easy_grade;
function normalizeAspectPreferences(weights) {
  const source = weights ?? {};
  const raw = [];
  for (const aspect of WEIGHTABLE_ASPECTS) {
    const value = source[aspect];
    if (value === void 0)
      continue;
    if (!Number.isFinite(value))
      continue;
    raw.push([aspect, Math.max(0, value)]);
  }
  const total = raw.reduce((sum, [, value]) => sum + value, 0);
  if (total <= 0)
    return normalizeAspectPreferences(DEFAULT_ASPECT_WEIGHTS);
  const out = {};
  for (const [aspect, value] of raw)
    out[aspect] = round(value / total, 6);
  return out;
}
function aspectReliability(score) {
  const reviews = score.evidenceReviewCount;
  if (reviews <= 0 || score.score === void 0)
    return 0;
  const volume = 1 - Math.exp(-reviews / REVIEW_COUNT_SATURATION);
  const positive = score.positiveReviewCount;
  const negative = score.negativeReviewCount;
  const mixed = score.mixedReviewCount;
  const directional = positive + negative;
  const agreement = directional === 0 ? 0.5 : (Math.max(positive, negative) + mixed * 0.5) / (directional + mixed);
  return round(clamp01(0.6 * volume + 0.4 * agreement), 6);
}
function decisionScore(raw, reliability) {
  const r = clamp01(reliability);
  return round(NEUTRAL_SCORE + r * (raw - NEUTRAL_SCORE), 4);
}
function buildAspectBreakdown(review, weights) {
  const analysis = review?.aspects;
  const preferred = normalizeAspectPreferences(weights);
  const aspects = [];
  const missingDimensions = [];
  const notes = [];
  for (const aspect of WEIGHTABLE_ASPECTS) {
    const weight = preferred[aspect];
    if (weight === void 0 || weight <= 0)
      continue;
    const score = analysis?.scores.find((entry2) => entry2.aspect === aspect);
    const raw = score?.score;
    const reliability = score === void 0 ? 0 : aspectReliability(score);
    const base = {
      aspect,
      reliability,
      weight: 0,
      evidenceReviewCount: score?.evidenceReviewCount ?? 0,
      mentionCount: score?.mentionCount ?? 0,
      matchedTerms: score?.matchedTerms ?? []
    };
    if (raw === void 0) {
      missingDimensions.push(aspect);
      aspects.push(base);
      continue;
    }
    base.raw = raw;
    base.decision = decisionScore(raw, reliability);
    aspects.push(base);
  }
  const usable = aspects.filter((entry2) => entry2.decision !== void 0);
  const weightSum = usable.reduce((sum, entry2) => {
    const weight = preferred[entry2.aspect] ?? 0;
    entry2.weight = weight;
    entry2.contribution = round(weight * entry2.decision, 6);
    return sum + weight;
  }, 0);
  const appliedWeights = {};
  let decisionTotal = null;
  if (usable.length > 0 && weightSum > 0) {
    for (const entry2 of usable) {
      appliedWeights[entry2.aspect] = round((preferred[entry2.aspect] ?? 0) / weightSum, 6);
    }
    decisionTotal = round(usable.reduce((sum, entry2) => sum + (entry2.contribution ?? 0), 0) / weightSum, 4);
  }
  for (const aspect of missingDimensions) {
    notes.push(`${aspectLabel(aspect)} \u7F3A\u5C11\u53EF\u9760\u6570\u636E\uFF0C\u672C\u6B21\u6392\u540D\u672A\u4F7F\u7528\u8BE5\u7EF4\u5EA6\uFF08\u5176\u6743\u91CD\u5DF2\u6309\u6BD4\u4F8B\u5206\u914D\u7ED9\u5176\u4F59\u7EF4\u5EA6\uFF09`);
  }
  return { aspects, decisionScore: decisionTotal, appliedWeights, missingDimensions, notes };
}
function clamp01(value) {
  if (!Number.isFinite(value))
    return 0;
  return Math.min(1, Math.max(0, value));
}
function riskAdjustedScore(score, confidence) {
  if (score === null || !Number.isFinite(score))
    return null;
  const c = clamp01(confidence);
  return round(NEUTRAL_SCORE + c * (score - NEUTRAL_SCORE), 4);
}
var EVIDENCE_STRENGTH_THRESHOLDS = {
  /** Reviews with evidence at or above this, **and** coverage at or above `coverage`, is `strong`. */
  strongReviews: 20,
  strongCoverage: 0.3,
  /** Reviews with evidence at or above this is at least `moderate`. */
  moderateReviews: 10,
  /** `moderate` additionally needs this much coverage. */
  moderateCoverage: 0.2,
  /** Below this many reviews the tier is `limited` however broad the coverage. */
  limitedReviews: 3
};
function evidenceStrength(score, corpusReviews) {
  const reviewsWithEvidence = score.evidenceReviewCount;
  const corpus = Number.isFinite(corpusReviews) && corpusReviews > 0 ? corpusReviews : 0;
  const coverage = corpus === 0 ? 0 : clamp01(reviewsWithEvidence / corpus);
  const directional = score.positiveReviewCount + score.negativeReviewCount;
  const mixed = score.mixedReviewCount;
  const agreement = directional === 0 ? mixed === 0 ? 0 : 0.5 : clamp01((Math.max(score.positiveReviewCount, score.negativeReviewCount) + mixed * 0.5) / (directional + mixed));
  const t = EVIDENCE_STRENGTH_THRESHOLDS;
  let level;
  if (reviewsWithEvidence === 0)
    level = "none";
  else if (reviewsWithEvidence >= t.strongReviews && coverage >= t.strongCoverage)
    level = "strong";
  else if (reviewsWithEvidence >= t.moderateReviews && coverage >= t.moderateCoverage)
    level = "moderate";
  else
    level = "limited";
  const shared = `${reviewsWithEvidence}/${corpus === 0 ? "?" : corpus} \u6761\u8BC4\u4EF7\u63D0\u53CA\uFF08\u8986\u76D6 ${(coverage * 100).toFixed(0)}%\uFF0C\u4E00\u81F4\u6027 ${(agreement * 100).toFixed(0)}%\uFF09`;
  const note = level === "none" ? "\u6CA1\u6709\u8BC4\u4EF7\u8C08\u5230\u8FD9\u4E00\u7EF4\u5EA6\uFF0C\u56E0\u6B64\u4E0D\u8BA1\u5165\u6392\u5E8F\uFF0C\u5176\u6743\u91CD\u5DF2\u5206\u914D\u7ED9\u5176\u4ED6\u7EF4\u5EA6" : level === "strong" ? `${shared}\uFF1B\u6837\u672C\u91CF\u4E0E\u8986\u76D6\u9762\u90FD\u8DB3\u591F\uFF0C\u7ED3\u8BBA\u8F83\u7A33` : level === "moderate" ? `${shared}\uFF1B\u6709\u53C2\u8003\u4EF7\u503C\uFF0C\u4F46\u6837\u672C\u4ECD\u504F\u5C11` : `${shared}\uFF1B\u6837\u672C\u6216\u8986\u76D6\u9762\u504F\u5C11\uFF0C\u7ED3\u8BBA\u4EC5\u4F9B\u53C2\u8003`;
  return { aspect: score.aspect, level, reviewsWithEvidence, corpusReviews: corpus, coverage, agreement, note };
}
function describeWeightRedistribution(requested, applied, missing) {
  if (missing.length === 0)
    return [];
  const notes = [];
  for (const aspect of missing) {
    const askedFor = requested[aspect];
    if (askedFor === void 0 || askedFor <= 0)
      continue;
    const receivers = Object.entries(applied).filter(([key]) => key !== aspect && applied[key] !== void 0).map(([key, value]) => `${aspectLabel(key)} ${(value * 100).toFixed(0)}%`);
    notes.push(`${aspectLabel(aspect)}\u65E0\u53EF\u7528\u6570\u636E\uFF0C\u5176 ${(askedFor * 100).toFixed(0)}% \u6743\u91CD\u5DF2\u5206\u914D\u81F3${receivers.length === 0 ? "\u5176\u4ED6\u7EF4\u5EA6" : `\uFF1A${receivers.join("\u3001")}`}`);
  }
  return notes;
}
function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
function aspectLabel(aspect) {
  switch (aspect) {
    case "gradeFriendliness":
      return "\u7ED9\u5206\u53CB\u597D";
    case "workloadFriendliness":
      return "\u5B66\u4E60\u8D1F\u62C5\u8F7B";
    case "attendanceFriendliness":
      return "\u8003\u52E4\u5BBD\u677E";
    case "examFriendliness":
      return "\u8003\u8BD5\u53CB\u597D";
    case "teachingQuality":
      return "\u6559\u5B66\u8D28\u91CF";
    case "studentSentiment":
      return "\u7EFC\u5408\u53E3\u7891";
  }
}
var LEGACY_METRIC_TO_ASPECT = {
  gradeFriendliness: "gradeFriendliness",
  workloadFriendliness: "workloadFriendliness",
  attendanceFriendliness: "attendanceFriendliness",
  // `overallScore` was the old name for "what students thought generally".
  overallScore: "studentSentiment"
};
function aspectWeightsFromPreferences(preferences) {
  const source = preferences ?? {};
  const preset = source.preset === void 0 ? void 0 : ASPECT_PRESETS[source.preset];
  if (preset !== void 0)
    return { ...preset };
  const explicit = {};
  let anyExplicit = false;
  const set = (aspect, value) => {
    if (value === void 0 || !Number.isFinite(value))
      return;
    explicit[aspect] = value;
    anyExplicit = true;
  };
  set("gradeFriendliness", source.gradeFriendliness);
  set("workloadFriendliness", source.workloadFriendliness);
  set("attendanceFriendliness", source.attendanceFriendliness);
  set("studentSentiment", source.studentSentiment ?? source.overallScore);
  set("examFriendliness", source.examFriendliness);
  set("teachingQuality", source.teachingQuality);
  if (anyExplicit)
    return explicit;
  return { ...DEFAULT_ASPECT_WEIGHTS };
}

// packages/core/dist/aspects/gradeSignal.js
var GRADE_OUTCOME_PRIOR_SAMPLES = 5;
var OUTCOME_WEIGHT = 0.5;
var TEXT_WEIGHT = 0.5;
function gradeOutcomeSignal(grades, calibration) {
  const samples = grades.validSampleCount;
  if (samples === 0 || grades.percentageAverage === void 0) {
    return {
      part: {
        sampleCount: 0,
        note: "\u6CA1\u6709\u53EF\u7528\u7684\u767E\u5206\u5236\u6210\u7EE9\u6837\u672C\uFF0C\u6210\u7EE9\u7ED3\u679C\u4FE1\u53F7\u7F3A\u5931"
      },
      weight: 0
    };
  }
  const meanScore = gradeToFriendliness(grades.percentageAverage, calibration);
  const medianScore = grades.percentageMedian === void 0 ? meanScore : gradeToFriendliness(grades.percentageMedian, calibration);
  const observed = (meanScore + medianScore) / 2;
  const reliability = samples / (samples + GRADE_OUTCOME_PRIOR_SAMPLES);
  const shrunk = 5.5 + (observed - 5.5) * reliability;
  return {
    part: {
      score: Number(shrunk.toFixed(4)),
      sampleCount: samples,
      note: `\u767E\u5206\u5236\u5747\u503C ${grades.percentageAverage.toFixed(1)}\u3001\u4E2D\u4F4D ${(grades.percentageMedian ?? grades.percentageAverage).toFixed(1)}\uFF08${samples} \u6761\u6837\u672C\uFF0C\u5176\u4E2D\u4F4E\u4E8E\u53CA\u683C\u7EBF ${grades.belowPassSampleCount} \u6761\uFF09\u2192 \u89C2\u6D4B\u53CB\u597D\u5EA6 ${observed.toFixed(2)}\uFF0C\u6309\u6837\u672C\u91CF\u6536\u7F29\uFF08w=${reliability.toFixed(2)}\uFF0C\u5148\u9A8C ${GRADE_OUTCOME_PRIOR_SAMPLES} \u6761\uFF09\u540E\u4E3A ${shrunk.toFixed(2)}`
    },
    weight: reliability
  };
}
function gradeTextSignal(mentions, evidenceReviewCount) {
  const mine = mentions.filter((mention) => mention.aspect === "gradeFriendliness");
  if (mine.length === 0) {
    return {
      sampleCount: 0,
      note: "\u8BC4\u4EF7\u6587\u672C\u91CC\u6CA1\u6709\u63D0\u5230\u7ED9\u5206\uFF08\u7ED9\u5206\u9AD8/\u538B\u5206/\u5E73\u65F6\u5206\u62C9\u6EE1 \u7B49\uFF09\uFF0C\u6587\u672C\u4FE1\u53F7\u7F3A\u5931"
    };
  }
  const positive = mine.filter((mention) => mention.polarity === "positive").length;
  const negative = mine.length - positive;
  const weights = mine.map((mention) => (mention.polarity === "positive" ? 1 : -1) * (mention.strength === "strong" ? 1.5 : mention.strength === "mild" ? 0.5 : 1));
  const strongest = weights.reduce((best, weight) => Math.abs(weight) > Math.abs(best) ? weight : best, weights[0] ?? 0);
  const mean2 = strongest / 1.5;
  const score = Number((5.5 + 4.5 * Math.tanh(1.2 * mean2)).toFixed(4));
  const reviews = evidenceReviewCount ?? mine.length;
  return {
    score,
    sampleCount: mine.length,
    note: `\u4F9D\u636E ${reviews} \u6761\u7ED9\u51FA\u7ED9\u5206\u8BC4\u4EF7\u7684\u8BC4\u8BBA\u3001\u5408\u8BA1 ${mine.length} \u5904\u63D0\u53CA\uFF08\u6B63\u9762 ${positive}\u3001\u8D1F\u9762 ${negative}\uFF0C\u6700\u5F3A\u4FE1\u53F7 ${mean2.toFixed(3)}\uFF0C\u5173\u952E\u8BCD\uFF1A${[...new Set(mine.map((mention) => mention.phrase))].join("\u3001")}\uFF09`
  };
}
function combineGradeSignals(grades, mentions, evidenceCounts, calibration) {
  const { part: outcome } = gradeOutcomeSignal(grades, calibration);
  const text = gradeTextSignal(mentions, evidenceCounts.text);
  const hasOutcome = outcome.score !== void 0;
  const hasText = text.score !== void 0;
  if (!hasOutcome && !hasText) {
    return { outcome, text, appliedWeights: { outcome: 0, text: 0 }, evidenceCounts };
  }
  if (hasOutcome && !hasText) {
    return { score: outcome.score, outcome, text, appliedWeights: { outcome: 1, text: 0 }, evidenceCounts };
  }
  if (!hasOutcome && hasText) {
    return { score: text.score, outcome, text, appliedWeights: { outcome: 0, text: 1 }, evidenceCounts };
  }
  const score = outcome.score * OUTCOME_WEIGHT + text.score * TEXT_WEIGHT;
  return {
    score: Number(score.toFixed(4)),
    outcome,
    text,
    appliedWeights: { outcome: OUTCOME_WEIGHT, text: TEXT_WEIGHT },
    evidenceCounts
  };
}
function withGradeSignal(scores, signal) {
  return scores.map((entry2) => {
    if (entry2.aspect !== "gradeFriendliness")
      return entry2;
    const breakdown = {
      ...signal.outcome.score === void 0 ? {} : {
        outcome: { score: signal.outcome.score, sampleCount: signal.outcome.sampleCount, note: signal.outcome.note }
      },
      ...signal.text.score === void 0 ? {} : {
        text: { score: signal.text.score, sampleCount: signal.text.sampleCount, note: signal.text.note }
      },
      appliedWeights: { ...signal.appliedWeights }
    };
    const merged = {
      ...entry2,
      /*
       * The UNION, so the dimension reports how much evidence it really has. Never the text count: that would leave the outcome-only
       * case at zero and re-break the very path this function exists to fix.
       */
      evidenceReviewCount: signal.evidenceCounts.union,
      note: `${entry2.note}\uFF1B\u7EFC\u5408\u4FE1\u53F7\uFF1A${signal.appliedWeights.outcome}/${signal.appliedWeights.text}\uFF08\u6210\u7EE9\u7ED3\u679C\u6743\u91CD/\u6587\u672C\u6743\u91CD\uFF09\u3002${signal.outcome.note}\u3002${signal.text.note}`,
      signalBreakdown: breakdown
    };
    if (signal.score !== void 0)
      merged.score = signal.score;
    return merged;
  });
}

// packages/provider/dist/whucourses.js
var WHUCOURSES_ORIGIN = "https://whucourses.cn";
var WHUCOURSES_FIELDS = {
  courseName: "\u8BFE\u7A0B\u540D\u79F0",
  teacher: "\u6388\u8BFE\u8001\u5E08",
  courseAttribute: "\u8BFE\u7A0B\u5C5E\u6027",
  electiveField: "\u516C\u9009\u8BFE\u9886\u57DF",
  assessment: "\u671F\u672B\u8003\u6838\u65B9\u5F0F",
  attendance: "\u8003\u52E4\u4E0E\u5E73\u65F6\u4F5C\u4E1A",
  content: "\u8BFE\u7A0B\u5185\u5BB9\u4E0E\u8BC4\u4EF7",
  grade: "\u8BFE\u7A0B\u6210\u7EE9",
  /** The site also emits a legacy empty-string key holding the same grade. */
  legacyGrade: ""
};
function tidyText(value) {
  if (value === void 0)
    return void 0;
  const collapsed = value.replace(/\s+/gu, " ").trim();
  return collapsed.length === 0 ? void 0 : collapsed;
}
function normalizeRow(raw) {
  const pick = (...keys) => {
    for (const key of keys) {
      const value = raw[key];
      if (typeof value === "string" && value.trim().length > 0)
        return value.trim();
    }
    return void 0;
  };
  const row = {
    provider: "whucourses",
    courseName: pick(WHUCOURSES_FIELDS.courseName) ?? "",
    raw
  };
  const teacher = pick(WHUCOURSES_FIELDS.teacher);
  if (teacher !== void 0)
    row.teacher = teacher;
  const content = pick(WHUCOURSES_FIELDS.content);
  if (content !== void 0)
    row.content = content;
  const assessment = pick(WHUCOURSES_FIELDS.assessment);
  if (assessment !== void 0)
    row.assessment = assessment;
  const attendance = pick(WHUCOURSES_FIELDS.attendance);
  if (attendance !== void 0)
    row.attendance = attendance;
  const grade = pick(WHUCOURSES_FIELDS.grade) ?? pick(WHUCOURSES_FIELDS.legacyGrade);
  if (grade !== void 0)
    row.grade = grade;
  const attribute = pick(WHUCOURSES_FIELDS.courseAttribute);
  if (attribute !== void 0)
    row.courseAttribute = attribute;
  const elective = pick(WHUCOURSES_FIELDS.electiveField);
  if (elective !== void 0)
    row.electiveField = elective;
  return row;
}
function cleanRow(row) {
  const parsedTeacher = parseTeacher(row.teacher);
  const grade = classifyGrade(row.grade);
  const comment = tidyText(row.content);
  const malformedTeacherText = parsedTeacher.validity === "malformed" ? tidyText(row.teacher) : void 0;
  const clean = {
    courseName: row.courseName,
    teacherValidity: parsedTeacher.validity,
    gradeScale: grade.scale,
    gradeValidity: grade.validity,
    raw: row
  };
  if (parsedTeacher.validity === "valid" && parsedTeacher.teacher !== void 0) {
    clean.teacher = parsedTeacher.teacher;
  }
  if (parsedTeacher.names.length > 0)
    clean.teacherNames = [...parsedTeacher.names];
  const teacherRaw = tidyText(row.teacher);
  if (teacherRaw !== void 0)
    clean.teacherRaw = teacherRaw;
  if (grade.value !== void 0)
    clean.reportedGrade = grade.value;
  if (row.grade !== void 0)
    clean.rawGrade = row.grade;
  const assessment = tidyText(row.assessment);
  if (assessment !== void 0)
    clean.examMethodText = assessment;
  const attendance = tidyText(row.attendance);
  if (attendance !== void 0)
    clean.attendanceWorkloadText = attendance;
  const merged = [comment, malformedTeacherText].filter((part) => part !== void 0);
  if (merged.length > 0)
    clean.commentText = merged.join(" ");
  if (malformedTeacherText !== void 0)
    clean.malformedTeacherText = malformedTeacherText;
  return clean;
}
function mean(values) {
  if (values.length === 0)
    return void 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}
function median(values) {
  if (values.length === 0)
    return void 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1)
    return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}
function average(scores) {
  const usable = scores.filter((value) => value !== void 0);
  if (usable.length === 0)
    return void 0;
  return usable.reduce((total, value) => total + value, 0) / usable.length;
}
function classifyFetchFailure(error) {
  const code = error instanceof ReviewProviderError ? error.code : typeof error === "object" && error !== null && "code" in error ? String(error.code ?? "") : "";
  if (code === "network-error" || code === "timeout" || code === "aborted")
    return "network";
  if (code === "http-error" || code.startsWith("http-") || code === "rate-limited")
    return "http";
  return "malformed";
}
function healthFromOutcomes(outcomes, failureKinds) {
  const rows = outcomes.filter((outcome) => outcome === "rows").length;
  const empty = outcomes.filter((outcome) => outcome === "empty").length;
  const unavailable = outcomes.filter((outcome) => outcome === "unavailable").length;
  const queries = outcomes.length;
  const status = unavailable === 0 ? "healthy" : unavailable === queries ? "unavailable" : "partial";
  return {
    status,
    queries,
    rows,
    empty,
    unavailable,
    ...failureKinds.length === 0 ? {} : { failureKinds: [...new Set(failureKinds)] }
  };
}
function countGradeFriendlinessEvidence(rows, reviews) {
  let total = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row === void 0)
      continue;
    const hasGrade = row.gradeValidity === "usable" && row.reportedGrade !== void 0;
    const mentions = reviews[index]?.mentions ?? [];
    const hasText = mentions.some((mention) => mention.aspect === "gradeFriendliness" && mention.formatOnly !== true);
    if (hasText || hasGrade)
      total += 1;
  }
  return total;
}
function gradeStatistics(rows) {
  const percentage = [];
  let ambiguousSampleCount = 0;
  let invalidSampleCount = 0;
  let belowPassSampleCount = 0;
  const distribution = {};
  for (const row of rows) {
    if (row.gradeValidity === "usable" && row.reportedGrade !== void 0) {
      percentage.push(row.reportedGrade);
      if (row.reportedGrade < GRADE_PASS_LINE)
        belowPassSampleCount += 1;
      const decade = gradeDecade(row.reportedGrade);
      distribution[decade] = (distribution[decade] ?? 0) + 1;
    } else if (row.gradeValidity === "ambiguous") {
      ambiguousSampleCount += 1;
    } else {
      invalidSampleCount += 1;
    }
  }
  const stats = {
    validSampleCount: percentage.length,
    ambiguousSampleCount,
    invalidSampleCount,
    percentageDistribution: distribution,
    belowPassSampleCount,
    distribution
  };
  const average2 = mean(percentage);
  const middle = median(percentage);
  if (average2 !== void 0) {
    stats.percentageAverage = Number(average2.toFixed(4));
    stats.average = stats.percentageAverage;
  }
  if (middle !== void 0) {
    stats.percentageMedian = Number(middle.toFixed(4));
    stats.median = stats.percentageMedian;
  }
  return stats;
}
function deriveMetrics(grades, analysis) {
  const evidence = {};
  const bundle = { evidence };
  const decisionFor = (metric) => {
    const aspect = LEGACY_METRIC_TO_ASPECT[metric];
    if (aspect === void 0)
      return void 0;
    const score = analysis.scores.find((entry2) => entry2.aspect === aspect);
    const raw = score?.score;
    if (score === void 0 || raw === void 0)
      return void 0;
    return {
      aspect,
      raw,
      reliability: aspectReliability(score),
      decision: decisionScore(raw, aspectReliability(score)),
      weight: 0,
      evidenceReviewCount: score.evidenceReviewCount,
      mentionCount: score.mentionCount,
      matchedTerms: score.matchedTerms
    };
  };
  const validGrades = grades.validSampleCount;
  const gradeScore = average([
    grades.percentageAverage === void 0 ? void 0 : gradeToFriendliness(grades.percentageAverage, WHU_GRADE_CALIBRATION),
    grades.percentageMedian === void 0 ? void 0 : gradeToFriendliness(grades.percentageMedian, WHU_GRADE_CALIBRATION)
  ]);
  if (gradeScore !== void 0) {
    bundle.gradeFriendliness = Number(gradeScore.toFixed(4));
    evidence.gradeFriendliness = {
      sampleCount: validGrades,
      note: `\u767E\u5206\u5236\u5E73\u5747 ${grades.percentageAverage?.toFixed(1) ?? "n/a"}\u3001\u4E2D\u4F4D ${grades.percentageMedian?.toFixed(1) ?? "n/a"}\uFF08${validGrades} \u6761\u53EF\u7528\u767E\u5206\u5236\u6837\u672C\uFF0C\u5176\u4E2D\u4F4E\u4E8E\u53CA\u683C\u7EBF ${grades.belowPassSampleCount} \u6761\uFF0C\u5747\u8BA1\u5165\uFF1B\u53E6\u6709 ${grades.ambiguousSampleCount} \u6761\u91CF\u8868\u4E0D\u660E\u3001${grades.invalidSampleCount} \u6761\u65E0\u6548\uFF0C\u672A\u8BA1\u5165\u767E\u5206\u5236\u7EDF\u8BA1\uFF09\uFF0C\u6309\u5206\u6BB5\u7EBF\u6027\u6620\u5C04\u5230 0-10`
    };
  }
  const TEXT_METRICS = [
    "workloadFriendliness",
    "attendanceFriendliness",
    "overallScore"
  ];
  for (const metric of TEXT_METRICS) {
    const entry2 = decisionFor(metric);
    if (entry2?.decision === void 0)
      continue;
    const key = metric;
    bundle[key] = entry2.decision;
    evidence[metric] = {
      sampleCount: entry2.evidenceReviewCount,
      note: `\u7531\u8BC4\u4EF7\u6587\u672C\u63A8\u65AD\uFF08${entry2.mentionCount} \u5904\u63D0\u53CA\uFF0C\u8BC1\u636E\u53EF\u9760\u6027 ${entry2.reliability.toFixed(2)}\uFF09\uFF0C\u4E0E\u6392\u5E8F\u4F7F\u7528\u540C\u4E00\u4EFD aspect \u51B3\u7B56\uFF1B\u8FD9\u662F\u6587\u672C\u5206\uFF0C\u4E0D\u662F\u539F\u59CB\u6210\u7EE9`,
      ...entry2.matchedTerms.length === 0 ? {} : { matchedTerms: entry2.matchedTerms.slice(0, 8) }
    };
  }
  if (grades.percentageAverage !== void 0)
    bundle.meanGrade = grades.percentageAverage;
  if (grades.percentageMedian !== void 0)
    bundle.medianGrade = grades.percentageMedian;
  return bundle;
}
function bucketKey(courseName, teacher) {
  return `${courseName}\0${teacher === void 0 ? "" : normalizeTeacherName(teacher)}`;
}
function buildTeacherReview(courseName, teacher, rows, courseReviewCount) {
  const grades = gradeStatistics(rows);
  const { analysis, mentions, reviews } = analyzeReviewRowsDetailed(rows);
  const metrics = deriveMetrics(grades, analysis);
  const review = {
    provider: "whucourses",
    courseName,
    normalizedName: normalizeCourseName(courseName),
    reviewCount: rows.length,
    courseReviewCount,
    matchedTeacherReviewCount: teacher === void 0 ? 0 : rows.length,
    gradedSampleCount: grades.validSampleCount,
    ambiguousGradeSampleCount: grades.ambiguousSampleCount,
    invalidGradeSampleCount: grades.invalidSampleCount,
    belowPassSampleCount: grades.belowPassSampleCount,
    gradeDistribution: grades.percentageDistribution,
    gradeScale: "percentage",
    aggregateScope: "teacher",
    sourceUrl: `${WHUCOURSES_ORIGIN}/search?course_name=${encodeURIComponent(courseName)}`
  };
  if (teacher !== void 0) {
    review.teacher = teacher;
    const teacherKey = normalizeTeacherName(teacher);
    if (teacherKey.length > 0)
      review.normalizedTeacher = teacherKey;
  }
  const jointTeaching = rows.some((row) => row.teacherValidity === "valid_multiple");
  if (jointTeaching) {
    const allNames = /* @__PURE__ */ new Set();
    for (const row of rows)
      for (const name of row.teacherNames ?? [])
        allNames.add(name);
    review.teacherNames = [...allNames].sort();
    review.jointTeaching = true;
  }
  if (metrics.meanGrade !== void 0)
    review.meanGrade = metrics.meanGrade;
  if (metrics.medianGrade !== void 0)
    review.medianGrade = metrics.medianGrade;
  review.malformedTeacherReviewCount = rows.filter((row) => row.teacherValidity === "malformed").length;
  review.missingTeacherReviewCount = rows.filter((row) => row.teacherValidity === "missing").length;
  review.multipleTeacherReviewCount = rows.filter((row) => row.teacherValidity === "valid_multiple").length;
  if (metrics.gradeFriendliness !== void 0)
    review.gradeFriendliness = metrics.gradeFriendliness;
  if (metrics.workloadFriendliness !== void 0)
    review.workloadFriendliness = metrics.workloadFriendliness;
  if (metrics.attendanceFriendliness !== void 0)
    review.attendanceFriendliness = metrics.attendanceFriendliness;
  if (metrics.overallScore !== void 0)
    review.overallScore = metrics.overallScore;
  if (Object.keys(metrics.evidence).length > 0)
    review.evidence = metrics.evidence;
  const gradeReviews = analysis.scores.find((entry2) => entry2.aspect === "gradeFriendliness")?.evidenceReviewCount;
  const gradeSignal = combineGradeSignals(grades, mentions, {
    /*
     * The TEXT count, which is what this signal describes, and the UNION, which is how much evidence the dimension really has. They
     * differ whenever a review published a grade without saying anything about marking, or vice versa.
     */
    text: gradeReviews ?? 0,
    union: countGradeFriendlinessEvidence(rows, reviews)
  }, WHU_GRADE_CALIBRATION);
  review.aspects = { ...analysis, scores: withGradeSignal(analysis.scores, gradeSignal) };
  review.sampleRows = rows.slice(0, EVIDENCE_ROWS_IN_AGGREGATE);
  return review;
}
var EVIDENCE_ROWS_IN_AGGREGATE = 5;
function aggregateCleanRows(cleaned, options = {}) {
  const courseTotals = /* @__PURE__ */ new Map();
  for (const row of cleaned) {
    if (row.courseName.length === 0)
      continue;
    courseTotals.set(row.courseName, (courseTotals.get(row.courseName) ?? 0) + 1);
  }
  const buckets = /* @__PURE__ */ new Map();
  for (const row of cleaned) {
    if (row.courseName.length === 0)
      continue;
    const teachers = row.teacherValidity === "valid" || row.teacherValidity === "valid_multiple" ? row.teacherNames ?? [] : [];
    if (teachers.length === 0) {
      const key = bucketKey(row.courseName, void 0);
      let bucket = buckets.get(key);
      if (bucket === void 0) {
        bucket = { courseName: row.courseName, rows: [] };
        buckets.set(key, bucket);
      }
      bucket.rows.push(row);
      continue;
    }
    for (const teacher of teachers) {
      const key = bucketKey(row.courseName, teacher);
      let bucket = buckets.get(key);
      if (bucket === void 0) {
        bucket = { courseName: row.courseName, teacher, rows: [] };
        buckets.set(key, bucket);
      }
      bucket.rows.push(row);
    }
  }
  const reviews = [];
  for (const bucket of buckets.values()) {
    const courseTotal = options.teacherScoped === true && options.courseReviewCount !== void 0 ? options.courseReviewCount : courseTotals.get(bucket.courseName) ?? bucket.rows.length;
    reviews.push(buildTeacherReview(bucket.courseName, bucket.teacher, bucket.rows, courseTotal));
  }
  reviews.sort((left, right) => {
    if (left.reviewCount !== right.reviewCount)
      return right.reviewCount - left.reviewCount;
    const leftTeacher = left.teacher ?? "";
    const rightTeacher = right.teacher ?? "";
    if (leftTeacher !== rightTeacher)
      return leftTeacher < rightTeacher ? -1 : 1;
    return left.courseName < right.courseName ? -1 : left.courseName > right.courseName ? 1 : 0;
  });
  if (options.limit === void 0)
    return reviews;
  return reviews.slice(0, Math.max(0, options.limit));
}
function summarizeCleanRows(cleaned, courseName, scope) {
  const rows = cleaned.filter((row) => row.courseName === courseName);
  if (rows.length === 0)
    return void 0;
  const grades = gradeStatistics(rows);
  const { analysis, mentions, reviews } = analyzeReviewRowsDetailed(rows);
  const metrics = deriveMetrics(grades, analysis);
  const byTeacher = /* @__PURE__ */ new Map();
  let malformedTeacherReviewCount = 0;
  let missingTeacherReviewCount = 0;
  let multipleTeacherReviewCount = 0;
  for (const row of rows) {
    if (row.teacherValidity === "valid" || row.teacherValidity === "valid_multiple") {
      if (row.teacherValidity === "valid_multiple")
        multipleTeacherReviewCount += 1;
      for (const name of row.teacherNames ?? []) {
        const key = normalizeTeacherName(name);
        const entry2 = byTeacher.get(key) ?? { teacher: name, count: 0, grades: 0 };
        entry2.count += 1;
        if (row.gradeValidity === "usable")
          entry2.grades += 1;
        byTeacher.set(key, entry2);
      }
    } else if (row.teacherValidity === "malformed") {
      malformedTeacherReviewCount += 1;
    } else {
      missingTeacherReviewCount += 1;
    }
  }
  const teacherCandidates = [...byTeacher.entries()].map(([normalizedTeacher, entry2]) => ({
    teacher: entry2.teacher,
    normalizedTeacher,
    reviewCount: entry2.count,
    validGradeSampleCount: entry2.grades
  })).sort((left, right) => {
    if (left.reviewCount !== right.reviewCount)
      return right.reviewCount - left.reviewCount;
    return left.teacher < right.teacher ? -1 : left.teacher > right.teacher ? 1 : 0;
  });
  const review = {
    provider: "whucourses",
    courseName,
    normalizedName: normalizeCourseName(courseName),
    scope,
    courseReviewCount: rows.length,
    validTeacherReviewCount: teacherCandidates.reduce((total, entry2) => total + entry2.reviewCount, 0),
    malformedTeacherReviewCount,
    missingTeacherReviewCount,
    multipleTeacherReviewCount,
    teacherCandidates,
    grades,
    sampleRows: rows.slice(0, EVIDENCE_ROWS_IN_AGGREGATE),
    sourceUrl: `${WHUCOURSES_ORIGIN}/search?course_name=${encodeURIComponent(courseName)}`
  };
  if (metrics.gradeFriendliness !== void 0)
    review.gradeFriendliness = metrics.gradeFriendliness;
  if (metrics.workloadFriendliness !== void 0)
    review.workloadFriendliness = metrics.workloadFriendliness;
  if (metrics.attendanceFriendliness !== void 0)
    review.attendanceFriendliness = metrics.attendanceFriendliness;
  if (metrics.overallScore !== void 0)
    review.overallScore = metrics.overallScore;
  if (metrics.meanGrade !== void 0)
    review.meanGrade = metrics.meanGrade;
  if (metrics.medianGrade !== void 0)
    review.medianGrade = metrics.medianGrade;
  const gradeReviews = analysis.scores.find((entry2) => entry2.aspect === "gradeFriendliness")?.evidenceReviewCount;
  review.aspects = {
    ...analysis,
    // Same two counts as the teacher path, through the same helper.
    scores: withGradeSignal(analysis.scores, combineGradeSignals(grades, mentions, {
      text: gradeReviews ?? 0,
      union: countGradeFriendlinessEvidence(rows, reviews)
    }, WHU_GRADE_CALIBRATION))
  };
  return review;
}
function partitionCleanRows(cleaned, courseName, localTeacherNames) {
  const partition = { matched: [], disjoint: [], unassigned: [] };
  for (const row of cleaned) {
    if (row.courseName !== courseName)
      continue;
    if (row.teacherValidity !== "valid" && row.teacherValidity !== "valid_multiple") {
      partition.unassigned.push(row);
      continue;
    }
    if (localTeacherNames.length === 0) {
      partition.disjoint.push(row);
      continue;
    }
    const relation = teacherSetRelation(localTeacherNames, row.teacherNames);
    if (relation === "agree")
      partition.matched.push(row);
    else
      partition.disjoint.push(row);
  }
  return partition;
}
function aggregateCourse(rows, courseName) {
  return summarizeCleanRows(rows.map(cleanRow), courseName, "course");
}
var DEFAULT_TIMEOUT_MS = 15e3;
var WhuCoursesProvider = class {
  id = "whucourses";
  label = "WHU \u8BFE\u7A0B\u8BC4\u4EF7 (whucourses.cn)";
  homepage = WHUCOURSES_ORIGIN;
  origin;
  fetchImpl;
  cache;
  limiter;
  timeoutMs;
  /**
   * Requests currently in flight, keyed by their final request URL.
   *
   * ## What it is for
   *
   * Two callers can ask for the same course at the same moment — a batch of visible rows groups per teaching class, so a course
   * taught by two different single teachers produces two lookups, and both may reach the wire before either has written to the
   * cache. A cache only removes repeats that happen AFTER it is populated; it cannot see a request its twin is already making.
   * This map lets the second caller await the first caller's request instead of issuing a duplicate.
   *
   * ## Scope
   *
   * INSTANCE-local, deliberately. It is not static, not module-global, and not shared through `globalThis`: two providers are two
   * callers with their own caches and limits, and coalescing across them would couple their lifetimes for no benefit.
   *
   * ## Why only signal-less requests use it
   *
   * A caller that supplies an `AbortSignal` is asking to be able to cancel. Sharing that caller's request with another would make
   * one caller's cancellation affect the other, and WHICH one that is would depend on arrival order — behaviour no caller could
   * predict. So a signaled request bypasses this map entirely and keeps the independent lifetime it has today; see
   * {@link fetchRows}. The consequence is that a signaled and a signal-less request for the same URL may both go out, which is
   * the honest price of keeping cancellation meaningful.
   *
   * ## Lifetime
   *
   * An entry exists only while its request is running and is removed on success AND on failure, so a failure can never be
   * remembered: the next caller retries for real.
   */
  pending = /* @__PURE__ */ new Map();
  /*
   * No default parameter value: `cache` is a required dependency, so an omissions must be a compile error rather than a
   * silently constructed default. That is the point of removing the fallback.
   */
  constructor(options) {
    this.origin = (options.origin ?? WHUCOURSES_ORIGIN).replace(/\/+$/u, "");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.cache = options.cache;
    this.limiter = new RequestLimiter({
      concurrency: options.concurrency ?? REVIEW_FETCH_CONCURRENCY,
      minIntervalMs: options.minIntervalMs ?? REVIEW_FETCH_MIN_INTERVAL_MS
    });
  }
  /** Cache statistics, for diagnostics. */
  get cacheStats() {
    return this.cache.stats;
  }
  /** The site itself is public; availability is really "can we reach it". */
  async isAvailable() {
    return typeof this.fetchImpl === "function";
  }
  /**
   * Fetch every row the site returns for a course, without aggregating.
   *
   * Exposed so a caller that needs the course-level roll-up and the teacher
   * buckets can compute both from one fetch instead of paying for two.
   *
   * @param query - course name plus optional teacher.
   * @returns the raw rows, or `null` when the API answered with `null`.
   */
  async fetchCourseRows(query) {
    const params = this.queryParams(query.courseName.trim(), queryTeacherFilter(query.teacher));
    return this.fetchRows(params, query.signal);
  }
  /**
   * Build the course-level roll-up for one course name.
   *
   * Always requests the corpus scoped by course name **only** (never by
   * teacher), because a course-level count must not depend on which teacher the
   * caller happens to be interested in.
   *
   * @param courseName - the published course name.
   * @param signal - caller abort signal.
   * @returns the roll-up, or `undefined` when the site has no rows for the name.
   */
  async aggregateForCourse(courseName, signal) {
    const params = new URLSearchParams({ course_name: courseName.trim() });
    const rows = await this.fetchRows(params, signal);
    if (rows === null || rows.length === 0)
      return void 0;
    return aggregateCourse(rows.filter((row) => row.courseName === courseName.trim()), courseName.trim());
  }
  /**
   * Search the site for review rows matching a course.
   *
   * @param query - course name plus optional teacher.
   * @returns aggregated review records, plus the course-level roll-up when the
   *   teacher filter did not already narrow the request to one person.
   */
  async searchCourse(query) {
    const warnings = [];
    const courseName = query.courseName.trim();
    if (courseName.length === 0) {
      return { reviews: [], provider: this.id, fromCache: false, warnings: ["\u8BFE\u7A0B\u540D\u79F0\u4E3A\u7A7A\uFF0C\u672A\u53D1\u8D77\u67E5\u8BE2"] };
    }
    const teacher = query.teacher?.trim();
    const teacherFilter = queryTeacherFilter(query.teacher);
    const teacherScoped = teacherFilter !== void 0 && teacherFilter.length > 0;
    const params = this.queryParams(courseName, teacherFilter);
    const cacheKey = `whucourses/search/${params.toString()}`;
    const corpusKey = `whucourses/corpus/${encodeURIComponent(courseName)}`;
    const cached = await this.cache.get(cacheKey);
    let rows;
    let fromCache = false;
    if (cached !== void 0) {
      rows = cached;
      fromCache = true;
    } else {
      rows = await this.fetchRows(params, query.signal);
      if (rows === null) {
        warnings.push(`whucourses \u672A\u627E\u5230\u300C${courseName}\u300D${teacher === void 0 ? "" : `/${teacher}`} \u7684\u8BC4\u4EF7\u8BB0\u5F55\uFF08\u63A5\u53E3\u8FD4\u56DE null\uFF09`);
        await this.cache.set(cacheKey, []);
        return { reviews: [], provider: this.id, fromCache: false, warnings };
      }
      await this.cache.set(cacheKey, rows);
    }
    const cleaned = rows.map(cleanRow);
    const scopedReviews = aggregateCleanRows(cleaned, {
      ...limitOption(query.limit),
      ...teacherScoped ? { teacherScoped: true, courseReviewCount: 0 } : {}
    });
    const result = {
      reviews: scopedReviews,
      provider: this.id,
      fromCache,
      warnings
    };
    if (rows.length === 0) {
      warnings.push(`whucourses \u6CA1\u6709\u300C${courseName}\u300D\u7684\u4EFB\u4F55\u8BC4\u4EF7\u8BB0\u5F55`);
      return result;
    }
    const requestOutcomes = [];
    const requestFailureKinds = [];
    const corpus = teacherScoped ? await (async () => {
      try {
        const fetched = await this.courseCorpus(courseName, corpusKey, query.signal);
        requestOutcomes.push(fetched === null ? "empty" : "rows");
        return fetched;
      } catch (error) {
        requestOutcomes.push("unavailable");
        requestFailureKinds.push(classifyFetchFailure(error));
        warnings.push(`whucourses \u8BFE\u7A0B\u6574\u4F53\u8BC4\u4EF7\u83B7\u53D6\u5931\u8D25\uFF1A${error.message}`);
        return null;
      }
    })() : rows.length === 0 ? null : rows;
    requestOutcomes.unshift(rows.length === 0 ? "empty" : "rows");
    result.reviewSource = healthFromOutcomes(requestOutcomes, requestFailureKinds);
    if (corpus !== null) {
      const corpusCleaned = corpus.map(cleanRow);
      const courseLevel = summarizeCleanRows(corpusCleaned, courseName, "course");
      if (courseLevel !== void 0) {
        result.courseLevel = courseLevel;
        for (const review of scopedReviews)
          review.courseReviewCount = courseLevel.courseReviewCount;
      }
      const localTeacherNames = query.localTeacherNames ?? [];
      const partition = partitionCleanRows(corpusCleaned, courseName, localTeacherNames);
      if (localTeacherNames.length > 0) {
        const teachingClassLevel = summarizeCleanRows(partition.matched, courseName, "teachingClass");
        if (teachingClassLevel !== void 0)
          result.teachingClassLevel = teachingClassLevel;
      }
      const courseSupplementary = summarizeCleanRows(partition.unassigned, courseName, "supplementary");
      if (courseSupplementary !== void 0)
        result.courseSupplementary = courseSupplementary;
      result.reviewExcerpts = selectReviewExcerpts(partition);
    }
    return result;
  }
  /**
   * Fetch (or reuse) the whole-course corpus for one course name.
   *
   * Kept separate from the teacher-scoped rows on purpose: it is the only source
   * of a course total, and mixing the two would let a teacher filter change it.
   *
   * @param courseName - the published course name.
   * @param corpusKey - cache key for the corpus.
   * @param signal - caller abort signal.
   * @returns the corpus rows, or `null` when the site has none.
   */
  async courseCorpus(courseName, corpusKey, signal) {
    const cached = await this.cache.get(corpusKey);
    if (cached !== void 0) {
      return cached.length === 0 ? null : cached;
    }
    const params = new URLSearchParams({ course_name: courseName });
    const rows = await this.fetchRows(params, signal);
    if (rows === null) {
      await this.cache.set(corpusKey, []);
      return null;
    }
    const scoped = rows.filter((row) => row.courseName === courseName);
    await this.cache.set(corpusKey, scoped);
    return scoped.length === 0 ? null : scoped;
  }
  /**
   * Assemble the request parameters from an already-normalized course name and teacher filter.
   *
   * This is a pure assembler and deliberately NOT the place where the teacher is vetted: the cache key is built from exactly
   * these parameters, so a guard applied here would produce one key while the request carried another. The vetting happens
   * once in {@link searchCourse}, before anything is derived from the parameters.
   *
   * Both filters are case-insensitive substrings server-side and AND-ed, which is exactly the disambiguation we want:
   * `instructor` narrows the corpus to one person, which is both cheaper and the request the site itself makes.
   *
   * @param courseName - the trimmed course name.
   * @param teacherFilter - a single teacher's name, or `undefined` to send no filter.
   * @returns the query parameters.
   */
  queryParams(courseName, teacherFilter) {
    const params = new URLSearchParams({ course_name: courseName });
    if (teacherFilter !== void 0 && teacherFilter.length > 0)
      params.set("instructor", teacherFilter);
    return params;
  }
  /**
   * Fetch and normalize rows from `/api/search`.
   *
   * @param params - query string parameters.
   * @param signal - caller abort signal.
   * @returns normalized rows, or `null` when the API answered with `null`.
   */
  /**
   * Fetch and normalize rows from `/api/search`, coalescing identical concurrent requests.
   *
   * ## Where the coalescing lives, and what it deliberately does NOT cover
   *
   * This is the exact HTTP layer, so the key is the FINAL request URL. Everything that makes two requests the same or different
   * is in it already: the origin, the path, and the query parameters — including `instructor`. A teacher-scoped request and a
   * whole-course request are therefore never merged, which matters because they are genuinely different data.
   *
   * It does NOT cover the work built on top of it. Each caller still runs its own `localTeacherNames` partition, so two callers
   * that share one request still get their OWN `teachingClassLevel` and `courseSupplementary`. Sharing the transport must never
   * become sharing the semantics: two teaching classes of one course ask the identical question of the site and must still be
   * answered separately about which reviews belong to which class.
   *
   * It also does not dedupe `cache.set`. Two callers that share one request each write the result to their own cache key
   * afterwards; that is a duplicate write of an identical value, and out of scope here.
   *
   * ## Signal rule
   *
   * A request WITHOUT a signal participates. A request WITH one bypasses this map completely — it neither reads nor writes an
   * entry, and takes its own limiter slot and its own `requestJson` call. That preserves today's cancellation behaviour exactly
   * and removes any dependence on which caller happened to arrive first.
   *
   * ## Cleanup
   *
   * The cleanup promise is the one STORED and the one RETURNED, so no `.finally()` result is discarded and no rejected cleanup
   * branch is left unobserved. The delete is identity-checked, so a slower predecessor can never remove a newcomer's entry.
   *
   * @param params - query string parameters.
   * @param signal - caller abort signal. Its PRESENCE disables coalescing.
   * @returns normalized rows, or `null` when the API answered `null`.
   */
  async fetchRows(params, signal) {
    const url = `${this.origin}/api/search?${params.toString()}`;
    if (signal !== void 0) {
      return this.requestRows(url, signal);
    }
    const existing = this.pending.get(url);
    if (existing !== void 0)
      return existing;
    const tracked = this.requestRows(url, signal).finally(() => {
      if (this.pending.get(url) === tracked)
        this.pending.delete(url);
    });
    this.pending.set(url, tracked);
    return tracked;
  }
  /**
   * Perform one request: take a limiter slot, fetch, normalize.
   *
   * `pending` is never touched here, so the coalescing decision stays in one place.
   *
   * @param url - the finished request URL.
   * @param signal - caller abort signal, forwarded as-is.
   */
  async requestRows(url, signal) {
    const payload = await this.limiter.run(() => this.requestJson(url, signal));
    if (payload === null)
      return null;
    if (!Array.isArray(payload)) {
      throw new ReviewProviderError(this.id, "unexpected-shape", `\u671F\u671B\u6570\u7EC4\u54CD\u5E94\uFF0C\u5B9E\u9645\u6536\u5230 ${typeof payload}`);
    }
    return payload.filter((item) => typeof item === "object" && item !== null && !Array.isArray(item)).map((item) => normalizeRow(item));
  }
  /**
   * Perform one JSON GET with timeout and abort propagation.
   *
   * ## A cancel that arrived before the request
   *
   * A caller may hand over a signal that is ALREADY aborted — it cancelled while the lookup was still being assembled. An
   * `abort` listener cannot fire for an event that has already happened, so registering one and stopping there let the request
   * go out anyway: a cancelled lookup still cost the review site a real request.
   *
   * So the listener is registered FIRST and the signal is inspected IMMEDIATELY AFTER, which is the race-safe order. Inspecting
   * first and registering second would leave a window where an abort lands in between and is never seen. A signal-less request
   * skips both steps entirely and behaves exactly as before.
   *
   * The early throw also means the pre-aborted path never creates a timer, which is why the timer's creation sits after it.
   *
   * @param url - the finished request URL.
   * @param signal - caller abort signal, or `undefined`.
   * @returns the parsed JSON body, or `null` for an empty body.
   */
  async requestJson(url, signal) {
    let timer;
    let onAbort;
    try {
      const controller = new AbortController();
      if (signal !== void 0) {
        onAbort = () => controller.abort(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) {
          throw new Error(`\u8BF7\u6C42\u5DF2\u88AB\u53D6\u6D88\uFF1A${String(signal.reason)}`);
        }
      }
      timer = setTimeout(() => controller.abort(new Error("timeout")), this.timeoutMs);
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: controller.signal
      });
      if (!response.ok) {
        throw new ReviewProviderError(this.id, "http-error", `whucourses \u8FD4\u56DE HTTP ${response.status} ${response.statusText}`, response.status);
      }
      const text = await response.text();
      if (text.trim().length === 0)
        return null;
      try {
        return JSON.parse(text);
      } catch (error) {
        throw new ReviewProviderError(this.id, "invalid-json", `\u54CD\u5E94\u4E0D\u662F\u5408\u6CD5 JSON\uFF1A${error.message}`);
      }
    } catch (error) {
      if (error instanceof ReviewProviderError)
        throw error;
      const message = error.message;
      throw new ReviewProviderError(this.id, "network-error", `\u65E0\u6CD5\u8BBF\u95EE whucourses\uFF1A${message}`);
    } finally {
      if (timer !== void 0)
        clearTimeout(timer);
      if (onAbort !== void 0)
        signal?.removeEventListener("abort", onAbort);
    }
  }
  /** Release the limiter's timers (none are held) and drop memory cache. */
  async dispose() {
    await this.cache.clear();
  }
};
function limitOption(limit) {
  if (limit === void 0)
    return {};
  return { limit: Math.max(1, Math.trunc(limit)) };
}

// apps/extension/src/background/memory-cache.ts
var MemoryCache = class {
  /*
   * The counters are declared with their own mutable type rather than as `CacheStats`, because that interface marks every field
   * `readonly` — correct for a CONSUMER reading statistics, and impossible to increment from the implementation that owns them.
   *
   * The relationship to the contract is not lost: `MemoryCacheSatisfiesContract` below asserts that this class, including this
   * stats shape, is assignable where a `CacheLike` is expected.
   */
  stats = {
    hits: 0,
    misses: 0,
    writes: 0,
    disabled: false
  };
  entries = /* @__PURE__ */ new Map();
  ttlMs;
  now;
  /**
   * @param options - the TTL, and optionally a clock.
   * @throws RangeError when `ttlMs` is not finite or is negative. The value is never silently clamped: a caller asking for a
   *   negative lifetime has a bug, and rounding it to zero would hide it.
   */
  constructor(options) {
    const { ttlMs } = options;
    if (typeof ttlMs !== "number" || !Number.isFinite(ttlMs) || ttlMs < 0) {
      throw new RangeError(`ttlMs \u5FC5\u987B\u662F\u6709\u9650\u4E14\u975E\u8D1F\u7684\u6BEB\u79D2\u6570\uFF0C\u5B9E\u9645\u6536\u5230 ${String(ttlMs)}`);
    }
    this.ttlMs = ttlMs;
    this.now = options.now ?? (() => Date.now());
  }
  /**
   * Read a value.
   *
   * An entry is stale when `expiresAt <= now`, so with `ttlMs: 0` every entry is stale on the very next read at the same instant.
   * A stale entry is DELETED rather than merely ignored, so it cannot reappear and cannot accumulate.
   *
   * @param key - cache key.
   * @returns the stored value, or `undefined` when absent or stale.
   */
  async get(key) {
    const entry2 = this.entries.get(key);
    if (entry2 === void 0) {
      this.stats.misses += 1;
      return void 0;
    }
    if (entry2.expiresAt <= this.now()) {
      this.entries.delete(key);
      this.stats.misses += 1;
      return void 0;
    }
    this.stats.hits += 1;
    return entry2.value;
  }
  /**
   * Store a value.
   *
   * The value is held by reference. Nothing is serialized, copied or structured-cloned, so an object comes back as the same
   * object — which matters because these are review records, and a copy would quietly break identity comparisons downstream.
   *
   * @param key - cache key.
   * @param value - the value to store.
   */
  async set(key, value) {
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    this.stats.writes += 1;
  }
  /** Drop every entry. */
  async clear() {
    this.entries.clear();
  }
};

// apps/extension/src/background/public-review-fetch.ts
var ALLOWED_HOSTNAME = "whucourses.cn";
var ALLOWED_PATHNAME = "/api/search";
var ALLOWED_PROTOCOL = "https:";
var REQUIRED_QUERY_KEYS = ["course_name"];
var OPTIONAL_QUERY_KEYS = ["instructor"];
var ALLOWED_QUERY_KEYS = [...REQUIRED_QUERY_KEYS, ...OPTIONAL_QUERY_KEYS];
var PublicReviewBoundaryError = class extends Error {
  name = "PublicReviewBoundaryError";
  constructor(message) {
    super(message);
  }
};
function assertAllowedRequest(input, init) {
  let url;
  try {
    url = new URL(typeof input === "string" ? input : input.href);
  } catch {
    throw new PublicReviewBoundaryError(`\u62D2\u7EDD\u8BF7\u6C42\uFF1AURL \u65E0\u6CD5\u89E3\u6790\uFF1A${String(input)}`);
  }
  if (url.protocol !== ALLOWED_PROTOCOL) {
    throw new PublicReviewBoundaryError(`\u62D2\u7EDD\u8BF7\u6C42\uFF1A\u534F\u8BAE\u5FC5\u987B\u662F ${ALLOWED_PROTOCOL}\uFF0C\u5B9E\u9645\u4E3A ${url.protocol}`);
  }
  if (url.hostname !== ALLOWED_HOSTNAME) {
    throw new PublicReviewBoundaryError(`\u62D2\u7EDD\u8BF7\u6C42\uFF1A\u4E3B\u673A\u5FC5\u987B\u662F ${ALLOWED_HOSTNAME}\uFF0C\u5B9E\u9645\u4E3A ${url.hostname}`);
  }
  if (url.port !== "") {
    throw new PublicReviewBoundaryError(`\u62D2\u7EDD\u8BF7\u6C42\uFF1A\u4E0D\u5141\u8BB8\u6307\u5B9A\u7AEF\u53E3\uFF0C\u5B9E\u9645\u4E3A ${url.port}`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new PublicReviewBoundaryError("\u62D2\u7EDD\u8BF7\u6C42\uFF1AURL \u4E2D\u4E0D\u5141\u8BB8\u5305\u542B\u51ED\u636E");
  }
  if (url.pathname !== ALLOWED_PATHNAME) {
    throw new PublicReviewBoundaryError(`\u62D2\u7EDD\u8BF7\u6C42\uFF1A\u8DEF\u5F84\u5FC5\u987B\u662F ${ALLOWED_PATHNAME}\uFF0C\u5B9E\u9645\u4E3A ${url.pathname}`);
  }
  if (url.hash !== "") {
    throw new PublicReviewBoundaryError("\u62D2\u7EDD\u8BF7\u6C42\uFF1AURL \u4E2D\u4E0D\u5141\u8BB8\u5305\u542B fragment");
  }
  const keys = [...new Set([...url.searchParams].map((entry2) => entry2.at(0) ?? ""))];
  const extra = keys.filter((key) => !ALLOWED_QUERY_KEYS.includes(key));
  if (extra.length > 0) {
    throw new PublicReviewBoundaryError(`\u62D2\u7EDD\u8BF7\u6C42\uFF1A\u4E0D\u5141\u8BB8\u7684\u67E5\u8BE2\u53C2\u6570 ${extra.join(", ")}`);
  }
  for (const required of REQUIRED_QUERY_KEYS) {
    const value = url.searchParams.get(required);
    if (value === null || value.trim() === "") {
      throw new PublicReviewBoundaryError(`\u62D2\u7EDD\u8BF7\u6C42\uFF1A\u7F3A\u5C11\u5FC5\u9700\u7684\u67E5\u8BE2\u53C2\u6570 ${required}`);
    }
  }
  const method = (init?.method ?? "GET").toUpperCase();
  if (method !== "GET") {
    throw new PublicReviewBoundaryError(`\u62D2\u7EDD\u8BF7\u6C42\uFF1A\u53EA\u5141\u8BB8 GET\uFF0C\u5B9E\u9645\u4E3A ${method}`);
  }
  if (init?.body !== void 0 && init?.body !== null) {
    throw new PublicReviewBoundaryError("\u62D2\u7EDD\u8BF7\u6C42\uFF1A\u4E0D\u5141\u8BB8\u8BF7\u6C42\u4F53");
  }
  return url;
}
function createGuardedPublicReviewFetch(underlying = globalThis.fetch) {
  return async (input, init) => {
    const url = assertAllowedRequest(input, init);
    return underlying(url.href, {
      method: "GET",
      headers: init?.headers,
      signal: init?.signal ?? void 0,
      credentials: "omit"
    });
  };
}
var guardedPublicReviewFetch = createGuardedPublicReviewFetch();

// apps/extension/src/background/recommendation-policy.ts
var EXTENSION_RECOMMENDATION_POLICY = Object.freeze({
  defaultPreferences: Object.freeze({
    gradeFriendliness: 0.5,
    workloadFriendliness: 0.3,
    attendanceFriendliness: 0.15,
    overallScore: 0.05
  }),
  defaultTopN: 5,
  maxTopN: 50,
  candidateLimit: 25
});

// packages/core/dist/types/course.js
var ALIAS_METHODS = ["alias_name_teacher", "alias_name"];
function isAliasMethod(method) {
  return ALIAS_METHODS.includes(method);
}

// packages/core/dist/confidence.js
function reviewCountScore(reviewCount) {
  if (!Number.isFinite(reviewCount) || reviewCount <= 0)
    return 0;
  return 1 - Math.exp(-reviewCount / REVIEW_COUNT_SATURATION);
}
function clamp012(value) {
  if (!Number.isFinite(value))
    return 0;
  return Math.min(1, Math.max(0, value));
}
function round2(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
function malformedTeacherRatio(matched, malformed, missing) {
  const total = matched + malformed + missing;
  if (total <= 0)
    return void 0;
  return (malformed + missing) / total;
}
function dirtyTeacherRowRatio(totalRows, malformedRows, missingRows) {
  if (!Number.isFinite(totalRows) || totalRows <= 0)
    return void 0;
  return clamp012((malformedRows + missingRows) / totalRows);
}
function calculateReviewConfidence(match) {
  const review = match.review;
  const level = match.courseLevel;
  const requestedTeacher = (match.course?.teacher ?? "").trim();
  const teacherSpecified = requestedTeacher.length > 0;
  const aliasUsed = match.aliasUsed === true || isAliasMethod(match.method);
  const teacherScoped = review?.aggregateScope === "teacher";
  const teacherFallbackUsed = teacherSpecified && !teacherScoped && review !== void 0;
  const courseReviewCount = review?.courseReviewCount ?? level?.courseReviewCount ?? review?.reviewCount ?? 0;
  const matchedTeacherReviewCount = review?.matchedTeacherReviewCount ?? review?.reviewCount ?? 0;
  const scoped = match.teachingClassLevel;
  const evidenceReviewCount = scoped !== void 0 ? scoped.courseReviewCount : teacherScoped ? matchedTeacherReviewCount : review?.aspects?.coveredReviewCount ?? review?.reviewCount ?? 0;
  const aspectCoverage = aspectCoverageScore(scoped === void 0 ? review : scoped);
  const hygiene = level !== void 0 && Number.isFinite(level.courseReviewCount) && level.courseReviewCount > 0 ? dirtyTeacherRowRatio(level.courseReviewCount, level.malformedTeacherReviewCount, level.missingTeacherReviewCount) : malformedTeacherRatio(review?.matchedTeacherReviewCount ?? 0, review?.malformedTeacherReviewCount ?? 0, review?.missingTeacherReviewCount ?? 0);
  const teacherAgreementScore = teacherAgreement(match);
  const components = {
    matching: clamp012(match.confidence),
    evidence: reviewCountScore(evidenceReviewCount),
    // Teacher agreement only carries information when a teacher was asked for.
    teacherAgreement: teacherAgreementScore ?? 0,
    aspectCoverage: aspectCoverage ?? 0,
    // No malformed-teacher denominator means the column was clean or absent;
    // treat as fully hygienic rather than penalising unknown.
    dataHygiene: hygiene === void 0 ? 1 : 1 - clamp012(hygiene)
  };
  const missing = [];
  if (review === void 0)
    missing.push("review", "evidence", "aspectCoverage", "dataHygiene");
  else {
    if (evidenceReviewCount <= 0)
      missing.push("evidence");
    if (aspectCoverage === void 0)
      missing.push("aspectCoverage");
    if (hygiene === void 0)
      missing.push("dataHygiene");
  }
  if (teacherAgreementScore === void 0)
    missing.push("teacherAgreement");
  const weights = [
    { key: "matching", weight: CONFIDENCE_WEIGHTS.matching, usable: true },
    { key: "evidence", weight: CONFIDENCE_WEIGHTS.evidence, usable: !missing.includes("evidence") },
    { key: "teacherAgreement", weight: CONFIDENCE_WEIGHTS.teacherAgreement, usable: !missing.includes("teacherAgreement") },
    { key: "aspectCoverage", weight: CONFIDENCE_WEIGHTS.aspectCoverage, usable: !missing.includes("aspectCoverage") },
    { key: "dataHygiene", weight: CONFIDENCE_WEIGHTS.dataHygiene, usable: !missing.includes("dataHygiene") }
  ];
  const usable = weights.filter((entry2) => entry2.usable);
  const weightSum = usable.reduce((sum, entry2) => sum + entry2.weight, 0);
  const base = weightSum === 0 ? 0 : usable.reduce((sum, entry2) => sum + entry2.weight * components[entry2.key], 0) / weightSum;
  const penalty = (teacherFallbackUsed ? CONFIDENCE_FALLBACK_PENALTY : 1) * (aliasUsed ? CONFIDENCE_ALIAS_PENALTY : 1);
  const gate = Math.min(1, Math.sqrt(evidenceReviewCount / EVIDENCE_GATE_SATURATION));
  const value = clamp012(Math.min(base * penalty * gate, 1));
  const componentsOut = {
    matching: round2(components.matching, 4),
    evidence: round2(components.evidence, 4),
    teacherAgreement: round2(components.teacherAgreement, 4),
    aspectCoverage: round2(components.aspectCoverage, 4),
    dataHygiene: round2(components.dataHygiene, 4)
  };
  const confidence = {
    value: round2(value, 4),
    tier: tierOf(value),
    components: componentsOut,
    missing,
    summary: "",
    inputs: {
      courseMatchConfidence: round2(clamp012(match.confidence), 4),
      teacherSpecified,
      teacherMatched: teacherAgreementScore === 1,
      teacherFallbackUsed,
      aliasUsed,
      courseReviewCount,
      matchedTeacherReviewCount,
      evidenceReviewCount,
      percentageGradeSampleCount: review?.gradedSampleCount ?? level?.grades.validSampleCount ?? 0,
      malformedTeacherRatio: round2(hygiene ?? 0, 4)
    }
  };
  if (match.method === "unmatched") {
    return {
      ...confidence,
      value: 0,
      tier: "low",
      summary: "\u672A\u5339\u914D\u5230\u4EFB\u4F55\u8BC4\u4EF7\u8BB0\u5F55\uFF0C\u6570\u636E\u53EF\u4FE1\u5EA6\u89C6\u4E3A 0"
    };
  }
  confidence.summary = summarize(confidence);
  return confidence;
}
function aspectCoverageScore(review) {
  const scores = review?.aspects?.scores;
  if (scores === void 0 || scores.length === 0)
    return void 0;
  const scored = scores.filter((entry2) => entry2.score !== void 0 && entry2.evidenceReviewCount > 0);
  return clamp012(scored.length / scores.length);
}
function teacherAgreement(match) {
  const requested = (match.course?.teacher ?? "").trim();
  if (requested.length === 0)
    return void 0;
  const review = match.review;
  if (review === void 0)
    return void 0;
  const relation = teacherSetRelation(requested, review.teacherNames ?? review.teacher);
  if (relation === "unknown")
    return void 0;
  return relation === "agree" ? 1 : 0;
}
function tierOf(value) {
  if (value >= CONFIDENCE_HIGH)
    return "high";
  if (value >= CONFIDENCE_MEDIUM)
    return "medium";
  return "low";
}
function summarize(confidence) {
  const { components, inputs } = confidence;
  const parts = [
    `\u603B\u4F53 ${confidence.value.toFixed(2)}\uFF08${confidence.tier}\uFF09`,
    `\u8BFE\u7A0B\u5171 ${inputs.courseReviewCount} \u6761\u6837\u672C`,
    `\u5339\u914D\u5EA6 ${components.matching.toFixed(2)}`,
    `\u8BC1\u636E\u91CF ${components.evidence.toFixed(2)}\uFF08\u672C\u6B21\u8BA1\u5206\u7528 ${inputs.evidenceReviewCount} \u6761\uFF09`
  ];
  if (!confidence.missing.includes("aspectCoverage")) {
    parts.push(`\u7EF4\u5EA6\u8986\u76D6 ${components.aspectCoverage.toFixed(2)}`);
  }
  if (!confidence.missing.includes("dataHygiene")) {
    parts.push(`\u6559\u5E08\u5B57\u6BB5\u53EF\u7528\u7387 ${components.dataHygiene.toFixed(2)}`);
  }
  if (inputs.teacherFallbackUsed)
    parts.push("\u5DF2\u56DE\u9000\u5230\u8BFE\u7A0B\u7EA7\u6570\u636E\uFF08\u964D\u6743 0.6\uFF09");
  if (inputs.aliasUsed)
    parts.push("\u8BFE\u7A0B\u540D\u901A\u8FC7 alias \u5339\u914D\uFF08\u964D\u6743 0.85\uFF09");
  if (confidence.missing.length > 0)
    parts.push(`\u7F3A\u5931\u5206\u91CF\uFF1A${confidence.missing.join("\u3001")}`);
  return parts.join("\uFF1B");
}

// packages/core/dist/ranking.js
function round3(value, decimals = 4) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
function normalizePreferences(preferences, basePreferences) {
  const merged = {
    ...basePreferences,
    ...preferences ?? {}
  };
  const raw = {
    gradeFriendliness: Math.max(0, finite(merged.gradeFriendliness, basePreferences.gradeFriendliness)),
    workloadFriendliness: Math.max(0, finite(merged.workloadFriendliness, basePreferences.workloadFriendliness)),
    attendanceFriendliness: Math.max(0, finite(merged.attendanceFriendliness, basePreferences.attendanceFriendliness)),
    overallScore: Math.max(0, finite(merged.overallScore, basePreferences.overallScore))
  };
  const total = METRIC_KEYS.reduce((sum, key) => sum + raw[key], 0);
  const source = total > 0 ? raw : {
    gradeFriendliness: basePreferences.gradeFriendliness,
    workloadFriendliness: basePreferences.workloadFriendliness,
    attendanceFriendliness: basePreferences.attendanceFriendliness,
    overallScore: basePreferences.overallScore
  };
  const divisor = total > 0 ? total : 1;
  const normalized = {
    gradeFriendliness: round3(source.gradeFriendliness / divisor, 6),
    workloadFriendliness: round3(source.workloadFriendliness / divisor, 6),
    attendanceFriendliness: round3(source.attendanceFriendliness / divisor, 6),
    overallScore: round3(source.overallScore / divisor, 6)
  };
  if (merged.minReviewCount !== void 0)
    normalized.minReviewCount = merged.minReviewCount;
  if (merged.requireAvailableSeats !== void 0) {
    normalized.requireAvailableSeats = merged.requireAvailableSeats;
  }
  return normalized;
}
function finite(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function clampMetric(value) {
  if (value === void 0 || !Number.isFinite(value))
    return void 0;
  return Math.min(10, Math.max(0, value));
}
function calculateCourseScore(review, preferences) {
  const decision = buildAspectBreakdown(review, aspectWeightsFromPreferences(preferences));
  const components = [];
  const appliedWeights = {};
  const redistributed = [];
  let weightSum = 0;
  for (const metric of METRIC_KEYS) {
    const aspect = LEGACY_METRIC_TO_ASPECT[metric];
    const entry2 = aspect === void 0 ? void 0 : decision.aspects.find((candidate) => candidate.aspect === aspect);
    const value = clampMetric(entry2?.decision) ?? (review === void 0 ? void 0 : clampMetric(review[metric]));
    if (value === void 0) {
      components.push({ metric, weight: 0, available: false });
      redistributed.push(metric);
      continue;
    }
    const weight = preferences[metric];
    weightSum += weight;
    components.push({ metric, weight, value, contribution: round3(weight * value, 6), available: true });
  }
  if (review === void 0 || weightSum === 0) {
    return { score: null, components, appliedWeights, redistributed, decision };
  }
  const total = components.reduce((sum, component) => {
    if (!component.available || component.value === void 0)
      return sum;
    return sum + component.weight * component.value;
  }, 0);
  for (const component of components) {
    if (!component.available)
      continue;
    appliedWeights[component.metric] = round3(component.weight / weightSum, 6);
  }
  return { score: round3(total / weightSum, 4), components, appliedWeights, redistributed, decision };
}

// packages/core/dist/alias.js
var COURSE_ALIAS_QUALIFIERS = [
  "\u4E0A\u518C",
  "\u4E0B\u518C",
  "\u4E0A\u7BC7",
  "\u4E0B\u7BC7",
  "\u7B2C\u4E00\u518C",
  "\u7B2C\u4E8C\u518C",
  "\u7B2C\u4E09\u518C",
  "\u7B2C\u56DB\u518C",
  "\u4E00\u518C",
  "\u4E8C\u518C",
  "\u4E09\u518C",
  "\u56DB\u518C",
  "(\u4E0A)",
  "(\u4E0B)",
  "(\u4E2D)",
  "(\u4E00)",
  "(\u4E8C)",
  "(\u4E09)",
  "(i)",
  "(ii)",
  "(iii)",
  "(iv)",
  "(1)",
  "(2)",
  "\u4E0A",
  "\u4E0B",
  "iii",
  "ii",
  "iv",
  "i",
  "\u2162",
  "\u2161",
  "\u2163",
  "\u2160"
];
function fold(input) {
  return input.normalize("NFKC").replace(/[\u200B-\u200D\uFEFF\u00AD]/gu, "").toLowerCase();
}
function fullKey(courseName) {
  return fold(courseName).replace(/[\s\u3000]+/gu, "").replace(/[·•・、,，;；:：\-—–_/\\|~^'"`“”‘’*#()[\]【】（）]/gu, "");
}
var SIGNIFICANT_TAIL = /[a-z0-9]$/u;
function courseAliases(courseName) {
  const key = fullKey(courseName);
  if (key.length === 0)
    return { aliases: [], qualifierIsSignificant: false };
  if (SIGNIFICANT_TAIL.test(key))
    return { aliases: [], qualifierIsSignificant: true };
  const aliases = [];
  for (const qualifier of COURSE_ALIAS_QUALIFIERS) {
    const folded = fold(qualifier);
    if (!key.endsWith(folded))
      continue;
    const stripped = key.slice(0, key.length - folded.length);
    if (stripped.length === 0)
      continue;
    if (!aliases.some((entry2) => entry2.key === stripped)) {
      aliases.push({ key: stripped, removedQualifier: qualifier, baseKey: key });
    }
  }
  return { aliases, qualifierIsSignificant: false };
}
function significantQualifier(courseName) {
  const key = fullKey(courseName);
  if (key.length === 0)
    return void 0;
  for (const qualifier of COURSE_ALIAS_QUALIFIERS) {
    const folded = fold(qualifier);
    if (key.endsWith(folded) && key.length > folded.length)
      return void 0;
  }
  const match = /([a-z]|\d{1,2})$/u.exec(key);
  return match?.[1];
}
function qualifiersConflict(left, right) {
  const leftMarker = significantQualifier(left);
  const rightMarker = significantQualifier(right);
  if (leftMarker === void 0 || rightMarker === void 0)
    return false;
  return leftMarker !== rightMarker;
}

// packages/core/dist/similarity.js
function bigrams(input) {
  const chars = [...input];
  if (chars.length <= 1)
    return chars.length === 1 ? [chars[0]] : [];
  const out = [];
  for (let index = 0; index < chars.length - 1; index += 1) {
    out.push(`${chars[index]}${chars[index + 1]}`);
  }
  return out;
}
function diceCoefficient(left, right) {
  if (left.length === 0 || right.length === 0)
    return 0;
  if (left === right)
    return 1;
  const leftGrams = bigrams(left);
  const rightGrams = bigrams(right);
  if (leftGrams.length === 0 || rightGrams.length === 0)
    return 0;
  const counts = /* @__PURE__ */ new Map();
  for (const gram of leftGrams)
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  let overlap = 0;
  for (const gram of rightGrams) {
    const remaining = counts.get(gram) ?? 0;
    if (remaining > 0) {
      overlap += 1;
      counts.set(gram, remaining - 1);
    }
  }
  return 2 * overlap / (leftGrams.length + rightGrams.length);
}
function longestCommonSubstringRatio(left, right) {
  if (left.length === 0 || right.length === 0)
    return 0;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;
  let best = 0;
  let previous = new Array(longer.length + 1).fill(0);
  for (let i = 1; i <= shorter.length; i += 1) {
    const current = new Array(longer.length + 1).fill(0);
    for (let j = 1; j <= longer.length; j += 1) {
      if (shorter[i - 1] === longer[j - 1]) {
        const cell = (previous[j - 1] ?? 0) + 1;
        current[j] = cell;
        if (cell > best)
          best = cell;
      }
    }
    previous = current;
  }
  return best / shorter.length;
}
function fuzzyNameScore(left, right) {
  if (left.length === 0 || right.length === 0)
    return 0;
  if (left === right)
    return 1;
  const dice = diceCoefficient(left, right);
  const lcs = longestCommonSubstringRatio(left, right);
  const blended = 0.7 * dice + 0.3 * lcs;
  const containment = left.includes(right) || right.includes(left) ? Math.min(left.length, right.length) / Math.max(left.length, right.length) : 0;
  return Math.max(blended, 0.5 + 0.5 * containment);
}

// packages/core/dist/matching/courseMatcher.js
var BASE_CONFIDENCE = {
  course_code: 0.95,
  course_code_teacher: 1,
  name_teacher: 0.94,
  exact_name: 0.78,
  alias_name_teacher: 0.68,
  alias_name: 0.6,
  fuzzy_name_teacher: 0.56,
  fuzzy_name: 0.4
};
var FUZZY_FLOOR = 0.55;
function normalizeCourseCode(code) {
  if (code === void 0)
    return "";
  return code.normalize("NFKC").toUpperCase().replace(/[\s\-_./\\()[\]]+/gu, "");
}
function indexReview(review) {
  const nameKey = review.normalizedName.length > 0 ? review.normalizedName : normalizeCourseName(review.courseName);
  return {
    review,
    // Fall back to normalizing the raw name so a provider that forgot to fill in
    // `normalizedName` cannot silently make every candidate unmatchable. The
    // normalizer is idempotent, so a correct value passes through unchanged.
    nameKey,
    // Aliases come from the raw name, because the qualifier is what gets removed.
    aliasKeys: courseAliases(review.courseName).aliases.map((alias) => alias.key),
    teacherKey: review.normalizedTeacher ?? normalizeTeacherName(review.teacher),
    codeKey: normalizeCourseCode(review.courseCode)
  };
}
function reviewTeacherNames(candidate) {
  const names = teacherNameSet(candidate.review.teacherNames);
  if (names.length > 0)
    return names;
  return teacherNameSet(candidate.review.teacher ?? candidate.review.normalizedTeacher);
}
function teacherRelation(course, candidate) {
  const relation = teacherSetRelation(course.teacher, reviewTeacherNames(candidate));
  return relation;
}
function applyTeacherAdjustment(base, relation) {
  switch (relation) {
    case "agree":
      return Math.min(1, base + 0.03);
    case "disagree":
      return Math.min(0.5, base * 0.55);
    case "unknown":
      return base;
  }
}
function candidatesFor(course, indexed) {
  const courseCode = normalizeCourseCode(course.courseCode);
  const out = [];
  for (const candidate of indexed) {
    const relation = teacherRelation(course, candidate);
    let best;
    const consider = (method, confidence, similarity) => {
      const proposal = { indexed: candidate, method, confidence, similarity };
      if (best === void 0 || proposal.confidence > best.confidence)
        best = proposal;
    };
    if (courseCode.length > 0 && candidate.codeKey.length > 0 && courseCode === candidate.codeKey) {
      if (relation === "agree")
        consider("course_code_teacher", applyTeacherAdjustment(BASE_CONFIDENCE.course_code_teacher, relation), 1);
      else if (relation === "disagree") {
        consider("course_code", applyTeacherAdjustment(BASE_CONFIDENCE.course_code, relation), 1);
      } else
        consider("course_code", BASE_CONFIDENCE.course_code, 1);
    }
    const nameSimilarity = similarityBetween(course, candidate);
    if (nameSimilarity >= 1) {
      if (relation === "agree")
        consider("name_teacher", applyTeacherAdjustment(BASE_CONFIDENCE.name_teacher, relation), 1);
      else if (relation === "disagree")
        consider("exact_name", applyTeacherAdjustment(BASE_CONFIDENCE.exact_name, relation), 1);
      else
        consider("exact_name", BASE_CONFIDENCE.exact_name, 1);
    } else if (aliasSimilarityBetween(course, candidate) >= 1) {
      if (relation === "agree")
        consider("alias_name_teacher", applyTeacherAdjustment(BASE_CONFIDENCE.alias_name_teacher, relation), 1);
      else if (relation === "disagree")
        consider("alias_name", applyTeacherAdjustment(BASE_CONFIDENCE.alias_name, relation), 1);
      else
        consider("alias_name", BASE_CONFIDENCE.alias_name, 1);
    } else if (nameSimilarity >= FUZZY_FLOOR && !qualifiersConflict(course.courseName, candidate.review.courseName)) {
      const base = BASE_CONFIDENCE.fuzzy_name + (BASE_CONFIDENCE.fuzzy_name_teacher - BASE_CONFIDENCE.fuzzy_name) * (nameSimilarity - FUZZY_FLOOR) / (1 - FUZZY_FLOOR);
      if (relation === "agree")
        consider("fuzzy_name_teacher", applyTeacherAdjustment(base, relation), nameSimilarity);
      else if (relation === "disagree")
        consider("fuzzy_name", applyTeacherAdjustment(base, relation), nameSimilarity);
      else
        consider("fuzzy_name", base, nameSimilarity);
    }
    if (best !== void 0)
      out.push(best);
  }
  return out;
}
function similarityBetween(course, candidate) {
  const courseKey = course.normalizedName.length > 0 ? course.normalizedName : normalizeCourseName(course.courseName);
  if (courseKey.length > 0 && courseKey === candidate.nameKey)
    return 1;
  return fuzzyNameScore(courseKey, candidate.nameKey);
}
function aliasSimilarityBetween(course, candidate) {
  const courseKey = course.normalizedName.length > 0 ? course.normalizedName : normalizeCourseName(course.courseName);
  if (courseKey.length === 0)
    return 0;
  const courseAliasKeys = courseAliases(course.courseName).aliases.map((alias) => alias.key);
  if (courseAliasKeys.includes(candidate.nameKey))
    return 1;
  if (candidate.aliasKeys.includes(courseKey))
    return 1;
  return 0;
}
var matchCourse = (course, candidates) => {
  if (candidates.length === 0) {
    return {
      course,
      confidence: 0,
      method: "unmatched",
      note: "\u8BC4\u4EF7\u7AD9\u70B9\u6CA1\u6709\u8FD4\u56DE\u4EFB\u4F55\u5019\u9009\u8BB0\u5F55"
    };
  }
  const indexed = candidates.map(indexReview);
  const scored = candidatesFor(course, indexed);
  if (scored.length === 0) {
    return {
      course,
      confidence: 0,
      method: "unmatched",
      note: `\u8BC4\u4EF7\u7AD9\u70B9\u8FD4\u56DE\u4E86 ${candidates.length} \u6761\u5019\u9009\uFF0C\u4F46\u6CA1\u6709\u4E00\u6761\u8FBE\u5230\u5339\u914D\u4E0B\u9650`
    };
  }
  scored.sort((left, right) => {
    if (left.confidence !== right.confidence)
      return right.confidence - left.confidence;
    if (left.similarity !== right.similarity)
      return right.similarity - left.similarity;
    const leftCount = left.indexed.review.reviewCount;
    const rightCount = right.indexed.review.reviewCount;
    if (leftCount !== rightCount)
      return rightCount - leftCount;
    const leftName = left.indexed.review.courseName;
    const rightName = right.indexed.review.courseName;
    if (leftName !== rightName)
      return leftName < rightName ? -1 : 1;
    const leftTeacher = left.indexed.review.teacher ?? "";
    const rightTeacher = right.indexed.review.teacher ?? "";
    return leftTeacher < rightTeacher ? -1 : leftTeacher > rightTeacher ? 1 : 0;
  });
  const winner = scored[0];
  if (winner === void 0) {
    return { course, confidence: 0, method: "unmatched", note: "\u5339\u914D\u9636\u6BB5\u6CA1\u6709\u4EA7\u751F\u5019\u9009" };
  }
  const trusted = winner.confidence >= REVIEW_MATCH_THRESHOLD;
  const alternatives = scored.slice(1, 4).map((entry2) => entry2.indexed.review);
  const result = {
    course,
    confidence: Number(winner.confidence.toFixed(4)),
    method: winner.method,
    aliasUsed: winner.method.startsWith("alias_")
  };
  if (trusted)
    result.review = winner.indexed.review;
  if (alternatives.length > 0)
    result.alternatives = alternatives;
  if (!trusted) {
    result.note = winner.method.startsWith("alias_") ? `\u8BFE\u7A0B\u540D\u901A\u8FC7 alias \u8FD1\u4F3C\u5339\u914D\uFF08\u65B9\u6CD5 ${winner.method}\uFF0C\u7F6E\u4FE1\u5EA6 ${winner.confidence.toFixed(2)}\uFF09\u4F4E\u4E8E\u9608\u503C ${REVIEW_MATCH_THRESHOLD}\uFF1B\u8FD9\u53EF\u80FD\u662F\u540C\u4E00\u95E8\u8BFE\u7684\u4E0D\u540C\u5199\u6CD5\uFF0C\u4F46\u672A\u7ECF\u786E\u8BA4\u4E0D\u4F1A\u7ED1\u5B9A\u8BC4\u4EF7\u6570\u636E` : `\u5339\u914D\u7F6E\u4FE1\u5EA6 ${winner.confidence.toFixed(2)} \u4F4E\u4E8E\u9608\u503C ${REVIEW_MATCH_THRESHOLD}\uFF0C\u8BC4\u4EF7\u5339\u914D\u4E0D\u786E\u5B9A\uFF0C\u672A\u7ED1\u5B9A\u6570\u636E`;
  } else if (teacherRelation(course, winner.indexed) === "unknown") {
    result.note = "\u8BFE\u7A0B\u6216\u8BC4\u4EF7\u7F3A\u5C11\u6559\u5E08\u4FE1\u606F\uFF0C\u5339\u914D\u4EC5\u4F9D\u636E\u8BFE\u7A0B\u540D\u79F0";
  }
  return result;
};

// packages/recommendation/dist/recommend.js
var HYDRATABLE_FIELDS = ["teacher", "schedule", "department", "capacity"];
function hasHydratableField(course, field) {
  switch (field) {
    case "teacher":
      return (course.teacher ?? "").trim().length > 0;
    case "schedule":
      return (course.schedule ?? []).length > 0;
    case "department":
      return (course.department ?? "").trim().length > 0;
    case "capacity":
      return course.capacity !== void 0;
    case "location":
      return (course.schedule ?? []).some((entry2) => entry2.includes(" @ "));
    default:
      return false;
  }
}
function describeSectionHydration(course) {
  const raw = course.raw ?? {};
  const rawHydrated = typeof raw.wholeRowHydrated === "boolean" ? raw.wholeRowHydrated : null;
  const available = HYDRATABLE_FIELDS.filter((field) => hasHydratableField(course, field));
  const missing = HYDRATABLE_FIELDS.filter((field) => !hasHydratableField(course, field));
  const status = rawHydrated ?? available.length > 0 ? "full" : "basic";
  return { status, available, missing, rawHydrated };
}
function describeReviewContext(review, course, teacherMatchConfidence) {
  const teacherSpecified = (course.teacher ?? "").trim().length > 0;
  const reviewTeacher = (review?.teacher ?? "").trim();
  const teacher = reviewTeacher.length > 0 ? reviewTeacher : null;
  const scope = review?.aggregateScope === "course" ? "course" : "teacher";
  const reviewCount = review?.reviewCount ?? 0;
  let aggregationNote;
  if (scope === "course") {
    aggregationNote = `\u8BE5\u8BC4\u4EF7\u8986\u76D6\u8BFE\u7A0B\u6574\u4F53\uFF08\u5171 ${reviewCount} \u6761\u5B66\u751F\u8BC4\u4EF7\uFF09\uFF0C\u4E0D\u4EE3\u8868\u4EFB\u4F55\u5355\u4E00\u4F4D\u6559\u5E08`;
  } else if (!teacherSpecified) {
    aggregationNote = teacher === null ? `\u5339\u914D\u5230\u7684\u8BC4\u4EF7\u672A\u6807\u6CE8\u6559\u5E08\uFF08${reviewCount} \u6761\u5B66\u751F\u8BC4\u4EF7\uFF09\uFF0C\u4EC5\u4F9D\u636E\u8BFE\u7A0B\u540D\u79F0\u5339\u914D\uFF0C\u65E0\u6CD5\u786E\u8BA4\u662F\u5426\u4E3A\u8BE5\u6559\u5B66\u73ED\u6559\u5E08` : `\u5339\u914D\u5230\u7684\u8BC4\u4EF7\u5BF9\u5E94 ${teacher} \u8001\u5E08\uFF08${reviewCount} \u6761\u5B66\u751F\u8BC4\u4EF7\uFF09\uFF0C\u4F46\u9875\u9762\u672A\u63D0\u4F9B\u672C\u6559\u5B66\u73ED\u7684\u6559\u5E08\u4FE1\u606F\uFF0C\u65E0\u6CD5\u786E\u8BA4\u672C\u73ED\u662F\u5426\u7531\u8BE5\u6559\u5E08\u6388\u8BFE`;
  } else {
    aggregationNote = `\u8BE5\u8BC4\u4EF7\u6765\u81EA\u6307\u5B9A\u6559\u5E08 ${teacher ?? course.teacher ?? ""}\uFF08${reviewCount} \u6761\u5B66\u751F\u8BC4\u4EF7\uFF09`;
  }
  return { scope, reviewCount, teacherSpecified, teacher, teacherMatchConfidence, aggregationNote };
}
function buildDataCoverage(input) {
  const { coursesDiscovered, sectionsDiscovered, sectionsHydrated } = input;
  return {
    coursesDiscovered,
    sectionsDiscovered,
    sectionsHydrated,
    hydratedRatio: sectionsDiscovered > 0 ? sectionsHydrated / sectionsDiscovered : null,
    exhausted: input.exhausted ?? null
  };
}
function defaultLookup(providers, candidateLimit) {
  return async (query) => {
    const warnings = [];
    const reviews = [];
    let fromCache = false;
    let courseLevel;
    let teachingClassLevel;
    let courseSupplementary;
    const reportedExcerpts = [];
    const outcomes = [];
    const failureKinds = [];
    let providerHealth = rollUpReviewSourceHealth([]);
    for (const provider of providers) {
      try {
        const result = await provider.searchCourse({ ...query, limit: candidateLimit });
        reviews.push(...result.reviews);
        warnings.push(...result.warnings);
        if (result.fromCache)
          fromCache = true;
        providerHealth = mergeReviewSourceHealth(providerHealth, result.reviewSource ?? rollUpReviewSourceHealth([result.reviews.length > 0 ? "rows" : "empty"]));
        if (providers.length === 1) {
          courseLevel = result.courseLevel;
          teachingClassLevel = result.teachingClassLevel;
          courseSupplementary = result.courseSupplementary;
        }
        reportedExcerpts.push(...result.reviewExcerpts ?? []);
      } catch (error) {
        warnings.push(`${provider.id} \u67E5\u8BE2\u5931\u8D25\uFF1A${error.message}`);
        outcomes.push("unavailable");
        const kind = classifyProviderFailure(error);
        if (!failureKinds.includes(kind))
          failureKinds.push(kind);
        providerHealth = mergeReviewSourceHealth(providerHealth, rollUpReviewSourceHealth(["unavailable"], [kind]));
      }
    }
    return {
      reviews,
      provider: providers.map((provider) => provider.id).join("+"),
      fromCache,
      warnings,
      /*
       * The structured facts a caller can branch on. `warnings` above stays for human diagnostics, but nothing public may depend on reading
       * its text to find out whether the source failed — so the rolled-up health is published here as well as the per-query outcomes.
       */
      outcomes,
      ...failureKinds.length === 0 ? {} : { failureKinds },
      /*
       * The provider-reported health when any provider gave one, otherwise the call-level roll-up. Reported rather than recomputed, so the
       * request count matches what was actually attempted.
       */
      reviewSource: providerHealth.queries > 0 ? providerHealth : rollUpReviewSourceHealth(outcomes, failureKinds),
      // Offsets keep the keys absent rather than present-and-undefined, which is what `ReviewSearchResult` documents.
      ...courseLevel === void 0 ? {} : { courseLevel },
      ...teachingClassLevel === void 0 ? {} : { teachingClassLevel },
      ...courseSupplementary === void 0 ? {} : { courseSupplementary },
      // Always present: the projection below may legitimately produce an empty array, and `[]` is a real answer.
      reviewExcerpts: capReviewExcerpts(reportedExcerpts)
    };
  };
}
function classifyProviderFailure(error) {
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code ?? "") : "";
  if (code === "network-error" || code === "timeout" || code === "aborted")
    return "network";
  if (code === "http-error" || code.startsWith("http-") || code === "rate-limited")
    return "http";
  return "malformed";
}
function rollUpReviewSourceHealth(outcomes, failureKinds = []) {
  const rows = outcomes.filter((outcome) => outcome === "rows").length;
  const empty = outcomes.filter((outcome) => outcome === "empty").length;
  const unavailable = outcomes.filter((outcome) => outcome === "unavailable").length;
  const queries = outcomes.length;
  const status = unavailable === 0 ? "healthy" : unavailable === queries ? "unavailable" : "partial";
  return {
    status,
    queries,
    rows,
    empty,
    unavailable,
    ...failureKinds.length === 0 ? {} : { failureKinds: [...failureKinds] }
  };
}
function mergeReviewSourceHealth(total, course) {
  const kinds = [...total.failureKinds ?? []];
  for (const kind of course.failureKinds ?? [])
    if (!kinds.includes(kind))
      kinds.push(kind);
  const queries = total.queries + course.queries;
  const unavailable = total.unavailable + course.unavailable;
  const status = unavailable === 0 ? "healthy" : unavailable === queries ? "unavailable" : "partial";
  return {
    status,
    queries,
    rows: total.rows + course.rows,
    empty: total.empty + course.empty,
    unavailable,
    ...kinds.length === 0 ? {} : { failureKinds: kinds }
  };
}
function projectGradeAggregate(source) {
  if (source === void 0)
    return void 0;
  const grades = "grades" in source ? source.grades : void 0;
  const gradedSampleCount = "gradedSampleCount" in source && typeof source.gradedSampleCount === "number" ? source.gradedSampleCount : grades?.validSampleCount ?? 0;
  return {
    ...source.meanGrade === void 0 ? {} : { meanGrade: source.meanGrade },
    ...source.medianGrade === void 0 ? {} : { medianGrade: source.medianGrade },
    gradedSampleCount,
    gradeDistribution: grades?.percentageDistribution ?? {}
  };
}
function describeGradeAggregates(review, teachingClassLevel, courseLevel, teacherNames) {
  const teacher = teacherNames.length === 1 ? projectGradeAggregate(review) : void 0;
  const teachingClass = projectGradeAggregate(teachingClassLevel);
  const course = projectGradeAggregate(courseLevel);
  return {
    teacherSet: { names: [...teacherNames] },
    ...teacher === void 0 ? {} : { teacher },
    ...teachingClass === void 0 ? {} : { teachingClass },
    ...course === void 0 ? {} : { course }
  };
}
function planQueries(courses) {
  const queries = /* @__PURE__ */ new Map();
  for (const course of courses) {
    const teacherKey = course.normalizedTeacher ?? normalizeTeacherName(course.teacher);
    const key = `${course.normalizedName}\0${teacherKey}`;
    if (queries.has(key))
      continue;
    const query = { courseName: course.courseName };
    const teacherFilter = queryTeacherFilter(course.teacher);
    if (teacherFilter !== void 0 && teacherFilter.trim().length > 0)
      query.teacher = teacherFilter;
    const localTeacherNames = teacherNamesOfCourse(course.teacher);
    if (localTeacherNames.length > 0)
      query.localTeacherNames = localTeacherNames;
    if (course.courseCode !== void 0)
      query.courseCode = course.courseCode;
    queries.set(key, query);
  }
  return { courses: [...courses], queries };
}
function groupKey(course) {
  const teacherKey = course.normalizedTeacher ?? normalizeTeacherName(course.teacher);
  return `${course.normalizedName}\0${teacherKey}`;
}
async function recommendCourses(courses, options, deps, coverage) {
  const now = deps.now ?? (() => /* @__PURE__ */ new Date());
  const generatedAt = now().toISOString();
  const threshold = deps.matchThreshold ?? REVIEW_MATCH_THRESHOLD;
  const matcher = deps.matcher ?? matchCourse;
  const candidateLimit = deps.policy.candidateLimit;
  const providers = [...deps.providers, ...options.extraProviders ?? []];
  const lookup = deps.lookup ?? defaultLookup(providers, candidateLimit);
  const preferences = normalizePreferences(options.preferences, deps.policy.defaultPreferences);
  const requestedTopN = options.topN ?? deps.policy.defaultTopN;
  const topN = Math.max(0, Math.min(deps.policy.maxTopN, Math.trunc(Number.isFinite(requestedTopN) ? requestedTopN : deps.policy.defaultTopN)));
  const { eligible, excluded } = filterEligible(courses, preferences);
  const plan = planQueries(eligible);
  const lookupWarnings = [];
  let usedCache = false;
  const byGroup = /* @__PURE__ */ new Map();
  const scopedByGroup = /* @__PURE__ */ new Map();
  const courseLevelByGroup = /* @__PURE__ */ new Map();
  const healthByGroup = /* @__PURE__ */ new Map();
  const excerptsByGroup = /* @__PURE__ */ new Map();
  const keys = [...plan.queries.keys()];
  const lookups = keys.map(async (key) => {
    const query = plan.queries.get(key);
    if (query === void 0)
      return;
    const result = await lookup(query);
    byGroup.set(key, result.reviews);
    scopedByGroup.set(key, result.teachingClassLevel);
    courseLevelByGroup.set(key, result.courseLevel);
    excerptsByGroup.set(key, result.reviewExcerpts ?? []);
    healthByGroup.set(key, result.reviewSource ?? rollUpReviewSourceHealth([result.reviews.length > 0 ? "rows" : "empty"]));
    if (result.fromCache)
      usedCache = true;
    for (const warning of result.warnings)
      lookupWarnings.push(warning);
  });
  await Promise.all(lookups);
  const matches = eligible.map((course) => {
    const key = groupKey(course);
    const candidates = byGroup.get(key) ?? [];
    const match = matcher(course, candidates);
    const scoped = scopedByGroup.get(key);
    const corpus = courseLevelByGroup.get(key);
    const withScoped = scoped === void 0 ? match : { ...match, teachingClassLevel: scoped };
    const excerpts = excerptsByGroup.get(key) ?? [];
    const withExcerpts = excerpts.length === 0 ? withScoped : { ...withScoped, reviewExcerpts: excerpts };
    if (corpus === void 0 || withExcerpts.review === void 0)
      return withExcerpts;
    return { ...withExcerpts, courseLevel: corpus };
  });
  const scored = matches.map((match) => {
    const legacy = calculateCourseScore(match.review, preferences);
    const breakdown = legacy.decision;
    return {
      course: match.course,
      score: legacy.score,
      components: legacy.components,
      appliedWeights: legacy.appliedWeights,
      redistributed: legacy.redistributed,
      match,
      confidence: calculateReviewConfidence(match),
      decision: breakdown
    };
  });
  scored.sort((left, right) => compareDecisions(left, right));
  const recommendations = [];
  const ratedButNotRecommended = [];
  const insufficientData = [];
  const ambiguousCandidates = [];
  for (const [index, entry2] of scored.entries()) {
    const trusted = entry2.match.review !== void 0 && entry2.match.confidence >= threshold;
    const breakdown = entry2.decision ?? buildAspectBreakdown(entry2.match.review, aspectWeightsFromPreferences(preferences));
    if (!trusted) {
      if (entry2.match.method.startsWith("alias_") || entry2.match.method.startsWith("fuzzy_")) {
        ambiguousCandidates.push({
          course: entry2.course,
          method: entry2.match.method,
          confidence: entry2.match.confidence,
          reason: entry2.match.note ?? `\u540D\u79F0\u8FD1\u4F3C\uFF08${entry2.match.method}\uFF0C\u7F6E\u4FE1\u5EA6 ${entry2.match.confidence.toFixed(2)}\uFF09\uFF0C\u9700\u786E\u8BA4\u540E\u624D\u4F1A\u4F7F\u7528\u8BC4\u4EF7\u6570\u636E`
        });
        continue;
      }
      insufficientData.push({
        course: entry2.course,
        reason: entry2.match.method === "unmatched" ? entry2.match.note ?? "\u672A\u5339\u914D\u5230\u8BC4\u4EF7\u8BB0\u5F55" : `\u8BC4\u4EF7\u5339\u914D\u4E0D\u786E\u5B9A\uFF08${entry2.match.method}\uFF0C\u7F6E\u4FE1\u5EA6 ${entry2.match.confidence.toFixed(2)} < ${threshold}\uFF09\uFF0C\u672A\u53C2\u4E0E\u6392\u5E8F`,
        match: { method: entry2.match.method, confidence: entry2.match.confidence },
        /*
         * Carried here too, because this is exactly the list where the distinction matters most: "the site has no reviews for this course" and
         * "the site could not be reached" both land here, and only the health says which one happened.
         */
        reviewSource: healthByGroup.get(groupKey(entry2.course)) ?? rollUpReviewSourceHealth([])
      });
      continue;
    }
    if (entry2.score === null || breakdown.decisionScore === null) {
      insufficientData.push({
        course: entry2.course,
        reason: "\u8BC4\u4EF7\u8BB0\u5F55\u5B58\u5728\uFF0C\u4F46\u6CA1\u6709\u4EFB\u4F55\u53EF\u7528\u7684\u8BC4\u5206\u7EF4\u5EA6",
        match: { method: entry2.match.method, confidence: entry2.match.confidence },
        reviewSource: healthByGroup.get(groupKey(entry2.course)) ?? rollUpReviewSourceHealth([])
      });
      continue;
    }
    const warnings = buildWarnings(entry2.match, entry2.course, threshold);
    warnings.push(...warningsFromBreakdown(breakdown));
    const effectiveWeights = { ...breakdown.appliedWeights };
    const requestedWeights = aspectWeightsFromPreferences(preferences);
    const corpusReviews = entry2.match.review?.reviewCount ?? 0;
    const reviewScores = entry2.match.review?.aspects?.scores ?? [];
    const evidenceStrength2 = breakdown.aspects.map((aspect) => {
      const score = reviewScores.find((candidate) => candidate.aspect === aspect.aspect);
      return score === void 0 ? {
        aspect: aspect.aspect,
        level: "none",
        reviewsWithEvidence: 0,
        corpusReviews,
        coverage: 0,
        agreement: 0,
        note: "\u6CA1\u6709\u8BC4\u4EF7\u8BB0\u5F55\uFF0C\u65E0\u6CD5\u8BC4\u4F30\u8BC1\u636E\u5F3A\u5EA6"
      } : evidenceStrength(score, corpusReviews);
    });
    const recommendation = {
      rank: recommendations.length + 1,
      course: entry2.course,
      reviewContext: describeReviewContext(
        entry2.match.review,
        entry2.course,
        // Confidence is a teacher-match figure only when a teacher was actually supplied; otherwise there is
        // no teacher match to be confident about.
        (entry2.course.teacher ?? "").trim().length > 0 ? entry2.match.confidence : null
      ),
      sectionHydration: describeSectionHydration(entry2.course),
      /*
       * Presentation data, projected from the aggregates the lookup already produced. It is deliberately built here, at the object
       * construction, because that is the only place the structured evidence was previously dropped: it lives on `MatchResult` all the way
       * through the lookup and was simply not carried into the recommendation.
       */
      gradeAggregates: describeGradeAggregates(
        entry2.match.review,
        entry2.match.teachingClassLevel,
        entry2.match.courseLevel,
        /*
         * The canonical splitter, not a local one: `teacherNamesOfCourse` owns the rules for what counts as a teacher cell naming several
         * people, and re-deriving the names here would create a second, divergent answer to "is this class co-taught?".
         */
        teacherNamesOfCourse(entry2.course.teacher)
      ),
      /*
       * The candidate's own review-source state. A `partial` or `unavailable` status qualifies every figure on this object, so it travels with
       * them rather than being looked up separately by a consumer.
       */
      reviewSource: healthByGroup.get(groupKey(entry2.course)) ?? rollUpReviewSourceHealth([]),
      recommendationStatus: "recommended",
      /*
       * The comments, carried for the same reason as `gradeAggregates` above and at the same construction site: the lookup produced
       * them and this is where they were previously dropped. They arrive already scoped and bounded by the provider — no teacher
       * matching happens here, and `[]` is published rather than `undefined` so a renderer has no maybe to interpret.
       */
      reviewExcerpts: entry2.match.reviewExcerpts ?? [],
      score: entry2.score,
      riskAdjustedScore: riskAdjustedScore(entry2.score, entry2.confidence.value),
      effectiveWeights,
      defaultWeights: { ...requestedWeights },
      effectiveWeightNotes: describeWeightRedistribution(requestedWeights, effectiveWeights, breakdown.missingDimensions),
      evidenceStrength: evidenceStrength2,
      confidence: entry2.confidence,
      reasons: buildAspectReasons(breakdown, entry2.confidence),
      warnings,
      match: {
        method: entry2.match.method,
        confidence: entry2.match.confidence,
        trusted: true,
        ...entry2.match.aliasUsed === true ? { aliasUsed: true } : {}
      },
      aspects: breakdown,
      missingDimensions: breakdown.missingDimensions,
      topAspects: breakdown.aspects.filter((aspect) => aspect.decision !== void 0 && aspect.weight > 0).sort((left, right) => (right.contribution ?? 0) - (left.contribution ?? 0)).slice(0, 3).map((aspect) => aspect.aspect),
      components: entry2.components,
      appliedWeights: entry2.appliedWeights,
      redistributed: entry2.redistributed
    };
    if (entry2.match.review !== void 0)
      recommendation.review = entry2.match.review;
    recommendations.push(recommendation);
    if (recommendations.length >= topN) {
      for (const rest of scored.slice(index + 1)) {
        const restTrusted = rest.match.review !== void 0 && rest.match.confidence >= threshold;
        const restBreakdown = rest.decision ?? buildAspectBreakdown(rest.match.review, aspectWeightsFromPreferences(preferences));
        if (!restTrusted || rest.score === null || restBreakdown.decisionScore === null)
          continue;
        ratedButNotRecommended.push({
          course: rest.course,
          // Ranks continue the same order, so the list reads as "6th, 7th, …" rather than restarting at 1.
          rank: recommendations.length + ratedButNotRecommended.length + 1,
          score: rest.score,
          reviewContext: describeReviewContext(rest.match.review, rest.course, (rest.course.teacher ?? "").trim().length > 0 ? rest.match.confidence : null),
          sectionHydration: describeSectionHydration(rest.course),
          /*
           * THE SAME PROJECTION THE RECOMMENDATION PATH USES, from the same lookup result.
           *
           * PRE-RELEASE-UX-A11. `rest.match` carries the identical structured evidence a recommended entry's `match` does, so the aggregates are projected here
           * rather than recomputed: no second algorithm, no re-fetch, and no way for the two paths to describe one course differently. What varies between them is
           * only whether the entry is above or below the cut.
           *
           * This is presentation data. It is populated AFTER the entry has already been placed, so nothing about `rank`, `score` or membership can depend on it.
           */
          gradeAggregates: describeGradeAggregates(rest.match.review, rest.match.teachingClassLevel, rest.match.courseLevel, teacherNamesOfCourse(rest.course.teacher)),
          /*
           * The same excerpt array the recommended path publishes, read from the same lookup result. A course that missed the cut is still a course a reader may open,
           * and its comments must be the provider's scoping — not a second derivation that could disagree with the entry above the cut.
           */
          reviewExcerpts: rest.match.reviewExcerpts ?? []
        });
      }
      break;
    }
  }
  return {
    recommendations,
    ratedButNotRecommended,
    considered: eligible.length,
    excluded,
    insufficientData,
    ambiguousCandidates,
    preferences,
    /*
     * The run-level roll-up: a fold over every course's health, so a caller can say "some review requests failed" without walking the
     * candidates. It reports only what was observed and never feeds back into scoring.
     */
    reviewSource: [...healthByGroup.values()].reduce(mergeReviewSourceHealth, rollUpReviewSourceHealth([])),
    dataCoverage: coverage === void 0 ? null : buildDataCoverage({
      coursesDiscovered: coverage.coursesDiscovered,
      sectionsDiscovered: coverage.sectionsDiscovered,
      sectionsHydrated: coverage.sectionsHydrated,
      exhausted: coverage.exhausted
    }),
    meta: {
      adapters: unique(courses.map((course) => course.source)),
      providers: unique(providers.map((provider) => provider.id)),
      reviewMatchThreshold: threshold,
      generatedAt,
      usedCache: usedCache || lookupWarnings.some((warning) => warning.includes("\u7F13\u5B58"))
    }
  };
}
function warningsFromBreakdown(breakdown) {
  const warnings = [];
  for (const aspect of breakdown.aspects) {
    if (aspect.decision === void 0 || aspect.weight <= 0)
      continue;
    if (aspect.evidenceReviewCount > 0 && aspect.evidenceReviewCount < 3) {
      warnings.push(`${aspectLabel(aspect.aspect)} \u4EC5\u6709 ${aspect.evidenceReviewCount} \u6761\u8BC4\u4EF7\u63D0\u5230\uFF0C\u8BE5\u7EF4\u5EA6\u4E0D\u786E\u5B9A\u6027\u8F83\u9AD8`);
    }
  }
  return warnings;
}
function compareDecisions(left, right) {
  if (left.score === null && right.score !== null)
    return 1;
  if (left.score !== null && right.score === null)
    return -1;
  if (left.score !== null && right.score !== null && left.score !== right.score) {
    return right.score - left.score;
  }
  if (left.confidence.value !== right.confidence.value) {
    return right.confidence.value - left.confidence.value;
  }
  const leftReviews = left.match.review?.reviewCount ?? 0;
  const rightReviews = right.match.review?.reviewCount ?? 0;
  if (leftReviews !== rightReviews)
    return rightReviews - leftReviews;
  const leftKey = left.course.courseCode ?? left.course.normalizedName;
  const rightKey = right.course.courseCode ?? right.course.normalizedName;
  if (leftKey !== rightKey)
    return leftKey < rightKey ? -1 : 1;
  if (left.course.courseName !== right.course.courseName) {
    return left.course.courseName < right.course.courseName ? -1 : 1;
  }
  return 0;
}
function buildAspectReasons(breakdown, confidence) {
  const reasons = [];
  const ranked = breakdown.aspects.filter((aspect) => aspect.decision !== void 0).sort((left, right) => right.decision - left.decision);
  for (const aspect of ranked) {
    const decision = aspect.decision;
    if (decision >= 7)
      reasons.push(`${aspectLabel(aspect.aspect)}\u8F83\u597D\uFF08${decision.toFixed(1)}/10\uFF09`);
    else if (decision <= 4)
      reasons.push(`${aspectLabel(aspect.aspect)}\u504F\u5F31\uFF08${decision.toFixed(1)}/10\uFF09`);
  }
  if (reasons.length === 0 && ranked[0] !== void 0) {
    reasons.push(`${aspectLabel(ranked[0].aspect)} \u5C45\u4E2D\uFF08${ranked[0].decision.toFixed(1)}/10\uFF09`);
  }
  for (const aspect of breakdown.aspects) {
    if (aspect.raw === void 0)
      continue;
    if (Math.abs(aspect.decision - aspect.raw) >= 1) {
      reasons.push(`${aspectLabel(aspect.aspect)} \u539F\u59CB\u5206 ${aspect.raw.toFixed(1)}\uFF0C\u56E0\u8BC1\u636E\u4EC5 ${aspect.evidenceReviewCount} \u6761\u6309\u53EF\u9760\u6027 ${aspect.reliability.toFixed(2)} \u5411\u4E2D\u6027\u6536\u7F29\u4E3A ${aspect.decision.toFixed(1)}`);
    }
  }
  const strong = confidence.inputs.evidenceReviewCount;
  reasons.push(strong >= 10 ? `\u6559\u5E08\u8BC4\u4EF7\u6837\u672C\u8F83\u5145\u5206\uFF08\u672C\u6B21\u8BA1\u5206 ${strong} \u6761\uFF09` : `\u6559\u5E08\u8BC4\u4EF7\u6837\u672C\u8F83\u5C11\uFF08\u672C\u6B21\u8BA1\u5206 ${strong} \u6761\uFF09\uFF0C\u7ED3\u8BBA\u4EC5\u4F9B\u53C2\u8003`);
  if (breakdown.missingDimensions.length > 0) {
    reasons.push(`\u7F3A\u5C11\u53EF\u9760\u6570\u636E\u7684\u7EF4\u5EA6\uFF1A${breakdown.missingDimensions.map(aspectLabel).join("\u3001")}`);
  }
  return reasons;
}
function buildWarnings(match, course, threshold) {
  const warnings = [];
  if (match.note !== void 0)
    warnings.push(match.note);
  if (match.confidence < threshold + 0.1) {
    warnings.push(`\u8BC4\u4EF7\u5339\u914D\u7F6E\u4FE1\u5EA6 ${match.confidence.toFixed(2)} \u63A5\u8FD1\u9608\u503C\uFF0C\u5EFA\u8BAE\u4EBA\u5DE5\u6838\u5BF9\u8BC4\u4EF7\u6765\u6E90\u8BFE\u7A0B\u662F\u5426\u4E3A\u540C\u4E00\u95E8`);
  }
  if (match.review !== void 0 && match.review.reviewCount < 5) {
    warnings.push(`\u8BC4\u4EF7\u6837\u672C\u4EC5 ${match.review.reviewCount} \u6761\uFF0C\u7EDF\u8BA1\u610F\u4E49\u6709\u9650`);
  }
  const courseTeacher = course.normalizedTeacher ?? normalizeTeacherName(course.teacher);
  const reviewTeacher = match.review?.normalizedTeacher;
  if (courseTeacher.length > 0 && reviewTeacher !== void 0 && reviewTeacher.length > 0 && courseTeacher !== reviewTeacher) {
    warnings.push(`\u6559\u5E08\u4E0D\u4E00\u81F4\uFF1A\u9009\u8BFE\u9875\u4E3A\u300C${course.teacher ?? ""}\u300D\uFF0C\u8BC4\u4EF7\u8BB0\u5F55\u4E3A\u300C${match.review?.teacher ?? ""}\u300D`);
  }
  if (course.availability === "unknown") {
    warnings.push("\u9875\u9762\u672A\u63D0\u4F9B\u672C\u8F6E\u4F59\u91CF\uFF0C\u662F\u5426\u53EF\u9009\u9700\u8981\u4EBA\u5DE5\u786E\u8BA4");
  }
  return warnings;
}
function unique(values) {
  return [...new Set(values)].sort();
}

// apps/extension/src/background/recommendation-runtime.ts
async function recommendExtensionCourses(input) {
  const { courses, provider, options, now, coverage } = input;
  return recommendCourses(
    courses,
    options ?? {},
    {
      providers: [provider],
      policy: EXTENSION_RECOMMENDATION_POLICY,
      ...now === void 0 ? {} : { now }
    },
    coverage
  );
}


export { recommendExtensionCourses, normalizeCourseName, normalizeTeacherName };
// Pure aggregation helpers, reused by the local WUST review adapter without network calls.
export { cleanRow, aggregateCleanRows, summarizeCleanRows, partitionCleanRows, selectReviewExcerpts, teacherNamesOfCourse };

export {mergeReviewSourceHealth,buildDataCoverage};
