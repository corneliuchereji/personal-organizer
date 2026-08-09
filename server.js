const express = require('express');
const fs      = require('fs');
const path    = require('path');
const cron    = require('node-cron');
const fetch   = require('node-fetch');

const app       = express();
const PORT      = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const APP_URL   = process.env.APP_URL || ''; // e.g. https://personal-organizer-xxx.up.railway.app

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ═══════════════════════════════════════════════════
// DATA
// ═══════════════════════════════════════════════════
function readData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE,'utf8')); }
  catch(e){ return {tasks:[],sportEvents:[],groups:[],settings:{}}; }
}
function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data,null,2));
}

// ═══════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════
function getToday() {
  const n=new Date();
  return n.getFullYear()+'-'+String(n.getMonth()+1).padStart(2,'0')+'-'+String(n.getDate()).padStart(2,'0');
}
function fmtTime(t) {
  if(!t)return'00:00';
  const p=String(t);
  return p.includes(':')?p:p.padStart(2,'0')+':00';
}
function addDays(dateStr,n) {
  const d=new Date(dateStr+'T00:00:00');
  d.setDate(d.getDate()+n);
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}
function uid() { return 'e'+Date.now().toString(36)+Math.random().toString(36).slice(2,5); }

function matchesDate(ev, ds) {
  if(!ev.date) return false;
  const freq = ev.freq||'none';
  if(freq==='none') return ev.date===ds;
  const base=new Date(ev.date+'T00:00:00');
  const tgt =new Date(ds+'T00:00:00');
  if(tgt<base) return false;
  if(freq==='daily')   return true;
  if(freq==='weekly')  return base.getDay()===tgt.getDay();
  if(freq==='monthly') return base.getDate()===tgt.getDate();
  if(freq==='yearly')  return base.getMonth()===tgt.getMonth()&&base.getDate()===tgt.getDate();
  return false;
}

function eventsOnDay(data, ds) {
  return [
    ...data.tasks.map(t=>({...t,_type:'task'})),
    ...(data.sportEvents||[]).map(e=>({...e,_type:'sport'}))
  ].filter(ev=>matchesDate(ev,ds))
   .sort((a,b)=>(a.time||'').localeCompare(b.time||''));
}

// ═══════════════════════════════════════════════════
// TELEGRAM SEND
// ═══════════════════════════════════════════════════
async function sendTg(token, chatId, text) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({chat_id:chatId, text, parse_mode:'HTML'})
    });
    const d = await r.json();
    if(!d.ok) console.log('TG error:',d.description);
    return d.ok;
  } catch(e) {
    console.log('TG fetch error:',e.message);
    return false;
  }
}

// ═══════════════════════════════════════════════════
// MESSAGE BUILDERS
// ═══════════════════════════════════════════════════
function buildDailyMsg(data) {
  const today = getToday();
  const d     = new Date(today+'T00:00:00');
  const dow   = d.toLocaleDateString('en-GB',{weekday:'long'});
  const dt    = d.toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'});
  const evs   = eventsOnDay(data, today);

  let msg = '📅 <b>Daily briefing — '+dow+', '+dt+'</b>\n\n';
  if(!evs.length) {
    msg += '✨ No events today. Enjoy your day!';
  } else {
    msg += '<b>'+evs.length+' event'+(evs.length>1?'s':'')+' today:</b>\n\n';
    evs.forEach(ev=>{
      const icon = ev._type==='task'?'📋':'🏆';
      msg += icon+' <b>'+ev.name+'</b>\n   🕐 '+fmtTime(ev.time);
      if(ev._type==='task'&&ev.priority&&ev.priority!=='normal') msg+=' · ⚠️ '+ev.priority;
      if(ev.notes) msg+='\n   📝 '+ev.notes;
      msg+='\n\n';
    });
  }
  msg += '—\n🗂 Personal Organizer';
  return msg;
}

