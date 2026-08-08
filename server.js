const express = require('express');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── DATA HELPERS ─────────────────────────────────────────
function readData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch(e) {
    return { tasks:[], sportEvents:[], groups:[], settings:{} };
  }
}
function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ── API ROUTES ───────────────────────────────────────────
// Get all data
app.get('/api/data', (req, res) => {
  res.json(readData());
});

// Save all data
app.post('/api/data', (req, res) => {
  const current = readData();
  const updated = { ...current, ...req.body };
  writeData(updated);
  // Reschedule Telegram if settings changed
  if(req.body.settings) setupCrons(updated.settings);
  res.json({ ok: true });
});

// Sports from TheSportsDB
app.get('/api/sports/:league', async (req, res) => {
  try {
    const league = req.params.league;
    const url = `https://www.thesportsdb.com/api/v1/json/3/eventsseason.php?id=${league}&s=2025-2026`;
    const r = await fetch(url);
    const d = await r.json();
    res.json(d);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Next event for a sport
app.get('/api/sports/next/:league', async (req, res) => {
  try {
    const league = req.params.league;
    const url = `https://www.thesportsdb.com/api/v1/json/3/eventsnextleague.php?id=${league}`;
    const r = await fetch(url);
    const d = await r.json();
    res.json(d);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Send Telegram message
app.post('/api/telegram/send', async (req, res) => {
  const { token, chatId, text } = req.body;
  if(!token || !chatId) return res.json({ ok:false, err:'Missing token or chatId' });
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
    });
    const d = await r.json();
    res.json({ ok: d.ok, err: d.description || '' });
  } catch(e) {
    res.json({ ok: false, err: e.message });
  }
});

// ── CRON / SCHEDULING ────────────────────────────────────
let _dailyCron = null;
let _weeklyCron = null;

function getToday() {
  const n = new Date();
  return n.getFullYear()+'-'+String(n.getMonth()+1).padStart(2,'0')+'-'+String(n.getDate()).padStart(2,'0');
}

function fmtTime(t) {
  if(!t) return '00:00';
  const p = String(t);
  return p.includes(':') ? p : p.padStart(2,'0')+':00';
}

function buildDailyMsg(data) {
  const today = getToday();
  const todayDate = new Date(today+'T00:00:00');
  const dow = todayDate.toLocaleDateString('en-GB',{weekday:'long'});
  const dateDisp = todayDate.toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'});

  // Get today's events
  const allEvs = [
    ...data.tasks.map(t=>({...t,_type:'task'})),
    ...(data.sportEvents||[]).map(e=>({...e,_type:'sport'}))
  ].filter(ev => {
    if(!ev.date) return false;
    const freq = ev.freq || 'none';
    if(freq==='none') return ev.date === today;
    const base = new Date(ev.date+'T00:00:00');
    const tgt = new Date(today+'T00:00:00');
    if(tgt < base) return false;
    if(freq==='daily') return true;
    if(freq==='weekly') return base.getDay()===tgt.getDay();
    if(freq==='monthly') return base.getDate()===tgt.getDate();
    if(freq==='yearly') return base.getMonth()===tgt.getMonth()&&base.getDate()===tgt.getDate();
    return false;
  }).sort((a,b)=>a.time?.localeCompare(b.time||'00:00')||0);

  let msg = '📅 <b>Daily briefing — '+dow+', '+dateDisp+'</b>\n\n';
  if(!allEvs.length) {
    msg += '✨ No events scheduled today. Enjoy your day!';
  } else {
    msg += '<b>'+allEvs.length+' event'+(allEvs.length>1?'s':'')+' today:</b>\n\n';
    allEvs.forEach(ev => {
      const icon = ev._type==='task' ? '📋' : '🏆';
      msg += icon+' <b>'+ev.name+'</b>\n';
      msg += '   🕐 '+fmtTime(ev.time);
      if(ev._type==='task' && ev.priority && ev.priority!=='normal') msg += ' · ⚠️ '+ev.priority;
      if(ev.notes) msg += '\n   📝 '+ev.notes;
      msg += '\n\n';
    });
  }
  msg += '—\n🗂 Personal Organizer';
  return msg;
}

function buildWeeklyMsg(data) {
  const today = getToday();
  const now = new Date();
  const dateDisp = now.toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'});
  let msg = '📆 <b>Weekly summary — '+dateDisp+'</b>\n\n';

  const activeTasks = data.tasks.filter(t=>!t.done);
  const sportEvs = data.sportEvents||[];
  msg += '📋 <b>'+activeTasks.length+'</b> active tasks · 🏆 <b>'+sportEvs.length+'</b> sport events\n\n';

  // Urgent tasks
  const urgent = activeTasks.filter(t=>t.priority==='very');
  const high = activeTasks.filter(t=>t.priority==='high');
  if(urgent.length) {
    msg += '🚨 <b>URGENT:</b>\n';
    urgent.forEach(t=>msg+='• '+t.name+' ('+t.date+')\n');
    msg += '\n';
  }
  if(high.length) {
    msg += '⚠️ <b>High priority:</b>\n';
    high.forEach(t=>msg+='• '+t.name+' ('+t.date+')\n');
    msg += '\n';
  }

  // This week day by day
  msg += '<b>This week\'s schedule:</b>\n';
  const allEvs = [
    ...data.tasks.map(t=>({...t,_type:'task'})),
    ...sportEvs.map(e=>({...e,_type:'sport'}))
  ];
  for(let i=0;i<7;i++) {
    const d = new Date(today+'T00:00:00');
    d.setDate(d.getDate()+i);
    const ds = d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
    const dayEvs = allEvs.filter(ev=>ev.date===ds);
    if(dayEvs.length) {
      const dow = d.toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short'});
      msg += '\n<b>'+dow+'</b>\n';
      dayEvs.sort((a,b)=>a.time?.localeCompare(b.time||'')||0).forEach(ev=>{
        const icon = ev._type==='task'?'📋':'🏆';
        msg += icon+' '+ev.name+' ('+fmtTime(ev.time)+')\n';
      });
    }
  }

  // Upcoming sport events
  const upcoming = sportEvs.filter(e=>e.date>=today).sort((a,b)=>a.date.localeCompare(b.date)).slice(0,5);
  if(upcoming.length) {
    msg += '\n🏆 <b>Next sport events:</b>\n';
    upcoming.forEach(e=>{
      const d = new Date(e.date+'T00:00:00');
      msg += '• '+e.name+' — '+d.toLocaleDateString('en-GB',{day:'numeric',month:'short'})+' at '+fmtTime(e.time)+'\n';
    });
  }
  msg += '\n—\n🗂 Personal Organizer';
  return msg;
}

async function sendTg(token, chatId, text) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({chat_id:chatId, text, parse_mode:'HTML'})
    });
    const d = await r.json();
    if(!d.ok) console.log('TG error:', d.description);
    return d.ok;
  } catch(e) {
    console.log('TG fetch error:', e.message);
    return false;
  }
}

