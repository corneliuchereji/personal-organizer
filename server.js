const express = require('express');
const fs      = require('fs');
const path    = require('path');
const cron    = require('node-cron');
const webpush = require('web-push');
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
    apiFootballKey: '', footballDataKey: '', highlightlyKey: '', tsdbKey: '123'
  },
  follows: { teams: [], competitions: [] }
};

// ═══════════════════════════════════════════════════
// STORAGE
// Two interchangeable backends, chosen automatically:
//
//   1. Upstash Redis (when UPSTASH_REDIS_REST_URL + _TOKEN are set) — lets
//      the app run on hosts with no persistent disk, which is what makes a
//      genuinely free deployment possible.
//   2. Local file (fallback) — used for local development, or any host
//      where a real volume is mounted at DATA_DIR.
//
// readData()/writeData() stay SYNCHRONOUS in both cases so the rest of the
// app is untouched. That works because the whole dataset is small and is
// held in memory: reads are served from the cache, and writes update the
// cache immediately then persist in the background. It also keeps Redis
// command usage tiny (writes only), comfortably inside the free tier.
// ═══════════════════════════════════════════════════
const _startedAt  = new Date().toISOString();
const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL || '';
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const USE_REDIS   = !!(REDIS_URL && REDIS_TOKEN);
const REDIS_KEY   = 'organizer:data';

let _cache = null;        // authoritative in-memory copy
let _writeTimer = null;   // debounce so bursts of saves cost one command
let _writePending = false;

async function redisCmd(command) {
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command)
  });
  if (!r.ok) throw new Error(`Upstash HTTP ${r.status}: ${(await r.text()).slice(0,200)}`);
  const d = await r.json();
  if (d.error) throw new Error('Upstash error: ' + d.error);
  return d.result;
}

// Called once at startup, before the server accepts traffic.
async function initStorage() {
  if (USE_REDIS) {
    try {
      const raw = await redisCmd(['GET', REDIS_KEY]);
      if (raw) {
        _cache = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (_cache._rev === undefined) _cache._rev = Date.now();
        console.log('   Storage: Upstash Redis (loaded existing data)');
      } else {
        _cache = JSON.parse(JSON.stringify(DEFAULT_DATA));
        await redisCmd(['SET', REDIS_KEY, JSON.stringify(_cache)]);
        console.log('   Storage: Upstash Redis (initialised empty dataset)');
      }
      return;
    } catch (e) {
      // Fail loudly rather than silently falling back and appearing to lose
      // everything — a bad token should be obvious, not mysterious.
      console.error('   ✗ Upstash Redis unreachable:', e.message);
      console.error('     Check UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN.');
      throw e;
    }
  }
  // File backend
  ensureDataFile();
  try { _cache = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch (e) { _cache = JSON.parse(JSON.stringify(DEFAULT_DATA)); }
  if (_cache && _cache._rev === undefined) _cache._rev = Date.now();
  console.log(`   Storage: file at ${DATA_FILE}${DATA_DIR===__dirname ? ' ⚠️  NOT on a persistent volume — will reset on every deploy!' : ' (persistent volume)'}`);
}

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

function readData() {
  if (!_cache) return JSON.parse(JSON.stringify(DEFAULT_DATA));
  // Hand back a copy: callers routinely mutate what they get and then pass
  // it to writeData, and sharing the live object would let a half-finished
  // mutation leak into unrelated reads.
  return JSON.parse(JSON.stringify(_cache));
}

function writeData(data) {
  // Every write gets a revision stamp. Clients send back the revision they
  // loaded, which lets the server spot a stale payload and merge instead of
  // blindly overwriting (see /api/data below).
  data._rev = Date.now();
  _cache = data;
  if (!USE_REDIS) {
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); }
    catch(e) { console.log('File write error:', e.message); }
    return;
  }
  // Debounce: several writeData calls in quick succession (common during a
  // sync) collapse into a single Redis command.
  _writePending = true;
  if (_writeTimer) clearTimeout(_writeTimer);
  _writeTimer = setTimeout(flushToRedis, 400);
}

async function flushToRedis() {
  if (!USE_REDIS || !_writePending) return;
  _writePending = false;
  try {
    await redisCmd(['SET', REDIS_KEY, JSON.stringify(_cache)]);
  } catch (e) {
    console.log('Redis write failed, will retry on next write:', e.message);
    _writePending = true; // don't lose the pending state
  }
}

// ═══════════════════════════════════════════════════
// SNAPSHOTS — point-in-time copies kept separately from the live dataset,
// so a bad edit or a failed restore can always be rolled back. Stored under
// their own keys (never nested inside the main record, which would make it
// grow on every backup).
// ═══════════════════════════════════════════════════
const SNAP_PREFIX = 'organizer:snapshot:';
const SNAP_KEEP   = 6;   // keep roughly six months of monthly snapshots
const SNAP_DIR    = path.join(DATA_DIR, 'snapshots');

async function saveSnapshot(label) {
  const id = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
  const payload = JSON.stringify({ id, label: label||'manual', createdAt: new Date().toISOString(), data: _cache });
  if (USE_REDIS) {
    await redisCmd(['SET', SNAP_PREFIX + id, payload]);
  } else {
    try { fs.mkdirSync(SNAP_DIR, { recursive: true }); } catch(e) {}
    fs.writeFileSync(path.join(SNAP_DIR, id + '.json'), payload);
  }
  await pruneSnapshots();
  return id;
}

async function listSnapshots() {
  let ids = [];
  if (USE_REDIS) {
    const keys = await redisCmd(['KEYS', SNAP_PREFIX + '*']) || [];
    ids = keys.map(k => k.replace(SNAP_PREFIX, ''));
  } else {
    try { ids = fs.readdirSync(SNAP_DIR).filter(f=>f.endsWith('.json')).map(f=>f.replace('.json','')); }
    catch(e) { ids = []; }
  }
  return ids.sort().reverse(); // newest first
}

async function getSnapshot(id) {
  if (!/^[\w\-]+$/.test(String(id))) return null; // guard against key/path injection
  if (USE_REDIS) {
    const raw = await redisCmd(['GET', SNAP_PREFIX + id]);
    return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
  }
  try { return JSON.parse(fs.readFileSync(path.join(SNAP_DIR, id + '.json'), 'utf8')); }
  catch(e) { return null; }
}

async function pruneSnapshots() {
  const ids = await listSnapshots();
  const stale = ids.slice(SNAP_KEEP);
  for (const id of stale) {
    try {
      if (USE_REDIS) await redisCmd(['DEL', SNAP_PREFIX + id]);
      else fs.unlinkSync(path.join(SNAP_DIR, id + '.json'));
    } catch(e) {}
  }
  return stale.length;
}

// Sends the backup to Telegram as a downloadable file. This is the part
// that makes it a real backup: the copy lives outside the app entirely, so
// it survives even if the database itself is lost.



// Make sure a pending write isn't lost if the container is stopped.
async function flushAndExit(signal) {
  console.log(`Received ${signal} — flushing pending data…`);
  if (_writeTimer) clearTimeout(_writeTimer);
  try { await flushToRedis(); } catch(e) {}
  process.exit(0);
}
process.on('SIGTERM', () => flushAndExit('SIGTERM'));
process.on('SIGINT',  () => flushAndExit('SIGINT'));

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

// Repeating tasks track completion per occurrence (doneDates), so ticking
// off one month doesn't mark every month done. Non-repeating tasks keep a
// simple boolean.
function isDoneOn(task, ds){
  if(!task) return false;
  if(!task.freq || task.freq==='none') return !!task.done;
  return Array.isArray(task.doneDates) && task.doneDates.includes(ds);
}

function eventsOnDay(data, ds) {
  return [
    ...data.tasks.map(t=>({...t,_type:'task',_occDate:ds,done:isDoneOn(t,ds)})),
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

// Same grouping rule as the app: a match involving a followed TEAM always
// shows on its own with real team names. Everything else that only belongs
// to a followed COMPETITION shows generically as the competition — even a
// single fixture — collapsing multiple same-competition matches into one
// expandable entry.
function collapseSportEventsSrv(data, sportEvs){
  const followedTeamIds = new Set(((data.follows&&data.follows.teams)||[]).map(t=>String(t.providerId)));
  const isTeamMatch = e => e.followType==='team' || (e.home && e.away && (followedTeamIds.has(String(e.home.id)) || followedTeamIds.has(String(e.away.id))));
  const teamSlots = sportEvs.filter(isTeamMatch).map(e=>({...e,_display:'single'}));
  const rest = sportEvs.filter(e=>!isTeamMatch(e));
  const manual = rest.filter(e=>e.source!=='auto').map(e=>({...e,_display:'single'}));
  const autoRest = rest.filter(e=>e.source==='auto');
  // Group by competition AND kick-off time, matching the app exactly: the
  // day view shows a fresh "Serie A" header for each distinct time slot
  // rather than one bucket for the whole day. The briefing previously used
  // day-level grouping, so it didn't mirror what you see on screen.
  const groups = {};
  autoRest.forEach(e=>{
    const key = (e.competitionId || ('single_'+e.id)) + '|' + fmtTime(e.time);
    (groups[key] = groups[key]||[]).push(e);
  });
  const restSlots = Object.values(groups).map(g=>{
    const sorted=[...g].sort((a,b)=>(a.name||'').localeCompare(b.name||''));
    return {
      _type:'sport', _display:'collapsed',
      id:'collapsed_'+(sorted[0].competitionId||sorted[0].id)+'_'+sorted[0].date+'_'+fmtTime(sorted[0].time),
      time: sorted[0].time, name: sorted[0].competitionName || 'Competition',
      competitionId: sorted[0].competitionId, date: sorted[0].date,
      count: sorted.length, fixtures: sorted
    };
  });
  return [...teamSlots, ...manual, ...restSlots];
}

// Same eventsOnDay filtering, but with sport fixtures pre-grouped per the
// rule above, re-sorted with tasks. Used everywhere a Telegram message needs
// "what's happening on day X".
function groupedEventsOnDay(data, ds){
  const tasks = data.tasks.map(t=>({...t,_type:'task',_occDate:ds,done:isDoneOn(t,ds)})).filter(ev=>matchesDate(ev,ds));
  const sportsRaw = (data.sportEvents||[]).map(e=>({...e,_type:'sport'})).filter(ev=>matchesDate(ev,ds));
  const sports = collapseSportEventsSrv(data, sportsRaw);
  return [...tasks, ...sports].sort((a,b)=>{
    const dt=timeToMinutes(a.time)-timeToMinutes(b.time);
    if(dt!==0) return dt;
    if(a._type!==b._type) return a._type==='task'?-1:1;
    return 0;
  });
}

// Maps a group's hex color to the closest Telegram circle emoji — actual
// background colors aren't supported in Bot API messages, so this is the
// nearest visual equivalent.
const CIRCLE_EMOJI = [
  { hex:'#ef4444', e:'🔴' }, { hex:'#f97316', e:'🟠' }, { hex:'#eab308', e:'🟡' },
  { hex:'#22c55e', e:'🟢' }, { hex:'#3b82f6', e:'🔵' }, { hex:'#a855f7', e:'🟣' },
  { hex:'#92400e', e:'🟤' }, { hex:'#111827', e:'⚫' }, { hex:'#e2e8f0', e:'⚪' }
];
function hexToRgb(hex){
  const h = hex.replace('#','');
  return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
}
function colorEmoji(hex){
  if(!hex) return '⚪';
  try{
    const [r,g,b] = hexToRgb(hex);
    // Low-saturation (grayish) colors should map to white/black, not
    // whichever hue happens to be numerically closest in raw RGB space.
    const maxc = Math.max(r,g,b), minc = Math.min(r,g,b);
    if (maxc - minc < 40) {
      const brightness = (r+g+b)/3;
      return brightness > 128 ? '⚪' : '⚫';
    }
    let best=CIRCLE_EMOJI[0], bestD=Infinity;
    for(const c of CIRCLE_EMOJI){
      const [cr,cg,cb] = hexToRgb(c.hex);
      const d = (r-cr)**2 + (g-cg)**2 + (b-cb)**2;
      if(d<bestD){ bestD=d; best=c; }
    }
    return best.e;
  }catch(e){ return '⚪'; }
}
function groupColor(data, groupId){
  const g = (data.groups||[]).find(x=>x.id===groupId);
  return g ? g.color : null;
}

// Formats one agenda line for a task or sport slot, plus an optional inline
// keyboard button for collapsed competition slots (tap to expand).
function formatEventLine(data, ev){
  if(ev._type==='task'){
    const emoji = colorEmoji(groupColor(data, ev.group));
    const g = (data.groups||[]).find(x=>x.id===ev.group);
    let line = emoji+' <b>'+ev.name+'</b> — '+fmtTime(ev.time);
    // Second line mirrors the sub-label under a task card in the app:
    // group, repeat and reminder badges.
    const bits = [];
    if (g) bits.push(g.name);
    if (ev.freq && ev.freq !== 'none') bits.push('🔁 '+ev.freq);
    if (ev.priority && ev.priority !== 'normal') bits.push('⚠️ '+ev.priority);
    const rl = remindersOf(ev);
    if (rl.length) bits.push('🔔 '+rl.sort((a,b)=>b-a).map(reminderLabel).join(', ')+' before');
    if (bits.length) line += '\n   <i>'+bits.join(' · ')+'</i>';
    if (ev.notes) line += '\n   📝 '+ev.notes;
    return { line, button:null };
  }
  // Competition slot — list its fixtures inline, indented, exactly as the
  // app shows them beneath the competition header.
  if(ev._display==='collapsed'){
    let line = '🏆 <b>'+ev.name+'</b> — '+fmtTime(ev.time);
    ev.fixtures.forEach(f=>{
      const score = (f.score && f.score.home!=null) ? '  ('+f.score.home+'-'+f.score.away+')' : '';
      const nm = (f.home && f.away) ? (f.home.name+' vs '+f.away.name) : f.name;
      line += '\n   • '+nm+score;
    });
    const button = ev.count>1
      ? { text:'📋 '+ev.name+' — '+ev.count+' fixtures', callback_data:'fx|'+ev.date+'|'+ev.competitionId }
      : null;
    return { line, button };
  }
  // A followed team's own match — shown on its own, like the highlighted
  // card in the app.
  let line = '⭐ <b>'+ev.name+'</b> — '+fmtTime(ev.time);
  if(ev.competitionName) line += '\n   <i>'+ev.competitionName+'</i>';
  if(ev.score && ev.score.home!=null) line += '  ('+ev.score.home+'-'+ev.score.away+')';
  return { line, button:null };
}

// The message sent when someone taps "View fixtures" on a collapsed
// competition slot in a briefing.
function formatFixtureListMsg(slot){
  const d = new Date(slot.date+'T00:00:00');
  const dateLabel = d.toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long'});
  let msg = '🏆 <b>'+slot.name+'</b>\n'+dateLabel+'\n\n';
  slot.fixtures.forEach(f=>{
    msg += '⏱ '+fmtTime(f.time)+' — <b>'+f.name+'</b>';
    if(f.score && f.score.home!=null) msg += ' (' + f.score.home+'-'+f.score.away+')';
    msg += '\n';
  });
  return msg;
}

// ═══════════════════════════════════════════════════
// TELEGRAM SEND
// ═══════════════════════════════════════════════════
let _lastTgError = null;
async function sendTg(token, chatId, text, replyMarkup) {
  try {
    const body = {chat_id:chatId, text, parse_mode:'HTML'};
    if (replyMarkup) body.reply_markup = replyMarkup;
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(body)
    });
    const d = await r.json();
    if(!d.ok){
      // Keep the reason retrievable — callers only get a boolean, so the
      // actual cause (bad token, blocked bot, wrong chat id) was otherwise
      // only visible in server logs.
      _lastTgError = d.description || 'unknown error';
      console.log('TG error:', _lastTgError);
    } else {
      _lastTgError = null;
    }
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
  const evs   = groupedEventsOnDay(data, today);

  let msg = '📅 <b>Daily briefing — '+dow+', '+dt+'</b>\n\n';
  const buttons = [];
  if(!evs.length) {
    msg += '✨ No events today. Enjoy your day!';
  } else {
    msg += '<b>'+evs.length+' item'+(evs.length>1?'s':'')+' today:</b>\n\n';
    evs.forEach(ev=>{
      const { line, button } = formatEventLine(data, ev);
      msg += line;
      if(ev._type==='task' && ev.notes) msg += '\n   📝 '+ev.notes;
      msg += '\n\n';
      if(button) buttons.push([button]);
    });
  }
  msg += '—\n🗂 Personal Organizer';
  return { msg, buttons };
}

function buildWeeklyMsg(data) {
  const today  = getToday();
  const dt     = new Date().toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'});
  const active = data.tasks.filter(t=>!t.done);
  const sports = data.sportEvents||[];

  let msg = '📆 <b>Weekly summary — '+dt+'</b>\n\n';
  msg += '📋 <b>'+active.length+'</b> active tasks · 🏆 <b>'+sports.length+'</b> sport events\n\n';
  const buttons = [];

  const urgent = active.filter(t=>t.priority==='very');
  const high   = active.filter(t=>t.priority==='high');
  if(urgent.length){ msg+='🚨 <b>URGENT:</b>\n'; urgent.forEach(t=>msg+='• '+t.name+' ('+t.date+')\n'); msg+='\n'; }
  if(high.length)  { msg+='⚠️ <b>High priority:</b>\n'; high.forEach(t=>msg+='• '+t.name+' ('+t.date+')\n'); msg+='\n'; }

  msg += '<b>This week\'s schedule:</b>\n';
  for(let i=0;i<7;i++){
    const ds = addDays(today,i);
    const dayEvs = groupedEventsOnDay(data,ds);
    if(dayEvs.length){
      const dObj = new Date(ds+'T00:00:00');
      msg += '\n<b>'+dObj.toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short'})+'</b>\n';
      dayEvs.forEach(ev=>{
        const { line, button } = formatEventLine(data, ev);
        msg += line+'\n';
        if(button) buttons.push([{ ...button, text: button.text+' ('+new Date(ds+'T00:00:00').toLocaleDateString('en-GB',{day:'numeric',month:'short'})+')' }]);
      });
    }
  }
  msg += '\n—\n🗂 Personal Organizer';
  return { msg, buttons };
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
  // Accept natural phrasing, not just the bare keyword — people type
  // "what do I have today?" far more often than "today".
  if(/^(today|azi|astazi|ast\u0103zi|ce am azi)$/.test(txt)
     || /\b(what|ce)\b.*\b(today|azi|astazi)\b/.test(txt)
     || /\b(schedule|agenda|program)\b.*\b(today|azi)\b/.test(txt)){
    // Uses the same grouped layout as the scheduled briefings, so every
    // view of the day reads the same way as the app itself.
    const evs = groupedEventsOnDay(data, today);
    if(!evs.length) return '📅 Nothing scheduled for today!';
    return '📅 <b>Today:</b>\n\n'+evs.map(e=>formatEventLine(data,e).line).join('\n\n');
  }
  if(/^(tomorrow|maine|m\u00e2ine)$/.test(txt)
     || /\b(what|ce)\b.*\b(tomorrow|maine|m\u00e2ine)\b/.test(txt)){
    const tmr = addDays(today,1);
    const evs = groupedEventsOnDay(data, tmr);
    if(!evs.length) return '📅 Nothing scheduled for tomorrow!';
    return '📅 <b>Tomorrow:</b>\n\n'+evs.map(e=>formatEventLine(data,e).line).join('\n\n');
  }
  if(/^(week|sapt|saptamana|this week)/.test(txt)) return buildWeeklyMsg(data).msg; // buttons not shown via chat command, only scheduled briefings
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
    if(t){
      if(!t.freq || t.freq==='none'){
        t.done=!t.done;
        writeData(data);
        return '✅ Marked <b>'+t.name+'</b> as '+(t.done?'done':'not done');
      }
      // Repeating: toggle just today's occurrence.
      if(!Array.isArray(t.doneDates)) t.doneDates=[];
      const i=t.doneDates.indexOf(today);
      let nowDone;
      if(i===-1){ t.doneDates.push(today); nowDone=true; } else { t.doneDates.splice(i,1); nowDone=false; }
      writeData(data);
      return '✅ Marked <b>'+t.name+'</b> ('+today+') as '+(nowDone?'done':'not done')+'\n<i>Other occurrences are unaffected.</i>';
    }
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
    // Strip trigger words. Done as a repeated loop rather than one fixed
    // pattern because real phrasing stacks fillers in any order — "add a
    // new task for ...", "create an appointment to ..." — and a single
    // regex left fragments like "new task for" behind, which then got
    // picked up as the task name.
    let work = clean.replace(/^event\s*:\s*/i,'').trim();
    const FILLER = /^(?:add|new|create|set|schedule|remind(?:er)?|adauga|pune|a|an|the|task|event|reminder|appointment|me|to|for|un|o)\b[\s:,\-]*/i;
    let guard = 0;
    while (FILLER.test(work) && guard++ < 12) {
      work = work.replace(FILLER,'').trim();
    }

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
      {r:/\b(tomorrow|maine|mâine)\b/i, f:()=>addDays(today,1)},
      {r:/\b(today|azi|astazi|astăzi)\b/i,    f:()=>today},
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

    // 6. Fallback: split on commas. When several descriptive fragments
    //    remain, the FIRST is the task name and the rest become notes —
    //    "go to market, don't forget the bags" should keep both halves
    //    rather than discarding one.
    let extraNotes = '';
    if(!name){
      const parts=work.split(',').map(s=>s.trim()).filter(Boolean);
      const looksLikeMeta = p =>
        /^\d{1,2}[:.\-]\d/.test(p) ||        // 07:00
        /^\d{4}/.test(p) ||                   // 2026...
        /^\d{1,2}\s*(am|pm)$/i.test(p) ||     // 7 PM
        /^(at|la|on)\b/i.test(p) ||           // leftover connectors
        p.length <= 1;
      const candidates = parts.filter(p => !looksLikeMeta(p));
      if(candidates.length){
        name = candidates[0];
        if(candidates.length > 1) extraNotes = candidates.slice(1).join(', ');
      } else {
        name = work;
      }
    }

    // Final cleanup — also drop connectors left dangling once the date or
    // time was removed from the middle of the sentence ("pay bill on" →
    // "pay bill").
    if(name){
      name = name.replace(/^[,\s\-–:]+/,'').replace(/[,\s\-–:]+$/,'').trim();
      name = name.replace(/\s+\b(on|at|la|pe|in|the|de)\b$/i,'').trim();
      name = name.replace(/^\b(on|at|la|pe|in|the|de)\b\s+/i,'').trim();
    }

    if(!name) return '❓ What should I call this?\nExamples:\n<code>add task dentist tomorrow at 10:00</code>\n<code>add task: tomorrow, 6AM, named: dentist</code>\n<code>add event: 12-08-2026, 22:00, Supercupa Europei</code>';

    const groups=data.groups||[];
    const grp=groups.find(g=>g.id===guessGroup(name))||groups[0]||{id:'g_pers'};
    data.tasks.push({id:uid(),name,date,time,freq:'none',priority:guessPriority(raw),group:grp.id,notes:extraNotes||'',done:false});
    writeData(data);
    return '\u2705 Task added:\n\ud83d\udccb <b>'+name+'</b>\n\ud83d\udcc5 '+(date===today?'Today':date)+' at '+time+(extraNotes?'\n\ud83d\udcdd '+extraNotes:'');
  }
  return '❓ I didn\'t understand that.\nSend /help to see what I can do.';
}