function buildWeeklyMsg(data) {
  const today  = getToday();
  const dt     = new Date().toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'});
  const active = data.tasks.filter(t=>!t.done);
  const sports = data.sportEvents||[];

  let msg = '📆 <b>Weekly summary — '+dt+'</b>\n\n';
  msg += '📋 <b>'+active.length+'</b> active tasks · 🏆 <b>'+sports.length+'</b> sport events\n\n';

  const urgent = active.filter(t=>t.priority==='very');
  const high   = active.filter(t=>t.priority==='high');
  if(urgent.length){ msg+='🚨 <b>URGENT:</b>\n'; urgent.forEach(t=>msg+='• '+t.name+' ('+t.date+')\n'); msg+='\n'; }
  if(high.length)  { msg+='⚠️ <b>High priority:</b>\n'; high.forEach(t=>msg+='• '+t.name+' ('+t.date+')\n'); msg+='\n'; }

  msg += '<b>This week\'s schedule:</b>\n';
  for(let i=0;i<7;i++){
    const ds = addDays(today,i);
    const dayEvs = eventsOnDay(data,ds);
    if(dayEvs.length){
      const d = new Date(ds+'T00:00:00');
      msg += '\n<b>'+d.toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short'})+'</b>\n';
      dayEvs.forEach(ev=>{ msg += (ev._type==='task'?'📋':'🏆')+' '+ev.name+' ('+fmtTime(ev.time)+')\n'; });
    }
  }

  const upcoming = sports.filter(e=>e.date>=today).sort((a,b)=>a.date.localeCompare(b.date)).slice(0,5);
  if(upcoming.length){
    msg += '\n🏆 <b>Next sport events:</b>\n';
    upcoming.forEach(e=>{
      const d=new Date(e.date+'T00:00:00');
      msg += '• '+e.name+' — '+d.toLocaleDateString('en-GB',{day:'numeric',month:'short'})+' at '+fmtTime(e.time)+'\n';
    });
  }
  msg += '\n—\n🗂 Personal Organizer';
  return msg;
}

// ═══════════════════════════════════════════════════
// TWO-WAY TELEGRAM BOT — COMMAND PARSER
// ═══════════════════════════════════════════════════
function parseDate(str, today) {
  if(!str) return null;
  const s = str.toLowerCase().trim();
  const yr = new Date().getFullYear();

  if(s==='today'||s==='azi')   return today;
  if(s==='tomorrow'||s==='maine') return addDays(today,1);

  // Next weekday
  const DAYS={sunday:0,monday:1,tuesday:2,wednesday:3,thursday:4,friday:5,saturday:6,
              duminica:0,luni:1,marti:2,miercuri:3,joi:4,vineri:5,sambata:6};
  const dm = s.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|luni|marti|miercuri|joi|vineri|sambata|duminica)\b/);
  if(dm){ const di=DAYS[dm[1]]; const base=new Date(today+'T00:00:00'); let diff=di-base.getDay(); if(diff<=0)diff+=7; return addDays(today,diff); }

  // DD.MM.YYYY or DD/MM/YYYY
  const dmy = s.match(/(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})/);
  if(dmy) return dmy[3]+'-'+dmy[2].padStart(2,'0')+'-'+dmy[1].padStart(2,'0');

  // DD.MM
  const dm2 = s.match(/(\d{1,2})[.\/-](\d{1,2})/);
  if(dm2) return yr+'-'+dm2[2].padStart(2,'0')+'-'+dm2[1].padStart(2,'0');

  // ISO
  const iso = s.match(/(\d{4}-\d{2}-\d{2})/);
  if(iso) return iso[1];

  // Month name
  const MONTHS={january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,
                september:9,october:10,november:11,december:12,
                ianuarie:1,februarie:2,martie:3,aprilie:4,mai:5,iunie:6,
                iulie:7,august:8,septembrie:9,octombrie:10,noiembrie:11,decembrie:12};
  for(const[mn,mi] of Object.entries(MONTHS)){
    const m=s.match(new RegExp('(\\d{1,2})\\s+'+mn+'|'+mn+'\\s+(\\d{1,2})'));
    if(m){ const day=parseInt(m[1]||m[2]); return yr+'-'+String(mi).padStart(2,'0')+'-'+String(day).padStart(2,'0'); }
  }

  // in N days
  const inn=s.match(/in\s+(\d+)\s+days?/);
  if(inn) return addDays(today,parseInt(inn[1]));

  return null;
}