function setupCrons(settings) {
  if(_dailyCron) { _dailyCron.stop(); _dailyCron=null; }
  if(_weeklyCron) { _weeklyCron.stop(); _weeklyCron=null; }

  if(!settings.tgToken || !settings.tgChatId) return;

  const hour = String(settings.tgMorningHour||'08').padStart(2,'0');
  const min  = String(settings.tgMorningMin||'00').padStart(2,'0');
  const weeklyDay = settings.tgWeeklyDay||'1'; // 1=Monday

  console.log(`Scheduling daily at ${hour}:${min}, weekly on day ${weeklyDay}`);

  // Daily cron — every day at morning hour (Bucharest = UTC+3 in summer)
  // cron runs in server UTC, so subtract 3h
  const utcHour = (parseInt(hour)-3+24)%24;
  _dailyCron = cron.schedule(`${min} ${utcHour} * * *`, async () => {
    console.log('Sending daily Telegram briefing...');
    const data = readData();
    await sendTg(settings.tgToken, settings.tgChatId, buildDailyMsg(data));
  });

  // Weekly cron — every Monday
  _weeklyCron = cron.schedule(`${min} ${utcHour} * * ${weeklyDay}`, async () => {
    console.log('Sending weekly Telegram summary...');
    const data = readData();
    await sendTg(settings.tgToken, settings.tgChatId, buildWeeklyMsg(data));
  });

  console.log('Telegram crons scheduled.');
}

// ── STARTUP ──────────────────────────────────────────────
const initialData = readData();
if(initialData.settings?.tgToken) {
  setupCrons(initialData.settings);
}

app.listen(PORT, () => {
  console.log(`Personal Organizer running on port ${PORT}`);
});