// ═══════════════════════════════════════════════════
// WEBHOOK — Telegram sends messages here
// ═══════════════════════════════════════════════════


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
// Reports which build is actually running. Deploy problems are otherwise
// invisible — the app looks fine while serving stale code — so this gives
// a definitive answer instead of inferring it from behaviour.
const BUILD_VERSION = '2026-10-02-bible-dialog-scroll-fix';
// ═══════════════════════════════════════════════════
// WEB PUSH — notifications that arrive when the app is closed, without
// depending on Telegram. VAPID keys are generated once and kept in
// settings, so there's no extra environment setup: losing them would
// invalidate every existing subscription, which is why they're persisted
// rather than regenerated per boot.
// ═══════════════════════════════════════════════════
let _vapidReady = false;
function ensureVapid() {
  const d = readData();
  if (!d.settings) d.settings = {};
  if (!d.settings.vapidPublicKey || !d.settings.vapidPrivateKey) {
    const keys = webpush.generateVAPIDKeys();
    d.settings.vapidPublicKey = keys.publicKey;
    d.settings.vapidPrivateKey = keys.privateKey;
    writeData(d);
    console.log('   Generated new VAPID keys for web push.');
  }
  webpush.setVapidDetails(
    'mailto:organizer@example.com',
    d.settings.vapidPublicKey,
    d.settings.vapidPrivateKey
  );
  _vapidReady = true;
  return d.settings.vapidPublicKey;
}