function parseTime(str) {
  if(!str) return '09:00';
  const s=(str||'').toLowerCase();
  // Named times
  if(/\bmorning\b/.test(s))  return '08:00';
  if(/\bnoon\b/.test(s))     return '12:00';
  if(/\bafternoon\b/.test(s))return '15:00';
  if(/\bevening\b/.test(s))  return '19:00';
  if(/\bnight\b/.test(s))    return '21:00';
  if(/\bmidnight\b/.test(s)) return '00:00';
  const m=str.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if(!m) return '09:00';
  let h=parseInt(m[1]); const mm=m[2]||'00';
  if((m[3]||'').toLowerCase()==='pm'&&h<12) h+=12;
  if((m[3]||'').toLowerCase()==='am'&&h===12) h=0;
  return String(h).padStart(2,'0')+':'+mm.padStart(2,'0');
}

function guessGroup(text) {
  const s=text.toLowerCase();
  if(/car|vehicle|tire|insurance|fuel/.test(s))  return 'g_car';
  if(/work|meeting|deadline|office|project/.test(s)) return 'g_work';
  if(/bill|invoice|electric|water|internet|rent/.test(s)) return 'g_home';
  if(/gym|run|sport|race|match|training/.test(s)) return 'g_sport';
  return 'g_pers';
}

function guessPriority(text) {
  const s=text.toLowerCase();
  if(/urgent|asap|critical/.test(s)) return 'very';
  if(/important|high/.test(s)) return 'high';
  if(/low|minor/.test(s)) return 'low';
  return 'normal';
}

