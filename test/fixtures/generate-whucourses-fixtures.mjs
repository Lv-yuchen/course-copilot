// (helper) Generate the whucourses.cn API fixtures deterministically.
// The rows mimic the real payload shape exactly (Chinese keys, 课程成绩 as a
// string, `""` legacy key, "未知" sentinels, outliers).
import { mkdirSync, writeFileSync } from 'node:fs';

const outDir = 'test/fixtures/whucourses';
mkdirSync(outDir, { recursive: true });

/** Build one review row. */
function row(courseName, teacher, grade, assessment, attendance, content, attribute = '专业课程') {
  return {
    '': grade === null ? '未知' : String(grade),
    '公选课领域': '非公选课',
    '授课老师': teacher,
    '期末考核方式': assessment,
    '考勤与平时作业': attendance,
    '课程内容与评价': content,
    '课程名称': courseName,
    '课程属性': attribute,
    '课程成绩': grade === null ? '未知' : String(grade),
  };
}

// ---------------------------------------------------------------------------
// 高等数学（上） / 张三 — a large, unambiguous sample: generous grades, heavy
// workload, strict attendance. 12 rows.
// ---------------------------------------------------------------------------
const advancedMath = [
  row('高等数学（上）', '张三', 95, '闭卷考试，期末占70%', '每节课都点名，平时作业每周一次', '老师讲得很清楚，给分很好，强烈推荐'),
  row('高等数学（上）', '张三', 92, '闭卷考试', '经常点名，作业很多', '内容充实，学到很多，但是作业量很大'),
  row('高等数学（上）', '张三', 90, '闭卷考试', '每节课都点名', '老师认真负责，就是作业太多了'),
  row('高等数学（上）', '张三', 88, '闭卷考试', '经常点名，有平时作业', '给分不错，任务量比较大'),
  row('高等数学（上）', '张三', 96, '闭卷考试', '每次都点名', '干货满满，老师很好，给分超高'),
  row('高等数学（上）', '张三', 91, '闭卷考试', '经常点名', '很硬核的课，收获很大，压力也大'),
  row('高等数学（上）', '张三', 85, '闭卷考试', '抽查点名，作业多', '难度不低，作业多，但老师负责'),
  row('高等数学（上）', '张三', 94, '闭卷考试', '每节课都点名', '强烈推荐，给分好，老师人很nice'),
  row('高等数学（上）', '张三', 89, '闭卷考试', '经常点名', '作业确实多，但学到很多'),
  row('高等数学（上）', '张三', 93, '闭卷考试', '点名频繁', '知识点扎实，给分大方'),
  row('高等数学（上）', '张三', 97, '闭卷考试', '每节课都点名', '神仙老师，给分超好'),
  row('高等数学（上）', '张三', 90, '闭卷考试', '偶尔点名', '整体不错，任务量中等偏上'),
];

// ---------------------------------------------------------------------------
// 高等数学（上） / 李四 — same course name, DIFFERENT teacher: the matcher must
// not silently merge these, and the teacher penalty must apply. 4 rows.
// ---------------------------------------------------------------------------
const advancedMathOtherTeacher = [
  row('高等数学（上）', '李四', 72, '闭卷考试，平时分占比低', '经常点名', '给分很低，压分严重，建议避雷'),
  row('高等数学（上）', '李四', 68, '闭卷考试', '每节课都点名', '不推荐，给分差，态度也不好'),
  row('高等数学（上）', '李四', 75, '闭卷考试', '经常点名', '教师要求高，学不到什么'),
  row('高等数学（上）', '李四', 70, '闭卷考试', '点名频繁', '很坑，分数低，不建议选'),
];

