import {randomBytes,createHash} from 'node:crypto';
export const cookieToken=req=>(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('wust_reader='))?.slice(12)||'';
const hash=token=>createHash('sha256').update(token).digest('hex');
export function freshmanPeriod(year,now=Date.now()){
 const currentYear=Number(new Intl.DateTimeFormat('en',{timeZone:'Asia/Shanghai',year:'numeric'}).format(now));
 if(!Number.isInteger(year)||year!==currentYear)throw new Error('新生通道仅面向当年入学的新生。');
 const start=Date.UTC(year,7,31,16),expires=Date.UTC(year+1,7,31,16);
 if(now<start||now>=expires)throw new Error('新生通道有效期为入学当年9月1日至次年9月1日。');
 return {start,expires};
}
export class ReaderAccess{
 constructor(store){this.db=store.db;this.db.exec('CREATE TABLE IF NOT EXISTS reader_access (token_hash TEXT PRIMARY KEY,kind TEXT NOT NULL,starts_at INTEGER NOT NULL,expires_at INTEGER,profile TEXT NOT NULL DEFAULT \'{}\')');this.db.exec(`CREATE TABLE IF NOT EXISTS reader_recovery(id INTEGER PRIMARY KEY,code_hash TEXT UNIQUE NOT NULL,kind TEXT NOT NULL,starts_at INTEGER NOT NULL,expires_at INTEGER);CREATE TABLE IF NOT EXISTS reader_links(token_hash TEXT PRIMARY KEY,recovery_id INTEGER NOT NULL);`);}
 state(token,now=Date.now()){const row=token?this.db.prepare('SELECT kind,starts_at,expires_at FROM reader_access WHERE token_hash=?').get(hash(token)):null;return {unlocked:!!row&&(row.expires_at===null||row.expires_at>now),kind:row?.kind||'visitor',expiresAt:row?.expires_at??null,hasRecovery:!!(token&&this.db.prepare('SELECT 1 FROM reader_links WHERE token_hash=?').get(hash(token)))};}
 grant(token,kind,profile={},now=Date.now()){
 const existing=this.state(token,now);if(existing.kind==='contributor')return {token,state:existing};
 let start=now,expires=null;
 if(kind==='freshman'){
  if(existing.kind==='freshman')throw new Error('当前浏览器已领取过新生权限，不能重复领取。');
  const year=Number(profile.year);({start,expires}=freshmanPeriod(year,now));
  for(const key of ['college','identity','courses'])if(typeof profile[key]!=='string'||!profile[key].trim()||profile[key].length>500)throw new Error('请完整填写学院、身份和关注课程。');
  if(!['本科新生','研究生新生','其他新生'].includes(profile.identity))throw new Error('请选择新生身份。');
  profile={year,college:profile.college.trim(),identity:profile.identity,courses:profile.courses.trim()};
 }
 const next=randomBytes(32).toString('hex');this.db.prepare('INSERT INTO reader_access(token_hash,kind,starts_at,expires_at,profile) VALUES (?,?,?,?,?)').run(hash(next),kind,start,expires,JSON.stringify(profile));
 if(token){const link=this.db.prepare('SELECT recovery_id FROM reader_links WHERE token_hash=?').get(hash(token));if(link){this.db.prepare('UPDATE reader_recovery SET kind=?,starts_at=?,expires_at=? WHERE id=?').run(kind,start,expires,link.recovery_id);this.db.prepare('UPDATE reader_access SET kind=?,starts_at=?,expires_at=? WHERE token_hash IN (SELECT token_hash FROM reader_links WHERE recovery_id=?)').run(kind,start,expires,link.recovery_id);this.db.prepare('INSERT INTO reader_links VALUES (?,?)').run(hash(next),link.recovery_id);this.db.prepare('DELETE FROM reader_links WHERE token_hash=?').run(hash(token));}this.db.prepare('DELETE FROM reader_access WHERE token_hash=?').run(hash(token));}
 return {token:next,state:this.state(next,now)};
 }
 recovery(token,now=Date.now()){
 const state=this.state(token,now);if(!state.unlocked)throw new Error('请先获得有效阅读资格。');const row=this.db.prepare('SELECT * FROM reader_access WHERE token_hash=?').get(hash(token));
 const raw=randomBytes(20).toString('hex').toUpperCase(),code='WUST-'+raw.match(/.{1,8}/g).join('-');const link=this.db.prepare('SELECT recovery_id FROM reader_links WHERE token_hash=?').get(hash(token));
 this.db.exec('BEGIN');try{if(link)this.db.prepare('UPDATE reader_recovery SET code_hash=? WHERE id=?').run(hash(code),link.recovery_id);else{const id=Number(this.db.prepare('INSERT INTO reader_recovery(code_hash,kind,starts_at,expires_at) VALUES (?,?,?,?)').run(hash(code),row.kind,row.starts_at,row.expires_at).lastInsertRowid);this.db.prepare('INSERT INTO reader_links VALUES (?,?)').run(hash(token),id);}this.db.exec('COMMIT');return {code,state};}catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 restore(value,current='',now=Date.now()){
 const code=typeof value==='string'?value.trim().toUpperCase():'';if(!/^WUST-(?:[A-F0-9]{8}-){4}[A-F0-9]{8}$/.test(code))throw new Error('恢复码无效或资格已到期。');const row=this.db.prepare('SELECT * FROM reader_recovery WHERE code_hash=?').get(hash(code));if(!row||row.starts_at>now||(row.expires_at!==null&&row.expires_at<=now))throw new Error('恢复码无效或资格已到期。');
 const existing=this.state(current,now);if(existing.unlocked&&(existing.kind==='contributor'||(row.kind==='freshman'&&existing.expiresAt>=row.expires_at)))return {token:current,state:existing};
 const next=randomBytes(32).toString('hex');this.db.exec('BEGIN');try{this.db.prepare("INSERT INTO reader_access VALUES (?,?,?,?, '{}')").run(hash(next),row.kind,row.starts_at,row.expires_at);this.db.prepare('INSERT INTO reader_links VALUES (?,?)').run(hash(next),row.id);this.db.exec('COMMIT');return {token:next,state:this.state(next,now)};}catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 cookie(token){return `wust_reader=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`;}
}