async function processTgCommand(text, data) {
  const today = getToday();
  const raw   = text.trim();
  // Strip ALL conversational/polite prefixes in any order
  let clean = raw
    .replace(/^(?:hi|hello|hey|buna|salut|ciao)[,!.\s]+/i,'')
    .replace(/^(?:please|can you|could you|would you|te rog|va rog|poti)\s+/i,'')
    .replace(/^(?:i want you to|i'd like you to|i would like you to)\s+/i,'')
    .trim();
  const txt = clean.toLowerCase();

  // ── HELP ──
  if(/^(help|\/?start|\/help)/.test(txt)){
    return `🤖 <b>Personal Organizer Bot</b>\n\nHere's what I understand:\n\n`+
      `📋 <b>Tasks:</b>\n`+
      `• <code>add task dentist tomorrow at 10:00</code>\n`+
      `• <code>add task pay bill on 15.08.2026 at 09:00</code>\n`+
      `• <code>add task work on Monday at 08:00</code>\n\n`+
      `🏆 <b>Sport events:</b>\n`+
      `• <code>add sport F1 Belgian GP on July 26 at 16:00</code>\n\n`+
      `✅ <b>Manage:</b>\n`+
      `• <code>delete dentist</code>\n`+
      `• <code>done dentist</code>\n`+
      `• <code>postpone dentist by 2 days</code>\n`+
      `• <code>remove all tasks</code>\n\n`+
      `📅 <b>Schedule:</b>\n`+
      `• <code>today</code> — today\'s events\n`+
      `• <code>tomorrow</code> — tomorrow\'s events\n`+
      `• <code>week</code> — this week\'s summary\n`+
      `• <code>tasks</code> — all active tasks`;
  }

  // ── TODAY / TOMORROW / WEEK ──
  if(/^(today|azi|ce am azi)$/.test(txt)){
    const evs = eventsOnDay(data, today);
    if(!evs.length) return '📅 Nothing scheduled for today!';
    return '📅 <b>Today:</b>\n\n'+evs.map(e=>(e._type==='task'?'📋':'🏆')+' <b>'+e.name+'</b> — '+fmtTime(e.time)).join('\n');
  }
  if(/^(tomorrow|maine)$/.test(txt)){
    const tmr = addDays(today,1);
    const evs = eventsOnDay(data, tmr);
    if(!evs.length) return '📅 Nothing scheduled for tomorrow!';
    return '📅 <b>Tomorrow:</b>\n\n'+evs.map(e=>(e._type==='task'?'📋':'🏆')+' <b>'+e.name+'</b> — '+fmtTime(e.time)).join('\n');
  }
  if(/^(week|sapt|saptamana|this week)/.test(txt)) return buildWeeklyMsg(data);
  if(/^(tasks|taskuri|active tasks)/.test(txt)){
    const active=data.tasks.filter(t=>!t.done);
    if(!active.length) return '📋 No active tasks!';
    return '📋 <b>Active tasks ('+active.length+'):</b>\n\n'+
      active.map(t=>'• <b>'+t.name+'</b> — '+t.date+' at '+fmtTime(t.time)+(t.priority!=='normal'?' ⚠️ '+t.priority:'')).join('\n');
  }

  // ── REMOVE ALL ──
  if(/remove all tasks?|delete all tasks?|clear all tasks?/.test(txt)){
    const n=data.tasks.length; data.tasks=[]; writeData(data);
    return '🗑️ Removed all '+n+' tasks.';
  }
  if(/remove all (sport|event)|delete all (sport|event)/.test(txt)){
    const n=(data.sportEvents||[]).length; data.sportEvents=[]; writeData(data);
    return '🗑️ Removed all '+n+' sport events.';
  }

  // ── DELETE ──
  const delM=txt.match(/^(?:delete|remove|sterge)\s+(?:task\s+)?["']?(.+?)["']?\s*$/);
  if(delM&&!/\ball\b/.test(txt)){
    const q=delM[1].toLowerCase();
    const t=data.tasks.find(x=>x.name.toLowerCase().includes(q));
    if(t){ data.tasks=data.tasks.filter(x=>x.id!==t.id); writeData(data); return '🗑️ Deleted: <b>'+t.name+'</b>'; }
    const se=(data.sportEvents||[]).find(x=>x.name.toLowerCase().includes(q));
    if(se){ data.sportEvents=data.sportEvents.filter(x=>x.id!==se.id); writeData(data); return '🗑️ Deleted: <b>'+se.name+'</b>'; }
    return '❌ Could not find "'+delM[1]+'"';
  }

  // ── MARK DONE ──
  const doneM=txt.match(/^(?:done|mark done|gata|rezolvat)\s+["']?(.+?)["']?\s*$/);
  if(doneM){
    const q=doneM[1].toLowerCase();
    const t=data.tasks.find(x=>x.name.toLowerCase().includes(q));
    if(t){ t.done=!t.done; writeData(data); return '✅ Marked <b>'+t.name+'</b> as '+(t.done?'done':'not done'); }
    return '❌ Could not find that task.';
  }

  // ── POSTPONE ──
  const postM=txt.match(/^postpone\s+["']?(.+?)["']?(?:\s+by\s+(\d+)\s+days?)?\s*$/);
  if(postM){
    const q=postM[1].toLowerCase();
    const t=data.tasks.find(x=>x.name.toLowerCase().includes(q));
    if(t){ const n=parseInt(postM[2])||1; t.date=addDays(t.date,n); writeData(data); return '⏩ Postponed <b>'+t.name+'</b> by '+n+' day(s) → '+t.date; }
    return '❌ Could not find that task.';
  }

  // ── ADD SPORT ──
  const isSportI=/\b(?:f1|formula|grand.?prix|\bgp\b|motogp|tour.de.france|giro|champions.league|ucl|serie.?a|bundesliga|wec|snooker)\b/i.test(raw);
  if(isSportI || /^(?:add|new)\s+sport/i.test(clean)){
    let work=clean.replace(/^(?:add|new|create)\s+(?:sport\s+(?:event\s+)?)?/i,'').trim();
    // Extract name from quotes
    let name=null;
    const qm=work.match(/named?\s+["""]([^"""]+)["""]|["""]([^"""]+)["""]/);
    if(qm){ name=(qm[1]||qm[2]).trim(); work=work.replace(qm[0],'').trim(); }
    // Time
    const tm=work.match(/\bat\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i);
    const time=tm?parseTime(tm[1]):'14:00';
    if(tm) work=work.replace(tm[0],'').trim();
    // Date
    let date=today; const datePatterns=[
      {r:/\b(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})\b/,f:m=>m[3]+'-'+m[2].padStart(2,'0')+'-'+m[1].padStart(2,'0')},
      {r:/\btomorrow\b/i,f:()=>addDays(today,1)},
      {r:/\b(?:next\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,f:m=>{const DAYS={sunday:0,monday:1,tuesday:2,wednesday:3,thursday:4,friday:5,saturday:6};const di=DAYS[m[1].toLowerCase()];const base=new Date(today+'T00:00:00');let diff=di-base.getDay();if(diff<=0)diff+=7;return addDays(today,diff)}},
      {r:/\b(?:on\s+)?(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})\b/i,f:m=>{const MI={january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12};return new Date().getFullYear()+'-'+String(MI[m[1].toLowerCase()]).padStart(2,'0')+'-'+String(parseInt(m[2])).padStart(2,'0')}},
      {r:/\b(\d{4}-\d{2}-\d{2})\b/,f:m=>m[1]},
    ];
    for(const p of datePatterns){const m=work.match(p.r);if(m){date=p.f(m);work=work.replace(m[0],'').trim();break;}}
    if(!name){
      work=work.replace(/^(?:on|for|a|the)\s+/i,'').replace(/[-–,;:]+/g,' ').trim();
      name=work||'Sport event';
    }
    const SPORT_MAP={f1:'f1',formula:'f1',motogp:'motogp',moto:'motogp','tour de france':'tdf',giro:'giro','champions league':'ucl',ucl:'ucl','serie a':'seriea',bundesliga:'bundesliga',wec:'wec',snooker:'snooker'};
    let sport='other';
    for(const[k,v] of Object.entries(SPORT_MAP)){if(raw.toLowerCase().includes(k)){sport=v;break;}}
    const COLORS={f1:'#e879a0',motogp:'#f97316',tdf:'#fbbf24',giro:'#f87171',ucl:'#4f8ef7',seriea:'#34d399',bundesliga:'#fb923c',wec:'#60a5fa',snooker:'#a78bfa',other:'#94a3b8'};
    if(!data.sportEvents) data.sportEvents=[];
    data.sportEvents.push({id:uid(),name,date,time,sport,notes:'',color:COLORS[sport]||'#94a3b8'});
    writeData(data);
    return '✅ Sport event added:\n🏆 <b>'+name+'</b>\n📅 '+date+' at '+time;
  }

  // ── ADD TASK ──
  const isAddI=/^(?:add|new|create|set|schedule|remind(?:er)?|adauga|pune|please add|please set)\b/i.test(clean);
  if(isAddI){
    let work=clean.replace(/^(?:add|new|create|set|schedule|remind(?:er)?|adauga|pune)\s+(?:a\s+)?(?:task|reminder|event|appointment|me\s+to)?\s*/i,'').trim();
    // Quoted name — check FIRST
    let name=null;
    const qm=work.match(/named?\s+[\u201c\u201d"]([^\u201c\u201d"]+)[\u201c\u201d"]|named?\s+"([^"]+)"|[\u201c\u201d"]([^\u201c\u201d"]+)[\u201c\u201d"]|"([^"]+)"/);
    if(qm){ name=(qm[1]||qm[2]||qm[3]||qm[4]).trim(); work=work.replace(qm[0],'').trim(); }
    // Named time THEN numeric time
    const namedTm=work.match(/\b(morning|afternoon|evening|noon|night|midnight)\b/i);
    const numTm=work.match(/\bat\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i);
    let time='09:00';
    if(numTm){ time=parseTime(numTm[1]); work=work.replace(numTm[0],'').trim(); }
    else if(namedTm){ time=parseTime(namedTm[1]); work=work.replace(namedTm[0],'').trim(); }
    // Date
    let date=today;
    const dp2=[
      {r:/\b(\d{1,2})[.\/\-](\d{1,2})[\.\/-](\d{4})\b/,f:m=>m[3]+'-'+m[2].padStart(2,'0')+'-'+m[1].padStart(2,'0')},
      {r:/\btomorrow\b/i,f:()=>addDays(today,1)},
      {r:/\btoday\b/i,f:()=>today},
      {r:/\b(?:next\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday|luni|marti|miercuri|joi|vineri|sambata|duminica)\b/i,f:m=>{const DW={sunday:0,monday:1,tuesday:2,wednesday:3,thursday:4,friday:5,saturday:6,duminica:0,luni:1,marti:2,miercuri:3,joi:4,vineri:5,sambata:6};const di=DW[m[1].toLowerCase()];const base=new Date(today+'T00:00:00');let diff=di-base.getDay();if(diff<=0)diff+=7;return addDays(today,diff)}},
      {r:/\b(?:on\s+)?(january|february|march|april|may|june|july|august|september|october|november|december|ianuarie|februarie|martie|aprilie|mai|iunie|iulie|august|septembrie|octombrie|noiembrie|decembrie)\s+(\d{1,2})\b/i,f:m=>{const MI={january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12,ianuarie:1,februarie:2,martie:3,aprilie:4,mai:5,iunie:6,iulie:7,august:8,septembrie:9,octombrie:10,noiembrie:11,decembrie:12};return new Date().getFullYear()+'-'+String(MI[m[1].toLowerCase()]).padStart(2,'0')+'-'+String(parseInt(m[2])).padStart(2,'0')}},
      {r:/\b(\d{4}-\d{2}-\d{2})\b/,f:m=>m[1]},
      {r:/\bin\s+(\d+)\s+days?\b/i,f:m=>addDays(today,parseInt(m[1]))},
    ];
    for(const p of dp2){const m=work.match(p.r);if(m){date=p.f(m);work=work.replace(m[0],'').trim();break;}}
    if(!name){
      work=work
        .replace(/^(?:for|on|a|an|the|task|reminder)\s+/gi,'')
        .replace(/^\s*[-\u2013:,;]+\s*/,'')
        .replace(/\s*[-\u2013,;:]+\s*$/,'')
        .trim();
      name=work||null;
    }
    if(!name) return '\u2753 What should I call this task?\nTry: <code>add task dentist tomorrow at 10:00</code>';
    const groups=data.groups||[];
    const grp=groups.find(g=>g.id===guessGroup(name))||groups[0]||{id:'g_pers'};
    data.tasks.push({id:uid(),name,date,time,freq:'none',priority:guessPriority(raw),group:grp.id,notes:'',done:false});
    writeData(data);
    return '\u2705 Task added:\n\ud83d\udccb <b>'+name+'</b>\n\ud83d\udcc5 '+(date===today?'Today':date)+' at '+time;
  }
  return '❓ I didn\'t understand that.\nSend /help to see what I can do.';
}

// ═══════════════════════════════════════════════════
// WEBHOOK — Telegram sends messages here
// ═══════════════════════════════════════════════════
app.post('/webhook/:token', async (req, res) => {
  res.sendStatus(200); // always ack fast
  try {
    const data = readData();
    console.log('Webhook received. Body keys:', Object.keys(req.body||{}));

    const msg = req.body?.message;
    if(!msg?.text){ console.log('No text, skip.'); return; }

    const chatId = String(msg.chat.id);
    const text   = msg.text;
    console.log('From chatId:', chatId, '| text:', text);
    console.log('Stored chatId:', String(data.settings?.tgChatId));

    if(!data.settings?.tgToken){ console.log('No token stored.'); return; }

    // Security: only our chat ID
    if(data.settings.tgChatId && chatId !== String(data.settings.tgChatId)){
      console.log('Unauthorized.');
      await sendTg(data.settings.tgToken, chatId, '⛔ Unauthorized.');
      return;
    }

    const reply = await processTgCommand(text, data);
    console.log('Reply:', reply.slice(0,80));
    await sendTg(data.settings.tgToken, chatId, reply);
  } catch(e) {
    console.log('Webhook error:', e.message);
  }
});

// Register webhook with Telegram
app.post('/api/telegram/register-webhook', async (req, res) => {
  const { token, chatId } = req.body;
  if(!token || !APP_URL) return res.json({ok:false, err:'Missing token or APP_URL env var'});
  const webhookUrl = APP_URL.replace(/\/$/,'')+'/webhook/'+token;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/setWebhook`,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({url: webhookUrl, drop_pending_updates:true})
    });
    const d = await r.json();
    console.log('Webhook registered:', d);
    res.json({ok:d.ok, err:d.description||'', webhookUrl});
  } catch(e) {
    res.json({ok:false, err:e.message});
  }
});

// ═══════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════
app.get('/api/data', (req, res) => res.json(readData()));

app.post('/api/data', (req, res) => {
  const current = readData();
  const updated = {...current, ...req.body};
  writeData(updated);
  if(req.body.settings) setupCrons(updated.settings);
  res.json({ok:true});
});

app.get('/api/sports/next/:league', async (req, res) => {
  try {
    const r = await fetch(`https://www.thesportsdb.com/api/v1/json/3/eventsnextleague.php?id=${req.params.league}`);
    res.json(await r.json());
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/telegram/send', async (req, res) => {
  const {token,chatId,text}=req.body;
  if(!token||!chatId) return res.json({ok:false,err:'Missing token or chatId'});
  try {
    const r=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({chat_id:chatId,text,parse_mode:'HTML'})
    });
    const d=await r.json();
    res.json({ok:d.ok,err:d.description||''});
  } catch(e){ res.json({ok:false,err:e.message}); }
});

// ═══════════════════════════════════════════════════
// CRON SCHEDULING
// ═══════════════════════════════════════════════════
let _dailyCron=null, _weeklyCron=null;

function setupCrons(settings) {
  if(_dailyCron)  { _dailyCron.stop();  _dailyCron=null;  }
  if(_weeklyCron) { _weeklyCron.stop(); _weeklyCron=null; }
  if(!settings?.tgToken||!settings?.tgChatId) return;

  const hour = String(settings.tgMorningHour||'08').padStart(2,'0');
  const min  = String(settings.tgMorningMin||'00').padStart(2,'0');
  const utcH = (parseInt(hour)-3+24)%24; // Bucharest UTC+3

  _dailyCron = cron.schedule(`${min} ${utcH} * * *`, async ()=>{
    console.log('Sending daily briefing...');
    const d=readData();
    await sendTg(settings.tgToken, settings.tgChatId, buildDailyMsg(d));
  });

  _weeklyCron = cron.schedule(`${min} ${utcH} * * 1`, async ()=>{
    console.log('Sending weekly summary...');
    const d=readData();
    await sendTg(settings.tgToken, settings.tgChatId, buildWeeklyMsg(d));
  });

  console.log(`Crons set: daily at ${hour}:${min} Bucharest time`);

  // Register webhook automatically if APP_URL is set
  if(APP_URL && settings.tgToken) {
    const webhookUrl = APP_URL.replace(/\/$/,'')+'/webhook/'+settings.tgToken;
    fetch(`https://api.telegram.org/bot${settings.tgToken}/setWebhook`,{
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({url:webhookUrl, drop_pending_updates:true})
    }).then(r=>r.json()).then(d=>console.log('Webhook auto-registered:',d.ok)).catch(()=>{});
  }
}

// ═══════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════
const initialData = readData();
if(initialData.settings?.tgToken) setupCrons(initialData.settings);

app.listen(PORT, ()=>console.log(`Personal Organizer running on port ${PORT}`));
