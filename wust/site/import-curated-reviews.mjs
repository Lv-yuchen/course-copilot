import fs from 'node:fs';
import {Store} from './store.mjs';
const s=new Store('.local/reviews.sqlite'),data=JSON.parse(fs.readFileSync('data/reviews-curated-offline.json','utf8'));
if(s.db.prepare("SELECT value FROM settings WHERE key='curated_reviews_import'").get()){console.log('整理评价已导入，无需重复替换。');s.close();process.exit(0);}
const originals=s.db.prepare("SELECT * FROM reviews WHERE source='Excel 历史导入'").all();
const key=p=>JSON.stringify([p.sheet,p.row,p.column]);const bySource=new Map(originals.map(r=>[key(JSON.parse(r.provenance)),r]));
const beforeOthers=s.db.prepare("SELECT * FROM reviews WHERE source<>'Excel 历史导入' ORDER BY id").all();let removed=0;
s.db.exec('BEGIN');try{
 const keep=new Set();for(const r of data.rows){const existing=r.sources.map(p=>bySource.get(key(p))).filter(Boolean);if(!existing.length)throw Error('来源记录缺失');const survivor=existing[0];keep.add(survivor.id);const c=s.course(r.courseName);const meta={file:data.sourceFile,sheet:r.sourceSheet,row:r.sourceRow,column:r.sourceColumn,sources:r.sources,category:'公选课',mode:'offline',historyGroup:r.historyGroup,curated:true};s.db.prepare('UPDATE reviews SET course_id=?,attendance=?,workload=?,assessment=?,provenance=? WHERE id=?').run(c.id,r.attendance,r.workload,r.assessment,JSON.stringify(meta),survivor.id);s.db.prepare("UPDATE courses SET category='公选课' WHERE id=?").run(c.id);
 for(const duplicate of existing.slice(1)){for(const table of ['reports','review_actions','notifications'])s.db.prepare(`UPDATE ${table} SET review_id=? WHERE review_id=?`).run(survivor.id,duplicate.id);}}
 for(const r of originals)if(!keep.has(r.id)){for(const table of ['review_checks','review_owners'])s.db.prepare(`DELETE FROM ${table} WHERE review_id=?`).run(r.id);s.db.prepare('DELETE FROM reviews WHERE id=?').run(r.id);removed++;}
 if(JSON.stringify(beforeOthers)!==JSON.stringify(s.db.prepare("SELECT * FROM reviews WHERE source<>'Excel 历史导入' ORDER BY id").all()))throw Error('用户投稿改变');
 s.db.prepare("INSERT OR REPLACE INTO settings VALUES ('curated_reviews_import','2026-10-10')").run();s.db.exec('COMMIT');console.log(JSON.stringify({retained:data.rows.length,mergedCopies:removed,otherReviews:beforeOthers.length,stats:s.stats(),integrity:s.db.prepare('PRAGMA integrity_check').get()}));
}catch(e){s.db.exec('ROLLBACK');throw e;}finally{s.close();}
