const express = require('express');
const http = require('http');
const os = require('os');
const fs = require('fs');
const nodePath = require('path');
const { Server } = require('socket.io');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');

const app = express();
const server = http.createServer(app);
// default transports (works with any app.js) + no compression
const io = new Server(server, { perMessageDeflate: false });
const PORT = Number(process.env.PORT || 3000);
const BAUD = Number(process.env.BAUD_RATE || 9600);
let serial = null;
let count = 0;
let capacity = 100;
let connection = { connected: false, port: null, mode: 'waiting', lastUpdate: null };

/* ---------------- History (feeds the forecast) ---------------- */
const MIN = 60e3, HOUR = 3600e3, TAU = 30;           // TAU = how fast the current trend fades (minutes)
const HISTORY_FILE = nodePath.join(__dirname, 'history.json');
let history = [];                                      // [{ t: ms, c: count }] real Arduino readings only
let demoHistory = null;                                // synthetic week, in memory only
let saveTimer = null;
try { history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch (_) {}

function saveHistory() { try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(history)); } catch (_) {} }
function record(c) {
  const now = Date.now();
  history.push({ t: now, c });
  const cutoff = now - 30 * 24 * HOUR;
  if (history.length && history[0].t < cutoff) history = history.filter(p => p.t >= cutoff);
  if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; saveHistory(); }, 30000);
}
// one reading a minute so quiet stretches are learned too, not just changes
setInterval(() => { if (connection.mode === 'arduino' && connection.connected) record(count); }, MIN);

function seedDemo() {
  const g = (h, m, w) => Math.exp(-(((h - m) / w) ** 2));
  const levelAt = t => {
    const d = new Date(t), h = d.getHours() + d.getMinutes() / 60;
    let lvl = 0.04 + 0.28 * g(h, 5.3, 0.5) + 0.34 * g(h, 12.5, 0.6) + 0.30 * g(h, 15.7, 0.5) + 0.42 * g(h, 18.4, 0.5) + 0.36 * g(h, 19.9, 0.6);
    if (d.getDay() === 5) lvl += 0.6 * g(h, 12.9, 0.75);        // Friday Jumu'ah
    lvl *= 0.9 + Math.random() * 0.2;
    return Math.max(0, Math.round(capacity * Math.min(1.05, lvl)));
  };
  const now = Date.now(), out = [];
  for (let t = now - 14 * 24 * HOUR; t < now; t += 10 * MIN) out.push({ t, c: levelAt(t) });
  out.push({ t: now, c: levelAt(now) });
  return out;
}

/* ---------------- Prediction ---------------- */
function slope(points) {                               // people per minute (least squares)
  const n = points.length; if (n < 2) return 0;
  const t0 = points[0].t; let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (const p of points) { const x = (p.t - t0) / MIN; sx += x; sy += p.c; sxy += x * p.c; sxx += x * x; }
  const d = n * sxx - sx * sx;
  return d ? (n * sxy - sx * sy) / d : 0;
}

function predict() {
  const now = Date.now();
  const data = demoHistory || history;
  const cap = capacity;
  const live = connection.mode === 'demo' || (connection.mode === 'arduino' && connection.connected);

  // 1) How people are arriving right now (last 20 min)
  const recent = data.filter(p => now - p.t <= 20 * MIN);
  if (live) recent.push({ t: now, c: count });
  let rate = 0, entries = 0;
  if (recent.length >= 2 && recent.at(-1).t - recent[0].t >= 3 * MIN) {
    const span = (recent.at(-1).t - recent[0].t) / MIN;
    rate = slope(recent);
    for (let i = 1; i < recent.length; i++) { const d = recent[i].c - recent[i - 1].c; if (d > 0) entries += d; }
    entries /= span;
  }
  const per = rate / cap;
  const label = per >= 0.015 ? 'rising fast' : per >= 0.004 ? 'rising' : per <= -0.004 ? 'easing' : 'steady';

  // 2) What usually happens at this time (30-min slots, per weekday + all days)
  const S = Array.from({ length: 8 }, () => Array.from({ length: 48 }, () => ({ sum: 0, n: 0, days: new Set() })));
  const days = new Set();
  const slotOf = d => d.getHours() * 2 + (d.getMinutes() >= 30 ? 1 : 0);
  for (const p of data) {
    const d = new Date(p.t), s = slotOf(d), key = d.toDateString();
    days.add(key);
    for (const k of [d.getDay(), 7]) { const cell = S[k][s]; cell.sum += p.c; cell.n++; cell.days.add(key); }
  }
  const histAt = t => {
    const d = new Date(t), s = slotOf(d), w = S[d.getDay()][s];
    if (w.days.size >= 2) return w.sum / w.n;
    const a = S[7][s];
    return a.n ? a.sum / a.n : null;
  };
  const histNow = histAt(now);
  const bias = histNow == null ? 0 : count - histNow;   // is today busier/quieter than usual?

  // 3) Blend: live trend dominates the next ~20 min, habit takes over after
  const valueAt = h => {
    const trend = count + rate * TAU * (1 - Math.exp(-h / TAU));
    const hist = histAt(now + h * MIN);
    if (hist == null) return Math.max(0, trend);
    const adj = hist + bias * Math.exp(-h / 60);
    const w = Math.exp(-h / 20);
    return Math.max(0, w * trend + (1 - w) * adj);
  };

  const steps = [];
  for (let h = 0; h <= 720; h += 5) {
    const v = valueAt(h);
    steps.push({ h, t: now + h * MIN, count: Math.round(v * 10) / 10, percent: Math.round(v / cap * 100) });
  }

  const peakStep = steps.reduce((best, s) => s.count > best.count ? s : best, steps[0]);
  const quietStep = steps.filter(s => s.h >= 15 && s.h <= 360).reduce((best, s) => s.count < best.count ? s : best, steps[3]);
  const busy = []; let cur = null;
  for (const s of steps) {
    if (s.percent >= 70) { if (!cur) cur = { from: s.t, to: s.t, peak: s.percent }; cur.to = s.t; cur.peak = Math.max(cur.peak, s.percent); }
    else if (cur) { busy.push(cur); cur = null; }
  }
  if (cur) busy.push(cur);
  const reach = pct => { const s = steps.find(x => x.percent >= pct); return s ? s.h : null; };

  const nDays = days.size;
  return {
    generatedAt: now, capacity: cap, mode: connection.mode, live,
    trend: { rate: Math.round(rate * 100) / 100, entries: Math.round(entries * 100) / 100, label },
    peak: { t: peakStep.t, percent: peakStep.percent, count: peakStep.count, inMinutes: peakStep.h },
    quiet: { t: quietStep.t, percent: quietStep.percent, count: quietStep.count },
    busy, reach: { busy: reach(70), near: reach(90) },
    usesHistory: histNow != null,
    confidence: { days: nDays, label: nDays >= 7 ? 'High confidence' : nDays >= 3 ? 'Medium confidence' : nDays >= 2 ? 'Low confidence' : 'Still learning' },
    curve: steps.filter(s => s.h % 15 === 0)
  };
}

