import {normalizeCourseName,cleanRow,aggregateCleanRows,summarizeCleanRows,partitionCleanRows,selectReviewExcerpts,teacherNamesOfCourse} from './engine.mjs';
function provenance(value,sourceUrl){
  if(Array.isArray(value))return value.map(v=>provenance(v,sourceUrl));
  if(!value||typeof value!=='object')return value;
  const result={};for(const [k,v] of Object.entries(value))result[k]=k==='provider'?'wust-local-reviews':k==='sourceUrl'?sourceUrl:provenance(v,sourceUrl);
  return result;
}
export function validateLocalReviews(data){
  if(!data||!Array.isArray(data.rows))throw new Error('本地评价文件必须包含 rows 数组。');
  for(const r of data.rows){if(!r||typeof r.courseName!=='string'||!r.courseName.trim()||typeof r.content!=='string'||!r.content.trim())throw new Error('每条评价必须有课程名和正文。');if(r.teacher!==undefined&&typeof r.teacher!=='string')throw new Error('教师字段须为字符串。');if(r.grade!==undefined&&typeof r.grade!=='string')throw new Error('成绩字段须保留原始字符串。');}
  return data;
}
export class LocalWustReviewProvider{
  id='wust-local-reviews';label='武科大本地评价表';
  constructor(data){validateLocalReviews(data);this.rows=data.rows;this.homepage=data.sourceUrl||'';}
  async isAvailable(){return true;}
  async searchCourse(query){
    if(query.signal?.aborted)throw new Error('评价查询已取消。');
    // Course identity is checked FIRST; same teacher in another course is not evidence for this one.
    const rows=this.rows.filter(r=>normalizeCourseName(r.courseName)===normalizeCourseName(query.courseName));
    const cleaned=rows.map(r=>cleanRow({...r,courseName:query.courseName,provider:this.id}));
    const names=query.localTeacherNames||teacherNamesOfCourse(query.teacher);
    const partition=partitionCleanRows(cleaned,query.courseName,names);
    const related=query.teacher||names.length?partition.matched:cleaned;
    const result={provider:this.id,fromCache:false,warnings:[],reviews:aggregateCleanRows(related,{limit:query.limit||25}),reviewExcerpts:selectReviewExcerpts(partition)};
    const courseLevel=summarizeCleanRows(cleaned,query.courseName,'course');if(courseLevel)result.courseLevel=courseLevel;
    if(names.length){const teachingClassLevel=summarizeCleanRows(partition.matched,query.courseName,'teachingClass');if(teachingClassLevel)result.teachingClassLevel=teachingClassLevel;}
    const supplementary=summarizeCleanRows(partition.unassigned,query.courseName,'supplementary');if(supplementary)result.courseSupplementary=supplementary;
    if(rows.length&&!related.length)result.warnings.push('该课程有评价，但未匹配到当前教师，不能归为当前教学班评价。');
    return provenance(result,this.homepage);
  }
}
