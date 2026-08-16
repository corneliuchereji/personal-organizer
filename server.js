const express = require('express');
const fs      = require('fs');
const path    = require('path');
const cron    = require('node-cron');
const fetch   = require('node-fetch');

const app       = express();
const PORT      = process.env.PORT || 3000;
// DATA_DIR should point at a Railway Volume mount (e.g. /data) so the file
// survives redeploys. Falls back to the app folder for local dev, but on
// Railway WITHOUT a volume this will still reset on every deploy.
const DATA_DIR  = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const SEED_FILE = path.join(__dirname, 'data.json'); // template shipped with the repo
const APP_URL   = process.env.APP_URL || ''; // e.g. https://personal-organizer-xxx.up.railway.app

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ═══════════════════════════════════════════════════
// DATA
// ═══════════════════════════════════════════════════
const DEFAULT_DATA = {
  tasks: [], sportEvents: [],
  groups: [
    {id:'g_pers',name:'Personal',color:'#a78bfa'},
    {id:'g_home',name:'Home',color:'#4f8ef7'},
    {id:'g_car',name:'Car',color:'#94a3b8'},
    {id:'g_work',name:'Work',color:'#34d399'},
    {id:'g_sport',name:'Sport',color:'#f97316'}
  ],
  settings: {
    tgToken:'', tgChatId:'', tgMorningHour:'08', tgMorningMin:'00', tgWeeklyDay:'1',
    wxLat: 45.689, wxLon: 21.903, wxLocName: 'Lugoj, RO',
    apiFootballKey: '', footballDataKey: '', tsdbKey: '123'
  },
  follows: { teams: [], competitions: [] }
};

