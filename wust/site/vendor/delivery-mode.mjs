export const DELIVERY_MODES=['online','offline','mixed','unknown'];
export const DELIVERY_LABELS={online:'线上课',offline:'线下课',mixed:'线上线下混合',unknown:'授课方式待确认'};
const online=/智慧树|知到|优课联盟|超星|学习通|学堂在线|中国大学mooc|mooc|慕课|线上|在线|网络教学|网络课程|腾讯会议|雨课堂/i;
const offline=/教[一二三四五六七八九十\d]|教学楼|教室|运动场|体育馆|体育场|操场|球场|游泳馆|游泳池|田径场|健身房|实验室|实验楼|实训楼|实训室|报告厅|音乐厅|舞蹈房/;
export function classifyDelivery(course){
 const location=String(course.location||course.fields?.['上课地点']||'').normalize('NFKC').trim();
 const lines=location.split(/[\n;；]+/).map(s=>s.trim()).filter(Boolean);
 let hasOnline=false,hasOffline=false,uncertain=false;
 for(const line of lines){const on=online.test(line),off=offline.test(line);hasOnline ||= on;hasOffline ||= off;if(!on&&!off)uncertain=true;}
 const mode=hasOnline&&hasOffline?'mixed':uncertain||!lines.length?'unknown':hasOnline?'online':hasOffline?'offline':'unknown';
 const reason=mode==='online'?'地点包含线上平台或网络授课标记':mode==='offline'?'地点包含实体教室或场馆标记':mode==='mixed'?'地点同时包含线上和线下标记':'地点缺失或无法确认';
 return {mode,label:DELIVERY_LABELS[mode],reason,location};
}
export function groupByDelivery(courses){const groups=Object.fromEntries(DELIVERY_MODES.map(mode=>[mode,[]]));for(const c of courses)groups[classifyDelivery(c).mode].push(c);return groups;}
