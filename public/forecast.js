/* Muttasil traffic forecast — loads after app.js and reuses its helpers ($, api, pathFor, dotLine, attachChartHover, timeLabel, socket). */
(() => {
  const css = `
.forecast-card{margin-top:20px;padding:24px;background:var(--paper);border:1px solid var(--line);border-radius:14px;box-shadow:0 2px 10px #35220808}
.forecast-card h2{font:700 19px Manrope,sans-serif;letter-spacing:-.3px;color:var(--brown);margin:6px 0 0}
.confidence-pill{padding:7px 12px;border-radius:99px;background:#eef2e6;color:var(--olive);font-size:11.5px;font-weight:700;letter-spacing:1px;white-space:nowrap}
.fc-pace{margin:14px 0 0;font-size:14.5px;color:var(--muted)}
.fc-pace b{color:var(--brown)}
.fc-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin:18px 0}
.fc-stat{padding:16px 18px;border:1px solid var(--line);border-radius:12px;background:var(--cream)}
.fc-stat span{display:block;font-size:11px;font-weight:700;letter-spacing:1.1px;color:var(--muted)}
.fc-stat b{display:block;font:800 26px Manrope,sans-serif;color:var(--brown);margin-top:6px;letter-spacing:-.6px}
.fc-stat small{display:block;font-size:12.5px;color:var(--muted);margin-top:2px;min-height:1.2em}
.fc-band{fill:#DDA448;opacity:.18}
.fc-threshold{stroke:#B9801F;stroke-width:1.2;stroke-dasharray:4 5;vector-effect:non-scaling-stroke;opacity:.85}
.fc-windows{display:flex;flex-wrap:wrap;align-items:center;gap:9px;margin-top:16px;font-size:13px;color:var(--muted)}
.fc-chip{padding:7px 12px;border:1px solid #ecd9b3;border-radius:99px;background:#fbf1de;color:var(--brown);font-weight:600}
.fc-note{margin:12px 0 0;font-size:12.5px;color:var(--muted)}
@media(max-width:760px){.fc-stats{grid-template-columns:1fr}.forecast-card{padding:20px}}`;
  document.head.insertAdjacentHTML('beforeend', `<style>${css}</style>`);

  document.querySelector('.insights-grid').insertAdjacentHTML('afterend', `
<section class="forecast-card" id="forecast">
  <div class="panel-heading">
    <div><span class="card-kicker">TRAFFIC FORECAST</span><h2>What to expect next</h2></div>
    <span class="confidence-pill" id="fcConfidence">Still learning</span>
  </div>
  <p class="fc-pace" id="fcPace">Gathering readings…</p>
  <div class="fc-stats">
    <div class="fc-stat"><span>NEXT PEAK</span><b id="fcPeakTime">—</b><small id="fcPeakSub"></small></div>
    <div class="fc-stat"><span>BUSY (70%) IN</span><b id="fcBusyIn">—</b><small id="fcBusySub"></small></div>
    <div class="fc-stat"><span>QUIETEST TIME</span><b id="fcQuietTime">—</b><small id="fcQuietSub"></small></div>
  </div>
  <div class="chart-wrap fc-wrap" id="fcWrap">
    <svg id="fcChart" viewBox="0 0 600 190" preserveAspectRatio="none" role="img" aria-label="Predicted occupancy for the next 12 hours">
      <defs><linearGradient id="fcFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="#4F6D7A" stop-opacity=".28"/><stop offset="100%" stop-color="#4F6D7A" stop-opacity="0"/></linearGradient></defs>
      <g class="grid-lines"><line x1="0" y1="25" x2="600" y2="25"/><line x1="0" y1="82" x2="600" y2="82"/><line x1="0" y1="139" x2="600" y2="139"/></g>
      <g id="fcBands"></g>
      <line id="fcThreshold" class="fc-threshold" x1="0" x2="600" y1="0" y2="0" style="display:none"/>
      <path id="fcArea" fill="url(#fcFill)" d=""/>
      <path id="fcLine" class="trend-line" fill="none" stroke="#4F6D7A" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" d=""/>
      <line id="fcGuide" class="chart-guide" x1="0" y1="18" x2="0" y2="172" style="display:none"/>
      <line id="fcFocus" class="dot focus" x1="0" y1="0" x2="0.01" y2="0" style="display:none"/>
      <g id="fcMarks"></g>
    </svg>
    <div class="chart-tooltip" id="fcTip" hidden></div>
  </div>
  <div class="chart-axis"><span>Now</span><span id="fcMid"></span><span id="fcEnd"></span></div>
  <div class="fc-windows" id="fcWindows"></div>
  <p class="fc-note" id="fcNote"></p>
</section>`);

  let forecast = null, fcPoints = [], lastFetch = 0, modeKey = '';
  const fmtIn = m => m == null ? null : m <= 0 ? 'now' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
  const pace = { 'rising fast': 'Arrivals are picking up fast', rising: 'Arrivals are picking up', steady: 'Arrivals are steady', easing: 'The crowd is easing' };

  function render() {
    const f = forecast; if (!f || !f.curve.length) return;
    const cap = f.capacity;

    $('fcConfidence').textContent = f.mode === 'demo' ? 'Sample data' : f.confidence.label;
    $('fcPace').innerHTML = f.live
      ? `<b>${pace[f.trend.label]}</b>${f.trend.entries >= 0.1 ? ` · about ${f.trend.entries.toFixed(1)} people/min coming in` : ''}`
      : 'Sensor offline — showing the usual pattern only.';

    $('fcPeakTime').textContent = timeLabel(f.peak.t);
    $('fcPeakSub').textContent = `~${f.peak.percent}% full · ${f.peak.inMinutes <= 0 ? 'right now' : 'in ' + fmtIn(f.peak.inMinutes)}`;
    $('fcBusyIn').textContent = f.reach.busy == null ? 'Not expected' : f.reach.busy === 0 ? 'Already' : fmtIn(f.reach.busy);
    $('fcBusySub').textContent = f.reach.near == null ? 'No near-capacity risk in 12 h' : f.reach.near === 0 ? 'Near capacity now' : `Near capacity in ${fmtIn(f.reach.near)}`;
    $('fcQuietTime').textContent = timeLabel(f.quiet.t);
    $('fcQuietSub').textContent = `~${f.quiet.percent}% full · best time to arrive`;

    /* chart */
    const max = Math.max(cap, ...f.curve.map(p => p.count), 1);
    const t0 = f.curve[0].t, t1 = f.curve.at(-1).t, span = Math.max(1, t1 - t0);
    fcPoints = f.curve.map((p, i) => ({ count: Math.round(p.count), stamp: p.t, x: i / (f.curve.length - 1) * 600, y: 165 - p.count / max * 135 }));
    const path = pathFor(fcPoints);
    $('fcLine').setAttribute('d', path);
    $('fcArea').setAttribute('d', `${path} L 600 165 L 0 165 Z`);
    const th = $('fcThreshold'); const y70 = 165 - 0.7 * cap / max * 135;
    th.setAttribute('y1', y70); th.setAttribute('y2', y70); th.style.display = '';

    const bands = $('fcBands'); bands.replaceChildren();
    f.busy.forEach(w => {
      const x1 = Math.max(0, (w.from - t0) / span * 600), x2 = Math.min(600, (w.to - t0) / span * 600);
      const r = document.createElementNS(SVG_NS, 'rect');
      r.setAttribute('class', 'fc-band'); r.setAttribute('x', x1); r.setAttribute('y', 18);
      r.setAttribute('width', Math.max(4, x2 - x1)); r.setAttribute('height', 154);
      bands.append(r);
    });
    const marks = $('fcMarks'); marks.replaceChildren();
    const pk = fcPoints.reduce((b, p) => p.count > b.count ? p : b, fcPoints[0]);
    marks.append(dotLine(pk.x, pk.y, 'dot', 10), dotLine(pk.x, pk.y, 'dot-core', 4));

    $('fcMid').textContent = timeLabel(f.curve[Math.floor(f.curve.length / 2)].t);
    $('fcEnd').textContent = timeLabel(t1);

    $('fcWindows').innerHTML = f.busy.length
      ? `<span>Expected busy:</span>${f.busy.map(w => `<span class="fc-chip">${timeLabel(w.from)} – ${timeLabel(w.to)} · peaks ~${w.peak}%</span>`).join('')}`
      : '<span>No busy period (70%+) expected in the next 12 hours.</span>';

    $('fcNote').textContent = f.mode === 'demo'
      ? 'Based on a generated sample week, not real readings. Connect the Arduino to start learning your real pattern.'
      : !f.usesHistory
        ? 'Still learning your patterns — using the live trend only. It gets sharper after a few days of readings.'
        : `Learned from ${f.confidence.days} day${f.confidence.days === 1 ? '' : 's'} of readings (blends the live arrival rate with what usually happens at this time and weekday).`;
  }

  async function load(force) {
    if (!force && Date.now() - lastFetch < 8000) return;
    lastFetch = Date.now();
    try { forecast = await api('/api/prediction'); render(); } catch (_) {}
  }

  attachChartHover({
    wrap: $('fcWrap'), svg: $('fcChart'), tip: $('fcTip'), guide: $('fcGuide'), focus: $('fcFocus'),
    getPoints: () => fcPoints
  });

  socket.on('state', s => {
    const key = `${s.connection?.mode}|${s.connection?.connected}|${s.capacity}`;
    const changed = key !== modeKey; modeKey = key; load(changed);
  });
  setInterval(() => load(true), 30000);
  load(true);
})();