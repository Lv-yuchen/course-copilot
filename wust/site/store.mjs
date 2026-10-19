import {extractGradeReferences} from './public/grade-reference.mjs';
import {canonicalCourseName,courseKey as normalizeCourseName} from './course-names.mjs';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import {normalizeTeacherName as normalizeSingleTeacher} from './vendor/engine.mjs';
const gradeReferenceStats=reviews=>{const vals=reviews.map(r=>extractGradeReferences(r.content).map(v=>v.value)).filter(v=>v.length).map(v=>v.reduce((a,b)=>a+b,0)/v.length);return {gradeReferenceCount:vals.length,gradeReferenceMean:vals.length?vals.reduce((a,b)=>a+b,0)/vals.length:null,gradeReferenceDistribution:[['90–100分',90,101],['80–90分',80,90],['70–80分',70,80],['60–70分',60,70],['60分以下',0,60]].map(([label,low,high])=>({label,count:vals.filter(v=>v>=low&&v<high).length}))};};
const catalogMode=(rows,fallback='unknown')=>{const modes=[...new Set(rows.map(r=>r.mode).filter(Boolean))];return modes.length>1?'mixed':modes[0]||fallback;};
const normalizeTeacherName=value=>String(value||'').split(/[、,，/\\;；&+\n\r]/u).map(normalizeSingleTeacher).filter(Boolean).join('、');
import {classifyDelivery} from './vendor/delivery-mode.mjs';

export function validateSubmission(value){
 const v={};
 for(const key of ['courseName','teacher','category','mode','term','content','attendance','workload','assessment','attendanceType','workloadType','assessmentType','gradeStatus']){
  v[key]=typeof value?.[key]==='string'?value[key].trim():'';
  if(!['content','attendance','workload','assessment'].includes(key)&&v[key].length>120)throw new Error('字段内容过长。');
 }
 for(const [key,label] of [['courseName','课程名称'],['teacher','授课教师'],['content','评价正文'],['attendance','考勤情况'],['workload','作业情况'],['assessment','考核方式'],['term','修读学期']])if(!v[key])throw new Error(`请填写${label}。`);
 if(['毛习马','模电和数电','体育'].includes(v.courseName))throw new Error('请填写具体课程名称，不要使用历史组合课程或大类名称。');
 if(!['公选课','公共课','专业课','体育课','其他'].includes(v.category))throw new Error('请选择课程属性。');
 if(!['online','offline','mixed','unknown'].includes(v.mode))throw new Error('请选择授课方式。');
 for(const key of ['recommendation','difficulty','workloadLevel']){const n=Number(value[key]);if(!Number.isInteger(n)||n<1||n>5)throw new Error('请完整选择推荐程度、课程难度和作业量。');v[key]=n;}
 for(const [key,options] of Object.entries({attendanceType:['无考勤','偶尔点名','经常点名','每次签到','其他'],workloadType:['无作业','课后习题','论文报告','小组任务','实验实践','其他'],assessmentType:['无期末考核','闭卷考试','开卷考试','论文报告','展示答辩','实践考核','多种方式','其他']}))if(!options.includes(v[key]))throw new Error('请选择考勤、作业和考核方式。');
 if(!['graded','pending'].includes(v.gradeStatus))throw new Error('请选择成绩状态。');
 if(v.gradeStatus==='graded'&&(value.grade===undefined||value.grade===null||String(value.grade).trim()===''))throw new Error('已出分必须填写精确成绩。');
 if(v.gradeStatus==='pending'&&value.grade!==undefined&&value.grade!==null&&String(value.grade).trim()!=='')throw new Error('未出分请留空成绩。');
 if(value.grade!==undefined&&value.grade!==null&&String(value.grade).trim()!==''){
  if(!['number','string'].includes(typeof value.grade))throw new Error('成绩格式无效。');
  const n=Number(value.grade);if(!Number.isFinite(n)||n<0||n>100)throw new Error('自报成绩应在 0 至 100 之间。');v.grade=String(n);
 }
 return v;
}

