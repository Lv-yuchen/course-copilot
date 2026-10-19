import {normalizeCourseName as normalize} from './vendor/engine.mjs';
// 明确别名按完整名称匹配；不使用包含关系吞并进阶课、实验课或不同等级课程。
const aliases=new Map([
 ['大物','大学物理'],['大学物理','大学物理'],['大学物理B','大学物理'],['大学物理B(一)','大学物理'],['大学物理B(二)','大学物理'],
 ['大英','大学英语'],['大学英语','大学英语'],
 ['有机','有机化学'],['有机化学','有机化学'],
].map(([alias,name])=>[normalize(alias),name]));
export function canonicalCourseName(name){const text=String(name||'').trim();return aliases.get(normalize(text))||text;}
export function courseKey(name){return normalize(canonicalCourseName(name));}