// If DATA_DIR is a fresh volume with no data.json yet, seed it once so the
// app doesn't start completely empty. This only ever runs the FIRST time —
// after that the volume's own file is the source of truth and is never
// overwritten by redeploys.
function ensureDataFile() {
  if (fs.existsSync(DATA_FILE)) return;
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch(e) {}
  let seed = DEFAULT_DATA;
  if (DATA_FILE !== SEED_FILE && fs.existsSync(SEED_FILE)) {
    try { seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8')); } catch(e) {}
  }
  fs.writeFileSync(DATA_FILE, JSON.stringify(seed, null, 2));
  console.log(`Seeded new data file at ${DATA_FILE}`);
}
ensureDataFile();

function readData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE,'utf8')); }
  catch(e){ return JSON.parse(JSON.stringify(DEFAULT_DATA)); }
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
// Converts "HH:MM" (or "H") to minutes-since-midnight for correct chronological sorting.
function timeToMinutes(t) {
  const s = fmtTime(t);
  const [h,m] = s.split(':').map(Number);
  return (h||0)*60+(m||0);
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
   .sort((a,b)=>{
     const dt=timeToMinutes(a.time)-timeToMinutes(b.time);
     if(dt!==0) return dt;
     // Same time: tasks (personal items) come before sport fixtures.
     if(a._type!==b._type) return a._type==='task'?-1:1;
     return 0;
   });
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
  const s=(str||'').toLowerCase().trim();
  // Named times
  if(/\bmorning\b/.test(s))   return '06:00';
  if(/\bnoon\b/.test(s))      return '12:00';
  if(/\bafternoon\b/.test(s)) return '15:00';
  if(/\bevening\b/.test(s))   return '19:00';
  if(/\bnight\b/.test(s))     return '21:00';
  if(/\bmidnight\b/.test(s))  return '00:00';
  // Numeric: 6AM, 6am, 6:30AM, 6:30 am, 18:00, 6
  const m=str.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if(!m) return '09:00';
  let h=parseInt(m[1]);
  const mm=m[2]||'00';
  const ap=(m[3]||'').toLowerCase();
  if(ap==='pm' && h<12) h+=12;
  if(ap==='am' && h===12) h=0;
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

  // ── ADD TASK / EVENT ──
  const isAddI = /^(?:add|new|create|set|schedule|remind(?:er)?|adauga|pune)\b/i.test(clean)
               || /^event\s*:/i.test(clean);
  if(isAddI){
    // Strip trigger words
    let work = clean
      .replace(/^(?:add|new|create|set|schedule|remind(?:er)?|adauga|pune)\s+(?:a\s+|an\s+)?(?:task|event|reminder|appointment|me\s+to)?\s*[:\-,]?\s*/i,'')
      .replace(/^event\s*:\s*/i,'')
      .trim();

    // 1. Extract NAME — try patterns in order of priority
    let name = null;

    // "named: X" — takes everything after colon to end of string or next comma
    const namedC = work.match(/\bnamed?\s*:\s*([^,\n]+?)\s*(?:,\s*(?:at|la|on|\d)|$)/i)
                || work.match(/\bnamed?\s*:\s*(.+)$/i);
    if(namedC){ name=namedC[1].trim(); work=work.replace(namedC[0],'').trim(); }

    // Quoted name "..." or “...”
    if(!name){
      const qm=work.match(/[\u201c\u201d"]([^\u201c\u201d"]+)[\u201c\u201d"]|"([^"]+)"/);
      if(qm){ name=(qm[1]||qm[2]).trim(); work=work.replace(qm[0],'').trim(); }
    }

    // 2. Extract DATE
    let date=today;
    const dps=[
      // DD-MM-YYYY, DD.MM.YYYY, DD/MM/YYYY
      {r:/\b(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{4})\b/, f:m=>m[3]+'-'+m[2].padStart(2,'0')+'-'+m[1].padStart(2,'0')},
      // YYYY-MM-DD
      {r:/\b(\d{4})-(\d{2})-(\d{2})\b/, f:m=>m[1]+'-'+m[2]+'-'+m[3]},
      {r:/\btomorrow\b/i, f:()=>addDays(today,1)},
      {r:/\btoday\b/i,    f:()=>today},
      {r:/\b(?:next\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday|luni|marti|miercuri|joi|vineri|sambata|duminica)\b/i,
        f:m=>{const DW={sunday:0,monday:1,tuesday:2,wednesday:3,thursday:4,friday:5,saturday:6,
                       duminica:0,luni:1,marti:2,miercuri:3,joi:4,vineri:5,sambata:6};
              const di=DW[m[1].toLowerCase()];const b=new Date(today+'T00:00:00');
              let diff=di-b.getDay();if(diff<=0)diff+=7;return addDays(today,diff)}},
      {r:/\b(?:on\s+)?(january|february|march|april|may|june|july|august|september|october|november|december|ianuarie|februarie|martie|aprilie|mai|iunie|iulie|august|septembrie|octombrie|noiembrie|decembrie)\s+(\d{1,2})\b/i,
        f:m=>{const MI={january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,
                       september:9,october:10,november:11,december:12,
                       ianuarie:1,februarie:2,martie:3,aprilie:4,mai:5,iunie:6,
                       iulie:7,august:8,septembrie:9,octombrie:10,noiembrie:11,decembrie:12};
              return new Date().getFullYear()+'-'+String(MI[m[1].toLowerCase()]).padStart(2,'0')+'-'+String(parseInt(m[2])).padStart(2,'0')}},
      {r:/\bin\s+(\d+)\s+days?\b/i, f:m=>addDays(today,parseInt(m[1]))},
    ];
    for(const p of dps){const m=work.match(p.r);if(m){date=p.f(m);work=work.replace(m[0],'').trim();break;}}

    // 3. Extract TIME — try patterns from most specific to least
    let time='09:00';
    const tmPats=[
      /\b(?:at|la)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i,  // at 10:00, at 6AM
      /\b(\d{1,2}:\d{2}\s*(?:am|pm)?)\b/i,                     // 22:00, 6:30PM
      /\b(\d{1,2}\s*(?:am|pm))\b/i,                             // 6AM, 10pm
      /\b(morning|afternoon|evening|noon|night|midnight)\b/i,      // morning, evening
    ];
    for(const r of tmPats){
      const m=work.match(r);
      if(m){time=parseTime(m[1]);work=work.replace(m[0],'').trim();break;}
    }

    // 4. Strip leftover date/time keywords
    work=work
      .replace(/\b(morning|afternoon|evening|noon|night|midnight)\b/gi,'')
      .replace(/\b(tomorrow|today|azi|maine)\b/gi,'')
      .replace(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|luni|marti|miercuri|joi|vineri|sambata|duminica)\b/gi,'')
      .replace(/\s+/g,' ').trim();

    // 5. Name from "- X" or ": X" separator pattern
    if(!name){
      const dashM=work.match(/^[,\s]*[-–:]\s*(.+)$/);
      if(dashM){name=dashM[1].trim();}
    }

    // 6. Fallback: last comma-part that looks like a name (not a number/date/time)
    if(!name){
      const parts=work.split(',').map(s=>s.trim()).filter(Boolean);
      const np=parts.find(p=>p.length>1&&!/^\d{1,2}[:.\-]\d/.test(p)&&!/^\d{4}/.test(p));
      name=np||work;
    }

    // Final cleanup
    if(name) name=name.replace(/^[,\s\-–:]+/,'').replace(/[,\s\-–:]+$/,'').trim();

    if(!name) return '❓ What should I call this?\nExamples:\n<code>add task dentist tomorrow at 10:00</code>\n<code>add task: tomorrow, 6AM, named: dentist</code>\n<code>add event: 12-08-2026, 22:00, Supercupa Europei</code>';

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

// ═══════════════════════════════════════════════════
// FOLLOWS — teams & competitions the user wants tracked,
// auto-synced into sportEvents.
//   Football        → football-data.org — free forever, fixtures/scores/standings
//                      for 12 major competitions, no lineups/live stats
//   Everything else → TheSportsDB — schedule/basic result only
// ═══════════════════════════════════════════════════
const FD_BASE = 'https://api.football-data.org/v4';
// The 12 competitions football-data.org's free tier covers. Fixed, documented
// list — no need to call their API to "search" competitions.
const FD_FREE_COMPETITIONS = [
  { code:'PL',  name:'Premier League', country:'England' },
  { code:'BL1', name:'Bundesliga', country:'Germany' },
  { code:'SA',  name:'Serie A', country:'Italy' },
  { code:'PD',  name:'La Liga', country:'Spain' },
  { code:'FL1', name:'Ligue 1', country:'France' },
  { code:'DED', name:'Eredivisie', country:'Netherlands' },
  { code:'PPL', name:'Primeira Liga', country:'Portugal' },
  { code:'ELC', name:'Championship', country:'England' },
  { code:'CL',  name:'UEFA Champions League', country:'Europe' },
  { code:'EC',  name:'European Championship', country:'Europe' },
  { code:'WC',  name:'FIFA World Cup', country:'World' },
  { code:'BSA', name:'Série A', country:'Brazil' }
];
// Sports on the "other" side all live under TheSportsDB's "Motorsport" bucket
// except cycling, snooker and darts which have their own sport names there.
const TSDB_SPORT_MAP = {
  motorsport:'Motorsport', f1:'Motorsport', motogp:'Motorsport', wec:'Motorsport',
  imsa:'Motorsport', endurance:'Motorsport',
  cycling:'Cycling', snooker:'Snooker', darts:'Darts',
  // football-data.org only covers 12 top-flight competitions — anything else
  // (lower divisions, smaller leagues/countries) goes through TheSportsDB
  // instead, which is broader but less consistently detailed.
  football_other:'Soccer'
};

function tsdbKeyOf(data){
  const k = data.settings && data.settings.tsdbKey;
  // '3' was an older shared test key that's since become unreliable —
  // auto-upgrade anyone still storing it to the current one, '123'.
  return (!k || k === '3') ? '123' : k;
}
function fdKeyOf(data){ return data.settings && data.settings.footballDataKey; }
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

// GET /api/sports/search?sport=football&kind=team&q=Milan&compCode=SA
// GET /api/sports/search?sport=motorsport&kind=competition&q=MotoGP
app.get('/api/sports/search', async (req, res) => {
  const { sport, kind, q, compCode } = req.query; // kind: 'team' | 'competition'
  const data = readData();
  try {
    if (sport === 'football') {
      if (kind === 'competition') {
        // Fixed free-tier list — no API call needed, so it's never rate-limited.
        let list = FD_FREE_COMPETITIONS;
        if (q && q.trim()) list = list.filter(c=>c.name.toLowerCase().includes(q.trim().toLowerCase()));
        return res.json({ results: list.map(c=>({ id:c.code, name:c.name, logo:`https://crests.football-data.org/${c.code}.png`, country:c.country })) });
      }
      // Team search: free tier has no global text search, so we search
      // within one competition's team list (picked by the user first).
      const key = fdKeyOf(data);
      if (!key) return res.status(400).json({ error: 'Add your football-data.org key in Settings first.' });
      if (!compCode) return res.status(400).json({ error: 'Pick which competition the team plays in first.' });
      const r = await fetch(`${FD_BASE}/competitions/${compCode}/teams`, { headers:{'X-Auth-Token':key} });
      const d = await r.json();
      if (d.errorCode || d.message) return res.status(400).json({ error: d.message || 'football-data.org error' });
      let teams = d.teams||[];
      if (q && q.trim()) teams = teams.filter(t=>t.name.toLowerCase().includes(q.trim().toLowerCase()) || (t.shortName||'').toLowerCase().includes(q.trim().toLowerCase()));
      return res.json({ results: teams.map(t=>({ id:t.id, name:t.name, logo:t.crest||'', country:'' })) });
    } else {
      const key = tsdbKeyOf(data);
      const sportName = TSDB_SPORT_MAP[sport] || sport;
      if (kind === 'team') {
        if (!q || q.length < 2) return res.json({ results: [] });
        const r = await fetch(`https://www.thesportsdb.com/api/v1/json/${key}/searchteams.php?t=${encodeURIComponent(q)}`);
        const d = await r.json();
        const results = (d.teams||[])
          .filter(t => !sportName || (t.strSport||'').toLowerCase() === sportName.toLowerCase())
          .map(t=>({ id:t.idTeam, name:t.strTeam, logo:t.strTeamBadge||'', country:t.strCountry }));
        return res.json({ results });
      } else {
        // TheSportsDB has no fuzzy league search on the free tier — list all
        // leagues for the sport and filter by name here.
        const r = await fetch(`https://www.thesportsdb.com/api/v1/json/${key}/search_all_leagues.php?s=${encodeURIComponent(sportName)}`);
        const d = await r.json();
        let list = d.countries || d.leagues || [];
        if (q) list = list.filter(l => (l.strLeague||'').toLowerCase().includes(q.toLowerCase()));
        const results = list.slice(0,40).map(l=>({ id:l.idLeague, name:l.strLeague, logo:l.strBadge||l.strLogo||'', country:l.strCountry||'' }));
        return res.json({ results });
      }
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/follows', (req, res) => {
  const d = readData();
  res.json(d.follows || { teams: [], competitions: [] });
});

app.post('/api/follows', async (req, res) => {
  const { kind, sport, providerId, name, logo } = req.body; // kind: 'team'|'competition'
  if (!kind || !sport || !providerId || !name) return res.status(400).json({ error: 'Missing fields' });
  const d = readData();
  if (!d.follows) d.follows = { teams: [], competitions: [] };
  const provider = sport === 'football' ? 'football-data' : 'thesportsdb';
  const listKey = kind === 'team' ? 'teams' : 'competitions';
  if (!d.follows[listKey].find(x => x.providerId === String(providerId) && x.provider === provider)) {
    d.follows[listKey].push({ id: uid(), kind, sport, provider, providerId: String(providerId), name, logo: logo||'' });
  }
  writeData(d);
  res.json({ ok:true, follows: d.follows });
  syncFixtures().catch(e => console.log('Sync after follow-add failed:', e.message));
});

app.delete('/api/follows/:kind/:id', (req, res) => {
  const { kind, id } = req.params;
  const d = readData();
  if (!d.follows) d.follows = { teams: [], competitions: [] };
  const listKey = kind === 'team' ? 'teams' : 'competitions';
  d.follows[listKey] = (d.follows[listKey]||[]).filter(x => x.id !== id);
  // Drop any auto-synced fixtures that came from this follow.
  d.sportEvents = (d.sportEvents||[]).filter(e => !(e.source === 'auto' && e.followId === id));
  writeData(d);
  res.json({ ok:true });
});

app.post('/api/sports/sync-now', async (req, res) => {
  try { const { count, log } = await syncFixtures(); res.json({ ok:true, synced:count, log }); }
  catch(e){ res.status(500).json({ error: e.message }); }
});

// One-off raw diagnostic against football-data.org, using whatever key is
// currently saved in Settings — shows exact HTTP status + body for three
// representative calls so we can see precisely what the account allows.
app.get('/api/sports/debug-football', async (req, res) => {
  const d = readData();
  const key = fdKeyOf(d);
  if (!key) return res.json({ error: 'No football-data.org key saved in Settings.' });
  const headers = { 'X-Auth-Token': key };
  const tests = [
    { label:'Competition lookup (Serie A)', url:`${FD_BASE}/competitions/SA` },
    { label:'Competition matches (Serie A)', url:`${FD_BASE}/competitions/SA/matches?status=SCHEDULED` },
    { label:'Team matches (AC Milan, id 98)', url:`${FD_BASE}/teams/98/matches?status=SCHEDULED` }
  ];
  const results = [];
  for (const t of tests) {
    try {
      const r = await fetch(t.url, { headers });
      const text = await r.text();
      let body; try { body = JSON.parse(text); } catch { body = text; }
      results.push({ label:t.label, url:t.url, status:r.status, body });
    } catch(e) {
      results.push({ label:t.label, url:t.url, status:'network-error', body:e.message });
    }
  }
  res.json({ keyPrefix: key.slice(0,6)+'…'+key.slice(-4), results });
});

// Diagnostic for TheSportsDB — tests a specific team id plus a known-good
// one (Manchester United, 133612) side by side, so we can tell whether a
// failure is "this team id is bad" vs "the endpoint/key is broken generally".
app.get('/api/sports/debug-tsdb', async (req, res) => {
  const d = readData();
  const key = tsdbKeyOf(d);
  const testTeamId = req.query.teamId;
  const tests = [
    { label:'Team lookup (known-good: Man United, 133612)', url:`https://www.thesportsdb.com/api/v1/json/${key}/lookupteam.php?id=133612` },
    { label:'Team next events (known-good: Man United, 133612)', url:`https://www.thesportsdb.com/api/v1/json/${key}/eventsnext.php?id=133612` }
  ];
  if (testTeamId) {
    tests.push({ label:`Team lookup (id ${testTeamId})`, url:`https://www.thesportsdb.com/api/v1/json/${key}/lookupteam.php?id=${testTeamId}` });
    tests.push({ label:`Team next events (id ${testTeamId})`, url:`https://www.thesportsdb.com/api/v1/json/${key}/eventsnext.php?id=${testTeamId}` });
  }
  const results = [];
  for (const t of tests) {
    try {
      const r = await fetch(t.url);
      const text = await r.text();
      let body; try { body = JSON.parse(text); } catch { body = text; }
      results.push({ label:t.label, url:t.url, status:r.status, body });
    } catch(e) {
      results.push({ label:t.label, url:t.url, status:'network-error', body:e.message });
    }
  }
  res.json({ key, results });
});

// Both football-data.org and TheSportsDB return fixture times in UTC. Everywhere
// else in this app, a stored "date"+"time" pair is assumed to already be in
// the user's local time (Europe/Bucharest) — so fixtures must be converted
// here, once, rather than displayed raw. This also means the calendar date
// a late-kickoff fixture lands on is correct even when UTC and Bucharest
// time fall on different calendar days.
function toBucharestParts(dateObj) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Bucharest',
    year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false
  }).formatToParts(dateObj);
  const get = t => parts.find(p=>p.type===t).value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
}

function normalizeFDMatch(m, followType, followId) {
  const dt = new Date(m.utcDate); // ISO UTC from football-data.org
  const { date, time } = toBucharestParts(dt);
  const ft = m.score && m.score.fullTime;
  return {
    id: 'fd_'+m.id, source:'auto', provider:'football-data', providerId:String(m.id),
    sport:'football', freq:'none', date, time,
    name: m.homeTeam.name+' vs '+m.awayTeam.name,
    home: { id:m.homeTeam.id, name:m.homeTeam.name, logo:m.homeTeam.crest||'' },
    away: { id:m.awayTeam.id, name:m.awayTeam.name, logo:m.awayTeam.crest||'' },
    competitionId: followType==='competition' ? followId : null,
    competitionCode: m.competition && m.competition.code,
    competitionName: m.competition && m.competition.name, competitionLogo: m.competition && m.competition.emblem,
    followType, followId,
    status: m.status,
    score: (ft && ft.home!=null) ? { home:ft.home, away:ft.away } : null,
    notes:'', color:'#4f8ef7'
  };
}
function normalizeTSDBEvent(ev, followType, followId) {
  // strTimestamp is UTC ISO when present; fall back to combining date+time as UTC.
  const iso = ev.strTimestamp ? ev.strTimestamp.replace(' ','T')+(ev.strTimestamp.includes('Z')?'':'Z')
    : `${ev.dateEvent}T${ev.strTime||'00:00:00'}Z`;
  const dt = new Date(iso);
  const { date, time } = isNaN(dt) ? { date: ev.dateEvent, time:(ev.strTime||'00:00').slice(0,5) } : toBucharestParts(dt);
  return {
    id: 'tsdb_'+ev.idEvent, source:'auto', provider:'thesportsdb', providerId:ev.idEvent,
    sport: (ev.strSport||'').toLowerCase(), freq:'none', date, time,
    name: ev.strEvent,
    home: ev.strHomeTeam ? { name:ev.strHomeTeam, logo:ev.strHomeTeamBadge||'' } : null,
    away: ev.strAwayTeam ? { name:ev.strAwayTeam, logo:ev.strAwayTeamBadge||'' } : null,
    competitionId: followType==='competition' ? followId : null,
    competitionName: ev.strLeague, competitionLogo: ev.strLeagueBadge||'',
    followType, followId,
    status: ev.strStatus||'',
    score: (ev.intHomeScore!=null) ? { home:ev.intHomeScore, away:ev.intAwayScore } : null,
    notes:'', color:'#94a3b8'
  };
}

// Pulls fresh fixtures for everything followed and replaces the auto-synced
// slice of sportEvents. Manually-added sportEvents (source !== 'auto') are
// left untouched.
async function syncFixtures() {
  const d = readData();
  if (!d.follows) return { count: 0, log: [] };
  const newAuto = [];
  const log = []; // per-follow diagnostic trail, returned to the UI so failures aren't silent
  const fdKey = fdKeyOf(d);
  const tsdbKey = tsdbKeyOf(d);
  // football-data.org's free (TIER_ONE) key rejects requests that combine
  // dateFrom/dateTo with status — confirmed via direct testing. So we fetch
  // with just status=SCHEDULED (their default date window covers the rest
  // of the season) and cap to a sane near-term window ourselves afterward.
  const windowEndMs = Date.now() + 60*86400000;

  if (!fdKey && (d.follows.teams.some(x=>x.sport==='football') || d.follows.competitions.some(x=>x.sport==='football'))) {
    log.push({ name:'Football follows', ok:false, error:'No football-data.org key set in Settings.' });
  }

  if (fdKey) {
    // football-data.org free tier: 10 requests/minute — pace calls out to stay under that.
    const headers = { 'X-Auth-Token': fdKey };
    for (const t of d.follows.teams.filter(x=>x.sport==='football')) {
      try {
        const r = await fetch(`${FD_BASE}/teams/${t.providerId}/matches?status=SCHEDULED`, { headers });
        const dd = await r.json();
        if (dd.errorCode || dd.message) { log.push({ name:t.name, ok:false, error: dd.message||JSON.stringify(dd) }); await sleep(6500); continue; }
        const found = (dd.matches||[]).filter(m => new Date(m.utcDate).getTime() <= windowEndMs);
        found.forEach(m => newAuto.push(normalizeFDMatch(m,'team',t.id)));
        log.push({ name:t.name, ok:true, count:found.length });
      } catch(e){ log.push({ name:t.name, ok:false, error:e.message }); }
      await sleep(6500);
    }
    for (const c of d.follows.competitions.filter(x=>x.sport==='football')) {
      try {
        const r = await fetch(`${FD_BASE}/competitions/${c.providerId}/matches?status=SCHEDULED`, { headers });
        const dd = await r.json();
        if (dd.errorCode || dd.message) { log.push({ name:c.name, ok:false, error: dd.message||JSON.stringify(dd) }); await sleep(6500); continue; }
        const found = (dd.matches||[]).filter(m => new Date(m.utcDate).getTime() <= windowEndMs);
        found.forEach(m => newAuto.push(normalizeFDMatch(m,'competition',c.id)));
        log.push({ name:c.name, ok:true, count:found.length });
      } catch(e){ log.push({ name:c.name, ok:false, error:e.message }); }
      await sleep(6500);
    }
  }

  for (const c of d.follows.competitions.filter(x=>x.sport!=='football')) {
    try {
      const r = await fetch(`https://www.thesportsdb.com/api/v1/json/${tsdbKey}/eventsnextleague.php?id=${c.providerId}`);
      const text = await r.text();
      let dd; try { dd = JSON.parse(text); } catch { log.push({ name:c.name, ok:false, error:`HTTP ${r.status}: ${text.slice(0,200)}` }); continue; }
      const found = dd.events||[];
      found.forEach(ev => newAuto.push(normalizeTSDBEvent(ev,'competition',c.id)));
      log.push({ name:c.name, ok:true, count:found.length });
    } catch(e){ log.push({ name:c.name, ok:false, error:e.message }); }
  }
  for (const t of d.follows.teams.filter(x=>x.sport!=='football')) {
    try {
      const r = await fetch(`https://www.thesportsdb.com/api/v1/json/${tsdbKey}/eventsnext.php?id=${t.providerId}`);
      const text = await r.text();
      let dd; try { dd = JSON.parse(text); } catch { log.push({ name:t.name, ok:false, error:`HTTP ${r.status}: ${text.slice(0,200)}` }); continue; }
      const found = dd.events||[];
      found.forEach(ev => newAuto.push(normalizeTSDBEvent(ev,'team',t.id)));
      log.push({ name:t.name, ok:true, count:found.length });
    } catch(e){ log.push({ name:t.name, ok:false, error:e.message }); }
  }

  // A match can legitimately be fetched twice — once via a followed
  // competition, once via a followed team playing in it. Same real match id
  // in both cases, so dedupe here, preferring the 'team' tag (so it always
  // renders with full team names as its own slot rather than folding into
  // the generic competition group).
  const dedup = new Map();
  for (const ev of newAuto) {
    const existing = dedup.get(ev.id);
    if (!existing || (existing.followType !== 'team' && ev.followType === 'team')) dedup.set(ev.id, ev);
  }
  const manual = (d.sportEvents||[]).filter(e => e.source !== 'auto');
  d.sportEvents = [...manual, ...dedup.values()];
  writeData(d);
  console.log(`Synced ${newAuto.length} auto fixtures from ${d.follows.teams.length} teams + ${d.follows.competitions.length} competitions.`, JSON.stringify(log));
  return { count: newAuto.length, log };
}

// GET /api/fixture/:provider/:id — full detail for tap-through
app.get('/api/fixture/:provider/:id', async (req, res) => {
  const { provider, id } = req.params;
  const d = readData();
  try {
    if (provider === 'football-data') {
      const key = fdKeyOf(d);
      if (!key) return res.status(400).json({ error: 'No football-data.org key set' });
      const headers = { 'X-Auth-Token': key };
      const r = await fetch(`${FD_BASE}/matches/${id}`, { headers });
      const fixture = await r.json();
      if (fixture.errorCode || fixture.message) return res.status(400).json({ error: fixture.message||'football-data.org error' });
      let standings = null;
      if (fixture.competition && fixture.competition.code) {
        try {
          const stR = await fetch(`${FD_BASE}/competitions/${fixture.competition.code}/standings`, { headers });
          const stD = await stR.json();
          standings = stD.standings && stD.standings.find(s=>s.type==='TOTAL');
        } catch(e) {}
      }
      // No lineups/statistics on the free tier — flagged so the UI shows an honest message.
      return res.json({ fixture, lineups: [], statistics: [], standings: standings ? standings.table : null, noDeepStats:true });
    } else if (provider === 'thesportsdb') {
      const key = tsdbKeyOf(d);
      const r = await fetch(`https://www.thesportsdb.com/api/v1/json/${key}/lookupevent.php?id=${id}`);
      const dd = await r.json();
      return res.json({ fixture: dd.events && dd.events[0] });
    }
    res.status(400).json({ error: 'Unknown provider' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════
// WEATHER — Open-Meteo (free, no API key required)
// ═══════════════════════════════════════════════════
const WMO_COND = {
  0:'sunny', 1:'partly_cloudy', 2:'partly_cloudy', 3:'cloudy',
  45:'fog', 48:'fog',
  51:'rainy', 53:'rainy', 55:'rainy', 56:'rainy', 57:'rainy',
  61:'rainy', 63:'rainy', 65:'rainy', 66:'rainy', 67:'rainy',
  80:'rainy', 81:'rainy', 82:'rainy',
  71:'snow', 73:'snow', 75:'snow', 77:'snow', 85:'snow', 86:'snow',
  95:'storm', 96:'storm', 99:'storm'
};
const WMO_LABEL = {
  sunny:'Sunny', partly_cloudy:'Partly sunny', cloudy:'Cloudy',
  rainy:'Rainy', snow:'Snow', storm:'Thunderstorm', fog:'Foggy'
};
function wmoToCond(code){ return WMO_COND[code] || 'cloudy'; }

async function geocodeLocation(name) {
  const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=en&format=json`);
  const d = await r.json();
  if(!d.results || !d.results.length) return null;
  const g = d.results[0];
  const label = [g.name, g.admin1, g.country].filter(Boolean).slice(0,2).join(', ');
  return { lat: g.latitude, lon: g.longitude, label };
}

// GET /api/weather?lat=..&lon=..          -> forecast for coordinates
// GET /api/weather?q=Timisoara            -> geocodes the name first
app.get('/api/weather', async (req, res) => {
  try {
    let { lat, lon, q } = req.query;
    let label = null;

    if (q && (!lat || !lon)) {
      const g = await geocodeLocation(q);
      if (!g) return res.status(404).json({ error: 'Location not found' });
      lat = g.lat; lon = g.lon; label = g.label;
    }
    if (!lat || !lon) { lat = 45.689; lon = 21.903; label = label || 'Lugoj, RO'; }

    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto`;
    const r = await fetch(url);
    const d = await r.json();
    if (!d.current || !d.daily) return res.status(502).json({ error: 'Weather provider error' });

    const forecast = d.daily.time.slice(0, 7).map((t, i) => ({
      dow: new Date(t + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short' }),
      high: Math.round(d.daily.temperature_2m_max[i]),
      low: Math.round(d.daily.temperature_2m_min[i]),
      rain: Math.round(d.daily.precipitation_probability_max?.[i] || 0),
      cond: wmoToCond(d.daily.weather_code[i])
    }));
    const cond = wmoToCond(d.current.weather_code);

    res.json({
      lat: Number(lat), lon: Number(lon),
      locName: label,
      tempC: Math.round(d.current.temperature_2m),
      cond, text: WMO_LABEL[cond] || 'Cloudy',
      high: forecast[0]?.high ?? null,
      low: forecast[0]?.low ?? null,
      forecast
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
// DEBUG ENDPOINTS
// ═══════════════════════════════════════════════════
app.get('/api/status', async (req, res) => {
  const data = readData();
  const token = data.settings?.tgToken;
  let webhookInfo = null;
  if(token){
    try{
      const r = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
      webhookInfo = await r.json();
    }catch(e){ webhookInfo = {error: e.message}; }
  }
  res.json({
    ok: true,
    appUrl: APP_URL,
    port: PORT,
    hasTgToken: !!token,
    hasTgChatId: !!data.settings?.tgChatId,
    taskCount: data.tasks?.length || 0,
    sportCount: data.sportEvents?.length || 0,
    webhookInfo: webhookInfo?.result || webhookInfo
  });
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

// Fixture sync — refreshes followed teams/competitions into sportEvents.
let _fixtureSyncCron = cron.schedule('17 */6 * * *', async () => {
  console.log('Running scheduled fixture sync...');
  try { await syncFixtures(); } catch(e){ console.log('Scheduled sync error:', e.message); }
});

// ═══════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════
const initialData = readData();

app.listen(PORT, async ()=>{
  console.log(`✅ Personal Organizer running on port ${PORT}`);
  console.log(`   APP_URL: ${APP_URL||'NOT SET'}`);
  console.log(`   DATA_FILE: ${DATA_FILE} ${DATA_DIR===__dirname?'⚠️  NOT on a persistent volume — will reset on every deploy!':'(persistent volume)'}`);

  const followCount = (initialData.follows?.teams?.length||0) + (initialData.follows?.competitions?.length||0);
  if (followCount > 0) {
    console.log(`   Syncing ${followCount} followed teams/competitions...`);
    syncFixtures().catch(e => console.log('Startup sync error:', e.message));
  }

  if(initialData.settings?.tgToken){
    console.log(`   TG token: set | ChatID: ${initialData.settings.tgChatId||'NOT SET'}`);
    setupCrons(initialData.settings);

    // Always re-register webhook on startup with current APP_URL
    if(APP_URL && initialData.settings.tgToken){
      const webhookUrl = APP_URL.replace(/\/$/,'')+'/webhook/'+initialData.settings.tgToken;
      console.log(`   Registering webhook: ${webhookUrl}`);
      try{
        const r = await fetch(`https://api.telegram.org/bot${initialData.settings.tgToken}/setWebhook`,{
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({url:webhookUrl, drop_pending_updates:false})
        });
        const d = await r.json();
        console.log(`   Webhook result: ${d.ok} — ${d.description||'ok'}`);
        // Send startup notification to user
        await sendTg(initialData.settings.tgToken, initialData.settings.tgChatId,
          '🟢 Personal Organizer bot is online!\nSend /help to see available commands.');
      }catch(e){
        console.log(`   Webhook error: ${e.message}`);
      }
    } else {
      console.log('   ⚠️  APP_URL not set — webhook not registered. Add APP_URL to Railway variables.');
    }
  } else {
    console.log('   ⚠️  No Telegram token in data.json — open the app and configure Telegram settings.');
  }
});
