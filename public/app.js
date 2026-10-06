const socket = io();
const $ = id => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';
const ZOOM_MS = 640;                       // keep in sync with .detail-panel transition in styles.css
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let currentState = { count: 0, capacity: 100, percent: 0, connection: { mode: 'waiting', connected: false } };
let previousCount = null;
let toastTimer;
let activeRange = 'live';
let chartPoints = [];
let activePanel = 'overview';
let originCard = null;
let zoomTimer, enterTimer;
let transitioning = false;   // true while zooming open / closed
let intro = false;           // true until the zoom has landed (numbers + bars animate in after)
const readings = [];

/* Palette: olive #607744 · brown #352208 · cream #FDFFF7 · blue #4F6D7A · gold #DDA448 */
const occupancyLevels = [
  { limit: 49, from: 0, color: '#607744', line: '#607744', ink: '#FFFFFF', accent: '#dfe8d0', label: 'Comfortable', copy: 'There is plenty of room for arrivals.' },
  { limit: 69, from: 50, color: '#DDA448', line: '#B9801F', ink: '#352208', accent: '#f6e2bd', label: 'Moderate', copy: 'The mosque has good space while occupancy is building.' },
  { limit: 89, from: 70, color: '#B5573A', line: '#B5573A', ink: '#FFFFFF', accent: '#f1cdbf', label: 'Busy', copy: 'Getting crowded, but not at the high-capacity zone yet.' },
  { limit: Infinity, from: 90, color: '#8C2F34', line: '#8C2F34', ink: '#FFFFFF', accent: '#ebbdc0', label: 'Near capacity', copy: 'The mosque is full or above the planned capacity.' }
];
const panelLabels = { overview: 'Home', occupancy: 'Occupancy', insights: 'Insights', activity: 'Activity', connection: 'Sensor' };
const timeLabel = stamp => new Date(stamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function toast(message) {
  const node = $('toast'); node.textContent = message; node.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => node.classList.remove('show'), 2800);
}