export class Store{
 constructor(path){
  this.db=new DatabaseSync(path);this.db.exec(`PRAGMA journal_mode=WAL;
   CREATE TABLE IF NOT EXISTS courses (id INTEGER PRIMARY KEY,name TEXT NOT NULL,norm TEXT UNIQUE NOT NULL,code TEXT,category TEXT DEFAULT '待确认',mode TEXT DEFAULT 'unknown',location TEXT DEFAULT '',campus TEXT DEFAULT '',published INTEGER DEFAULT 0);
   CREATE TABLE IF NOT EXISTS reviews (id INTEGER PRIMARY KEY,course_id INTEGER NOT NULL,teacher TEXT DEFAULT '',teacher_norm TEXT DEFAULT '',term TEXT DEFAULT '',content TEXT NOT NULL,attendance TEXT DEFAULT '',workload TEXT DEFAULT '',assessment TEXT DEFAULT '',grade TEXT,source TEXT NOT NULL,provenance TEXT DEFAULT '',status TEXT NOT NULL DEFAULT 'pending',created_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY,value TEXT);
   CREATE TABLE IF NOT EXISTS course_redirects (old_id INTEGER PRIMARY KEY,new_id INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS review_course_status ON reviews(course_id,status);`);
  this.db.exec(`CREATE TABLE IF NOT EXISTS catalog_classes(id INTEGER PRIMARY KEY,source_key TEXT UNIQUE NOT NULL,course_id INTEGER NOT NULL,teacher TEXT NOT NULL,teacher_norm TEXT NOT NULL,term TEXT NOT NULL,class_name TEXT NOT NULL,data TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS catalog_course_teacher ON catalog_classes(course_id,teacher_norm);
   CREATE TABLE IF NOT EXISTS notifications(id INTEGER PRIMARY KEY,owner_hash TEXT NOT NULL,review_id INTEGER,title TEXT NOT NULL,content TEXT NOT NULL,kind TEXT NOT NULL,created_at TEXT NOT NULL,read_at TEXT);
   CREATE INDEX IF NOT EXISTS notification_owner ON notifications(owner_hash,id);
   CREATE TABLE IF NOT EXISTS notice_reads(recipient TEXT NOT NULL,notice_key TEXT NOT NULL,PRIMARY KEY(recipient,notice_key));
   CREATE TABLE IF NOT EXISTS review_checks(review_id INTEGER PRIMARY KEY,checked_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS review_owners(review_id INTEGER PRIMARY KEY,owner_hash TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS reports(id INTEGER PRIMARY KEY,review_id INTEGER NOT NULL,reason TEXT NOT NULL,detail TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open',created_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS review_actions(id INTEGER PRIMARY KEY,review_id INTEGER NOT NULL,action TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL);`);
  if(!this.db.prepare("SELECT value FROM settings WHERE key='full_teacher_keys'").get()){this.db.exec('BEGIN');try{for(const r of this.db.prepare('SELECT id,teacher FROM reviews').all())this.db.prepare('UPDATE reviews SET teacher_norm=? WHERE id=?').run(normalizeTeacherName(r.teacher),r.id);this.db.prepare("INSERT INTO settings VALUES ('full_teacher_keys','1')").run();this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}}
  this.mergeCourseAliases();
 }
 mergeCourseAliases(){
  this.db.exec('BEGIN');try{
   for(const row of this.db.prepare('SELECT * FROM courses ORDER BY id').all()){
    if(!this.db.prepare('SELECT id FROM courses WHERE id=?').get(row.id))continue;
    const name=canonicalCourseName(row.name),norm=normalizeCourseName(name);const target=this.db.prepare('SELECT * FROM courses WHERE norm=? AND id<>?').get(norm,row.id);
    if(target){
     this.db.prepare('UPDATE reviews SET course_id=? WHERE course_id=?').run(target.id,row.id);this.db.prepare('UPDATE catalog_classes SET course_id=? WHERE course_id=?').run(target.id,row.id);
     this.db.prepare("UPDATE courses SET name=?,published=MAX(published,?),category=CASE WHEN category='待确认' THEN ? ELSE category END,mode=CASE WHEN mode='unknown' THEN ? ELSE mode END WHERE id=?").run(name,row.published,row.category,row.mode,target.id);
     this.db.prepare('UPDATE course_redirects SET new_id=? WHERE new_id=?').run(target.id,row.id);
     this.db.prepare('INSERT OR REPLACE INTO course_redirects(old_id,new_id) VALUES (?,?)').run(row.id,target.id);
     this.db.prepare('DELETE FROM courses WHERE id=?').run(row.id);
    }else this.db.prepare('UPDATE courses SET name=?,norm=? WHERE id=?').run(name,norm,row.id);
   }
   this.db.exec('COMMIT');
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 resolveCourseId(id){return this.db.prepare('SELECT new_id FROM course_redirects WHERE old_id=?').get(id)?.new_id||id;}
 close(){this.db.close();}
 course(name){name=canonicalCourseName(name);const norm=normalizeCourseName(name);this.db.prepare('INSERT OR IGNORE INTO courses(name,norm) VALUES (?,?)').run(name,norm);return this.db.prepare('SELECT * FROM courses WHERE norm=?').get(norm);}
 insert(v,status,source,provenance=''){
  const c=this.course(v.courseName);if(status==='approved')this.db.prepare('UPDATE courses SET published=1 WHERE id=?').run(c.id);return Number(this.db.prepare(`INSERT INTO reviews(course_id,teacher,teacher_norm,term,content,attendance,workload,assessment,grade,source,provenance,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(c.id,v.teacher||'',normalizeTeacherName(v.teacher||''),v.term||'',v.content,v.attendance||'',v.workload||'',v.assessment||'',v.grade??null,source,provenance,status,new Date().toISOString()).lastInsertRowid);
 }
 seed(reviewFile,courseFile){
  if(this.db.prepare("SELECT value FROM settings WHERE key='seeded'").get())return;
  const data=JSON.parse(fs.readFileSync(reviewFile,'utf8')),snapshot=JSON.parse(fs.readFileSync(courseFile,'utf8'));
  this.db.exec('BEGIN');
  try{
   for(const r of data.rows)this.insert(r,'approved','Excel 历史导入',JSON.stringify({file:data.sourceFile,sheet:r.sourceSheet,row:r.sourceRow,column:r.sourceColumn}));
   const byName=new Map();for(const c of snapshot.courses){const k=normalizeCourseName(c.courseName);const list=byName.get(k)||[];list.push(c);byName.set(k,list);}
   for(const rows of byName.values()){
    const r=rows[0],c=this.course(r.courseName),modes=new Set(rows.map(classifyDelivery).map(c=>c.mode));
    this.db.prepare('UPDATE courses SET published=1,code=?,category=?,mode=?,location=?,campus=? WHERE id=?').run(r.courseCode||'', '公选课',modes.size===1?[...modes][0]:'mixed',[...new Set(rows.map(x=>x.location))].join('\n'),r.campus||'',c.id);
   }
   this.db.prepare("INSERT INTO settings(key,value) VALUES ('seeded','1')").run();this.db.exec('COMMIT');
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 importCatalog(file){const data=JSON.parse(fs.readFileSync(file,'utf8'));if(!data.dataset||!Array.isArray(data.rows))throw new Error('课程清单格式错误。');const baseline=new Set([...this.db.prepare('SELECT c.norm,r.teacher_norm FROM reviews r JOIN courses c ON c.id=r.course_id').all(),...this.db.prepare('SELECT c.norm,r.teacher_norm FROM catalog_classes r JOIN courses c ON c.id=r.course_id').all()].map(r=>r.norm+'\0'+r.teacher_norm));let added=0,skipped=0,newCourses=0;this.db.exec('BEGIN');try{for(const r of data.rows){if(!r.courseName||!r.term||!r.className||!['online','offline'].includes(r.mode))throw new Error('课程清单字段缺失。');const key=data.dataset+':'+r.sourceSheet+':'+r.sourceRow,norm=normalizeCourseName(r.courseName),existing=this.db.prepare('SELECT * FROM courses WHERE norm=?').get(norm);if(data.addOnly&&(this.db.prepare('SELECT 1 FROM catalog_classes WHERE source_key=?').get(key)||baseline.has(norm+'\0'+normalizeTeacherName(r.teacher)))){if(data.fillMissing&&existing){for(const old of this.db.prepare('SELECT source_key,data FROM catalog_classes WHERE course_id=? AND teacher_norm=?').all(existing.id,normalizeTeacherName(r.teacher))){const saved=JSON.parse(old.data);let changed=false;for(const field of ['college','credits','hours','nature','attribute','courseCategory','description'])if(!saved[field]&&r[field]){saved[field]=r[field];changed=true;}if(changed)this.db.prepare('UPDATE catalog_classes SET data=? WHERE source_key=?').run(JSON.stringify(saved),old.source_key);}}skipped++;continue;}const c=this.course(r.courseName);if(!existing)newCourses++;added++;this.db.prepare('INSERT INTO catalog_classes(source_key,course_id,teacher,teacher_norm,term,class_name,data) VALUES (?,?,?,?,?,?,?) ON CONFLICT(source_key) DO UPDATE SET course_id=excluded.course_id,teacher=excluded.teacher,teacher_norm=excluded.teacher_norm,term=excluded.term,class_name=excluded.class_name,data=excluded.data').run(key,c.id,r.teacher||'',normalizeTeacherName(r.teacher),r.term,r.className,JSON.stringify({...r,sourceFile:data.sourceFile,sourceTitle:data.title}));if(!data.addOnly||!existing)this.db.prepare("UPDATE courses SET published=1,code=CASE WHEN code IS NULL OR code='' THEN ? ELSE code END,category=?,mode=?,campus=CASE WHEN campus='' THEN ? ELSE campus END WHERE id=?").run(r.courseCode||'',r.siteCategory||'公选课',catalogMode(this.catalog(c.id),r.mode),r.campus||'',c.id);}this.db.exec('COMMIT');return data.addOnly?{added,skipped,newCourses}:{classes:data.rows.length,courses:new Set(data.rows.map(r=>normalizeCourseName(r.courseName))).size};}catch(e){this.db.exec('ROLLBACK');throw e;}}
 catalog(id){return this.db.prepare('SELECT * FROM catalog_classes WHERE course_id=? ORDER BY term DESC,id').all(id).map(r=>({...JSON.parse(r.data),teacherKey:r.teacher_norm}));}
 stats(){return {courses:this.db.prepare('SELECT count(*) n FROM courses WHERE published=1').get().n,reviews:this.db.prepare("SELECT count(*) n FROM reviews WHERE status='approved'").get().n,teachers:this.db.prepare("SELECT count(DISTINCT teacher_norm) n FROM reviews WHERE status='approved' AND teacher_norm<>''").get().n,pending:this.pending().length};}
 search(params){
  const course=normalizeCourseName(params.get('course')||''),teacher=normalizeTeacherName(params.get('teacher')||'');
  const category=params.get('category')||'',mode=params.get('mode')||'';let page=Math.max(1,Math.min(10000,parseInt(params.get('page')||'1',10)||1));
  let where=' WHERE c.published=1';const args=[];
  if(course){where+=' AND instr(c.norm,?)>0';args.push(course);}
  if(teacher){where+=" AND (EXISTS (SELECT 1 FROM reviews rr WHERE rr.course_id=c.id AND rr.status='approved' AND instr(rr.teacher_norm,?)>0) OR EXISTS (SELECT 1 FROM catalog_classes cc WHERE cc.course_id=c.id AND instr(cc.teacher_norm,?)>0))";args.push(teacher,teacher);}
  if(category){where+=' AND c.category=?';args.push(category);}if(mode){where+=" AND (c.mode=? OR EXISTS (SELECT 1 FROM catalog_classes cm WHERE cm.course_id=c.id AND json_extract(cm.data,'$.mode')=?))";args.push(mode,mode);}
  const total=this.db.prepare('SELECT count(*) n FROM courses c'+where).get(...args).n;
  page=Math.min(page,Math.max(1,Math.ceil(total/12)));
  const courses=this.db.prepare('SELECT c.* FROM courses c'+where+' ORDER BY (SELECT count(*) FROM reviews r WHERE r.course_id=c.id AND r.status=\'approved\') DESC,c.name LIMIT 12 OFFSET ?').all(...args,(page-1)*12).map(c=>{
   const reviews=this.approved(c.id).filter(r=>!teacher||r.teacher_norm.includes(teacher));const teachers=[...new Set(reviews.map(r=>r.teacher).filter(Boolean))];const grades=reviews.filter(r=>r.grade!==null&&r.grade!=='').map(r=>Number(r.grade));
   return {...c,reviewCount:reviews.length,teachers,...gradeReferenceStats(reviews),gradeCount:grades.length,meanGrade:grades.length?grades.reduce((a,b)=>a+b,0)/grades.length:null};
  });return {courses,total,page,pages:Math.max(1,Math.ceil(total/12))};
 }
 applyDeliveryRules(){this.db.exec('BEGIN');try{this.db.prepare("INSERT OR REPLACE INTO settings VALUES ('authoritative_delivery','1')").run();for(const c of this.db.prepare('SELECT * FROM courses').all()){const catalog=this.catalog(c.id),reviews=this.approved(c.id),modes=new Set(catalog.map(r=>r.mode));for(const r of reviews)modes.add(this.reviewDelivery(r,catalog));if(!modes.size)modes.add('offline');this.db.prepare('UPDATE courses SET mode=? WHERE id=?').run(modes.size>1?'mixed':[...modes][0],c.id);}this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}}
 reviewDelivery(r,catalog){let meta={};try{meta=JSON.parse(r.provenance||'{}');}catch{}return r.source==='学生投稿'&&meta.mode==='online'&&catalog.some(c=>c.mode==='online')?'online':'offline';}
 splitOfferings(params){const teacher=normalizeTeacherName(params.get('teacher')||''),mode=params.get('mode')||'';const query=new URLSearchParams({...Object.fromEntries(params),mode:'',page:'1'}),first=this.search(query),rows=[];for(let page=1;page<=first.pages;page++){query.set('page',String(page));for(const c of this.search(query).courses){const catalog=this.catalog(c.id),groups=new Map();const group=(key,delivery,name)=>{const id=key+'\0'+delivery;if(!groups.has(id))groups.set(id,{key,delivery,name,reviews:[],catalog:[]});return groups.get(id);};for(const r of catalog)if(!teacher||r.teacherKey.includes(teacher))group(r.teacherKey,r.mode,r.teacher).catalog.push(r);for(const r of this.approved(c.id))if(!teacher||r.teacher_norm.includes(teacher))group(r.teacher_norm,this.reviewDelivery(r,catalog),r.teacher).reviews.push(r);if(!groups.size&&!teacher&&!catalog.length)group('','offline','');for(const g of groups.values()){if(mode&&g.delivery!==mode)continue;const grades=g.reviews.filter(r=>r.grade!==null&&r.grade!=='').map(r=>Number(r.grade));rows.push({id:c.id,name:c.name,category:c.category,mode:g.delivery,teacher:g.name,teacherKey:g.key,catalogCount:g.catalog.length,reviewCount:g.reviews.length,...gradeReferenceStats(g.reviews),gradeCount:grades.length,meanGrade:grades.length>=1?grades.reduce((a,b)=>a+b,0)/grades.length:null});}}}rows.sort((a,b)=>b.reviewCount-a.reviewCount||a.name.localeCompare(b.name,'zh-CN')||a.teacher.localeCompare(b.teacher,'zh-CN'));const pages=Math.max(1,Math.ceil(rows.length/12)),page=Math.min(pages,Math.max(1,parseInt(params.get('page')||'1')||1));return {courses:rows.slice((page-1)*12,page*12),total:rows.length,page,pages};}
 offerings(params){
  if(this.db.prepare("SELECT value FROM settings WHERE key='authoritative_delivery'").get())return this.splitOfferings(params);
  const teacher=normalizeTeacherName(params.get('teacher')||''),mode=params.get('mode')||'';const all=this.search(new URLSearchParams({...Object.fromEntries(params),page:'1'}));
  const rows=[];for(let page=1;page<=all.pages;page++)for(const c of this.search(new URLSearchParams({...Object.fromEntries(params),page:String(page)})).courses){
   const groups=new Map();for(const r of this.approved(c.id)){if(teacher&&!r.teacher_norm.includes(teacher))continue;if(!groups.has(r.teacher_norm))groups.set(r.teacher_norm,[]);groups.get(r.teacher_norm).push(r);}
   const catalog=this.catalog(c.id);for(const r of catalog){if(teacher&&!r.teacherKey.includes(teacher))continue;if(!groups.has(r.teacherKey))groups.set(r.teacherKey,[]);}if(!groups.size&&!teacher)groups.set('',[]);
   for(const [teacherKey,reviews] of groups){const scopedCatalog=catalog.filter(r=>r.teacherKey===teacherKey),delivery=catalogMode(scopedCatalog,c.mode);if(mode&&delivery!==mode&&!scopedCatalog.some(r=>r.mode===mode))continue;const grades=reviews.filter(r=>r.grade!==null&&r.grade!=='').map(r=>Number(r.grade));rows.push({id:c.id,name:c.name,category:c.category,mode:delivery,teacher:reviews[0]?.teacher||catalog.find(r=>r.teacherKey===teacherKey)?.teacher||'',teacherKey,catalogCount:catalog.filter(r=>r.teacherKey===teacherKey).length,reviewCount:reviews.length,...gradeReferenceStats(reviews),gradeCount:grades.length,meanGrade:grades.length>=1?grades.reduce((a,b)=>a+b,0)/grades.length:null});}
  }
  rows.sort((a,b)=>b.reviewCount-a.reviewCount||a.name.localeCompare(b.name,'zh-CN')||a.teacher.localeCompare(b.teacher,'zh-CN'));
  const pages=Math.max(1,Math.ceil(rows.length/12)),page=Math.min(pages,Math.max(1,parseInt(params.get('page')||'1')||1));return {courses:rows.slice((page-1)*12,page*12),total:rows.length,page,pages};
 }
 courseOptions(){return this.db.prepare('SELECT id,name FROM courses WHERE published=1').all().sort((a,b)=>a.name.localeCompare(b.name,'zh-CN'));}
 groupedCourses(params){
  const first=this.offerings(new URLSearchParams({...Object.fromEntries(params),page:'1'}));const groups=new Map();
  for(let page=1;page<=first.pages;page++)for(const offering of (page===1?first:this.offerings(new URLSearchParams({...Object.fromEntries(params),page:String(page)}))).courses){
   const groupKey=offering.id+(this.db.prepare("SELECT value FROM settings WHERE key='authoritative_delivery'").get()?':'+offering.mode:'');if(!groups.has(groupKey))groups.set(groupKey,{id:offering.id,name:offering.name,category:offering.category,mode:offering.mode,reviewCount:0,teachers:[]});const group=groups.get(groupKey);group.teachers.push(offering);group.reviewCount+=offering.reviewCount;if(group.mode!==offering.mode)group.mode='mixed';
  }
  const courses=[...groups.values()].sort((a,b)=>b.reviewCount-a.reviewCount||a.name.localeCompare(b.name,'zh-CN'));const pages=Math.max(1,Math.ceil(courses.length/12)),page=Math.min(pages,Math.max(1,parseInt(params.get('page')||'1')||1));return {courses:courses.slice((page-1)*12,page*12),total:courses.length,page,pages};
 }
 offeringDetails(id,teacherKey,term='',delivery=''){id=this.resolveCourseId(id);
  const c=this.db.prepare('SELECT * FROM courses WHERE id=? AND published=1').get(id);if(!c)return null;
  const allCatalog=this.catalog(id),allReviews=this.approved(id),split=!!this.db.prepare("SELECT value FROM settings WHERE key='authoritative_delivery'").get();if(split&&!['online','offline'].includes(delivery))delivery=allReviews.some(r=>r.teacher_norm===teacherKey&&this.reviewDelivery(r,allCatalog)==='offline')?'offline':allCatalog.find(r=>r.teacherKey===teacherKey)?.mode||'offline';const catalog=allCatalog.filter(r=>r.teacherKey===teacherKey&&(!split||r.mode===delivery));const scoped=allReviews.filter(r=>r.teacher_norm===teacherKey&&(!split||this.reviewDelivery(r,allCatalog)===delivery));if(teacherKey&&!scoped.length&&!catalog.length)return null;
  const reviews=scoped.filter(r=>!term||r.term===term);const metas=reviews.map(r=>{try{return JSON.parse(r.provenance||'{}');}catch{return {};}});
  const metrics={};for(const key of ['recommendation','difficulty','workloadLevel']){const values=metas.map(m=>m[key]).filter(n=>Number.isInteger(n)&&n>=1&&n<=5);metrics[key]={count:values.length,mean:values.length?values.reduce((a,b)=>a+b,0)/values.length:null};}
  const overview={};for(const key of ['attendanceType','workloadType','assessmentType']){overview[key]={};for(const m of metas)if(m[key])overview[key][m[key]]=(overview[key][m[key]]||0)+1;}
  const grades=reviews.filter(r=>r.grade!==null&&r.grade!=='').map(r=>Number(r.grade)).filter(Number.isFinite).sort((a,b)=>a-b);const stats={count:grades.length,minimumSamples:1,available:grades.length>=1};
  if(stats.available){const mean=grades.reduce((a,b)=>a+b,0)/grades.length;Object.assign(stats,{mean,median:(grades[Math.floor((grades.length-1)/2)]+grades[Math.floor(grades.length/2)])/2,deviation:Math.sqrt(grades.reduce((a,b)=>a+(b-mean)**2,0)/grades.length),distribution:[{label:'低于60',min:0,max:60},{label:'60–69',min:60,max:70},{label:'70–79',min:70,max:80},{label:'80–89',min:80,max:90},{label:'90–100',min:90,max:101}].map(b=>({label:b.label,count:grades.filter(n=>n>=b.min&&n<b.max).length}))});}
  const selectedCatalog=catalog.filter(r=>!term||r.term===term);const ownDescriptions=[...new Set(selectedCatalog.map(r=>r.description).filter(Boolean))],fallbackDescriptions=[...new Set(allCatalog.filter(r=>(!term||r.term===term)&&(split?r.mode===delivery:(!catalog.length||catalog.some(c=>c.mode===r.mode)))).map(r=>r.description).filter(Boolean))];return {...c,mode:split?delivery:catalogMode(selectedCatalog,catalogMode(catalog,c.mode)),catalog:selectedCatalog,descriptions:ownDescriptions.length?ownDescriptions:fallbackDescriptions,descriptionScope:ownDescriptions.length?'本教学班清单简介':'同课程其他教学班清单简介',teacher:scoped[0]?.teacher||catalog[0]?.teacher||'',teacherKey,...gradeReferenceStats(reviews),terms:[...new Set(scoped.map(r=>r.term).filter(Boolean))].sort().reverse(),term,metrics,overview,gradeStats:stats,reviews:reviews.map((r,i)=>{const {grade,provenance,...safe}=r;return {...safe,provenance,fields:metas[i]};})};
 }
 approved(id){return this.db.prepare("SELECT * FROM reviews WHERE course_id=? AND status='approved' ORDER BY id DESC").all(id);}
 details(id,teacher=''){id=this.resolveCourseId(id);const c=this.db.prepare('SELECT * FROM courses WHERE id=? AND published=1').get(id);if(!c)return null;return {...c,reviews:this.approved(id).filter(r=>!teacher||r.teacher_norm.includes(normalizeTeacherName(teacher)))};}
 providerRows(name){const c=this.db.prepare('SELECT * FROM courses WHERE norm=?').get(normalizeCourseName(name));if(!c)return [];return this.approved(c.id).map(r=>({courseName:c.name,teacher:r.teacher||undefined,content:[r.content,r.attendance,r.workload,r.assessment].filter(Boolean).join('\n'),grade:r.grade??undefined}));}
 pending(){return this.db.prepare("SELECT r.*,c.name AS courseName FROM reviews r JOIN courses c ON c.id=r.course_id WHERE r.status='pending' OR (r.status='approved' AND r.source='学生投稿' AND NOT EXISTS (SELECT 1 FROM review_checks k WHERE k.review_id=r.id)) ORDER BY r.id DESC").all().map(r=>({...r,canNotify:!!this.db.prepare('SELECT 1 FROM review_owners WHERE review_id=?').get(r.id)}));}
 publish(id){const r=this.db.prepare("SELECT * FROM reviews WHERE id=? AND status='pending'").get(id);if(!r)return false;this.db.prepare("UPDATE reviews SET status='approved' WHERE id=?").run(id);this.db.prepare('UPDATE courses SET published=1 WHERE id=?').run(r.course_id);return true;}
 moderate(id,status){const r=this.pending().find(r=>r.id===id);if(!r||!['approved','rejected'].includes(status))return false;if(r.status==='approved'&&status!=='approved')return false;this.db.exec('BEGIN');try{this.db.prepare('UPDATE reviews SET status=? WHERE id=?').run(status,id);this.db.prepare('INSERT OR REPLACE INTO review_checks VALUES (?,?)').run(id,new Date().toISOString());this.action(id,status==='approved'?'check':'reject',status==='approved'?'管理员确认保留':'不予发布');this.notifyReview(id,status==='approved'?'评价复核通过':'评价未予发布',status==='approved'?'管理员已确认保留你的评价。':'管理员未予发布这条待审核评价。',status==='approved'?'approved':'rejected');if(status==='approved')this.db.prepare('UPDATE courses SET published=1 WHERE id=?').run(r.course_id);this.db.exec('COMMIT');return true;}catch(e){this.db.exec('ROLLBACK');throw e;}}

 submit(value){const v=validateSubmission(value);const id=this.insert(v,'pending','学生投稿',JSON.stringify({category:v.category,mode:v.mode,recommendation:v.recommendation,difficulty:v.difficulty,workloadLevel:v.workloadLevel,attendanceType:v.attendanceType,workloadType:v.workloadType,assessmentType:v.assessmentType,gradeStatus:v.gradeStatus}));return id;}
 applyMetadata(id){const r=this.db.prepare('SELECT * FROM reviews WHERE id=?').get(id);const meta=JSON.parse(r.provenance||'{}');if(meta.category&&meta.mode){this.db.prepare("UPDATE courses SET category=CASE WHEN category='待确认' THEN ? ELSE category END,mode=CASE WHEN mode='unknown' THEN ? ELSE mode END WHERE id=?").run(meta.category,meta.mode,r.course_id);}}
 notifyReview(id,title,content,kind){const owner=this.db.prepare('SELECT owner_hash FROM review_owners WHERE review_id=?').get(id);if(!owner)return;const r=this.db.prepare('SELECT r.teacher,c.name FROM reviews r JOIN courses c ON c.id=r.course_id WHERE r.id=?').get(id);this.db.prepare('INSERT INTO notifications(owner_hash,review_id,title,content,kind,created_at) VALUES (?,?,?,?,?,?)').run(owner.owner_hash,id,title,(r?r.name+' · '+r.teacher+'\n':'')+content,kind,new Date().toISOString());}
 notifications(hash){return this.db.prepare('SELECT id,review_id,title,content,kind,created_at,read_at FROM notifications WHERE owner_hash=? ORDER BY id DESC LIMIT 50').all(hash);}
 unread(hash){return this.db.prepare('SELECT count(*) n FROM notifications WHERE owner_hash=? AND read_at IS NULL').get(hash).n;}
 readNotifications(hash,id){return id==='all'?this.db.prepare('UPDATE notifications SET read_at=? WHERE owner_hash=? AND read_at IS NULL').run(new Date().toISOString(),hash).changes:this.db.prepare('UPDATE notifications SET read_at=? WHERE owner_hash=? AND id=? AND read_at IS NULL').run(new Date().toISOString(),hash,id).changes;}
 noticeRead(recipient,key){return !!this.db.prepare('SELECT 1 FROM notice_reads WHERE recipient=? AND notice_key=?').get(recipient,key);}
 markNotice(recipient,key){this.db.prepare('INSERT OR IGNORE INTO notice_reads VALUES (?,?)').run(recipient,key);}
 ownership(id,hash){this.db.prepare('INSERT INTO review_owners VALUES (?,?)').run(id,hash);}
 mine(hash){return this.db.prepare('SELECT r.*,c.name AS courseName FROM reviews r JOIN courses c ON c.id=r.course_id JOIN review_owners o ON o.review_id=r.id WHERE o.owner_hash=? ORDER BY r.id DESC').all(hash);}
 own(id,hash){return this.mine(hash).find(r=>r.id===id);}
 action(id,action,reason){this.db.prepare('INSERT INTO review_actions(review_id,action,reason,created_at) VALUES (?,?,?,?)').run(id,action,reason,new Date().toISOString());}
 edit(id,hash,value){const old=this.own(id,hash);if(!old||!['approved','pending'].includes(old.status))return false;const v=validateSubmission(value);const c=this.course(v.courseName);const meta=JSON.stringify(Object.fromEntries(['category','mode','recommendation','difficulty','workloadLevel','attendanceType','workloadType','assessmentType','gradeStatus'].map(k=>[k,v[k]])));
 this.db.exec('BEGIN');try{this.db.prepare('UPDATE reviews SET course_id=?,teacher=?,teacher_norm=?,term=?,content=?,attendance=?,workload=?,assessment=?,grade=?,provenance=? WHERE id=?').run(c.id,v.teacher,normalizeTeacherName(v.teacher),v.term,v.content,v.attendance,v.workload,v.assessment,v.grade??null,meta,id);if(old.status==='approved')this.db.prepare('UPDATE courses SET published=1 WHERE id=?').run(c.id);this.applyMetadata(id);this.db.prepare('DELETE FROM review_checks WHERE review_id=?').run(id);this.action(id,'edit','投稿者修改');this.notifyReview(id,'评价修改成功','修改后的评价重新进入待复核列表。','edit');this.db.exec('COMMIT');return true;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 completeGrade(id,hash,value){const r=this.own(id,hash);if(!r||!['approved','pending'].includes(r.status))return false;let meta={};try{meta=JSON.parse(r.provenance||'{}');}catch{}if(meta.gradeStatus!=='pending'||(r.grade!==null&&r.grade!==''))return false;if(!['number','string'].includes(typeof value)||String(value).trim()==='')throw new Error('请填写已出分的精确成绩。');const grade=Number(value);if(!Number.isFinite(grade)||grade<0||grade>100)throw new Error('成绩应在0至100之间。');this.db.exec('BEGIN');try{this.db.prepare('UPDATE reviews SET grade=?,provenance=? WHERE id=?').run(String(grade),JSON.stringify({...meta,gradeStatus:'graded'}),id);this.db.prepare('DELETE FROM review_checks WHERE review_id=?').run(id);this.action(id,'grade','投稿者补充已出分成绩');this.notifyReview(id,'成绩补充成功','成绩已用于聚合统计，评价重新进入待复核列表。','grade');this.db.exec('COMMIT');return true;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 withdraw(id,hash){const r=this.own(id,hash);if(!r||!['approved','pending'].includes(r.status))return false;this.db.exec('BEGIN');try{this.db.prepare("UPDATE reviews SET status='withdrawn' WHERE id=?").run(id);this.action(id,'withdraw','投稿者撤回');this.notifyReview(id,'你已撤回评价','评价不再公开展示，也不再参与统计。阅读资格保持不变。','self-withdraw');this.db.exec('COMMIT');return true;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 report(id,value){if(!this.db.prepare("SELECT id FROM reviews WHERE id=? AND status='approved'").get(id))return false;const reasons=['课程或教师错误','重复内容','个人信息','辱骂攻击','其他问题'];const reason=value?.reason,detail=typeof value?.detail==='string'?value.detail.trim():'';if(!reasons.includes(reason)||detail.length>2000||(reason==='其他问题'&&!detail))throw new Error('请选择原因；其他问题请填写说明（最多2000字）。');this.db.prepare('INSERT INTO reports(review_id,reason,detail,created_at) VALUES (?,?,?,?)').run(id,reason,detail,new Date().toISOString());return true;}
 management(params){const q=(params.get('q')||'').trim(),status=params.get('status')||'approved';if(!['approved','hidden','withdrawn','pending','rejected'].includes(status))throw new Error('状态无效。');const args=[status,q,q,q];const where=" WHERE r.status=? AND (?='' OR instr(c.name,?)>0 OR instr(r.teacher,?)>0)";const total=this.db.prepare('SELECT count(*) n FROM reviews r JOIN courses c ON c.id=r.course_id'+where).get(...args).n;const pages=Math.max(1,Math.ceil(total/20)),page=Math.min(pages,Math.max(1,parseInt(params.get('page')||'1')||1));return {reviews:this.db.prepare('SELECT r.*,c.name AS courseName FROM reviews r JOIN courses c ON c.id=r.course_id'+where+' ORDER BY r.id DESC LIMIT 20 OFFSET ?').all(...args,(page-1)*20).map(r=>({...r,canNotify:!!this.db.prepare('SELECT 1 FROM review_owners WHERE review_id=?').get(r.id),actions:this.db.prepare('SELECT action,reason,created_at FROM review_actions WHERE review_id=? ORDER BY id DESC LIMIT 5').all(r.id)})),total,page,pages};}
 reports(){return this.db.prepare("SELECT p.*,r.content,r.teacher,r.status AS reviewStatus,c.name AS courseName FROM reports p JOIN reviews r ON r.id=p.review_id JOIN courses c ON c.id=r.course_id WHERE p.status='open' ORDER BY p.id DESC").all().map(r=>({...r,canNotify:!!this.db.prepare('SELECT 1 FROM review_owners WHERE review_id=?').get(r.review_id)}));}
 resolveReport(id){return this.db.prepare("UPDATE reports SET status='resolved' WHERE id=? AND status='open'").run(id).changes>0;}
 visibility(id,action,reason){const r=this.db.prepare('SELECT * FROM reviews WHERE id=?').get(id);if(!r||!(action==='hide'&&r.status==='approved'||action==='restore'&&r.status==='hidden'))return false;if(typeof reason!=='string'||!reason.trim()||reason.length>1000)throw new Error('请填写处理原因（最多1000字）。');this.db.exec('BEGIN');try{this.db.prepare('UPDATE reviews SET status=? WHERE id=?').run(action==='hide'?'hidden':'approved',id);this.db.prepare('INSERT OR REPLACE INTO review_checks VALUES (?,?)').run(id,new Date().toISOString());this.action(id,action,reason.trim());this.notifyReview(id,action==='hide'?'管理员已撤回评价展示':'管理员已恢复评价展示','处理理由：'+reason.trim(),action==='hide'?'admin-hide':'admin-restore');this.db.exec('COMMIT');return true;}catch(e){this.db.exec('ROLLBACK');throw e;}}

}