app.use(express.static('public'));
app.use(express.json());
app.get('/api/state', (_req, res) => res.json(snapshot()));
app.get('/api/prediction', (_req, res) => res.json(predict()));
app.get('/api/ports', async (_req, res) => {
  try { res.json(await SerialPort.list()); }
  catch (error) { res.status(500).json({ error: error.message }); }
});
app.post('/api/connect', async (req, res) => {
  const path = String(req.body.path || '');
  if (!path) return res.status(400).json({ error: 'Choose a serial port.' });
  closeSerial();
  demoHistory = null;
  try {
    serial = new SerialPort({ path, baudRate: BAUD, autoOpen: false });
    const serialPort = serial;
    const parser = serial.pipe(new ReadlineParser({ delimiter: '\n' }));
    parser.on('data', line => {
      console.log('Arduino says:', String(line).trim());
      const match = String(line).match(/Count\s*:\s*(-?\d+)/i);
      if (!match) return;
      count = Math.max(0, Number(match[1]));
      connection = { connected: true, port: path, mode: 'arduino', lastUpdate: new Date().toISOString() };
      record(count);
      broadcast();
    });
    serial.on('error', error => {
      count = 0;
      connection = { connected: false, port: path, mode: 'error', error: error.message, lastUpdate: connection.lastUpdate };
      broadcast();
    });
    serial.on('close', () => {
      // USB removal closes the serial device. Clear the displayed reading so an
      // old count is never presented as current sensor data.
      if (serial === serialPort) resetDisconnectedState();
    });
    await new Promise((resolve, reject) => serial.open(error => error ? reject(error) : resolve()));
    connection = { connected: true, port: path, mode: 'arduino', lastUpdate: new Date().toISOString() };
    broadcast();
    res.json(snapshot());
  } catch (error) {
    closeSerial();
    connection = { connected: false, port: path, mode: 'error', error: error.message, lastUpdate: connection.lastUpdate };
    broadcast();
    res.status(500).json({ error: error.message });
  }
});
app.post('/api/disconnect', (_req, res) => {
  demoHistory = null;
  closeSerial(true);
  broadcast(); res.json(snapshot());
});
app.post('/api/capacity', (req, res) => {
  const next = Number(req.body.capacity);
  if (!Number.isInteger(next) || next < 1 || next > 10000) return res.status(400).json({ error: 'Capacity must be a whole number from 1 to 10,000.' });
  capacity = next; broadcast(); res.json(snapshot());
});
app.post('/api/demo', (_req, res) => {
  closeSerial(false);
  demoHistory = seedDemo();                            // sample week so the forecast has something to learn from
  count = demoHistory.at(-1).c;
  connection = { connected: false, port: null, mode: 'demo', lastUpdate: new Date().toISOString() };
  broadcast(); res.json(snapshot());
});
function snapshot() { return { count, capacity, percent: Math.min(100, Math.round(count / capacity * 100)), connection }; }
function broadcast() { io.emit('state', snapshot()); }
function resetDisconnectedState() {
  count = 0;
  connection = { connected: false, port: null, mode: 'waiting', lastUpdate: null };
  broadcast();
}
function closeSerial(resetCount = false) {
  const activeSerial = serial;
  serial = null;
  if (activeSerial) {
    try { activeSerial.close(); } catch (_) {}
  }
  if (resetCount) resetDisconnectedState();
}
io.on('connection', socket => socket.emit('state', snapshot()));
server.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter(item => item && item.family === 'IPv4' && !item.internal).map(item => item.address);
  console.log(`Muttasil dashboard: http://localhost:${PORT}`);
  ips.forEach(ip => console.log(`Phone on same Wi-Fi: http://${ip}:${PORT}`));
  console.log(`Arduino serial baud rate: ${BAUD}`);
  console.log(`Loaded ${history.length} saved readings for forecasting`);
});
process.on('SIGINT', () => { closeSerial(); saveHistory(); process.exit(0); });