// ---------------------------------------------------------------------------
// 乒乓球（初级） / 钱七 — the "水课" archetype: no attendance, no homework,
// generous grades. 8 rows.
// ---------------------------------------------------------------------------
const pingPong = [
  row('乒乓球（初级）', '钱七', 96, '接发球，正反手，各30个', '从不点名，没有作业', '好喜欢老师，给分巨好', '体育课'),
  row('乒乓球（初级）', '钱七', 95, '技术考核', '无考勤，无作业', '很水很轻松，推荐，给分超好', '体育课'),
  row('乒乓球（初级）', '钱七', 98, '技术考核', '不点名，不用签到', '神仙课，强烈推荐，事儿少', '体育课'),
  row('乒乓球（初级）', '钱七', 94, '技术考核', '不查考勤', '轻松有趣，老师很幽默，给分大方', '体育课'),
  row('乒乓球（初级）', '钱七', 92, '技术考核', '几乎不点名', '很nice的老师，课程轻松，好评', '体育课'),
  row('乒乓球（初级）', '钱七', 97, '技术考核', '从不点名，没有平时作业', '宝藏课程，给分高，强烈推荐', '体育课'),
  row('乒乓球（初级）', '钱七', 93, '技术考核', '无考勤', '喜欢，很轻松，收获也不错', '体育课'),
  row('乒乓球（初级）', '钱七', 99, '技术考核', '不点名', '给分特别好，老师耐心，推荐', '体育课'),
];

// ---------------------------------------------------------------------------
// 数据结构 / 赵六 — tiny sample (2 usable grades) plus sentinel/outlier grades, to
// prove confidence stays low and the parser rejects garbage. The teacher matches
// the selection-page fixture so the end-to-end match resolves.
// ---------------------------------------------------------------------------
const dataStructures = [
  row('数据结构', '赵六', 88, '闭卷考试 + 大作业', '偶尔点名，有实验报告', '硬核课程，作业量大，但很值得'),
  row('数据结构', '赵六', 45, '闭卷考试', '经常点名', '挂科率有点高，避雷'),
  row('数据结构', '赵六', null, '闭卷考试', '偶尔点名', '课程内容不错，就是难'),
  row('数据结构', '赵六', 1270000000000000000, '闭卷考试', '偶尔点名', '数据异常行，成绩字段是脏数据'),
  row('数据结构', '赵六', -1, '闭卷考试', '偶尔点名', '另一个异常成绩'),
];

// ---------------------------------------------------------------------------
// 中国近现代史纲要 / 王五 — no explicit attendance keywords at all, so the
// attendance dimension must be absent (not scored as 0). 3 rows.
// ---------------------------------------------------------------------------
const history = [
  row('中国近现代史纲要', '王五', 90, '论文', '按要求完成即可', '老师讲得很有意思，给分不错', '公共课（高数、线代、大物和思政课等）'),
  row('中国近现代史纲要', '王五', 89, '论文', '按课堂要求完成', '内容翔实，推荐', '公共课（高数、线代、大物和思政课等）'),
  row('中国近现代史纲要', '王五', 91, '读书报告', '按课堂要求完成', '很不错的一门课', '公共课（高数、线代、大物和思政课等）'),
];

// The selection-page fixture marks 大学英语（三）as already selected, so a review
// group for it proves the eligibility stage — not a missing match — is what keeps
// it out of the ranking.
const english = [
  row('大学英语（三）', '孙八', 91, '闭卷考试', '偶尔点名，有平时作业', '老师很负责，给分不错'),
  row('大学英语（三）', '孙八', 89, '闭卷考试', '经常点名', '还不错，推荐'),
  row('大学英语（三）', '孙八', 93, '闭卷考试', '偶尔点名', '给分挺好，老师耐心'),
];

const allRows = [
  ...advancedMath,
  ...advancedMathOtherTeacher,
  ...pingPong,
  ...dataStructures,
  ...history,
  ...english,
];

writeFileSync(`${outDir}/search-all.json`, JSON.stringify(allRows));
writeFileSync(`${outDir}/search-advanced-math.json`, JSON.stringify(advancedMath));
writeFileSync(`${outDir}/search-advanced-math-other-teacher.json`, JSON.stringify(advancedMathOtherTeacher));
writeFileSync(`${outDir}/search-pingpong.json`, JSON.stringify(pingPong));
writeFileSync(`${outDir}/search-datastructures.json`, JSON.stringify(dataStructures));
writeFileSync(`${outDir}/search-history.json`, JSON.stringify(history));
writeFileSync(`${outDir}/search-english.json`, JSON.stringify(english));
writeFileSync(`${outDir}/search-empty.json`, 'null');
writeFileSync(`${outDir}/search-empty-array.json`, '[]');

console.log(`wrote fixtures: total rows = ${allRows.length}`);
console.log(`  advancedMath=${advancedMath.length} otherTeacher=${advancedMathOtherTeacher.length}`);
console.log(`  pingPong=${pingPong.length} dataStructures=${dataStructures.length}`);
console.log(`  history=${history.length} english=${english.length}`);