app.get('/api/push/key', (req, res) => {
  try { res.json({ key: ensureVapid() }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/push/subscribe', (req, res) => {
  try {
    const sub = req.body && req.body.subscription;
    if (!sub || !sub.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
    const d = readData();
    if (!Array.isArray(d.pushSubs)) d.pushSubs = [];
    // Endpoint uniquely identifies a browser/device, so replace rather than
    // duplicate when the same device re-subscribes.
    d.pushSubs = d.pushSubs.filter(x => x.endpoint !== sub.endpoint);
    d.pushSubs.push({ ...sub, label: (req.body.label||'device'), addedAt: new Date().toISOString() });
    writeData(d);
    res.json({ ok:true, devices: d.pushSubs.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/push/unsubscribe', (req, res) => {
  try {
    const endpoint = req.body && req.body.endpoint;
    const d = readData();
    d.pushSubs = (d.pushSubs||[]).filter(x => x.endpoint !== endpoint);
    writeData(d);
    res.json({ ok:true, devices: d.pushSubs.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/push/status', (req, res) => {
  const d = readData();
  res.json({
    configured: !!(d.settings && d.settings.vapidPublicKey),
    devices: (d.pushSubs||[]).map(s=>({ label:s.label, addedAt:s.addedAt, endpoint:s.endpoint.slice(0,40)+'…' }))
  });
});

// Sends to each device individually and reports exactly what the push
// service said. sendWebPush() quietly prunes rejected subscriptions, which
// made a VAPID-key mismatch look like "no devices" — the cause was invisible.
app.post('/api/push/test', async (req, res) => {
  try {
    const d = readData();
    const subs = d.pushSubs || [];
    if (!subs.length) return res.json({ ok:true, sent:0, devices:[], note:'No devices registered.' });
    if (!_vapidReady) ensureVapid();
    const payload = JSON.stringify({ title:'🔔 Test notification', body:'If you can see this, web push is working.' });
    const results = [];
    for (const sub of subs) {
      const host = (()=>{ try { return new URL(sub.endpoint).host; } catch(e){ return 'unknown'; } })();
      try {
        await webpush.sendNotification(sub, payload);
        results.push({ label: sub.label||'device', host, ok:true });
      } catch(e) {
        results.push({
          label: sub.label||'device', host, ok:false,
          status: e.statusCode || null,
          error: (e.body && String(e.body).slice(0,160)) || e.message,
          meaning: e.statusCode===410 || e.statusCode===404
            ? 'Subscription expired or was removed by the device — re-enable on that device.'
            : (e.statusCode===403
               ? 'VAPID key mismatch — the subscription was created with a different key. Re-enable on that device.'
               : null)
        });
      }
    }
    res.json({ ok:true, sent: results.filter(r=>r.ok).length, devices: results });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Sends to every subscribed device. Subscriptions that the push service
// reports as gone (404/410) are pruned automatically — otherwise a
// reinstalled browser would leave dead entries that fail forever.
async function sendWebPush(title, body, data, opts) {
  const d = readData();
  const subs = d.pushSubs || [];
  if (!subs.length) return 0;
  if (!_vapidReady) ensureVapid();
  const payload = JSON.stringify({ title, body, data: data||{} });
  // Time-to-live: how long the push service may hold the message for an
  // offline device. The library default is FOUR WEEKS — so a laptop that
  // was shut for hours received every queued reminder in one burst on
  // wake. A reminder is worthless once its event has started, so callers
  // pass a TTL matching that; anything else defaults to one hour.
  const ttl = Math.max(60, Math.floor((opts && opts.ttl) || 3600));
  let sent = 0;
  const dead = [];
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, payload, { TTL: ttl, urgency: (opts && opts.urgency) || 'normal' });
      sent++;
    } catch(e) {
      if (e.statusCode === 404 || e.statusCode === 410) dead.push(sub.endpoint);
      else console.log('Push failed:', e.statusCode || e.message);
    }
  }
  if (dead.length) {
    const cur = readData();
    cur.pushSubs = (cur.pushSubs||[]).filter(x => !dead.includes(x.endpoint));
    writeData(cur);
    console.log(`   Pruned ${dead.length} expired push subscription(s).`);
  }
  return sent;
}

// Shows exactly what the reminder cron sees: server clock, every item with
// a reminder set, when each is due to fire, and why it is or isn't firing.
// Reminder problems are otherwise invisible — nothing arrives and there's
// no way to tell whether the cron, the data, or delivery is at fault.
app.get('/api/reminders/debug', (req, res) => {
  try {
    const d = readData();
    const nowMs = Date.now();
    const days = [getToday(), addDays(getToday(),1)];
    const sent = d.sentReminders || {};
    const rows = [];
    const candidates = [
      ...(d.tasks||[]).map(t=>({...t,_type:'task'})),
      ...(d.sportEvents||[]).map(e=>({...e,_type:'sport'}))
    ];
    for (const ev of candidates) {
      for (const mins of remindersOf(ev)) {
      for (const ds of days) {
        if (!matchesDate(ev, ds)) continue;
        const startMs = eventStartMs({ ...ev, date: ds });
        const fireMs = startMs - mins*60000;
        const key = ev.id + '|' + ds + '|' + mins;
        let status;
        if (isNaN(startMs)) status = 'BAD DATE/TIME';
        else if (ev._type==='task' && isDoneOn(ev, ds)) status = 'skipped (marked done)';
        else if (sent[key]) status = 'already sent';
        else if (startMs <= nowMs) status = 'event already started';
        else if (fireMs > nowMs) status = 'waiting — fires in '+Math.round((fireMs-nowMs)/60000)+' min';
        else if (nowMs - fireMs >= 10*60000) status = 'MISSED (fire time passed >10 min ago)';
        else status = 'DUE NOW';
        rows.push({
          name: ev.name, type: ev._type, date: ds, time: fmtTime(ev.time),
          reminderMins: mins,
          startsAt: isNaN(startMs)? null : new Date(startMs).toISOString(),
          firesAt:  isNaN(fireMs) ? null : new Date(fireMs).toISOString(),
          status
        });
      }
      }
    }
    res.json({
      serverTimeUTC: new Date(nowMs).toISOString(),
      serverTimeLocal: new Date(nowMs).toLocaleString('en-GB',{timeZone:'Europe/Bucharest'}),
      serverTZ: process.env.TZ || '(not set — should be Europe/Bucharest)',
      todayAccordingToServer: getToday(),
      telegramConfigured: !!(d.settings && d.settings.tgToken && d.settings.tgChatId),
      pushDevices: (d.pushSubs||[]).length,
      itemsWithReminders: rows.length,
      sentCount: Object.keys(sent).length,
      // Why the last failed delivery failed — the thing that was
      // previously only visible in server logs.
      recentDeliveryErrors: d.reminderErrors || {},
      items: rows
    });
  } catch(e) { res.status(500).json({ error: e.message, stack:(e.stack||'').split('\n').slice(0,4).join(' | ') }); }
});

// Sends a reminder-style message through BOTH channels right now and
// reports precisely what happened to each. Unlike the individual test
// buttons, this mirrors what the reminder cron actually does.
app.post('/api/reminders/test-delivery', async (req, res) => {
  // Telegram has been retired, so this now exercises web push only.
  const out = { telegram: { ok:false, error:'Telegram removed' }, push: {} };
  try {
    const n = await sendWebPush('⏰ Delivery test', 'If you can see this, reminders work.');
    out.push = { ok: n>0, devices: n, error: n===0 ? 'No subscribed devices' : null };
  } catch(e) { out.push = { ok:false, error:e.message }; }
  out.summary = out.push.ok ? 'Push delivered.' : 'Push failed — see the error above.';
  res.json(out);
});


app.get('/api/version', (req, res) => {
  res.json({
    version: BUILD_VERSION,
    features: {
      taskNotesFromCommas: true,
      perOccurrenceRecurringDone: true,
      staleWriteMerge: true,
      upstashStorage: USE_REDIS,
      snapshots: true
    },
    startedAt: _startedAt
  });
});

// In-app chat uses the SAME parser as Telegram, so both entry points
// behave identically — previously the browser had its own weaker parser
// and the two could disagree about the same sentence.
app.post('/api/chat', async (req, res) => {
  try {
    const text = (req.body && req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'No text' });
    const data = readData();
    const reply = await processTgCommand(text, data);
    res.json({ reply, _rev: readData()._rev });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/data', (req, res) => res.json(readData()));

app.post('/api/data', (req, res) => {
  const current = readData();
  const updated = {...current, ...req.body};

  // Settings must be MERGED, not replaced. The spread above is shallow, so
  // a client payload would otherwise drop every server-owned setting the
  // browser doesn't know about — most damagingly the VAPID keys, whose
  // regeneration silently invalidates every existing push subscription.
  if (req.body.settings) {
    updated.settings = { ...(current.settings||{}), ...req.body.settings };
    // Belt and braces: never let these be cleared by a client write.
    if (current.settings) {
      if (current.settings.homeLat)  updated.settings.homeLat  = current.settings.homeLat;
      if (current.settings.homeLon)  updated.settings.homeLon  = current.settings.homeLon;
      if (current.settings.homeName) updated.settings.homeName = current.settings.homeName;
      if (current.settings.homeAddress) updated.settings.homeAddress = current.settings.homeAddress;
      if (current.settings.orsKey) updated.settings.orsKey = current.settings.orsKey;
      if (current.settings.vapidPublicKey)  updated.settings.vapidPublicKey  = current.settings.vapidPublicKey;
      if (current.settings.vapidPrivateKey) updated.settings.vapidPrivateKey = current.settings.vapidPrivateKey;
    }
  }
  // Push subscriptions are server-owned too.
  if (!req.body.pushSubs) updated.pushSubs = current.pushSubs || [];
  // Travel results are server-owned, like pushSubs — a client save must
  // not clear them (the browser never sends this field).
  if (!req.body.travelCache) updated.travelCache = current.travelCache || {};

  // A client sends the revision it last loaded. If the server has moved on
  // since (another device saved, or Telegram added something), this payload
  // is stale and must NOT be treated as the truth — otherwise a phone with
  // yesterday's list silently deletes everything added elsewhere. Merging
  // by id keeps both sides' work; the cost is that a deletion made against
  // a stale view won't apply, which is the safe direction to fail.
  // Stale unless the client can PROVE it saw the latest revision. A missing
  // revision used to count as "fresh", which let a queued offline edit
  // (or any client that loaded before the first write) overwrite newer
  // data from another device. Unproven edits are now merged, never trusted.
  const clientRev = req.body._rev;
  const isStale = current._rev !== undefined && clientRev !== current._rev;

  if (req.body.tasks) {
    if (isStale) {
      const byId = new Map((current.tasks||[]).map(t=>[t.id,t]));
      for (const t of req.body.tasks) byId.set(t.id, t); // client edits win for tasks it knows
      updated.tasks = [...byId.values()];
      console.log(`Stale save merged: client rev ${clientRev} vs server ${current._rev} — tasks ${(req.body.tasks||[]).length} + server-only kept => ${updated.tasks.length}`);
    } else {
      updated.tasks = req.body.tasks;
    }
  }

  if (req.body.sportEvents) {
    // The client only ever sends its MANUAL sport entries — auto-synced
    // fixtures are exclusively managed by syncFixtures(). Naively replacing
    // sportEvents with the client's payload would silently wipe every
    // auto-synced fixture on every ordinary save (e.g. the weather widget
    // auto-saving your location on page load). Preserve them here instead.
    const autoExisting = (current.sportEvents||[]).filter(e=>e.source==='auto');
    if (isStale) {
      const manualById = new Map((current.sportEvents||[]).filter(e=>e.source!=='auto').map(e=>[e.id,e]));
      for (const e of req.body.sportEvents) manualById.set(e.id, e);
      updated.sportEvents = [...manualById.values(), ...autoExisting];
    } else {
      updated.sportEvents = [...req.body.sportEvents, ...autoExisting];
    }
  }

  // sentReminders is server-owned bookkeeping (which reminders already
  // fired) — the client never manages it, so never let a client payload
  // clear it, or reminders would re-fire after every save.
  updated.sentReminders = current.sentReminders || {};
  writeData(updated);
  if(req.body.settings) setupCrons(updated.settings);
  res.json({ok:true, _rev: updated._rev, merged: isStale});
});

// Settings-only save. The weather widget persists your chosen location on
// load/refresh; routing that through the full save was what let a stale
// browser tab clobber tasks added on another device. This touches nothing
// but settings.
app.post('/api/settings', (req, res) => {
  const current = readData();
  current.settings = { ...(current.settings||{}), ...(req.body||{}) };
  writeData(current);
  setupCrons(current.settings);
  res.json({ ok:true, _rev: current._rev });
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
//   Football        → Highlightly — 100 req/day free, any league/team, lineups/stats/standings
//                      for 12 major competitions, no lineups/live stats
//   Everything else → TheSportsDB — schedule/basic result only
// ═══════════════════════════════════════════════════
// Highlightly — free tier: 100 requests/day, covers 950+ leagues in 170+
// countries, any club or national team, with lineups/stats/standings/live
// events included, for any team or competition worldwide.
// Highlightly — one API key works across all their sport-specific APIs
// (football, handball, basketball, etc.) — same schema, same auth, just a
// different subdomain per sport. Free tier: 100 requests/day, SHARED across
// every Highlightly sport used.
const HL_BASES = { football:'https://soccer.highlightly.net', handball:'https://handball.highlightly.net' };
function hlBase(sport){ return HL_BASES[sport]; }
// Sports on the "other" side all live under TheSportsDB's "Motorsport" bucket
// except cycling, snooker and darts which have their own sport names there.
const TSDB_SPORT_MAP = {
  motorsport:'Motorsport', f1:'Motorsport', motogp:'Motorsport', wec:'Motorsport',
  imsa:'Motorsport', endurance:'Motorsport',
  cycling:'Cycling', snooker:'Snooker', darts:'Darts'
};

function tsdbKeyOf(data){
  const k = data.settings && data.settings.tsdbKey;
  // '3' was an older shared test key that's since become unreliable —
  // auto-upgrade anyone still storing it to the current one, '123'.
  return (!k || k === '3') ? '123' : k;
}
// TheSportsDB's free tier is occasionally flaky (intermittent 503s even on
// known-good requests) — retry once after a short pause before giving up.
async function fetchTsdbWithRetry(url, attempts=2){
  let lastErr;
  for (let i=0;i<attempts;i++){
    try{
      const r = await fetch(url);
      const text = await r.text();
      try { return JSON.parse(text); }
      catch { lastErr = `HTTP ${r.status}: ${text.slice(0,200)}`; }
    } catch(e){ lastErr = e.message; }
    if (i < attempts-1) await sleep(1500);
  }
  return { error: lastErr };
}
function hlKeyOf(data){ return data.settings && data.settings.highlightlyKey; }
function hlHeaders(key){ return { 'x-rapidapi-key': key }; }

// football-data.org — used specifically for the major COMPETITIONS
// (Premier League, La Liga, Serie A, Bundesliga, Champions League, etc).
// Proven reliable for this after removing the status filter (matches move
// through SCHEDULED→TIMED→IN_PLAY→FINISHED and filtering to one status
// caused fixtures to silently disappear — fixed by fetching everything and
// filtering by date range ourselves instead). Highlightly's competition-
// level endpoint has a pagination quirk that doesn't reliably surface
// near-term matches, so competitions specifically stay on football-data.org
// while TEAM/national-squad follows stay on Highlightly (works great there).
const FD_BASE = 'https://api.football-data.org/v4';
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
function fdKeyOf(data){ return data.settings && data.settings.footballDataKey; }

// Looks a football-data.org competition up on Highlightly by name and
// returns its near-term matches — used as an automatic fallback when
// football-data.org has no fixtures in our window for that competition.
async function hlFallbackForCompetition(follow, hlKey, windowStartMs, windowEndMs){
  try{
    const base = hlBase('football');
    const headers = hlHeaders(hlKey);
    const r = await fetch(`${base}/leagues?leagueName=${encodeURIComponent(follow.name)}&limit=5`, { headers });
    const d = await r.json();
    if (!d.data || !d.data.length) return null;
    // Prefer an exact-ish name match to avoid picking a same-named league
    // from a different country.
    const wanted = follow.name.toLowerCase();
    const league = d.data.find(l=>(l.name||'').toLowerCase()===wanted) || d.data[0];
    const res = await hlFetchCompetitionMatches(base, headers, league.id, windowStartMs, windowEndMs);
    if (res.error) return null;
    return res.data.filter(m=>{ const t=new Date(m.date).getTime(); return t>=windowStartMs && t<=windowEndMs; });
  }catch(e){ return null; }
}
function normalizeFDMatch(m, followType, followId) {
  const dt = new Date(m.utcDate);
  const _p = toBucharestParts(dt); if(!_p) return null;
  const { date, time } = _p;
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

// Fetches Highlightly matches for a query, retrying without the season
// param if the first attempt comes back empty — a brand-new season isn't
// always indexed under the current year yet (same issue we hit with other
// providers), so this avoids reporting "0 fixtures" when data does exist
// under a different season labeling.
async function hlFetchMatches(base, headers, params){
  const year = new Date().getFullYear();
  const qs1 = new URLSearchParams({ ...params, season:String(year), limit:'100' });
  let r = await fetch(`${base}/matches?${qs1}`, { headers });
  let d = await r.json();
  if (d.message && !d.data) return { error: d.message };
  if ((d.data||[]).length === 0) {
    const qs2 = new URLSearchParams({ ...params, limit:'100' });
    r = await fetch(`${base}/matches?${qs2}`, { headers });
    d = await r.json();
    if (d.message && !d.data) return { error: d.message };
  }
  return { data: d.data||[] };
}
// Competition-level match lists don't reliably start from "today" — a full
// season easily exceeds the 100-match page size, and the first page can
// land anywhere in the season rather than the near-term games we actually
// want (confirmed directly: Premier League's first page was entirely
// Oct–Dec while near-term August fixtures existed elsewhere). So page
// through (capped, to protect the shared daily quota) until a page
// actually contains something inside our target window, or we run out of
// pages/budget.
async function hlFetchCompetitionMatches(base, headers, leagueId, windowStartMs, windowEndMs, maxPages=3){
  const inWindow = m => { const t=new Date(m.date).getTime(); return t>=windowStartMs && t<=windowEndMs; };
  let all = [];
  for (let page=0; page<maxPages; page++){
    const offset = page*100;
    const qs = new URLSearchParams({ leagueId:String(leagueId), limit:'100', offset:String(offset) });
    let r, d;
    try {
      r = await fetch(`${base}/matches?${qs}`, { headers });
      d = await r.json();
    } catch(e) { return { error: e.message }; }
    if (d.message && !d.data) return page===0 ? { error: d.message } : { data: all }; // later pages failing just means we stop, not a hard error
    const batch = d.data || [];
    all = all.concat(batch);
    const hasWindowHit = batch.some(inWindow);
    if (batch.length < 100) break; // reached the end of the dataset
    if (hasWindowHit) break; // found our target range — no need to keep paging
    await sleep(600);
  }
  return { data: all };
}
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

// GET /api/sports/search?sport=football&kind=team&q=Milan
// GET /api/sports/search?sport=motorsport&kind=competition&q=MotoGP
app.get('/api/sports/search', async (req, res) => {
  const { sport, kind, q } = req.query; // kind: 'team' | 'competition'
  const data = readData();
  try {
    if (sport === 'motogp_official') {
      // No search needed — the whole championship calendar is one thing to follow.
      if (kind === 'team') return res.json({ error: 'The MotoGP calendar only supports following the whole championship, not individual riders.' });
      return res.json({ results: [{ id:'motogp', name:'MotoGP World Championship (race weekends)', logo:'', country:'' }] });
    }
    if (sport === 'football' && kind === 'competition') {
      // Fixed free-tier list from football-data.org — no API call needed, so
      // it's never rate-limited, and its date-window matches are reliable.
      let list = FD_FREE_COMPETITIONS;
      if (q && q.trim()) list = list.filter(c=>c.name.toLowerCase().includes(q.trim().toLowerCase()));
      return res.json({ results: list.map(c=>({ id:c.code, name:c.name, logo:`https://crests.football-data.org/${c.code}.png`, country:c.country })) });
    }
    if (sport === 'football' || sport === 'handball') {
      const key = hlKeyOf(data);
      if (!key) return res.status(400).json({ error: 'Add your Highlightly API key in Settings first.' });
      if (!q || q.trim().length < 2) return res.json({ results: [] });
      const headers = hlHeaders(key);
      const base = hlBase(sport);
      if (kind === 'competition') {
        // Handball competitions still go through Highlightly (football-data.org doesn't cover it).
        const r = await fetch(`${base}/leagues?leagueName=${encodeURIComponent(q.trim())}&limit=20`, { headers });
        const d = await r.json();
        if (d.message && !d.data) return res.status(400).json({ error: d.message });
        const results = (d.data||[]).map(l=>({ id:l.id, name:l.name, logo:l.logo||'', country: l.country && l.country.name }));
        return res.json({ results });
      }
      // Team search (both sports) — works for both clubs and national squads in one search.
      const r = await fetch(`${base}/teams?name=${encodeURIComponent(q.trim())}&limit=20`, { headers });
      const d = await r.json();
      if (d.message && !d.data) return res.status(400).json({ error: d.message });
      const results = (d.data||[]).map(t=>({ id:t.id, name:t.name + (t.type && t.type!=='club' ? ' (National team)' : ''), logo:t.logo||'', country:'' }));
      return res.json({ results });
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

// GET /api/sports/competition-teams?sport=football&leagueId=X
// Lists every club currently in a competition, via its standings table —
// lets someone browse "who's in the Premier League" and follow specific
// clubs directly, instead of only following the whole competition.
app.get('/api/sports/competition-teams', async (req, res) => {
  const { sport, leagueId } = req.query;
  const data = readData();
  const key = hlKeyOf(data);
  if (!key) return res.status(400).json({ error: 'Add your Highlightly API key in Settings first.' });
  if (!leagueId) return res.status(400).json({ error: 'Missing leagueId' });
  const base = hlBase(sport) || hlBase('football');
  const headers = hlHeaders(key);
  try {
    // Season isn't always the current calendar year — resolve it from the
    // league's own reported seasons if the obvious guess comes back empty.
    const year = new Date().getFullYear();
    async function tryStandings(season){
      const r = await fetch(`${base}/standings?leagueId=${leagueId}&season=${season}`, { headers });
      const d = await r.json();
      const groups = d.groups || (Array.isArray(d) ? d : []);
      return groups;
    }
    let groups = await tryStandings(year);
    let flatTeams = (groups||[]).flatMap(g=>(g.standings||g.table||[])).map(t=>t.team).filter(Boolean);
    if (!flatTeams.length) {
      // Fall back to whatever season the league itself last reported.
      const lr = await fetch(`${base}/leagues/${leagueId}`, { headers });
      const ld = await lr.json();
      const league = Array.isArray(ld) ? ld[0] : ld;
      const seasons = (league && league.seasons) || [];
      const latestSeason = seasons.length ? Math.max(...seasons.map(s=>s.season||s)) : null;
      if (latestSeason) {
        groups = await tryStandings(latestSeason);
        flatTeams = (groups||[]).flatMap(g=>(g.standings||g.table||[])).map(t=>t.team).filter(Boolean);
      }
    }
    const seen = new Set();
    const teams = [];
    flatTeams.forEach(t=>{ if(t && !seen.has(t.id)){ seen.add(t.id); teams.push({ id:t.id, name:t.name, logo:t.logo||'' }); } });
    if (!teams.length) return res.json({ results: [], note:'No standings/team list available for this competition (may be a cup or international tournament without a season-long table).' });
    res.json({ results: teams });
  } catch(e) { res.status(500).json({ error: e.message }); }
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
  const provider = (sport === 'football' && kind === 'competition') ? 'football-data'
    : (sport === 'football' || sport === 'handball') ? 'highlightly'
    : (sport === 'motogp_official') ? 'motogp' : 'thesportsdb';
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

// One-off seed for AC Milan's 2026-27 Europa League league-phase fixtures.
// Stored as MANUAL events (source:'manual') so the fixture sync never wipes
// them. Kickoff times below are already converted from Italian local time
// to Romanian local time — Italy and Romania observe DST on identical
// dates, so the offset is a constant +1 hour for every fixture here.
const ACM_EL_FIXTURES = [
  { date:'2026-09-16', time:'22:00', home:'AC Milan',      away:'S.L. Benfica' },
  { date:'2026-10-15', time:'19:45', home:'Salzburg',      away:'AC Milan' },
  { date:'2026-10-22', time:'22:00', home:'Bournemouth',   away:'AC Milan' },
  { date:'2026-11-05', time:'19:45', home:'AC Milan',      away:'Ferencváros' },
  { date:'2026-11-26', time:'19:45', home:'Olympiacos',    away:'AC Milan' },
  { date:'2026-12-10', time:'22:00', home:'AC Milan',      away:'Sunderland' },
  { date:'2027-01-21', time:'22:00', home:'Levski Sofia',  away:'AC Milan' },
  { date:'2027-01-28', time:'22:00', home:'AC Milan',      away:'Ararat-Armenia' }
];
// Removes auto-synced fixtures that share an identical date+time with
// other fixtures involving the same team — the signature of a provider
// placeholder date (a whole campaign stamped onto one slot). Manual events
// are never touched.
// ═══════════════════════════════════════════════════
// BACKUP / RESTORE — lets the whole dataset be exported as a file and
// re-imported on another host, so migrating between platforms doesn't
// mean losing tasks, follows, settings and imported fixtures.
// ═══════════════════════════════════════════════════
app.get('/api/backup', (req, res) => {
  try {
    const d = readData();
    const stamp = new Date().toISOString().slice(0,10);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="organizer-backup-${stamp}.json"`);
    res.send(JSON.stringify(d, null, 2));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/restore', (req, res) => {
  try {
    const incoming = req.body;
    if (!incoming || typeof incoming !== 'object') return res.status(400).json({ error: 'Body must be a JSON object' });
    // Basic shape check so a wrong file can't wipe everything silently.
    if (!Array.isArray(incoming.tasks) && !Array.isArray(incoming.sportEvents) && !incoming.settings) {
      return res.status(400).json({ error: "This doesn't look like an organizer backup (no tasks/sportEvents/settings)." });
    }
    const current = readData();
    const merged = {
      tasks: Array.isArray(incoming.tasks) ? incoming.tasks : (current.tasks||[]),
      sportEvents: Array.isArray(incoming.sportEvents) ? incoming.sportEvents : (current.sportEvents||[]),
      groups: Array.isArray(incoming.groups) && incoming.groups.length ? incoming.groups : current.groups,
      follows: incoming.follows || current.follows || { teams:[], competitions:[] },
      settings: { ...(current.settings||{}), ...(incoming.settings||{}) },
      sentReminders: incoming.sentReminders || current.sentReminders || {}
    };
    writeData(merged);
    if (merged.settings) setupCrons(merged.settings);
    res.json({
      ok:true,
      tasks: merged.tasks.length,
      sportEvents: merged.sportEvents.length,
      follows: (merged.follows.teams||[]).length + (merged.follows.competitions||[]).length
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Snapshots: list / create / restore / send-to-Telegram ──
app.get('/api/snapshots', async (req, res) => {
  try {
    const ids = await listSnapshots();
    const out = [];
    for (const id of ids) {
      const s = await getSnapshot(id);
      if (!s) continue;
      out.push({
        id,
        label: s.label || 'manual',
        createdAt: s.createdAt || null,
        tasks: (s.data && s.data.tasks || []).length,
        sportEvents: (s.data && s.data.sportEvents || []).length
      });
    }
    res.json({ snapshots: out, keeping: SNAP_KEEP });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/snapshots', async (req, res) => {
  try {
    const id = await saveSnapshot((req.body && req.body.label) || 'manual');
    res.json({ ok:true, id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/snapshots/:id/restore', async (req, res) => {
  try {
    const snap = await getSnapshot(req.params.id);
    if (!snap || !snap.data) return res.status(404).json({ error: 'Snapshot not found' });
    // Save a safety snapshot of the CURRENT state first, so restoring the
    // wrong one is itself reversible.
    await saveSnapshot('pre-restore');
    writeData(snap.data);
    if (snap.data.settings) setupCrons(snap.data.settings);
    res.json({
      ok:true,
      tasks: (snap.data.tasks||[]).length,
      sportEvents: (snap.data.sportEvents||[]).length
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/snapshots/:id/download', async (req, res) => {
  try {
    const snap = await getSnapshot(req.params.id);
    if (!snap || !snap.data) return res.status(404).json({ error: 'Snapshot not found' });
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="organizer-${req.params.id}.json"`);
    res.send(JSON.stringify(snap.data, null, 2));
  } catch(e) { res.status(500).json({ error: e.message }); }
});



app.post('/api/sports/purge-placeholders', (req, res) => {
  try {
    const d = readData();
    const auto = (d.sportEvents||[]).filter(e => e.source === 'auto');
    const others = (d.sportEvents||[]).filter(e => e.source !== 'auto');
    // Count, per team, how many fixtures fall on each exact date+time slot.
    const teamSlot = {};
    auto.forEach(e => {
      const slot = e.date+'T'+e.time;
      [e.home && e.home.name, e.away && e.away.name].filter(Boolean).forEach(team => {
        const k = team+'|'+slot;
        teamSlot[k] = (teamSlot[k]||0)+1;
      });
    });
    const isPlaceholder = e => {
      const slot = e.date+'T'+e.time;
      return [e.home && e.home.name, e.away && e.away.name].filter(Boolean)
        .some(team => teamSlot[team+'|'+slot] > 1);
    };
    const kept = auto.filter(e => !isPlaceholder(e));
    const removed = auto.length - kept.length;
    d.sportEvents = [...others, ...kept];
    writeData(d);
    res.json({ ok:true, removed, remaining: d.sportEvents.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sports/seed-acm-el', (req, res) => {
  try {
    const d = readData();
    if (!d.sportEvents) d.sportEvents = [];
    let added = 0, skipped = 0;
    for (const f of ACM_EL_FIXTURES) {
      const id = 'acmel_' + f.date;
      if (d.sportEvents.find(e => e.id === id)) { skipped++; continue; }
      d.sportEvents.push({
        id, source:'manual', provider:'manual', sport:'football', freq:'none',
        date: f.date, time: f.time,
        name: f.home + ' vs ' + f.away,
        home: { name: f.home, logo:'' },
        away: { name: f.away, logo:'' },
        competitionId: null,
        competitionName: 'UEFA Europa League', competitionLogo: '',
        followType: 'team',   // renders as a highlighted card, like other AC Milan games
        status: 'Not started', score: null,
        notes: '', color: '#f97316'
      });
      added++;
    }
    writeData(d);
    res.json({ ok:true, added, skipped, total: ACM_EL_FIXTURES.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sports/sync-now', async (req, res) => {
  try { const { count, log } = await syncFixtures(); res.json({ ok:true, synced:count, log }); }
  catch(e){
    console.log('Sync-now failed:', e.stack || e.message);
    res.status(500).json({ error: e.message, stack: (e.stack||'').split('\n').slice(0,5).join(' | ') });
  }
});

// One-off raw diagnostic against Highlightly, using whatever key is
// currently saved in Settings — shows exact HTTP status + body for a few
// representative calls so we can see precisely what the account allows.
app.get('/api/sports/debug-football', async (req, res) => {
  const d = readData();
  const key = hlKeyOf(d);
  if (!key) return res.json({ error: 'No Highlightly key saved in Settings.' });
  const headers = hlHeaders(key);
  const year = new Date().getFullYear();
  const tests = [
    { label:'League search (Serie A)', url:`${hlBase('football')}/leagues?leagueName=Serie%20A&limit=5` },
    { label:'Team search (AC Milan)', url:`${hlBase('football')}/teams?name=Milan&limit=5` },
    { label:'AC Milan matches (with season)', url:`${hlBase('football')}/matches?homeTeamId=458&season=${year}&limit=5` },
    { label:'AC Milan matches (no season)', url:`${hlBase('football')}/matches?homeTeamId=458&limit=5` },
    { label:'Handball: league search (EHF)', url:`${hlBase('handball')}/leagues?leagueName=EHF&limit=5` }
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

// Diagnostic specifically for the "competition follow shows almost nothing"
// bug: searches for the named league, then pulls its match list both with
// and without a season param, and summarizes total counts + date range so
// we can see exactly what's being returned instead of guessing.
app.get('/api/sports/debug-competition', async (req, res) => {
  const d = readData();
  const key = hlKeyOf(d);
  if (!key) return res.json({ error: 'No Highlightly key saved in Settings.' });
  const sport = req.query.sport || 'football';
  const leagueName = req.query.name || 'Serie A';
  const base = hlBase(sport);
  const headers = hlHeaders(key);
  const year = new Date().getFullYear();
  try {
    const lr = await fetch(`${base}/leagues?leagueName=${encodeURIComponent(leagueName)}&limit=5`, { headers });
    const ld = await lr.json();
    const league = ld.data && ld.data[0];
    if (!league) return res.json({ error: 'League not found: '+leagueName, raw: ld });

    async function summarize(url){
      const r = await fetch(url, { headers });
      const d2 = await r.json();
      if (d2.message && !d2.data) return { error: d2.message };
      const matches = d2.data || [];
      const dates = matches.map(m=>m.date).sort();
      return {
        count: matches.length,
        earliestDate: dates[0]||null,
        latestDate: dates[dates.length-1]||null,
        first5: matches.slice(0,5).map(m=>({date:m.date, home:m.homeTeam.name, away:m.awayTeam.name, status:m.state&&m.state.description})),
        last5: matches.slice(-5).map(m=>({date:m.date, home:m.homeTeam.name, away:m.awayTeam.name, status:m.state&&m.state.description}))
      };
    }
    const withSeason = await summarize(`${base}/matches?leagueId=${league.id}&season=${year}&limit=100`);
    const noSeason    = await summarize(`${base}/matches?leagueId=${league.id}&limit=100`);
    const leagueSeasons = league.seasons || null;

    res.json({ league:{ id:league.id, name:league.name, seasons:leagueSeasons }, withSeason, noSeason, todayIs: getToday() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Same diagnostic, but using the EXACT id already saved for a currently
// followed competition — avoids the ambiguity of re-searching by name
// (e.g. 20 different countries all have a "Premier League"), so this shows
// precisely what the real sync is actually querying.
app.get('/api/sports/debug-followed-competition', async (req, res) => {
  const d = readData();
  const key = hlKeyOf(d);
  if (!key) return res.json({ error: 'No Highlightly key saved in Settings.' });
  const followId = req.query.followId;
  const follow = (d.follows && d.follows.competitions || []).find(c=>c.id===followId);
  if (!follow) return res.json({ error: 'Follow not found' });
  const base = hlBase(follow.sport);
  if (!base) return res.json({ error: 'Not a Highlightly-backed sport: '+follow.sport });
  const headers = hlHeaders(key);
  const year = new Date().getFullYear();
  try {
    async function summarize(url){
      const r = await fetch(url, { headers });
      const d2 = await r.json();
      if (d2.message && !d2.data) return { error: d2.message, status:r.status };
      const matches = d2.data || [];
      const dates = matches.map(m=>m.date).sort();
      return {
        count: matches.length,
        earliestDate: dates[0]||null,
        latestDate: dates[dates.length-1]||null,
        first5: matches.slice(0,5).map(m=>({date:m.date, home:m.homeTeam.name, away:m.awayTeam.name, status:m.state&&m.state.description})),
        last5: matches.slice(-5).map(m=>({date:m.date, home:m.homeTeam.name, away:m.awayTeam.name, status:m.state&&m.state.description}))
      };
    }
    const withSeason = await summarize(`${base}/matches?leagueId=${follow.providerId}&season=${year}&limit=100`);
    const noSeason    = await summarize(`${base}/matches?leagueId=${follow.providerId}&limit=100`);
    let leagueDetail = null;
    try {
      const lr = await fetch(`${base}/leagues/${follow.providerId}`, { headers });
      const ld = await lr.json();
      leagueDetail = Array.isArray(ld) ? ld[0] : ld;
    } catch(e) {}

    // What the real sync now actually does (paginated, window-filtered) —
    // shows directly whether the fix works, without needing a full sync.
    const windowStartMs = Date.now() - 3*86400000;
    const windowEndMs   = Date.now() + 120*86400000; // 120d: long enough to cover a full Champions League phase and multi-week stage races
    const paged = await hlFetchCompetitionMatches(base, headers, follow.providerId, windowStartMs, windowEndMs);
    const pagedInWindow = paged.error ? null : paged.data.filter(m=>{ const t=new Date(m.date).getTime(); return t>=windowStartMs && t<=windowEndMs; });

    res.json({
      follow: { name:follow.name, providerId:follow.providerId, sport:follow.sport },
      leagueDetail: leagueDetail ? { name:leagueDetail.name, country: leagueDetail.country && leagueDetail.country.name, seasons: leagueDetail.seasons } : null,
      withSeason, noSeason, todayIs: getToday(),
      livePagedResult: paged.error ? { error: paged.error } : {
        totalFetchedAcrossPages: paged.data.length,
        matchesInWindow: pagedInWindow.length,
        sample: pagedInWindow.slice(0,5).map(m=>({date:m.date, home:m.homeTeam.name, away:m.awayTeam.name}))
      }
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Diagnostic for TheSportsDB — tests a specific team id plus a known-good
// one (Manchester United, 133612) side by side, so we can tell whether a
// failure is "this team id is bad" vs "the endpoint/key is broken generally".
// Diagnostic for a followed TheSportsDB COMPETITION (cycling, snooker,
// darts, motorsport): compares the full-season endpoint against the
// next-events endpoint, and lists what each actually returns, so we can
// see exactly why something like the Vuelta shows only one stage.
app.get('/api/sports/debug-tsdb-competition', async (req, res) => {
  const d = readData();
  const key = tsdbKeyOf(d);
  const followId = req.query.followId;
  const follow = (d.follows && d.follows.competitions || []).find(c=>c.id===followId);
  if (!follow) return res.json({ error: 'Follow not found' });
  const year = new Date().getFullYear();
  const out = { follow:{ name:follow.name, providerId:follow.providerId, sport:follow.sport }, key, todayIs:getToday(), tests:[] };
  const urls = [
    { label:'Full season ('+year+')', url:`https://www.thesportsdb.com/api/v1/json/${key}/eventsseason.php?id=${follow.providerId}&s=${year}` },
    { label:'Full season ('+year+'-'+(year+1)+')', url:`https://www.thesportsdb.com/api/v1/json/${key}/eventsseason.php?id=${follow.providerId}&s=${year}-${year+1}` },
    { label:'Next events (next 15)', url:`https://www.thesportsdb.com/api/v1/json/${key}/eventsnextleague.php?id=${follow.providerId}` }
  ];
  for (const t of urls) {
    const r = await fetchTsdbWithRetry(t.url);
    if (r.error) { out.tests.push({ label:t.label, url:t.url, error:r.error }); continue; }
    const evs = r.events || [];
    const dates = evs.map(e=>e.dateEvent).filter(Boolean).sort();
    out.tests.push({
      label: t.label, url: t.url,
      count: evs.length,
      earliest: dates[0]||null, latest: dates[dates.length-1]||null,
      sample: evs.slice(0,8).map(e=>({ date:e.dateEvent, time:(e.strTime||'').slice(0,5), name:e.strEvent }))
    });
  }
  res.json(out);
});

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

// Both Highlightly and TheSportsDB return fixture times in UTC. Everywhere
// else in this app, a stored "date"+"time" pair is assumed to already be in
// the user's local time (Europe/Bucharest) — so fixtures must be converted
// here, once, rather than displayed raw. This also means the calendar date
// a late-kickoff fixture lands on is correct even when UTC and Bucharest
// time fall on different calendar days.
function toBucharestParts(dateObj) {
  // Guard against invalid dates: an unparseable value used to fall through
  // and yield a nonsense-but-identical date for every affected fixture,
  // which made whole competitions appear stacked on one day.
  if (!(dateObj instanceof Date) || isNaN(dateObj.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Bucharest',
    year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false
  }).formatToParts(dateObj);
  const get = t => parts.find(p=>p.type===t).value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
}

// Parses Highlightly's "3 - 1" score string into {home, away} ints.
function parseHLScore(current){
  if(!current) return null;
  const m = String(current).match(/(\d+)\s*-\s*(\d+)/);
  return m ? { home:Number(m[1]), away:Number(m[2]) } : null;
}
function normalizeHLMatch(m, followType, followId, sport) {
  sport = sport || 'football';
  const dt = new Date(m.date); // ISO UTC from Highlightly
  const parts = toBucharestParts(dt);
  if (!parts) return null; // undated/unparseable — caller filters these out
  const { date, time } = parts;
  return {
    id: 'hl_'+sport+'_'+m.id, source:'auto', provider:'highlightly', providerSport:sport, providerId:String(m.id),
    sport, freq:'none', date, time,
    name: m.homeTeam.name+' vs '+m.awayTeam.name,
    home: { id:m.homeTeam.id, name:m.homeTeam.name, logo:m.homeTeam.logo||'' },
    away: { id:m.awayTeam.id, name:m.awayTeam.name, logo:m.awayTeam.logo||'' },
    competitionId: followType==='competition' ? followId : null,
    competitionHLId: m.league && m.league.id, competitionSeason: m.league && m.league.season,
    competitionName: m.league && m.league.name, competitionLogo: m.league && m.league.logo,
    followType, followId,
    status: m.state && m.state.description,
    liveClock: m.state && m.state.clock,
    score: m.state && parseHLScore(m.state.score && m.state.score.current),
    notes:'', color: sport==='handball' ? '#eab308' : '#4f8ef7'
  };
}
function normalizeTSDBEvent(ev, followType, followId) {
  // strTimestamp is UTC ISO when present; fall back to combining date+time as UTC.
  const iso = ev.strTimestamp ? ev.strTimestamp.replace(' ','T')+(ev.strTimestamp.includes('Z')?'':'Z')
    : `${ev.dateEvent}T${ev.strTime||'00:00:00'}Z`;
  const dt = new Date(iso);
  const _p = isNaN(dt) ? (ev.dateEvent ? { date: ev.dateEvent, time:(ev.strTime||'00:00').slice(0,5) } : null) : toBucharestParts(dt);
  if (!_p || !_p.date) return null; // no usable date — skip rather than store a bogus one
  const { date, time } = _p;
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

// MotoGP's official (unofficial-but-public) API — no key needed. Each
// "event" is a full race weekend; we anchor the calendar entry to the
// premier-class (MotoGP, not Moto2/Moto3) race session's start time, since
// that's what a fan means by "when is the race".
function normalizeMotoGpEvent(ev, followId) {
  let raceBroadcast = (ev.broadcasts||[]).find(b => b.shortname==='RAC' && b.category && b.category.name==='MotoGP');
  if (!raceBroadcast) raceBroadcast = (ev.broadcasts||[]).find(b => b.shortname==='RAC');
  const dt = raceBroadcast ? new Date(raceBroadcast.date_start) : new Date(ev.date_start);
  const _p = toBucharestParts(dt); if(!_p) return null;
  const { date, time } = _p;
  return {
    id: 'motogp_'+ev.id, source:'auto', provider:'motogp', providerId:ev.id,
    sport:'motogp', freq:'none', date, time,
    name: (ev.name||ev.shortname||'MotoGP').replace(/™/g,'').trim(),
    competitionId: followId, competitionName:'MotoGP', competitionLogo:'',
    followType:'competition', followId,
    status: ev.status||'',
    circuit: ev.circuit && ev.circuit.name, country: ev.country,
    score: null, notes:'', color:'#f97316'
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
  const hlKey = hlKeyOf(d);
  const fdKey = fdKeyOf(d);
  const tsdbKey = tsdbKeyOf(d);
  const windowStartMs = Date.now() - 3*86400000;
  const windowEndMs   = Date.now() + 120*86400000; // 120d: long enough to cover a full Champions League phase and multi-week stage races
  const inWindow = m => { const t=new Date(m.date).getTime(); return t>=windowStartMs && t<=windowEndMs; };
  const HL_SPORTS = ['football','handball']; // teams (both) + handball competitions go through Highlightly

  const needsHl = d.follows.teams.some(x=>HL_SPORTS.includes(x.sport)) || d.follows.competitions.some(x=>x.sport==='handball');
  if (!hlKey && needsHl) {
    log.push({ name:'Highlightly follows', ok:false, error:'No Highlightly key set in Settings.' });
  }
  const needsFd = d.follows.competitions.some(x=>x.sport==='football');
  if (!fdKey && needsFd) {
    log.push({ name:'Football competitions', ok:false, error:'No football-data.org key set in Settings.' });
  }

  if (hlKey) {
    const headers = hlHeaders(hlKey);
    for (const sport of HL_SPORTS) {
      const base = hlBase(sport);
      for (const t of d.follows.teams.filter(x=>x.sport===sport)) {
        // A follow added before a provider switch can be left with a
        // stale, non-numeric providerId (e.g. an old football-data.org
        // code) — catch that clearly instead of sending "NaN" to the API.
        if (!/^\d+$/.test(String(t.providerId))) { log.push({ name:t.name, followId:t.id, ok:false, error:'This follow has an old/invalid ID (likely from before a data source change) — remove it and re-add via search.' }); continue; }
        try {
          const [rh, ra] = await Promise.all([
            hlFetchMatches(base, headers, { homeTeamId:t.providerId }),
            hlFetchMatches(base, headers, { awayTeamId:t.providerId })
          ]);
          if (rh.error || ra.error) { log.push({ name:t.name, followId:t.id, ok:false, error: rh.error||ra.error }); await sleep(1200); continue; }
          const all = [...rh.data, ...ra.data].filter(inWindow);
          const seen = new Set();
          let normalized = [];
          all.forEach(m => { if(!seen.has(m.id)){ seen.add(m.id); const n=normalizeHLMatch(m,'team',t.id,sport); if(n) normalized.push(n); } });
          // A single team physically cannot play two fixtures at the same
          // minute. When a provider hasn't got real kickoff times yet (e.g.
          // a European league phase drawn but not yet scheduled) it stamps
          // every fixture with the same placeholder date/time — which used
          // to dump the whole campaign onto one day. Detect those clusters
          // and drop them rather than showing wrong dates.
          const slotCounts = {};
          normalized.forEach(n => { const k = n.date+'T'+n.time; slotCounts[k] = (slotCounts[k]||0)+1; });
          const placeholderSlots = Object.keys(slotCounts).filter(k => slotCounts[k] > 1);
          let droppedPlaceholders = 0;
          if (placeholderSlots.length) {
            const before = normalized.length;
            normalized = normalized.filter(n => !placeholderSlots.includes(n.date+'T'+n.time));
            droppedPlaceholders = before - normalized.length;
          }
          normalized.forEach(n => newAuto.push(n));
          log.push({ name:t.name, followId:t.id, ok:true, count:normalized.length,
            note: droppedPlaceholders ? droppedPlaceholders+' fixture(s) skipped — provider has no real kickoff times for them yet' : undefined });
        } catch(e){ log.push({ name:t.name, followId:t.id, ok:false, error:e.message }); }
        await sleep(1200);
      }
      // Football competitions are handled by football-data.org below —
      // only handball competitions stay on Highlightly here.
      if (sport === 'handball') {
        for (const c of d.follows.competitions.filter(x=>x.sport==='handball')) {
          if (!/^\d+$/.test(String(c.providerId))) { log.push({ name:c.name, followId:c.id, ok:false, error:'This follow has an old/invalid ID (likely from before a data source change) — remove it and re-add via search.' }); continue; }
          try {
            const r = await hlFetchCompetitionMatches(base, headers, c.providerId, windowStartMs, windowEndMs);
            if (r.error) { log.push({ name:c.name, followId:c.id, ok:false, error: r.error }); await sleep(1200); continue; }
            const found = r.data.filter(inWindow);
            found.forEach(m => { const n=normalizeHLMatch(m,'competition',c.id,sport); if(n) newAuto.push(n); });
            log.push({ name:c.name, followId:c.id, ok:true, count:found.length });
          } catch(e){ log.push({ name:c.name, followId:c.id, ok:false, error:e.message }); }
          await sleep(1200);
        }
      }
    }
  }

  if (fdKey) {
    const headers = { 'X-Auth-Token': fdKey };
    for (const c of d.follows.competitions.filter(x=>x.sport==='football')) {
      if (!/^[A-Z0-9]+$/.test(String(c.providerId))) { log.push({ name:c.name, followId:c.id, ok:false, error:'This follow has an old/invalid ID (likely from before a data source change) — remove it and re-add via search.' }); continue; }
      try {
        const r = await fetch(`${FD_BASE}/competitions/${c.providerId}/matches`, { headers });
        const dd = await r.json();
        if (dd.errorCode || dd.message) { log.push({ name:c.name, followId:c.id, ok:false, error: dd.message||JSON.stringify(dd) }); await sleep(6500); continue; }
        const found = (dd.matches||[]).filter(m=>{ const t=new Date(m.utcDate).getTime(); return t>=windowStartMs && t<=windowEndMs; });
        if (found.length === 0 && hlKey) {
          // football-data.org's free tier can be thin for some competitions
          // in the near term (notably Champions League before the league
          // phase is fully published). Fall back to Highlightly rather than
          // showing an empty competition.
          const hlFound = await hlFallbackForCompetition(c, hlKey, windowStartMs, windowEndMs);
          if (hlFound && hlFound.length) {
            hlFound.forEach(m => { const n=normalizeHLMatch(m,'competition',c.id,'football'); if(n) newAuto.push(n); });
            log.push({ name:c.name, followId:c.id, ok:true, count:hlFound.length, note:'via Highlightly fallback' });
            await sleep(6500);
            continue;
          }
        }
        found.forEach(m => { const n=normalizeFDMatch(m,'competition',c.id); if(n) newAuto.push(n); });
        log.push({ name:c.name, followId:c.id, ok:true, count:found.length });
      } catch(e){ log.push({ name:c.name, followId:c.id, ok:false, error:e.message }); }
      await sleep(6500); // football-data.org free tier: 10 req/min
    }
  }

  // MotoGP official calendar — no key needed, no rate limit concerns (one call covers the whole season).
  for (const c of d.follows.competitions.filter(x=>x.sport==='motogp_official')) {
    try {
      const year = new Date().getFullYear();
      const r = await fetch(`https://api.motogp.pulselive.com/motogp/v1/events?seasonYear=${year}`);
      const events = await r.json();
      const todayStr = getToday();
      const upcoming = Array.isArray(events) ? events.filter(ev => ev.kind==='GP' && ev.date_end && ev.date_end.slice(0,10) >= todayStr) : [];
      const found = upcoming.map(ev => normalizeMotoGpEvent(ev, c.id)).filter(Boolean);
      found.forEach(n => newAuto.push(n));
      log.push({ name:c.name, followId:c.id, ok:true, count:found.length });
    } catch(e){ log.push({ name:c.name, followId:c.id, ok:false, error:e.message }); }
  }

  for (const c of d.follows.competitions.filter(x=>x.sport!=='football' && x.sport!=='motogp_official')) {
    try {
      // eventsnextleague only returns the next ~15 events, which for a
      // stage race (Vuelta/Giro/Tour) or a long season means you see a
      // single upcoming stage rather than the whole competition. Pull the
      // full season schedule first and fall back to next-15 only if the
      // season endpoint has nothing.
      const season = new Date().getFullYear();
      let found = [];
      let note;
      const seasonRes = await fetchTsdbWithRetry(`https://www.thesportsdb.com/api/v1/json/${tsdbKey}/eventsseason.php?id=${c.providerId}&s=${season}`);
      if (!seasonRes.error && seasonRes.events && seasonRes.events.length) {
        found = seasonRes.events;
        note = 'full season';
      } else {
        const nextRes = await fetchTsdbWithRetry(`https://www.thesportsdb.com/api/v1/json/${tsdbKey}/eventsnextleague.php?id=${c.providerId}`);
        if (nextRes.error) { log.push({ name:c.name, followId:c.id, ok:false, error:nextRes.error }); continue; }
        found = nextRes.events||[];
        note = 'next events only';
      }
      // Season lists span the whole year, so trim to our near-term window.
      const windowed = found.filter(ev=>{
        const iso = ev.strTimestamp ? ev.strTimestamp.replace(' ','T')+(ev.strTimestamp.includes('Z')?'':'Z') : `${ev.dateEvent}T${ev.strTime||'00:00:00'}Z`;
        const t = new Date(iso).getTime();
        return !isNaN(t) && t>=windowStartMs && t<=windowEndMs;
      });
      windowed.forEach(ev => { const n=normalizeTSDBEvent(ev,'competition',c.id); if(n) newAuto.push(n); });
      log.push({ name:c.name, followId:c.id, ok:true, count:windowed.length, note });
    } catch(e){ log.push({ name:c.name, followId:c.id, ok:false, error:e.message }); }
  }
  for (const t of d.follows.teams.filter(x=>x.sport!=='football')) {
    try {
      const dd = await fetchTsdbWithRetry(`https://www.thesportsdb.com/api/v1/json/${tsdbKey}/eventsnext.php?id=${t.providerId}`);
      if (dd.error) { log.push({ name:t.name, followId:t.id, ok:false, error:dd.error }); continue; }
      const found = dd.events||[];
      if (found.length === 0) { log.push({ name:t.name, followId:t.id, ok:true, count:0, note:'TheSportsDB has no scheduled fixtures listed for this team right now' }); continue; }
      found.forEach(ev => { const n=normalizeTSDBEvent(ev,'team',t.id); if(n) newAuto.push(n); });
      log.push({ name:t.name, followId:t.id, ok:true, count:found.length });
    } catch(e){ log.push({ name:t.name, followId:t.id, ok:false, error:e.message }); }
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

  // Carry over any reminder the user set on an auto-synced fixture — the
  // fixture object itself is replaced wholesale on each sync, so without
  // this a reminder set on a match would silently vanish at the next sync.
  const prevById = new Map((d.sportEvents||[]).filter(e=>e.source==='auto').map(e=>[e.id,e]));
  for (const [id, ev] of dedup) {
    const prev = prevById.get(id);
    if (prev && prev.reminder) ev.reminder = prev.reminder;
    if (prev && Array.isArray(prev.reminders)) ev.reminders = prev.reminders;
  }

  // CRITICAL: don't wipe out previously-good fixtures just because this
  // round failed for some (or all) follows — a rate limit or transient
  // network hiccup should never delete data that was working fine before.
  // Only replace a follow's stored fixtures if THIS round actually
  // succeeded for that specific follow; anything that failed keeps
  // whatever was already on disk from the last successful sync.
  const succeededFollowIds = new Set(log.filter(l=>l.ok && l.followId).map(l=>String(l.followId)));
  const oldAuto = (d.sportEvents||[]).filter(e => e.source === 'auto');
  const staleButKept = oldAuto.filter(e => !succeededFollowIds.has(String(e.followId)));
  const manual = (d.sportEvents||[]).filter(e => e.source !== 'auto');
  d.sportEvents = [...manual, ...staleButKept, ...dedup.values()];
  writeData(d);
  console.log(`Synced ${newAuto.length} auto fixtures from ${d.follows.teams.length} teams + ${d.follows.competitions.length} competitions (kept ${staleButKept.length} stale fixtures from failed follows).`, JSON.stringify(log));
  return { count: newAuto.length, log };
}

// GET /api/fixture/:provider/:id?sport=football — full detail for tap-through
app.get('/api/fixture/:provider/:id', async (req, res) => {
  const { provider, id } = req.params;
  const sport = req.query.sport || 'football';
  const d = readData();
  try {
    if (provider === 'highlightly') {
      const key = hlKeyOf(d);
      if (!key) return res.status(400).json({ error: 'No Highlightly key set' });
      const headers = hlHeaders(key);
      const base = hlBase(sport) || hlBase('football');
      const [fxR, lineupR] = await Promise.all([
        fetch(`${base}/matches/${id}`, { headers }),
        fetch(`${base}/lineups/${id}`, { headers })
      ]);
      const fxData = await fxR.json();
      const fixture = Array.isArray(fxData) ? fxData[0] : fxData;
      if (!fixture || fixture.message) return res.status(400).json({ error: (fixture&&fixture.message)||'Highlightly error' });
      let lineups = null;
      try { const l = await lineupR.json(); if(!l.message) lineups = l; } catch(e) {}
      let standings = null;
      if (fixture.league && fixture.league.id && fixture.league.season) {
        try {
          const stR = await fetch(`${base}/standings?leagueId=${fixture.league.id}&season=${fixture.league.season}`, { headers });
          const stD = await stR.json();
          standings = stD.groups && stD.groups[0] && stD.groups[0].standings;
        } catch(e) {}
      }
      return res.json({ fixture, lineups, statistics: fixture.statistics||[], standings });
    } else if (provider === 'football-data') {
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
      return res.json({ fixture, lineups: [], statistics: [], standings: standings ? standings.table : null, noDeepStats:true });
    } else if (provider === 'thesportsdb') {
      const key = tsdbKeyOf(d);
      const r = await fetch(`https://www.thesportsdb.com/api/v1/json/${key}/lookupevent.php?id=${id}`);
      const dd = await r.json();
      return res.json({ fixture: dd.events && dd.events[0] });
    } else if (provider === 'motogp') {
      const r = await fetch(`https://api.motogp.pulselive.com/motogp/v1/events/${id}`);
      const ev = await r.json();
      return res.json({ fixture: ev });
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
// ═══════════════════════════════════════════════════
// TRAVEL / "LEAVE BY"
// Works out how long it takes to drive to an event's location, so the app
// can warn you when to LEAVE rather than when the event starts.
// Routing uses OSRM's free public router (no key, no signup). If it's
// unreachable we fall back to a straight-line estimate, clearly flagged as
// an estimate rather than quietly pretending it's a real route.
// ═══════════════════════════════════════════════════
const TRAVEL_TTL_MS = 30*24*3600*1000;   // routes between two towns don't change often
// Per mode: the OSRM routing profile, a fallback speed if routing is
// unavailable, and whether the duration has to come from you. There is no
// free timetable source for Romanian buses/trains, so rather than invent a
// number those modes ask for the journey time once and reuse it.
// OSRM's free public server hosts the CAR profile only — asking it for a
// foot or bike route quietly returns the car route, which is why walking a
// few km once reported the same 8 minutes as driving. So: distance comes
// from the route, and walking/cycling durations are derived from that
// distance at a realistic speed. With an OpenRouteService key we use real
// pedestrian/cycle routing instead (see routeFor).
const TRAVEL_MODES = {
  drive:  { label:'Drive',       emoji:'🚗', osrm:'driving', ors:'driving-car',    kmh:62,  manual:false, traffic:true },
  taxi:   { label:'Taxi',        emoji:'🚕', osrm:'driving', ors:'driving-car',    kmh:62,  manual:false, traffic:true, extraMins:8 },
  bike:   { label:'Bike',        emoji:'🚲', osrm:null,      ors:'cycling-regular',kmh:14,  manual:false, detour:1.05 },
  walk:   { label:'Walk',        emoji:'🚶', osrm:null,      ors:'foot-walking',   kmh:4.7, manual:false, detour:0.92 },
  transit:{ label:'Bus / train', emoji:'🚌', manual:true },
  custom: { label:'Other',       emoji:'⏱',  manual:true }
};
function travelMode(ev){
  const m = ev && ev.travelMode;
  return (m && TRAVEL_MODES[m]) ? m : 'drive';
}

function haversineKm(a, b){
  const R=6371, rad=x=>x*Math.PI/180;
  const dLat=rad(b.lat-a.lat), dLon=rad(b.lon-a.lon);
  const x=Math.sin(dLat/2)**2 + Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(x));
}

// True multi-profile routing, if a (free) OpenRouteService key is saved.
async function orsRoute(from, to, cfg, key){
  const url = `https://api.openrouteservice.org/v2/directions/${cfg.ors}?api_key=${encodeURIComponent(key)}`
            + `&start=${from.lon},${from.lat}&end=${to.lon},${to.lat}`;
  const r = await fetch(url, { headers:{ 'Accept':'application/json' } });
  if(!r.ok) throw new Error('ORS HTTP '+r.status);
  const d = await r.json();
  const sum = d.features && d.features[0] && d.features[0].properties && d.features[0].properties.summary;
  if(!sum || sum.duration == null) throw new Error((d.error && (d.error.message||d.error)) || 'no route');
  return { secs: sum.duration, metres: sum.distance };
}

// Car distance/duration from OSRM (the only profile it serves publicly).
async function osrmDriving(from, to){
  const url = `https://router.project-osrm.org/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=false&alternatives=false`;
  const r = await fetch(url, { headers:{ 'User-Agent':'personal-organizer/1.0 (personal calendar app)' } });
  if(!r.ok) throw new Error('HTTP '+r.status);
  const d = await r.json();
  const route = d.routes && d.routes[0];
  if(!route) throw new Error(d.message || 'no route');
  return { secs: route.duration, metres: route.distance };
}

async function drivingRoute(from, to, mode, data){
  const cfg = TRAVEL_MODES[mode] || TRAVEL_MODES.drive;
  const st = (data && data.settings) || {};
  const orsKey = (st.orsKey||'').trim();
  // Traffic allowance: routers quote free-flow speeds, which run optimistic
  // in town. Applies to car-based modes only.
  const trafficPct = cfg.traffic ? (parseInt(st.trafficPct != null ? st.trafficPct : 20) || 0) : 0;
  const withExtras = (mins) => Math.max(1, Math.round(mins * (1 + trafficPct/100)) + (cfg.extraMins||0));

  if(orsKey && cfg.ors){
    try{
      const o = await orsRoute(from, to, cfg, orsKey);
      return { mins: withExtras(o.secs/60), km: +(o.metres/1000).toFixed(1), estimated:false, source:'ors', mode, trafficPct };
    }catch(e){ console.log('ORS routing failed, falling back:', e.message); }
  }
  try{
    const o = await osrmDriving(from, to);
    const km = o.metres/1000;
    if(cfg.osrm === 'driving'){
      return { mins: withExtras(o.secs/60), km:+km.toFixed(1), estimated:false, source:'osrm', mode, trafficPct };
    }
    // Walking/cycling: keep the road distance, apply a sensible speed.
    const dist = km * (cfg.detour || 1);
    return { mins: withExtras(dist/(cfg.kmh||5)*60), km:+dist.toFixed(1), estimated:false, derived:true, source:'osrm-distance', mode };
  }catch(e){
    // Nothing reachable: straight-line distance with a road factor.
    const km = haversineKm(from, to) * 1.28 * (cfg.detour || 1);
    return { mins: withExtras(km/(cfg.kmh||62)*60), km:+km.toFixed(1), estimated:true, source:'estimate', mode, error:e.message };
  }
}

// Street-level geocoding. Open-Meteo (used for the weather search) only
// knows towns, so "Str. Lazar 12, Timisoara" would collapse to the city
// centre — useless for a trip across the same city. Nominatim understands
// full addresses. It's free but rate-limited, hence the cache and the
// identifying User-Agent its usage policy requires.
async function geocodeAddress(q){
  const query = String(q||'').trim();
  if(!query) return null;
  try{
    const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&addressdetails=1&q='+encodeURIComponent(query);
    const r = await fetch(url, { headers:{ 'User-Agent':'personal-organizer/1.0 (personal calendar app)', 'Accept-Language':'ro,en' } });
    if(!r.ok) throw new Error('HTTP '+r.status);
    const d = await r.json();
    if(Array.isArray(d) && d.length){
      const h = d[0];
      // Keep the label short — the full display_name is a paragraph.
      const label = (h.display_name||query).split(',').slice(0,3).join(',').trim();
      return { lat:+h.lat, lon:+h.lon, label, precise:true };
    }
  }catch(e){ console.log('Nominatim lookup failed:', e.message); }
  // Falls back to the town-level geocoder so a plain city name still works.
  const g = await geocodeLocation(query);
  return g ? { ...g, precise:false } : null;
}

function homeOf(data){
  const st = data.settings || {};
  if (st.homeLat && st.homeLon) return { lat:+st.homeLat, lon:+st.homeLon, name: st.homeName || 'Home', precise:true };
  // Falls back to the weather location, which is already where you are.
  if (st.wxLat && st.wxLon) return { lat:+st.wxLat, lon:+st.wxLon, name: st.wxLocName || 'Home' };
  return null;
}

// "home" means the saved starting address; anything else is the event's own
// From field. Keying on the text keeps the cache lookup synchronous, which
// the reminder check needs.
function fromSig(fromPlace){
  const f = String(fromPlace||'').trim().toLowerCase();
  return f || 'home';
}
function travelKey(fromPlace, place, mode){
  return fromSig(fromPlace)+'|'+String(place).trim().toLowerCase()+'|'+(mode||'drive');
}
function travelCached(data, place, mode, fromPlace){
  if(!place) return null;
  if(fromSig(fromPlace)==='home' && !homeOf(data)) return null;
  const hit = (data.travelCache||{})[travelKey(fromPlace, place, mode)];
  if(!hit) return null;
  if(Date.now() - (hit.at||0) > TRAVEL_TTL_MS) return null;
  return hit;
}

// Resolves (and caches) the drive from home to a place name.
async function travelFor(data, place, force, mode, fromPlace){
  mode = (mode && TRAVEL_MODES[mode]) ? mode : 'drive';
  if(!place || !String(place).trim()) return { error:'No destination given.' };
  // Bus/train/other can't be routed: the time comes from what you entered.
  if(TRAVEL_MODES[mode].manual) return { manual:true, mode, needsMinutes:true };
  const key = travelKey(fromPlace, place, mode);
  if(!force){
    const hit = travelCached(data, place, mode, fromPlace);
    if(hit) return hit;
  }
  // Origin: the event's own From field if given, otherwise your saved
  // starting address.
  let home;
  if(String(fromPlace||'').trim()){
    const g = await geocodeAddress(fromPlace);
    if(!g) return { error:'Could not find the starting point “'+fromPlace+'”.' };
    home = { lat:g.lat, lon:g.lon, name:g.label, precise:g.precise!==false };
  } else {
    home = homeOf(data);
    if(!home) return { error:'No starting address set — add one in Settings, or fill in the From field.' };
  }
  const geo = await geocodeAddress(place);
  if(!geo) return { error:'Could not find “'+place+'” on the map.' };
  const route = await drivingRoute(home, { lat:geo.lat, lon:geo.lon }, mode, data);
  const entry = { ...route, place, mode, toName: geo.label || place, lat:geo.lat, lon:geo.lon,
                  precise: geo.precise !== false, fromPrecise: !!home.precise,
                  fromPlace: String(fromPlace||'').trim(), fromName: home.name, at: Date.now() };
  const cur = readData();
  if(!cur.travelCache) cur.travelCache = {};
  cur.travelCache[key] = entry;
  writeData(cur);
  return entry;
}

// Called before the reminder check so the (synchronous) due-calculation can
// read travel times straight from the cache.
async function ensureTravelForUpcoming(data){
  const st = data.settings || {};
  if(st.leaveBy === false) return;
  const days = [getToday(), addDays(getToday(),1)];
  const items = [
    ...(data.tasks||[]),
    ...(data.sportEvents||[])
  ].filter(ev => ev.location && String(ev.location).trim() && days.some(ds => matchesDate(ev, ds)));
  const seen = new Set();
  for(const ev of items){
    const place = String(ev.location).trim();
    const sig = fromSig(ev.travelFrom)+'|'+place.toLowerCase()+'|'+travelMode(ev);
    if(seen.has(sig)) continue;
    seen.add(sig);
    const mode = travelMode(ev);
    if(TRAVEL_MODES[mode].manual) continue;            // you supplied the duration
    if(travelCached(data, place, mode, ev.travelFrom)) continue;
    try{ await travelFor(data, place, false, mode, ev.travelFrom); }catch(e){ console.log('Travel lookup failed for', place, e.message); }
    await sleep(400);   // be polite to the free router
  }
}

// ═══════════════════════════════════════════════════
// BIBLE READING PLAN (T4T)
// Chapters are never split, so each day lands as close to the target verse
// count as possible. Verse counts are the standard versification
// (1,189 chapters / 31,103 verses); T4T follows it.
// ═══════════════════════════════════════════════════
const BIBLE_BOOKS = [{"n":"Genesis","c":"GEN","v":[31,25,24,26,32,22,24,22,29,32,32,20,18,24,21,16,27,33,38,18,34,24,20,67,34,35,46,22,35,43,55,32,20,31,29,43,36,30,23,23,57,38,34,34,28,34,31,22,33,26]},{"n":"Exodus","c":"EXO","v":[22,25,22,31,23,30,25,32,35,29,10,51,22,31,27,36,16,27,25,26,36,31,33,18,40,37,21,43,46,38,18,35,23,35,35,38,29,31,43,38]},{"n":"Leviticus","c":"LEV","v":[17,16,17,35,19,30,38,36,24,20,47,8,59,57,33,34,16,30,37,27,24,33,44,23,55,46,34]},{"n":"Numbers","c":"NUM","v":[54,34,51,49,31,27,89,26,23,36,35,16,33,45,41,50,13,32,22,29,35,41,30,25,18,65,23,31,40,16,54,42,56,29,34,13]},{"n":"Deuteronomy","c":"DEU","v":[46,37,29,49,33,25,26,20,29,22,32,32,18,29,23,22,20,22,21,20,23,30,25,22,19,19,26,68,29,20,30,52,29,12]},{"n":"Joshua","c":"JOS","v":[18,24,17,24,15,27,26,35,27,43,23,24,33,15,63,10,18,28,51,9,45,34,16,33]},{"n":"Judges","c":"JDG","v":[36,23,31,24,31,40,25,35,57,18,40,15,25,20,20,31,13,31,30,48,25]},{"n":"Ruth","c":"RUT","v":[22,23,18,22]},{"n":"1 Samuel","c":"1SA","v":[28,36,21,22,12,21,17,22,27,27,15,25,23,52,35,23,58,30,24,42,15,23,29,22,44,25,12,25,11,31,13]},{"n":"2 Samuel","c":"2SA","v":[27,32,39,12,25,23,29,18,13,19,27,31,39,33,37,23,29,33,43,26,22,51,39,25]},{"n":"1 Kings","c":"1KI","v":[53,46,28,34,18,38,51,66,28,29,43,33,34,31,34,34,24,46,21,43,29,53]},{"n":"2 Kings","c":"2KI","v":[18,25,27,44,27,33,20,29,37,36,21,21,25,29,38,20,41,37,37,21,26,20,37,20,30]},{"n":"1 Chronicles","c":"1CH","v":[54,55,24,43,26,81,40,40,44,14,47,40,14,17,29,43,27,17,19,8,30,19,32,31,31,32,34,21,30]},{"n":"2 Chronicles","c":"2CH","v":[17,18,17,22,14,42,22,18,31,19,23,16,22,15,19,14,19,34,11,37,20,12,21,27,28,23,9,27,36,27,21,33,25,33,27,23]},{"n":"Ezra","c":"EZR","v":[11,70,13,24,17,22,28,36,15,44]},{"n":"Nehemiah","c":"NEH","v":[11,20,32,23,19,19,73,18,38,39,36,47,31]},{"n":"Esther","c":"EST","v":[22,23,15,17,14,14,10,17,32,3]},{"n":"Job","c":"JOB","v":[22,13,26,21,27,30,21,22,35,22,20,25,28,22,35,22,16,21,29,29,34,30,17,25,6,14,23,28,25,31,40,22,33,37,16,33,24,41,30,24,34,17]},{"n":"Psalms","c":"PSA","v":[6,12,8,8,12,10,17,9,20,18,7,8,6,7,5,11,15,50,14,9,13,31,6,10,22,12,14,9,11,12,24,11,22,22,28,12,40,22,13,17,13,11,5,26,17,11,9,14,20,23,19,9,6,7,23,13,11,11,17,12,8,12,11,10,13,20,7,35,36,5,24,20,28,23,10,12,20,72,13,19,16,8,18,12,13,17,7,18,52,17,16,15,5,23,11,13,12,9,9,5,8,28,22,35,45,48,43,13,31,7,10,10,9,8,18,19,2,29,176,7,8,9,4,8,5,6,5,6,8,8,3,18,3,3,21,26,9,8,24,13,10,7,12,15,21,10,20,14,9,6]},{"n":"Proverbs","c":"PRO","v":[33,22,35,27,23,35,27,36,18,32,31,28,25,35,33,33,28,24,29,30,31,29,35,34,28,28,27,28,27,33,31]},{"n":"Ecclesiastes","c":"ECC","v":[18,26,22,16,20,12,29,17,18,20,10,14]},{"n":"Song of Songs","c":"SNG","v":[17,17,11,16,16,13,13,14]},{"n":"Isaiah","c":"ISA","v":[31,22,26,6,30,13,25,22,21,34,16,6,22,32,9,14,14,7,25,6,17,25,18,23,12,21,13,29,24,33,9,20,24,17,10,22,38,22,8,31,29,25,28,28,25,13,15,22,26,11,23,15,12,17,13,12,21,14,21,22,11,12,19,12,25,24]},{"n":"Jeremiah","c":"JER","v":[19,37,25,31,31,30,34,22,26,25,23,17,27,22,21,21,27,23,15,18,14,30,40,10,38,24,22,17,32,24,40,44,26,22,19,32,21,28,18,16,18,22,13,30,5,28,7,47,39,46,64,34]},{"n":"Lamentations","c":"LAM","v":[22,22,66,22,22]},{"n":"Ezekiel","c":"EZK","v":[28,10,27,17,17,14,27,18,11,22,25,28,23,23,8,63,24,32,14,49,32,31,49,27,17,21,36,26,21,26,18,32,33,31,15,38,28,23,29,49,26,20,27,31,25,24,23,35]},{"n":"Daniel","c":"DAN","v":[21,49,30,37,31,28,28,27,27,21,45,13]},{"n":"Hosea","c":"HOS","v":[11,23,5,19,15,11,16,14,17,15,12,14,16,9]},{"n":"Joel","c":"JOL","v":[20,32,21]},{"n":"Amos","c":"AMO","v":[15,16,15,13,27,14,17,14,15]},{"n":"Obadiah","c":"OBA","v":[21]},{"n":"Jonah","c":"JON","v":[17,10,10,11]},{"n":"Micah","c":"MIC","v":[16,13,12,13,15,16,20]},{"n":"Nahum","c":"NAM","v":[15,13,19]},{"n":"Habakkuk","c":"HAB","v":[17,20,19]},{"n":"Zephaniah","c":"ZEP","v":[18,15,20]},{"n":"Haggai","c":"HAG","v":[15,23]},{"n":"Zechariah","c":"ZEC","v":[21,13,10,14,11,15,14,23,17,12,17,14,9,21]},{"n":"Malachi","c":"MAL","v":[14,17,18,6]},{"n":"Matthew","c":"MAT","v":[25,23,17,25,48,34,29,34,38,42,30,50,58,36,39,28,27,35,30,34,46,46,39,51,46,75,66,20]},{"n":"Mark","c":"MRK","v":[45,28,35,41,43,56,37,38,50,52,33,44,37,72,47,20]},{"n":"Luke","c":"LUK","v":[80,52,38,44,39,49,50,56,62,42,54,59,35,35,32,31,37,43,48,47,38,71,56,53]},{"n":"John","c":"JHN","v":[51,25,36,54,47,71,53,59,41,42,57,50,38,31,27,33,26,40,42,31,25]},{"n":"Acts","c":"ACT","v":[26,47,26,37,42,15,60,40,43,48,30,25,52,28,41,40,34,28,41,38,40,30,35,27,27,32,44,31]},{"n":"Romans","c":"ROM","v":[32,29,31,25,21,23,25,39,33,21,36,21,14,23,33,27]},{"n":"1 Corinthians","c":"1CO","v":[31,16,23,21,13,20,40,13,27,33,34,31,13,40,58,24]},{"n":"2 Corinthians","c":"2CO","v":[24,17,18,18,21,18,16,24,15,18,33,21,14]},{"n":"Galatians","c":"GAL","v":[24,21,29,31,26,18]},{"n":"Ephesians","c":"EPH","v":[23,22,21,32,33,24]},{"n":"Philippians","c":"PHP","v":[30,30,21,23]},{"n":"Colossians","c":"COL","v":[29,23,25,18]},{"n":"1 Thessalonians","c":"1TH","v":[10,20,13,18,28]},{"n":"2 Thessalonians","c":"2TH","v":[12,17,18]},{"n":"1 Timothy","c":"1TI","v":[20,15,16,16,25,21]},{"n":"2 Timothy","c":"2TI","v":[18,26,17,22]},{"n":"Titus","c":"TIT","v":[16,15,15]},{"n":"Philemon","c":"PHM","v":[25]},{"n":"Hebrews","c":"HEB","v":[14,18,19,16,14,20,28,13,28,39,40,29,25]},{"n":"James","c":"JAS","v":[27,26,18,17,20]},{"n":"1 Peter","c":"1PE","v":[25,25,22,19,14]},{"n":"2 Peter","c":"2PE","v":[21,22,18]},{"n":"1 John","c":"1JN","v":[10,29,24,21,21]},{"n":"2 John","c":"2JN","v":[13]},{"n":"3 John","c":"3JN","v":[15]},{"n":"Jude","c":"JUD","v":[25]},{"n":"Revelation","c":"REV","v":[20,29,22,11,14,17,17,13,21,11,19,17,18,20,8,21,18,24,21,15,27,21]}];

// The plan is a POSITION in the text, not a dated schedule: you read at
// your own pace, tick chapters as you go, and the next session is suggested
// from wherever you stopped. Reaching Revelation 22 wraps back to Genesis 1
// and starts another cycle.
function bibleChapters(){
  const out = [];
  BIBLE_BOOKS.forEach((b,bi)=> b.v.forEach((verses,ci)=> out.push({
    i: out.length, bi, book: b.n, code: b.c, ch: ci+1, verses
  })));
  return out;
}
const BIBLE_CHAPTERS = bibleChapters();
const BIBLE_TOTAL_VERSES = BIBLE_CHAPTERS.reduce((s,c)=>s+c.verses,0);

function bibleChapterUrl(c){
  const pad = c.code === 'PSA' ? String(c.ch).padStart(3,'0') : String(c.ch).padStart(2,'0');
  return 'https://ebible.org/eng-t4t/' + c.code + pad + '.htm';
}

// The next chapters from `pos` that together reach the target. Wraps around
// the end of the text, so there is always a suggestion.
function bibleSuggestion(pos, target){
  const want = Math.max(1, parseInt(target)||50);
  const picked = [];
  let total = 0, i = pos;
  while(total < want && picked.length < BIBLE_CHAPTERS.length){
    const c = BIBLE_CHAPTERS[i % BIBLE_CHAPTERS.length];
    picked.push(c); total += c.verses; i++;
  }
  return { chapters: picked, verses: total, nextPos: i % BIBLE_CHAPTERS.length, wraps: i > BIBLE_CHAPTERS.length };
}

function bibleRangeLabel(chapters){
  const parts = [];
  let cur = null;
  for(const c of chapters){
    if(!cur || cur.book !== c.book || c.ch !== cur.b + 1){ cur = { book:c.book, a:c.ch, b:c.ch }; parts.push(cur); }
    else cur.b = c.ch;
  }
  return parts.map(p => p.book + ' ' + (p.a===p.b ? p.a : p.a+'\u2013'+p.b)).join(', ');
}

const BIBLE_PLAN_ID = 'bible-t4t';

function biblePlanState(cfg){
  const pos = Math.max(0, Math.min(BIBLE_CHAPTERS.length-1, parseInt(cfg.pos)||0));
  const sug = bibleSuggestion(pos, cfg.versesPerDay);
  const versesRead = BIBLE_CHAPTERS.slice(0, pos).reduce((s,c)=>s+c.verses,0);
  return {
    active: true,
    versesPerDay: cfg.versesPerDay,
    pos, cycle: cfg.cycle || 1,
    totalChapters: BIBLE_CHAPTERS.length,
    totalVerses: BIBLE_TOTAL_VERSES,
    chaptersRead: pos,
    versesRead,
    lastReadAt: cfg.lastReadAt || null,
    suggestion: {
      label: bibleRangeLabel(sug.chapters),
      verses: sug.verses,
      count: sug.chapters.length,
      from: sug.chapters[0].i,
      to: sug.chapters[sug.chapters.length-1].i,
      wraps: sug.wraps,
      url: bibleChapterUrl(sug.chapters[0])
    },
    chapters: BIBLE_CHAPTERS.map(c => ({
      i:c.i, label:c.book+' '+c.ch, verses:c.verses, url:bibleChapterUrl(c),
      read: c.i < pos,
      inSuggestion: sug.chapters.some(x=>x.i===c.i)
    }))
  };
}

app.get('/api/bible/plan', (req, res) => {
  try{
    const d = readData();
    if(!d.biblePlan) return res.json({ active:false, defaultVerses:50 });
    res.json(biblePlanState(d.biblePlan));
  }catch(e){ res.status(500).json({ error:e.message }); }
});

app.post('/api/bible/plan', (req, res) => {
  try{
    const { versesPerDay = 50, reset = false } = req.body || {};
    const d = readData();
    const prev = d.biblePlan || {};
    d.biblePlan = {
      versesPerDay: Math.max(5, parseInt(versesPerDay)||50),
      // Changing the target must not lose your place.
      pos: reset ? 0 : (parseInt(prev.pos)||0),
      cycle: reset ? 1 : (prev.cycle || 1),
      startedAt: prev.startedAt || new Date().toISOString(),
      lastReadAt: reset ? null : (prev.lastReadAt || null)
    };
    writeData(d);
    res.json(biblePlanState(d.biblePlan));
  }catch(e){ res.status(500).json({ error:e.message }); }
});

// Tick (or untick) a chapter. Reading is sequential, so marking a chapter
// read means everything before it is read too — and unticking rewinds.
app.post('/api/bible/read', (req, res) => {
  try{
    const { index, read = true } = req.body || {};
    const d = readData();
    if(!d.biblePlan) return res.status(400).json({ error:'No plan' });
    const i = Math.max(0, Math.min(BIBLE_CHAPTERS.length-1, parseInt(index)||0));
    let pos = read ? i+1 : i;
    if(pos >= BIBLE_CHAPTERS.length){ pos = 0; d.biblePlan.cycle = (d.biblePlan.cycle||1) + 1; }
    d.biblePlan.pos = pos;
    d.biblePlan.lastReadAt = new Date().toISOString();
    writeData(d);
    res.json(biblePlanState(d.biblePlan));
  }catch(e){ res.status(500).json({ error:e.message }); }
});

// "Done for today" — advances past the whole suggested batch at once.
app.post('/api/bible/session', (req, res) => {
  try{
    const d = readData();
    if(!d.biblePlan) return res.status(400).json({ error:'No plan' });
    const sug = bibleSuggestion(d.biblePlan.pos||0, d.biblePlan.versesPerDay);
    if(sug.wraps) d.biblePlan.cycle = (d.biblePlan.cycle||1) + 1;
    d.biblePlan.pos = sug.nextPos;
    d.biblePlan.lastReadAt = new Date().toISOString();
    writeData(d);
    res.json(biblePlanState(d.biblePlan));
  }catch(e){ res.status(500).json({ error:e.message }); }
});

app.post('/api/bible/plan/remove', (req, res) => {
  try{
    const d = readData();
    delete d.biblePlan;
    d.tasks = (d.tasks||[]).filter(t => t.planId !== BIBLE_PLAN_ID);
    writeData(d);
    res.json({ ok:true });
  }catch(e){ res.status(500).json({ error:e.message }); }
});

// ═══════════════════════════════════════════════════
// MCP ENDPOINT — lets Claude read and update this organizer.
// Speaks JSON-RPC over HTTP (MCP streamable transport). The URL carries a
// long random secret because custom connectors can't send auth headers:
// anyone holding the URL has full access, so it is treated like a password
// and can be rotated from Settings.
// ═══════════════════════════════════════════════════
function mcpSecret(data, create){
  const d = data || readData();
  if(!d.settings) d.settings = {};
  if(!d.settings.mcpSecret && create){
    d.settings.mcpSecret = [...Array(4)].map(()=>Math.random().toString(36).slice(2,10)).join('');
    writeData(d);
  }
  return d.settings.mcpSecret || null;
}

const MCP_TOOLS = [
  { name:'list_day', description:"What is scheduled on a given day: tasks and sport fixtures.",
    inputSchema:{ type:'object', properties:{ date:{type:'string', description:'YYYY-MM-DD, or omit for today'} } } },
  { name:'add_task', description:'Add a task or reminder to the organizer.',
    inputSchema:{ type:'object', required:['name','date'], properties:{
      name:{type:'string'}, date:{type:'string', description:'YYYY-MM-DD'},
      time:{type:'string', description:'HH:MM, 24h. Defaults to 09:00'},
      notes:{type:'string'}, location:{type:'string', description:'Enables a leave-by warning'},
      remindMinutes:{type:'array', items:{type:'number'}, description:'e.g. [15, 120]'} } } },
  { name:'complete_task', description:'Mark a task done (or not done) by name.',
    inputSchema:{ type:'object', required:['name'], properties:{ name:{type:'string'}, done:{type:'boolean'} } } },
  { name:'delete_task', description:'Delete a task by name.',
    inputSchema:{ type:'object', required:['name'], properties:{ name:{type:'string'} } } },
  { name:'upcoming', description:'Everything scheduled over the next N days (default 7).',
    inputSchema:{ type:'object', properties:{ days:{type:'number'} } } },
  { name:'bible_status', description:'Current Bible reading position and the next suggested session.',
    inputSchema:{ type:'object', properties:{} } },
  { name:'bible_mark_session', description:'Mark the suggested Bible reading session as read.',
    inputSchema:{ type:'object', properties:{} } }
];

function mcpText(obj){ return { content:[{ type:'text', text: typeof obj==='string'?obj:JSON.stringify(obj,null,2) }] }; }

function mcpFindTask(d, name){
  const n = String(name||'').toLowerCase().trim();
  return (d.tasks||[]).find(t => (t.name||'').toLowerCase() === n)
      || (d.tasks||[]).find(t => (t.name||'').toLowerCase().includes(n));
}

async function mcpCall(name, args){
  const d = readData();
  args = args || {};
  switch(name){
    case 'list_day': {
      const ds = /^\d{4}-\d{2}-\d{2}$/.test(args.date||'') ? args.date : getToday();
      const evs = groupedEventsOnDay(d, ds);
      if(!evs.length) return mcpText('Nothing scheduled on '+ds+'.');
      return mcpText({ date: ds, items: evs.map(e=>({
        type: e._type,
        name: (e._type==='sport' && e._display==='collapsed') ? e.name+' ('+e.count+' fixtures)' : e.name,
        time: fmtTime(e.time), done: !!e.done, location: e.location || undefined })) });
    }
    case 'upcoming': {
      const days = Math.min(60, Math.max(1, parseInt(args.days)||7));
      const out = [];
      for(let i=0;i<days;i++){
        const ds = addDays(getToday(), i);
        const evs = groupedEventsOnDay(d, ds);
        if(evs.length) out.push({ date: ds, items: evs.map(e=>({ name:e.name, time:fmtTime(e.time), type:e._type })) });
      }
      return mcpText(out.length ? out : 'Nothing scheduled in the next '+days+' days.');
    }
    case 'add_task': {
      if(!args.name || !args.date) return mcpText('A name and a date are required.');
      const grp = (d.groups||[])[0] || { id:'g_pers' };
      const reminders = Array.isArray(args.remindMinutes) ? args.remindMinutes.map(String) : ['15'];
      const task = { id: uid(), name: String(args.name), date: args.date, time: fmtTime(args.time||'09:00'),
        freq:'none', group: grp.id, priority:'normal', notes: args.notes||'',
        location: args.location||'', reminders, reminder: reminders[0]||'', done:false };
      d.tasks = d.tasks || []; d.tasks.push(task);
      writeData(d);
      return mcpText('Added "'+task.name+'" on '+task.date+' at '+task.time+'.');
    }
    case 'complete_task': {
      const t = mcpFindTask(d, args.name);
      if(!t) return mcpText('No task matching "'+args.name+'".');
      t.done = args.done === false ? false : true;
      writeData(d);
      return mcpText('"'+t.name+'" marked '+(t.done?'done':'not done')+'.');
    }
    case 'delete_task': {
      const t = mcpFindTask(d, args.name);
      if(!t) return mcpText('No task matching "'+args.name+'".');
      d.tasks = d.tasks.filter(x => x.id !== t.id);
      writeData(d);
      return mcpText('Deleted "'+t.name+'".');
    }
    case 'bible_status': {
      if(!d.biblePlan) return mcpText('No Bible reading plan has been started.');
      const st = biblePlanState(d.biblePlan);
      return mcpText({ next: st.suggestion.label, verses: st.suggestion.verses,
        chaptersRead: st.chaptersRead, of: st.totalChapters, timeThrough: st.cycle });
    }
    case 'bible_mark_session': {
      if(!d.biblePlan) return mcpText('No Bible reading plan has been started.');
      const sug = bibleSuggestion(d.biblePlan.pos||0, d.biblePlan.versesPerDay);
      if(sug.wraps) d.biblePlan.cycle = (d.biblePlan.cycle||1)+1;
      d.biblePlan.pos = sug.nextPos; d.biblePlan.lastReadAt = new Date().toISOString();
      writeData(d);
      const st = biblePlanState(d.biblePlan);
      return mcpText('Marked as read. Next: '+st.suggestion.label+' ('+st.suggestion.verses+' verses).');
    }
    default:
      return mcpText('Unknown tool: '+name);
  }
}

async function mcpHandle(msg){
  const id = msg.id;
  const reply = (result) => ({ jsonrpc:'2.0', id, result });
  switch(msg.method){
    case 'initialize':
      return reply({ protocolVersion:'2024-11-05',
        capabilities:{ tools:{} },
        serverInfo:{ name:'personal-organizer', version: BUILD_VERSION } });
    case 'notifications/initialized':
      return null;                       // a notification: no response
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: MCP_TOOLS });
    case 'tools/call': {
      try{
        const out = await mcpCall(msg.params && msg.params.name, msg.params && msg.params.arguments);
        return reply(out);
      }catch(e){
        return reply({ content:[{ type:'text', text:'Error: '+e.message }], isError:true });
      }
    }
    default:
      return { jsonrpc:'2.0', id, error:{ code:-32601, message:'Method not found: '+msg.method } };
  }
}

app.post('/mcp/:secret', async (req, res) => {
  const want = mcpSecret(null, false);
  if(!want || req.params.secret !== want) return res.status(404).json({ error:'Not found' });
  const body = req.body;
  const msgs = Array.isArray(body) ? body : [body];
  const out = [];
  for(const m of msgs){
    const r = await mcpHandle(m || {});
    if(r) out.push(r);
  }
  if(!out.length) return res.status(202).end();     // notifications only
  res.json(Array.isArray(body) ? out : out[0]);
});

app.get('/mcp/:secret', (req, res) => {
  const want = mcpSecret(null, false);
  if(!want || req.params.secret !== want) return res.status(404).json({ error:'Not found' });
  res.status(405).json({ error:'Use POST (JSON-RPC)' });
});

app.get('/api/mcp/info', (req, res) => {
  const d = readData();
  const secret = mcpSecret(d, true);
  res.json({ url: (APP_URL||'') + '/mcp/' + secret, tools: MCP_TOOLS.map(t=>t.name) });
});
app.post('/api/mcp/rotate', (req, res) => {
  const d = readData();
  if(!d.settings) d.settings = {};
  d.settings.mcpSecret = null;
  writeData(d);
  const secret = mcpSecret(readData(), true);
  res.json({ url: (APP_URL||'') + '/mcp/' + secret });
});


app.get('/api/home', async (req, res) => {
  try{
    const q = (req.query.q||'').trim();
    if(!q){
      const d = readData(); const h = homeOf(d);
      return res.json(h ? { ...h, address: d.settings && d.settings.homeAddress || '' } : { error:'No home set' });
    }
    const geo = await geocodeAddress(q);
    if(!geo) return res.json({ error:'Could not find “'+q+'”.' });
    const d = readData();
    d.settings = d.settings || {};
    d.settings.homeAddress = q;
    d.settings.homeLat = geo.lat; d.settings.homeLon = geo.lon; d.settings.homeName = geo.label;
    // Starting point changed, so every cached journey is now wrong.
    d.travelCache = {};
    writeData(d);
    res.json({ ok:true, lat:geo.lat, lon:geo.lon, name:geo.label, precise:geo.precise!==false });
  }catch(e){ res.status(500).json({ error:e.message }); }
});

// Settings that change the maths (traffic allowance, routing key) make the
// cached journeys wrong, so the app clears them after saving.
app.post('/api/travel/clear', (req, res) => {
  try{ const d=readData(); d.travelCache={}; writeData(d); res.json({ok:true}); }
  catch(e){ res.status(500).json({error:e.message}); }
});

// GET /api/travel?to=Timisoara[&force=1]
app.get('/api/travel', async (req, res) => {
  try{
    const data = readData();
    const out = await travelFor(data, req.query.to, req.query.force === '1', req.query.mode, req.query.from);
    res.json(out);
  }catch(e){ res.status(500).json({ error:e.message }); }
});

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
// The daily and weekly briefings were Telegram-only, so they retire with
// it. setupCrons is kept as a no-op because several places still call it
// after settings change.
function setupCrons(){ /* nothing scheduled — notifications are push-based */ }

// Fixture sync — refreshes followed teams/competitions into sportEvents.
// Monthly snapshot on the 1st at 03:30. The copy that used to be sent to
// Telegram is now the folder backup on your PC (see Settings).
let _backupCron = cron.schedule('30 3 1 * *', async () => {
  console.log('Running monthly backup...');
  try {
    const id = await saveSnapshot('monthly');
    console.log('   Snapshot saved:', id);
  } catch(e) { console.log('Monthly backup error:', e.message); }
});

let _fixtureSyncCron = cron.schedule('17 */6 * * *', async () => {
  console.log('Running scheduled fixture sync...');
  try { await syncFixtures(); } catch(e){ console.log('Scheduled sync error:', e.message); }
});

// ═══════════════════════════════════════════════════
// EVENT REMINDERS — server-side, so they fire via Telegram whether or not
// the app is open in a browser (the old browser-notification-only version
// silently did nothing when the tab was closed).
// ═══════════════════════════════════════════════════
function eventStartMs(ev){
  if(!ev.date) return NaN;
  const t = fmtTime(ev.time||'00:00');
  // Stored dates/times are already local (Europe/Bucharest). Build the UTC
  // instant that corresponds to that local wall-clock time.
  const [y,mo,dd] = ev.date.split('-').map(Number);
  const [hh,mi] = t.split(':').map(Number);
  // Determine Bucharest's UTC offset for that date (handles DST correctly).
  const guess = Date.UTC(y, mo-1, dd, hh, mi);
  const asBuch = new Date(guess).toLocaleString('en-US',{timeZone:'Europe/Bucharest'});
  const offsetMs = new Date(guess).getTime() - new Date(asBuch+' UTC').getTime();
  return guess + offsetMs;
}

// Which upcoming occurrences need a reminder right now. Handles recurring
// tasks by resolving the reminder against today's/tomorrow's occurrence.
// An event may carry several reminders (e.g. 1 day, 2 hours, 15 min before).
// Older data stored one "reminder" string, so both shapes are accepted.
function remindersOf(ev){
  let list = Array.isArray(ev && ev.reminders) && ev.reminders.length ? ev.reminders
           : (ev && ev.reminder ? [ev.reminder] : []);
  return [...new Set(list.map(x=>parseInt(x)).filter(n=>n>0))];
}

function dueReminders(data, nowMs, windowMs){
  const due = [];
  const sent = data.sentReminders || {};
  const candidates = [
    ...(data.tasks||[]).map(t=>({...t,_type:'task'})),
    ...(data.sportEvents||[]).map(e=>({...e,_type:'sport'}))
  ];
  // Look at today and tomorrow so a late-night event with a long lead time
  // (e.g. "1 day before") still resolves correctly.
  const days = [getToday(), addDays(getToday(),1)];
  for (const ev of candidates) {
    const list = remindersOf(ev);
    // An event may want ONLY a leave-by warning and no ordinary reminder,
    // so don't skip it just because the reminder list is empty.
    const wantsLeave = (data.settings||{}).leaveBy !== false && !!ev.location;
    if (!list.length && !wantsLeave) continue;
    for (const ds of days) {
      if (!matchesDate(ev, ds)) continue;
      if (ev._type === 'task' && isDoneOn(ev, ds)) continue; // already ticked off for this date
      const startMs = eventStartMs({ ...ev, date: ds });
      if (isNaN(startMs)) continue;
      // A "leave by" warning is a reminder derived from travel time rather
      // than a fixed number of minutes, so it's added alongside the others.
      const stx = data.settings || {};
      if (stx.leaveBy !== false && ev.location) {
        const mode = travelMode(ev);
        // A manually entered duration (bus, train, anything we can't route)
        // takes precedence over a computed one.
        const manualMins = parseInt(ev.travelMins);
        const tr = (manualMins > 0)
          ? { mins: manualMins, manual:true, mode, toName: ev.location }
          : travelCached(data, ev.location, mode, ev.travelFrom);
        if (tr && tr.mins != null) {
          const buffer = parseInt(stx.leaveBuffer != null ? stx.leaveBuffer : 10) || 0;
          const leaveMs = startMs - (tr.mins + buffer)*60000;
          const lkey = ev.id + '|' + ds + '|leave';
          if (!sent[lkey] && leaveMs <= nowMs && nowMs - leaveMs < windowMs && startMs > nowMs) {
            due.push({ ev, ds, startMs, mins: Math.round((startMs-nowMs)/60000), key: lkey, leave: true, travel: tr, buffer });
          }
        }
      }
      for (const mins of list) {
        const fireMs = startMs - mins*60000;
        // Each reminder is tracked separately, so "2 hours before" going
        // out doesn't suppress "15 min before" later on.
        const key = ev.id + '|' + ds + '|' + mins;
        if (sent[key]) continue;
        // Reminders sent before multi-reminder support used the key
        // "id|date"; honour those so nothing fires twice after the update.
        if (sent[ev.id + '|' + ds] && String(mins) === String(parseInt(ev.reminder))) continue;
        if (fireMs <= nowMs && nowMs - fireMs < windowMs && startMs > nowMs) {
          due.push({ ev, ds, startMs, mins, key });
        }
      }
    }
  }
  return due;
}

function reminderLabel(mins){
  if (mins >= 1440) return (mins/1440)+' day'+(mins>=2880?'s':'');
  if (mins >= 60) return (mins/60)+' hour'+(mins>=120?'s':'');
  return mins+' min';
}

let _reminderCron = cron.schedule('* * * * *', async () => {
  try {
    const d = readData();
    const token = null, chatId = null;          // Telegram retired
    const hasPush = (d.pushSubs || []).length > 0;
    // Previously this returned early without Telegram configured, which
    // would have silently disabled web-push reminders too.
    if ((!token || !chatId) && !hasPush) return;
    const nowMs = Date.now();
    // Cache travel times for today's and tomorrow's located events first, so
    // the (synchronous) due-check below can read them.
    try { await ensureTravelForUpcoming(d); } catch(e) { console.log('Travel prep failed:', e.message); }
    // 10-minute grace window so a brief restart/outage doesn't drop a reminder.
    const due = dueReminders(readData(), nowMs, 10*60000);
    if (!due.length) return;
    const data = readData();
    if (!data.sentReminders) data.sentReminders = {};
    for (const item of due) {
      const ev = item.ev;
      const emoji = ev._type === 'task' ? colorEmoji(groupColor(data, ev.group)) : '🏆';
      let msg;
      if (item.leave) {
        const t = item.travel;
        msg  = '🚗 <b>Time to leave</b>\n\n';
        msg += emoji+' <b>'+ev.name+'</b>\n';
        msg += '🕐 Starts '+fmtTime(ev.time)+(item.ds!==getToday()?' · '+item.ds:'')+'\n';
        msg += '📍 '+(t.fromName && t.fromPlace ? t.fromName+' → ' : '')+(t.toName||ev.location)+'\n';
        const mcfg = TRAVEL_MODES[t.mode||'drive'] || TRAVEL_MODES.drive;
        msg += mcfg.emoji+' '+reminderLabel(t.mins)+' by '+mcfg.label.toLowerCase()+
               (t.km?' · '+t.km+' km':'')+(t.estimated?' (estimated)':'')+(t.manual?' (your estimate)':'')+'\n';
        if (item.buffer) msg += '⏳ includes '+item.buffer+' min to spare\n';
      } else {
      msg = '⏰ <b>Starting in '+reminderLabel(item.mins)+'</b>\n\n';
      msg += emoji+' <b>'+ev.name+'</b>\n';
      msg += '🕐 '+fmtTime(ev.time)+(item.ds!==getToday()?' · '+item.ds:'')+'\n';
      }
      if (ev.competitionName) msg += '🏆 '+ev.competitionName+'\n';
      if (ev.notes) msg += '📝 '+ev.notes+'\n';
      // Both channels: Telegram (reliable on phones) and web push (works
      // without opening Telegram). Either failing must not stop the other.
      // Telegram has been retired: notifications go out via web push only.
      let tgOk = false, tgErr = 'Telegram removed', pushCount = 0, pushErr = null;
      try {
        const when = fmtTime(ev.time) + (item.ds!==getToday() ? ' · '+item.ds : '');
        const secsToStart = Math.floor((item.startMs - Date.now())/1000);
        pushCount = await sendWebPush(
          item.leave
            ? '🚗 Leave now — '+ev.name
            : '⏰ In '+reminderLabel(item.mins)+': '+ev.name,
          item.leave
            ? reminderLabel(item.travel.mins)+' drive to '+(item.travel.toName||ev.location)+' · starts '+fmtTime(ev.time)
            : when + (ev.competitionName ? ' · '+ev.competitionName : '') + (ev.notes ? '\n'+ev.notes : ''),
          // Same tag as the in-page fallback so the device shows one
          // notification, not two, if both happen to fire.
          { date: item.ds, tag: 'rem-'+ev.id+'-'+item.ds+(item.leave?'-leave':'') },
          // Expire when the event starts — never deliver a stale reminder.
          { ttl: secsToStart, urgency: 'high' }
        );
      } catch(e){ pushErr = e.message; }

      const delivered = pushCount > 0;
      // Only record it as sent if something actually got through. Marking
      // it sent unconditionally (the previous behaviour) meant a failed
      // delivery was never retried AND the failure was invisible — the
      // reminder simply never arrived and the app believed it had.
      if (delivered) {
        data.sentReminders[item.key] = nowMs;
        console.log('Sent reminder for:', ev.name, item.ds, '| telegram:', tgOk, '| pushDevices:', pushCount);
      } else {
        console.log('⚠️ Reminder NOT delivered for:', ev.name, item.ds,
                    '| telegram error:', tgErr, '| push error:', pushErr, '| will retry next tick');
      }
      // Keep the last failure visible in the diagnostic endpoint.
      if (!delivered) {
        if (!data.reminderErrors) data.reminderErrors = {};
        data.reminderErrors[item.key] = { at: new Date().toISOString(), telegram: tgErr, push: pushErr };
      } else if (data.reminderErrors) {
        delete data.reminderErrors[item.key];
      }
    }
    // Prune records older than 3 days so this doesn't grow forever.
    const cutoff = nowMs - 3*86400000;
    for (const k of Object.keys(data.sentReminders)) {
      if (data.sentReminders[k] < cutoff) delete data.sentReminders[k];
    }
    writeData(data);
  } catch(e) { console.log('Reminder cron error:', e.message); }
});

// ═══════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════
// Storage must be loaded before anything reads data, so the whole startup
// path is wrapped in an async bootstrap rather than running at import time.
(async () => {
try {
  await initStorage();
} catch (e) {
  console.error('✗ Could not initialise storage — refusing to start with an empty dataset.');
  process.exit(1);
}

const initialData = readData();

app.listen(PORT, async ()=>{
  console.log(`✅ Personal Organizer running on port ${PORT}`);
  console.log(`   APP_URL: ${APP_URL||'NOT SET'}`);

  const followCount = (initialData.follows?.teams?.length||0) + (initialData.follows?.competitions?.length||0);
  if (followCount > 0) {
    console.log(`   Syncing ${followCount} followed teams/competitions...`);
    syncFixtures().catch(e => console.log('Startup sync error:', e.message));
  }

  console.log('   Notifications: web push');
});

})(); // end async bootstrap