/* ---------------- Readings + chart ---------------- */
function addReading(count, stamp = Date.now()) {
  const last = readings.at(-1);
  if (!last || last.count !== count) readings.push({ count, stamp });
  while (readings.length > 60) readings.shift();
}
function chartData() {
  const limit = activeRange === 'live' ? 12 : activeRange === '15m' ? 24 : 60;
  const data = readings.slice(-limit);
  const fallback = data.length ? data[0].count : 0;
  while (data.length < 2) data.unshift({ count: fallback, stamp: Date.now() - 60000 });
  const max = Math.max(currentState.capacity || 1, ...data.map(item => item.count), 1);
  return data.map((item, index) => ({ ...item, x: index / (data.length - 1) * 600, y: 165 - (item.count / max * 135) }));
}
function dotLine(x, y, cls, width) {
  const el = document.createElementNS(SVG_NS, 'line');
  el.setAttribute('x1', x); el.setAttribute('x2', x + 0.01); el.setAttribute('y1', y); el.setAttribute('y2', y);
  el.setAttribute('class', cls); if (width) el.style.strokeWidth = `${width}px`;
  return el;
}
function drawPoints(group, points) {
  group.replaceChildren();
  points.forEach((point, index) => {
    const last = index === points.length - 1;
    group.append(dotLine(point.x, point.y, last ? 'dot live' : 'dot', last ? 11 : 7), dotLine(point.x, point.y, 'dot-core', last ? 4.5 : 3));
  });
}
function pathFor(points) { return points.map((point, index) => `${index ? 'L' : 'M'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' '); }
const rangeLabels = { live: 'Last 12 readings', '15m': 'Last 24 readings', '1h': 'Last 60 readings' };

function renderChart() {
  chartPoints = chartData();
  const path = pathFor(chartPoints);
  $('chartLine').setAttribute('d', path);
  $('chartArea').setAttribute('d', `${path} L 600 165 L 0 165 Z`);
  drawPoints($('chartPoints'), chartPoints);
  $('axisStart').textContent = rangeLabels[activeRange];
  const values = readings.map(item => item.count);
  $('chartCurrent').textContent = currentState.count;
  $('chartPeak').textContent = values.length ? Math.max(...values) : 0;
  $('chartAverage').textContent = values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0;
  renderDetailChart();
}

/* Shared hover / pin behaviour for both charts */
function attachChartHover({ wrap, svg, tip, guide, focus, getPoints, onPin }) {
  const pick = event => {
    const points = getPoints(); if (!points.length) return null;
    const bounds = svg.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / bounds.width * 600;
    return points.reduce((best, point) => Math.abs(point.x - x) < Math.abs(best.x - x) ? point : best, points[0]);
  };
  const show = point => {
    if (!point) return;
    const box = svg.getBoundingClientRect(); const wrapBox = wrap.getBoundingClientRect();
    tip.hidden = false;
    tip.textContent = `${point.count} people · ${timeLabel(point.stamp)}`;
    tip.style.left = `${box.left - wrapBox.left + point.x / 600 * box.width}px`;
    tip.style.top = `${point.y / 190 * box.height}px`;
    guide.style.display = ''; focus.style.display = '';
    guide.setAttribute('x1', point.x); guide.setAttribute('x2', point.x);
    focus.setAttribute('x1', point.x); focus.setAttribute('x2', point.x + 0.01); focus.setAttribute('y1', point.y); focus.setAttribute('y2', point.y);
  };
  const hide = () => { tip.hidden = true; guide.style.display = 'none'; focus.style.display = 'none'; };
  wrap.addEventListener('pointermove', event => show(pick(event)));
  wrap.addEventListener('pointerleave', hide);
  wrap.addEventListener('click', event => { event.stopPropagation(); const point = pick(event); show(point); if (point && onPin) onPin(point); });
}

/* ---------------- Occupancy state ---------------- */
function occupancyLevel(percent) { return occupancyLevels.find(level => percent <= level.limit); }
function setOccupancyColor(state) {
  const level = occupancyLevel(state.percent);
  const root = document.documentElement.style;
  root.setProperty('--occupancy', level.color);
  root.setProperty('--occupancy-line', level.line);
  root.setProperty('--on-occupancy', level.ink);
  root.setProperty('--occupancy-accent', level.accent);
  $('chartLine').setAttribute('stroke', level.line);
  $('areaStart').setAttribute('stop-color', level.line); $('areaEnd').setAttribute('stop-color', level.line);
  document.documentElement.dataset.occupancy = level.label.toLowerCase().replace(' ', '-');
  return level;
}
function updateSpaceStatus(state) {
  const free = Math.max(0, 100 - state.percent); const c = state.connection || {}; const online = c.connected || c.mode === 'demo'; const level = occupancyLevel(state.percent);
  $('spacePercent').textContent = `${free}%`; $('spaceBar').style.width = `${free}%`;
  $('feedValue').textContent = c.mode === 'demo' ? 'Demo' : c.connected ? 'Live' : 'Offline';
  $('lastReading').textContent = c.lastUpdate ? timeLabel(c.lastUpdate) : '—';
  $('capacityStatus').textContent = level.label;
  $('occupancyBand').innerHTML = `<i class="small-check">✓</i> ${level.label}`;
  $('spaceTitle').textContent = !online ? 'Ready for arrivals' : level.label === 'Comfortable' ? 'Room for your community' : `Occupancy is ${level.label.toLowerCase()}`;
  $('spaceText').textContent = !online ? 'Connect your sensor to start monitoring occupancy in real time.' : level.copy;
}
function update(state) {
  if (!state) return;
  if (previousCount !== null && previousCount !== state.count && state.connection.mode !== 'demo') {
    const delta = state.count - previousCount;
    const row = document.createElement('div'); row.className = 'activity-item';
    const label = document.createElement('span'); label.textContent = delta > 0 ? `${delta} ${delta === 1 ? 'person' : 'people'} detected entering` : `${Math.abs(delta)} ${Math.abs(delta) === 1 ? 'person' : 'people'} count updated`;
    const dot = document.createElement('i'); dot.className = 'event-dot';
    const time = document.createElement('small'); time.textContent = timeLabel(Date.now());
    row.append(dot, label, time); $('activityList').prepend(row); $('activityEmpty').style.display = 'none';
    while ($('activityList').children.length > 5) $('activityList').lastElementChild.remove();
  }
  previousCount = state.count; currentState = state; setOccupancyColor(state); addReading(state.count, state.connection?.lastUpdate ? Date.parse(state.connection.lastUpdate) : Date.now());
  $('count').textContent = state.count; $('insideMetric').textContent = state.count;
  $('capacityText').textContent = state.capacity; $('capacityMetric').textContent = state.capacity;
  $('percent').textContent = `${state.percent}%`; $('progressFill').style.width = `${Math.min(100, state.percent)}%`;
  const remaining = Math.max(0, state.capacity - state.count);
  $('available').textContent = `${remaining} ${remaining === 1 ? 'space' : 'spaces'} remaining`;
  $('availableMetric').textContent = remaining; $('miniFill').style.width = `${Math.max(0, 100 - state.percent)}%`;
  $('miniPercent').textContent = `${Math.max(0, 100 - state.percent)}% free`;
  const c = state.connection || {}; const mode = c.mode || 'waiting';
  const connected = c.connected || mode === 'demo';
  $('connectionOrb').classList.toggle('connected', connected);
  $('connectionTitle').textContent = mode === 'demo' ? 'Demo preview active' : c.connected ? 'Arduino connected' : mode === 'error' ? 'Connection issue' : 'Not connected';
  $('connectionDesc').textContent = mode === 'demo' ? 'Sample data · Arduino not connected' : c.connected ? `${c.port} · ${c.lastUpdate ? timeLabel(c.lastUpdate) : 'Live'}` : c.error || 'Connect your Arduino to begin';
  $('statusText').textContent = mode === 'demo' ? 'Demo data · preview mode' : c.connected ? 'Sensor link active' : mode === 'error' ? 'Check serial connection' : 'Awaiting sensor data';
  $('connectBtn').textContent = c.connected ? 'Disconnect Arduino →' : 'Connect Arduino →';
  $('connectBtn').dataset.action = c.connected ? 'disconnect' : 'connect';
  updateSpaceStatus(state); renderChart();
  if (document.body.classList.contains('detail-open') && !intro) fillDetail(activePanel);
}

/* ---------------- API + controls ---------------- */
async function api(path, body) {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Request failed.'); return data;
}
async function scanPorts() {
  try {
    const ports = await api('/api/ports'); const select = $('portSelect'); const previous = select.value;
    select.replaceChildren(new Option(ports.length ? 'Select a port…' : 'No ports found', ''));
    ports.forEach(port => { const label = [port.path, port.manufacturer].filter(Boolean).join(' · '); select.add(new Option(label, port.path)); });
    if (previous && [...select.options].some(option => option.value === previous)) select.value = previous;
    if (!ports.length) toast('No serial ports found. Check the Arduino USB connection.');
  } catch (error) { toast(error.message); }
}
$('scanBtn').addEventListener('click', scanPorts);
$('connectBtn').addEventListener('click', async () => {
  try {
    const action = $('connectBtn').dataset.action;
    if (action === 'disconnect') { update(await api('/api/disconnect', {})); toast('Arduino disconnected.'); return; }
    const path = $('portSelect').value; if (!path) { toast('Select an Arduino serial port first.'); return; }
    update(await api('/api/connect', { path })); toast('Arduino connected.');
  } catch (error) { toast(error.message); }
});
$('demoBtn').addEventListener('click', async () => { try { update(await api('/api/demo', {})); toast('Demo preview is on. Connect Arduino for live counts.'); } catch (error) { toast(error.message); } });
$('refreshBtn').addEventListener('click', async () => { try { update(await api('/api/state')); await scanPorts(); toast('Dashboard refreshed.'); } catch (error) { toast(error.message); } });
$('editCapacity').addEventListener('click', () => { $('capacityInput').value = currentState.capacity; $('capacityDialog').showModal(); });
$('saveCapacity').addEventListener('click', async event => {
  event.preventDefault(); try { update(await api('/api/capacity', { capacity: Number($('capacityInput').value) })); $('capacityDialog').close(); toast('Capacity updated.'); } catch (error) { toast(error.message); }
});
$('dateLabel').textContent = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date());
document.querySelectorAll('.range').forEach(button => button.addEventListener('click', event => {
  event.stopPropagation();
  activeRange = button.dataset.range;
  document.querySelectorAll('.range').forEach(item => item.classList.toggle('active', item === button));
  renderChart();
}));

/* ---------------- Detail content ---------------- */
function cardForPanel(panel) { return document.querySelector(`.detail-trigger[data-panel="${panel}"]`); }

function bandMarkup(level) {
  const items = occupancyLevels.map((item, index) => {
    const next = occupancyLevels[index + 1];
    const range = item.limit === Infinity ? `${item.from}% and above` : `${item.from}–${item.limit}%`;
    return `<div class="band-item ${item === level ? 'current' : ''}" style="--chip:${item.color}"><i></i><div><b>${item.label}</b><small>${item.copy}</small></div><span class="band-range">${range}</span></div>`;
  }).join('');
  return `<div class="detail-section"><h3>Occupancy bands</h3><div class="band-list">${items}</div></div>`;
}
function legendMarkup() {
  return `<div class="band-row">${occupancyLevels.map(item => `<span class="band-chip" style="--chip:${item.color}"><i></i>${item.label}</span>`).join('')}</div>`;
}

function fillDetail(panel) {
  const c = currentState.connection || {}; const level = occupancyLevel(currentState.percent); const remaining = Math.max(0, currentState.capacity - currentState.count);
  const num = value => intro ? `<span data-count="${value}">0</span>` : value;       // counts up after the zoom lands
  const bar = pct => intro ? `style="width:0" data-w="${pct}"` : `style="width:${pct}%"`;
  let detail;

  if (panel === 'connection') {
    const online = c.connected || c.mode === 'demo';
    detail = {
      eyebrow: 'SENSOR CONNECTION', title: 'Arduino link', intro: 'The live data path from the fabric sensor to this dashboard.',
      content: `<div class="expanded-card connection-skin"><div class="connection-status"><span class="status-orb ${online ? 'connected' : ''}"></span><div><b>${c.mode === 'demo' ? 'Demo preview active' : c.connected ? 'Arduino connected' : 'Not connected'}</b><small>${c.connected ? `${c.port || 'Serial'} · live` : c.error || 'Connect from Home, then return here for the full path.'}</small></div></div></div>
      <div class="detail-section"><h3>Live data path</h3><div class="detail-flow"><span class="flow-step">Fabric touch sensor</span><span class="flow-arrow">→</span><span class="flow-step">Arduino Uno</span><span class="flow-arrow">→</span><span class="flow-step">USB serial</span><span class="flow-arrow">→</span><span class="flow-step">Muttasil dashboard</span></div></div>
      <div class="detail-section"><h3>What to do next</h3><p>${c.connected ? `Counts arrived ${c.lastUpdate ? 'at ' + timeLabel(c.lastUpdate) : 'just now'}. Keep the USB cable seated while people enter.` : 'On Home, choose the Arduino COM port and select Connect Arduino. Demo preview is available if the board is not plugged in yet.'}</p></div>`
    };
  } else if (panel === 'activity') {
    const events = [...$('activityList').children].map(item => `<li>${item.innerHTML}</li>`).join('') || '<li><span class="event-dot"></span><span>No sensor changes have arrived yet.</span></li>';
    detail = {
      eyebrow: 'SYSTEM ACTIVITY', title: 'Live activity', intro: 'The latest events recorded during this session.',
      content: `<div class="expanded-card"><ul class="detail-events">${events}</ul></div>
      <div class="detail-section"><h3>How this feed works</h3><p>Each time the Arduino sends a new <code>Count: N</code> value, Muttasil updates the count, graph and event feed on every open device on your local network.</p></div>`
    };
  } else if (panel === 'insights') {
    detail = {
      eyebrow: 'OCCUPANCY PATTERN', title: 'Live occupancy trend', intro: 'Move across the graph to inspect any reading. Select a point to pin it.',
      content: `<div class="expanded-card chart-skin"><div class="chart-summary"><div><b>${num(currentState.count)}</b><span>people now</span></div><div><b>${num($('chartPeak').textContent)}</b><span>peak today</span></div><div><b>${num($('chartAverage').textContent)}</b><span>average</span></div></div>
      <div class="chart-wrap detail-chart-wrap" id="detailChartWrap"><svg id="detailChart" viewBox="0 0 600 190" preserveAspectRatio="none" role="img" aria-label="Occupancy trend"><defs><linearGradient id="detailAreaFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="${level.line}" stop-opacity=".28"/><stop offset="100%" stop-color="${level.line}" stop-opacity="0"/></linearGradient></defs><g class="grid-lines"><line x1="0" y1="25" x2="600" y2="25"/><line x1="0" y1="82" x2="600" y2="82"/><line x1="0" y1="139" x2="600" y2="139"/></g><path id="detailChartArea" fill="url(#detailAreaFill)" d=""/><path id="detailChartLine" class="trend-line" fill="none" stroke="${level.line}" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" d=""/><line id="detailGuide" class="chart-guide" x1="0" y1="18" x2="0" y2="172" style="display:none"/><line id="detailFocus" class="dot focus" x1="0" y1="0" x2="0.01" y2="0" style="display:none"/><g id="detailChartPoints"></g></svg><div class="chart-tooltip" id="detailChartTooltip" hidden></div></div>
      <div class="chart-axis"><span>${rangeLabels[activeRange]}</span><span>Now</span></div><p class="chart-hint" id="detailChartHint">Range follows the selection on Home.</p>${legendMarkup()}</div>`
    };
  } else {
    detail = {
      eyebrow: 'CURRENT OCCUPANCY', title: 'Mosque occupancy', intro: 'Live headcount with colour bands and remaining capacity.',
      content: `<div class="expanded-card occupancy-skin"><div class="skin-top"><span class="card-kicker">LIVE HEADCOUNT</span><span class="badge">${level.label}</span></div>
      <div class="count-line"><strong>${num(currentState.count)}</strong><span>people<br>inside</span></div>
      <div class="capacity-label"><span><b>${num(currentState.percent)}%</b> of capacity</span><span><b>${currentState.capacity}</b> max</span></div>
      <div class="progress-track"><div ${bar(Math.min(100, currentState.percent))}></div></div>
      <div class="occupancy-foot"><span>${level.label}</span><span>${remaining} ${remaining === 1 ? 'space' : 'spaces'} remaining</span></div></div>
      <div class="detail-grid"><div class="detail-stat"><span>INSIDE NOW</span><b>${num(currentState.count)}</b><small>people</small></div><div class="detail-stat"><span>AVAILABLE</span><b>${num(remaining)}</b><small>spaces</small></div><div class="detail-stat"><span>STATUS</span><b style="font-size:26px">${level.label}</b><small>${level.copy}</small></div></div>
      ${bandMarkup(level)}`
    };
  }
  $('detailEyebrow').textContent = detail.eyebrow; $('detailTitle').textContent = detail.title; $('detailIntro').textContent = detail.intro; $('detailContent').innerHTML = detail.content;
  $('detailPanel').dataset.panel = panel;
  if (panel === 'insights') renderDetailChart(true);
}

function renderDetailChart(bindHover = false) {
  const svg = $('detailChart'); if (!svg) return;
  const points = chartData();
  const path = pathFor(points);
  $('detailChartLine').setAttribute('d', path);
  $('detailChartArea').setAttribute('d', `${path} L 600 165 L 0 165 Z`);
  drawPoints($('detailChartPoints'), points);
  if (!bindHover) return;
  attachChartHover({
    wrap: $('detailChartWrap'), svg, tip: $('detailChartTooltip'), guide: $('detailGuide'), focus: $('detailFocus'),
    getPoints: () => chartData(),
    onPin: point => { $('detailChartHint').textContent = `Pinned reading: ${point.count} people at ${timeLabel(point.stamp)}`; }
  });
}

/* Number count-up + bar fill once the zoom has landed */
function playIntro() {
  intro = false;
  $('detailContent').querySelectorAll('[data-w]').forEach(el => { requestAnimationFrame(() => { el.style.width = `${el.dataset.w}%`; }); });
  $('detailContent').querySelectorAll('[data-count]').forEach(el => {
    const target = Number(el.dataset.count) || 0;
    if (reducedMotion() || target === 0) { el.textContent = target; return; }
    const start = performance.now(); const duration = 900;
    const tick = now => {
      const t = Math.min(1, (now - start) / duration);
      el.textContent = Math.round(target * (1 - Math.pow(1 - t, 3)));
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/* ---------------- Navigation state ---------------- */
function setNav(panel) {
  document.querySelectorAll('.nav-item[data-panel]').forEach(item => item.classList.toggle('active', item.dataset.panel === panel));
  $('crumbLabel').textContent = panelLabels[panel] || 'Home';
}

/* ---------------- Zoom open / close ---------------- */
function rectOf(el) { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; }
function visibleRect(el) {
  if (!el) return null;
  const r = rectOf(el);
  return r.width > 24 && r.height > 24 && r.top + r.height > 40 && r.top < window.innerHeight - 40 ? r : null;
}
function paintRect(el, r, radius, bg) {
  el.style.left = `${r.left}px`; el.style.top = `${r.top}px`; el.style.width = `${r.width}px`; el.style.height = `${r.height}px`;
  el.style.borderRadius = radius; el.style.backgroundColor = bg;
}
function clearRect(el) { ['left', 'top', 'width', 'height', 'borderRadius', 'backgroundColor'].forEach(k => { el.style[k] = ''; }); }
function cardRadius(el) { return getComputedStyle(el).borderTopLeftRadius || '14px'; }

function revealPage() {
  const shell = $('detailShell');
  document.body.classList.add('chrome-in');      // sidebar + top bar glide back in above the zoomed card
  shell.classList.add('enter', 'show');
  playIntro();
  clearTimeout(enterTimer);
  enterTimer = setTimeout(() => shell.classList.remove('enter'), 1400);
  transitioning = false;
  $('detailShell').querySelector('.detail-back').focus({ preventScroll: true });
}

function openDetail(panel) {
  if (panel === 'overview') { closeDetail(); return; }
  if (transitioning && document.body.classList.contains('detail-closing')) return;
  const view = $('detailView'); const panelEl = $('detailPanel'); const shell = $('detailShell');
  const alreadyOpen = document.body.classList.contains('detail-open');

  /* Already open → switch panel with a soft cross-fade (chrome stays in place) */
  if (alreadyOpen) {
    if (panel === activePanel) return;
    activePanel = panel; originCard = cardForPanel(panel); setNav(panel);
    if (intro) { fillDetail(panel); return; }
    shell.classList.add('swap'); shell.classList.remove('show');
    setTimeout(() => {
      intro = true; fillDetail(panel); shell.classList.remove('swap');
      requestAnimationFrame(() => { shell.classList.add('show', 'enter'); playIntro(); clearTimeout(enterTimer); enterTimer = setTimeout(() => shell.classList.remove('enter'), 1400); });
    }, 180);
    return;
  }

  /* "Click" the card: bring it into view, then zoom out of it */
  const card = cardForPanel(panel);
  let rect = visibleRect(card);
  if (!rect && card) { card.scrollIntoView({ block: 'center' }); rect = visibleRect(card); }
  originCard = card; activePanel = panel; intro = true;
  fillDetail(panel); setNav(panel);

  shell.classList.remove('show', 'enter');
  view.classList.add('open'); view.setAttribute('aria-hidden', 'false');
  document.body.classList.add('detail-open');
  transitioning = true;

  if (rect && !reducedMotion()) {
    panelEl.style.transition = 'none';
    paintRect(panelEl, rect, cardRadius(card), getComputedStyle(card).backgroundColor);
    void panelEl.offsetWidth;                          // commit the start frame
    panelEl.style.transition = '';
    requestAnimationFrame(() => requestAnimationFrame(() => clearRect(panelEl)));   // → full screen (CSS rule)
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(revealPage, ZOOM_MS - 90);
  } else {
    clearRect(panelEl);
    revealPage();
  }
}

function closeDetail() {
  if (!document.body.classList.contains('detail-open') || document.body.classList.contains('detail-closing')) return;
  const view = $('detailView'); const panelEl = $('detailPanel'); const shell = $('detailShell');
  const card = cardForPanel(activePanel) || originCard;
  const rect = visibleRect(card);
  const finish = () => {
    view.classList.remove('open'); view.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('detail-open', 'detail-closing', 'chrome-in');
    clearRect(panelEl); shell.classList.remove('show', 'enter', 'swap');
    activePanel = 'overview'; setNav('overview'); transitioning = false; intro = false;
    if (card) card.focus({ preventScroll: true });
  };
  document.body.classList.add('detail-closing');
  transitioning = true; clearTimeout(zoomTimer); clearTimeout(enterTimer);
  shell.classList.remove('show', 'enter');             // content dissolves first…
  if (rect && !reducedMotion()) {
    setTimeout(() => paintRect(panelEl, rect, cardRadius(card), getComputedStyle(card).backgroundColor), 120);   // …then the page folds back into its card
    zoomTimer = setTimeout(finish, ZOOM_MS + 120);
  } else finish();
}

/* ---------------- Wiring ---------------- */
attachChartHover({
  wrap: document.querySelector('.chart-wrap'), svg: $('occupancyChart'), tip: $('chartTooltip'), guide: $('chartGuide'), focus: $('chartFocus'),
  getPoints: () => chartPoints,
  onPin: point => toast(`${point.count} people at ${timeLabel(point.stamp)}`)
});
document.querySelector('.brand').addEventListener('click', event => { event.preventDefault(); closeDetail(); });
document.querySelectorAll('.nav-item[data-panel]').forEach(item => item.addEventListener('click', () => openDetail(item.dataset.panel)));
document.querySelectorAll('.detail-trigger').forEach(card => {
  card.addEventListener('click', event => { if (event.target.closest('button,select,input,label')) return; openDetail(card.dataset.panel); });
  card.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openDetail(card.dataset.panel); } });
});
document.querySelectorAll('[data-close-detail]').forEach(item => item.addEventListener('click', closeDetail));
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('capacityDialog').open) closeDetail(); });
socket.on('state', update); socket.on('connect', () => api('/api/state').then(update).catch(() => {}));
scanPorts();