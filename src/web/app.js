/* ── app.js — Strategy Lab frontend ───────────────────────────────── */

const API = '';   // same origin
const PAIR_COLORS = { ARBUSD: '#0891b2', OPUSD: '#dc2626', STRKUSD: '#7c3aed', ZKUSD: '#2563eb' };
const INTERVAL_LABELS = { 15: '15m', 60: '1h', 240: '4h', 1440: '1D' };

let state = {
  pair: 'STRKUSD',
  interval: 1440,
  pairsData: [],
  showUnlocks: true,
  dataSources: { ohlcvt: true, unlocks: true, indicators: false },
};

let priceChart = null, candleSeries = null, volumeSeries = null;
let vestingChartInst = null;

// ── Particles ─────────────────────────────────────────────────────────────────
(function initParticles() {
  const canvas = document.getElementById('particles');
  if (!canvas) return;  // Strategy Lab page uses a different canvas — skip
  const ctx = canvas.getContext('2d');
  const COLORS = ['#4285F4', '#EA4335', '#FBBC04', '#34A853'];
  let dots = [];

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }

  function spawn() {
    dots = [];
    const n = Math.floor((canvas.width * canvas.height) / 28000);
    for (let i = 0; i < n; i++) {
      dots.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        s: Math.random() * 2.5 + 1,
        c: COLORS[Math.floor(Math.random() * COLORS.length)],
        a: Math.random() * 0.35 + 0.08,
      });
    }
  }

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    dots.forEach(d => {
      ctx.globalAlpha = d.a;
      ctx.fillStyle = d.c;
      ctx.fillRect(d.x, d.y, d.s, d.s);
    });
    ctx.globalAlpha = 1;
  }

  window.addEventListener('resize', () => { resize(); spawn(); draw(); });
  resize(); spawn(); draw();
})();

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  setupTabs();
  setupToolbar();
  const pairs = await fetch(`${API}/api/pairs`).then(r => r.json()).catch(() => []);
  state.pairsData = pairs;
  if (!pairs.length) { console.error('API not reachable'); return; }

  renderPairPills(pairs);
  renderPairSelect(pairs);
  setDefaultDates(pairs);
  renderIntervalGroup();

  // Wire controls
  document.getElementById('loadBtn').addEventListener('click', loadChart);
  document.getElementById('showUnlocks').addEventListener('change', e => {
    state.showUnlocks = e.target.checked;
    loadChart();
  });
  document.getElementById('pairSelect').addEventListener('change', e => {
    state.pair = e.target.value;
    syncPairPills();
    setDefaultDates(state.pairsData);
    renderIntervalGroup();
    loadChart();
    loadTokenMetrics();
  });

  // Auto-load on start
  renderSourceCards(null);
  initBacktest(pairs);
  initMultiBacktest();
  await Promise.all([loadChart(), loadUpcomingCliffs()]);
  loadDbSummary();
});

// ── Tabs ──────────────────────────────────────────────────────────────────────
function setupTabs() {
  document.querySelectorAll('.nav-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll('.nav-tab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${tab}`).classList.add('active');
      // CodeMirror needs refresh() after becoming visible
      if (tab === 'backtest' && btEditor) btEditor.refresh();
      if (tab === 'portfolio' && mbEditor) mbEditor.refresh();
    });
  });
}

// ── Toolbar ───────────────────────────────────────────────────────────────────
function setupToolbar() {
  document.querySelectorAll('.tool-btn:not([disabled])').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const tool = btn.dataset.tool;
      if (tool === 'unlock') document.getElementById('vestingCard').scrollIntoView({ behavior: 'smooth' });
      if (tool === 'metrics') document.getElementById('tokenInfoCard')?.scrollIntoView({ behavior: 'smooth' });
    });
  });
}

// ── Pair pills and select ─────────────────────────────────────────────────────
function renderPairPills(pairs) {
  const wrap = document.getElementById('pairPills');
  wrap.innerHTML = pairs.map(p => `
    <button class="pair-pill ${p.pair === state.pair ? 'active' : ''}"
            data-pair="${p.pair}" style="${p.pair === state.pair ? `background:${p.color};border-color:${p.color}` : ''}">
      ${p.pair.replace('USD', '')}
    </button>`).join('');
  wrap.querySelectorAll('.pair-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      state.pair = btn.dataset.pair;
      syncPairPills();
      document.getElementById('pairSelect').value = state.pair;
      setDefaultDates(state.pairsData);
      loadChart();
      loadTokenMetrics();
    });
  });
}

function syncPairPills() {
  document.querySelectorAll('.pair-pill').forEach(btn => {
    const active = btn.dataset.pair === state.pair;
    btn.classList.toggle('active', active);
    const color = PAIR_COLORS[btn.dataset.pair] || '#1a1a1a';
    btn.style.cssText = active ? `background:${color};border-color:${color}` : '';
  });
}

function renderPairSelect(pairs) {
  const sel = document.getElementById('pairSelect');
  sel.innerHTML = pairs.map(p =>
    `<option value="${p.pair}" ${p.pair === state.pair ? 'selected' : ''}>${p.pair.replace('USD', '')} — ${p.name}</option>`
  ).join('');
}

function renderIntervalGroup() {
  const wrap = document.getElementById('intervalGroup');
  const labels = { 15: '15m', 60: '1h', 240: '4h', 1440: '1D' };
  // Find available intervals for this pair
  const pairData = state.pairsData.find(p => p.pair === state.pair);
  const available = pairData ? pairData.intervals : [1440];
  wrap.innerHTML = Object.entries(labels)
    .filter(([v]) => available.includes(+v))
    .map(([v, l]) => `<button class="int-btn ${+v === state.interval ? 'active' : ''}" data-val="${v}">${l}</button>`)
    .join('');
  wrap.querySelectorAll('.int-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.interval = +btn.dataset.val;
      wrap.querySelectorAll('.int-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      loadChart();
    });
  });
}

function setDefaultDates(pairs) {
  const pairData = pairs.find(p => p.pair === state.pair);
  if (!pairData) return;
  document.getElementById('startDate').value = pairData.start;
  document.getElementById('endDate').value = pairData.end;
}

// ── Chart loading ─────────────────────────────────────────────────────────────
async function loadChart() {
  const start = document.getElementById('startDate').value;
  const end = document.getElementById('endDate').value;
  const pair = document.getElementById('pairSelect').value || state.pair;
  state.pair = pair;

  document.getElementById('chartTitle').textContent = `${pair} — ${INTERVAL_LABELS[state.interval] || state.interval + 'm'}`;
  document.getElementById('chartSub').textContent = `Loading…`;

  const [candles, events, unlockData] = await Promise.all([
    fetch(`${API}/api/ohlcvt?pair=${pair}&interval=${state.interval}&start=${start}&end=${end}`).then(r => r.json()).catch(() => []),
    fetch(`${API}/api/unlock-events?pair=${pair}`).then(r => r.json()).catch(() => []),
    fetch(`${API}/api/unlocks?pair=${pair}`).then(r => r.json()).catch(() => []),
  ]);

  if (!candles.length) {
    document.getElementById('chartSub').textContent = 'No data for selected range.';
    return;
  }

  renderPriceChart(candles, events, pair);
  renderVestingChart(unlockData, pair);
  renderChartStats(candles, pair);
  loadTokenMetrics();
}

// ── TradingView Candlestick Chart ─────────────────────────────────────────────
function renderPriceChart(candles, events, pair) {
  const container = document.getElementById('priceChart');

  // Destroy previous
  if (priceChart) { priceChart.remove(); priceChart = null; }

  priceChart = LightweightCharts.createChart(container, {
    width: container.clientWidth,
    height: 420,
    layout: {
      background: { color: '#ffffff' },
      textColor: '#5f6368',
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
    },
    grid: {
      vertLines: { color: '#f1f3f4' },
      horzLines: { color: '#f1f3f4' },
    },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    rightPriceScale: { borderColor: '#e8eaed' },
    timeScale: {
      borderColor: '#e8eaed',
      timeVisible: true,
      secondsVisible: false,
    },
  });

  const color = PAIR_COLORS[pair] || '#1a1a1a';

  candleSeries = priceChart.addCandlestickSeries({
    upColor: '#16a34a',
    downColor: '#dc2626',
    borderVisible: false,
    wickUpColor: '#16a34a',
    wickDownColor: '#dc2626',
  });

  // Volume histogram (overlay, bottom 20%)
  volumeSeries = priceChart.addHistogramSeries({
    color: `${color}40`,
    priceFormat: { type: 'volume' },
    priceScaleId: 'vol',
  });
  priceChart.priceScale('vol').applyOptions({
    scaleMargins: { top: 0.82, bottom: 0 },
  });

  candleSeries.setData(candles.map(c => ({
    time: c.time,
    open: c.open, high: c.high, low: c.low, close: c.close,
  })));

  volumeSeries.setData(candles.map(c => ({
    time: c.time,
    value: c.volume,
    color: c.close >= c.open ? '#16a34a40' : '#dc262640',
  })));

  // Add unlock event markers
  if (state.showUnlocks && events.length) {
    const candleTimes = new Set(candles.map(c => c.time));
    const sortedTimes = candles.map(c => c.time).sort((a, b) => a - b);

    function nearestTime(t) {
      let best = sortedTimes[0];
      for (const st of sortedTimes) {
        if (Math.abs(st - t) < Math.abs(best - t)) best = st;
      }
      return best;
    }

    const markers = events
      .filter(e => e.amount > 0)
      .map(e => ({
        time: candleTimes.has(e.time) ? e.time : nearestTime(e.time),
        position: 'belowBar',
        color: color,
        shape: 'arrowDown',
        text: fmtAmount(e.amount),
        size: 2,
      }))
      .sort((a, b) => a.time - b.time);

    // Deduplicate by time
    const seen = new Set();
    const dedupedMarkers = markers.filter(m => {
      if (seen.has(m.time)) return false;
      seen.add(m.time); return true;
    });

    if (dedupedMarkers.length) candleSeries.setMarkers(dedupedMarkers);
  }

  // Responsive resize
  const ro = new ResizeObserver(() => {
    if (priceChart) priceChart.applyOptions({ width: container.clientWidth });
  });
  ro.observe(container);
}

// ── Chart stats (OHLCV summary) ───────────────────────────────────────────────
function renderChartStats(candles, pair) {
  const last = candles[candles.length - 1];
  const first = candles[0];
  const chg = ((last.close - first.close) / first.close * 100).toFixed(2);
  const up = +chg >= 0;
  const color = PAIR_COLORS[pair] || '#1a1a1a';

  document.getElementById('chartSub').textContent =
    `${candles.length} candles  ·  ${tsToDate(first.time)} → ${tsToDate(last.time)}`;

  document.getElementById('chartStats').innerHTML = `
    <div class="stat-item">
      <div class="stat-value" style="color:${color}">$${last.close.toFixed(4)}</div>
      <div class="stat-label">Last Price</div>
    </div>
    <div class="stat-item">
      <div class="stat-value ${up ? 'stat-up' : 'stat-dn'}">${up ? '+' : ''}${chg}%</div>
      <div class="stat-label">Total Period</div>
    </div>`;
}

// ── Vesting area chart (Chart.js) ─────────────────────────────────────────────
function renderVestingChart(data, pair) {
  if (!data.length) return;
  document.getElementById('vestingCard').style.display = 'block';

  const color = PAIR_COLORS[pair] || '#7c3aed';
  const pairData = state.pairsData.find(p => p.pair === pair);

  // Downsample to ~300 points for performance
  const step = Math.max(1, Math.floor(data.length / 300));
  const sampled = data.filter((_, i) => i % step === 0);

  // Find max supply from pairsData (not available; estimate from last cumulative)
  const totalTokens = data[data.length - 1].cumulative_tokens || 1;
  const labels = sampled.map(d => tsToDate(d.time));
  const pctData = sampled.map(d => +(d.cumulative_tokens / totalTokens * 100).toFixed(2));

  // Cliff bars — only cliff event days
  const cliffData = sampled.map(d => d.has_cliff_event ? +(d.cliff_event_tokens / totalTokens * 100).toFixed(3) : null);

  const vestSub = document.getElementById('vestingSub');
  const lastPct = pctData[pctData.length - 1];
  vestSub.textContent = `${lastPct.toFixed(1)}% of modelled supply unlocked by end of schedule`;

  const meta = document.getElementById('vestingMeta');
  meta.innerHTML = `<span class="vesting-badge" style="background:${color}20;color:${color}">${pair.replace('USD', '')}</span>`;

  // Destroy previous
  if (vestingChartInst) { vestingChartInst.destroy(); vestingChartInst = null; }

  const ctx = document.getElementById('vestingChart').getContext('2d');

  const gradient = ctx.createLinearGradient(0, 0, 0, 180);
  gradient.addColorStop(0, `${color}30`);
  gradient.addColorStop(1, `${color}00`);

  vestingChartInst = new Chart(ctx, {
    data: {
      labels,
      datasets: [
        {
          type: 'line',
          label: 'Cumulative Unlocked %',
          data: pctData,
          borderColor: color,
          borderWidth: 2,
          backgroundColor: gradient,
          fill: true,
          tension: 0.3,
          pointRadius: 0,
          pointHoverRadius: 4,
          yAxisID: 'y',
        },
        {
          type: 'bar',
          label: 'Cliff Events %',
          data: cliffData,
          backgroundColor: `${color}80`,
          borderColor: color,
          borderWidth: 0,
          yAxisID: 'y',
          barPercentage: 0.5,
        }
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1a1a1a',
          titleColor: '#9aa0a6',
          bodyColor: '#fff',
          callbacks: {
            label: ctx => ctx.dataset.label + ': ' + (ctx.parsed.y ?? 0).toFixed(2) + '%'
          }
        }
      },
      scales: {
        x: {
          ticks: { maxTicksLimit: 8, font: { family: "'JetBrains Mono'", size: 10 }, color: '#9aa0a6' },
          grid: { display: false },
        },
        y: {
          ticks: { callback: v => v + '%', font: { family: "'JetBrains Mono'", size: 10 }, color: '#9aa0a6' },
          grid: { color: '#f1f3f4' },
        }
      }
    }
  });
}

// ── Upcoming Cliffs ───────────────────────────────────────────────────────────
async function loadUpcomingCliffs() {
  const data = await fetch(`${API}/api/upcoming-cliffs?days=120`).then(r => r.json()).catch(() => []);
  const list = document.getElementById('cliffList');

  if (!data.length) {
    list.innerHTML = '<div class="empty-state">No cliffs in next 120 days</div>';
    return;
  }

  const now = Date.now() / 1000;
  list.innerHTML = data.map(c => {
    const daysAway = Math.round((c.time - now) / 86400);
    const soon = daysAway <= 14;
    return `
      <div class="cliff-item">
        <div class="cliff-dot" style="background:${c.color}"></div>
        <div class="cliff-info">
          <div class="cliff-pair" style="color:${c.color}">${c.pair.replace('USD', '')}</div>
          <div class="cliff-date">${c.date_str}</div>
        </div>
        <div class="cliff-amount">
          <div class="cliff-tokens">${c.amount_fmt}</div>
          <div class="cliff-days ${soon ? 'cliff-days-soon' : ''}">${daysAway}d</div>
        </div>
      </div>`;
  }).join('');
}

// ── Token Metrics ─────────────────────────────────────────────────────────────
async function loadTokenMetrics() {
  const unlocks = await fetch(`${API}/api/unlocks?pair=${state.pair}`).then(r => r.json()).catch(() => []);
  if (!unlocks.length) return;
  const last = unlocks[unlocks.length - 1];
  const today = unlocks.find(u => u.time >= Math.floor(Date.now() / 1000) - 86400) || last;
  const totalScheduled = last.cumulative_tokens;

  document.getElementById('tokenMetrics').innerHTML = `
    <div class="metric-row">
      <span class="metric-label">Scheduled total</span>
      <span class="metric-value">${fmtAmount(totalScheduled)}</span>
    </div>
    <div class="metric-row">
      <span class="metric-label">Unlocked to date</span>
      <span class="metric-value">${fmtAmount(today.cumulative_tokens)}</span>
    </div>
    <div class="metric-row">
      <span class="metric-label">Unlock %</span>
      <span class="metric-value">${(today.cumulative_tokens / totalScheduled * 100).toFixed(1)}%</span>
    </div>
    <div class="metric-row">
      <span class="metric-label">Daily rate</span>
      <span class="metric-value">${fmtAmount(today.daily_new_tokens)}/day</span>
    </div>
    <div class="metric-row">
      <span class="metric-label">Daily inflation</span>
      <span class="metric-value">${(today.inflation_pct_of_supply || 0).toFixed(4)}%</span>
    </div>`;
  document.getElementById('tokenInfoCard').style.display = 'block';
}

// ── DB Summary & Source Cards ─────────────────────────────────────────────────
async function loadDbSummary() {
  const data = await fetch(`${API}/api/db-summary`).then(r => r.json()).catch(() => null);
  if (!data) return;

  // DB explorer table
  const rows = [
    ...data.ohlcvt.map(r => ({
      table: 'ohlcvt', pair: r.pair,
      type: `${r.interval}m candles`,
      rows: r.rows.toLocaleString(),
      range: `${r.start} → ${r.end}`,
    })),
    ...data.unlocks.map(r => ({
      table: 'token_unlocks', pair: r.pair,
      type: 'daily unlock',
      rows: r.days.toLocaleString(),
      range: `${r.start} → ${r.end}`,
    })),
  ];

  document.getElementById('dbTable').innerHTML = `
    <table>
      <thead><tr><th>Table</th><th>Pair</th><th>Type</th><th>Rows</th><th>Date Range</th></tr></thead>
      <tbody>${rows.map(r => `
        <tr>
          <td><span class="td-badge">${r.table}</span></td>
          <td class="td-mono" style="color:${PAIR_COLORS[r.pair] || '#1a1a1a'};font-weight:700">${r.pair}</td>
          <td>${r.type}</td>
          <td class="td-mono">${r.rows}</td>
          <td class="td-mono">${r.range}</td>
        </tr>`).join('')}
      </tbody>
    </table>`;

  // Store for source cards
  window._dbData = data;
  renderSourceCards(data);
}

function renderSourceCards(data) {
  const d = data || window._dbData;
  const totalCandles = d ? d.counts.ohlcvt.toLocaleString() : 'Loading…';
  const totalCliffs = d ? d.counts.unlock_events.toLocaleString() : 'Loading…';
  const pairsCount = d ? [...new Set(d.ohlcvt.map(r => r.pair))].length : 4;
  const intervals = d ? [...new Set(d.ohlcvt.map(r => r.interval))].length : 6;

  const cards = [
    {
      key: 'ohlcvt', icon: '📈', name: 'Kraken OHLCVT',
      desc: 'Historical open/high/low/close/volume/VWAP price data for all pairs.',
      enabled: state.dataSources.ohlcvt,
      stats: [
        ['Pairs', pairsCount + ' pairs'],
        ['Intervals', intervals + ' (15m–1D)'],
        ['Candles', (+totalCandles || 0).toLocaleString()],
        ['Source', 'Kraken Exchange'],
      ],
    },
    {
      key: 'unlocks', icon: '🔓', name: 'Token Unlock Schedule',
      desc: 'Vesting cliff events and daily linear unlock schedules from official tokenomics docs.',
      enabled: state.dataSources.unlocks,
      stats: [
        ['Tokens', '4 (ARB, OP, STRK, ZK)'],
        ['Cliff events', (+totalCliffs || 0).toLocaleString()],
        ['Horizon', '2022 → 2028'],
        ['Source', 'Official docs + Binance'],
      ],
    },
    {
      key: 'indicators', icon: '📐', name: 'Technical Indicators',
      desc: 'RSI, VWAP, moving averages, volume analysis computed from OHLCVT data.',
      enabled: false, disabled: true,
      stats: [
        ['RSI', '7 / 14 / 21 period'],
        ['MA', 'SMA, EMA, VWAP'],
        ['Volume', 'OBV, Volume delta'],
        ['Status', 'Coming soon'],
      ],
    },
  ];

  document.getElementById('sourceGrid').innerHTML = cards.map(c => `
    <div class="source-card ${c.enabled ? 'enabled' : ''} ${c.disabled ? 'disabled-card' : ''}">
      ${c.disabled ? '<span class="coming-soon-tag">Coming soon</span>' : ''}
      <div class="source-card-header">
        <div class="source-icon">${c.icon}</div>
        <label class="source-toggle">
          <input type="checkbox" ${c.enabled ? 'checked' : ''} ${c.disabled ? 'disabled' : ''}
                 data-source="${c.key}" onchange="toggleSource('${c.key}', this.checked)">
          <span class="source-toggle-track"><span class="source-toggle-thumb"></span></span>
        </label>
      </div>
      <div class="source-name">${c.name}</div>
      <div class="source-desc">${c.desc}</div>
      <div class="source-stats">
        ${c.stats.map(([k, v]) => `
          <div class="source-stat">
            <span class="source-stat-k">${k}</span>
            <span class="source-stat-v">${v}</span>
          </div>`).join('')}
      </div>
    </div>`).join('');
}

function toggleSource(key, val) {
  state.dataSources[key] = val;
  document.querySelector(`.source-card[data-source="${key}"]`)?.classList.toggle('enabled', val);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtAmount(n) {
  if (!n) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)}M`;
  return n.toLocaleString();
}

function tsToDate(ts) {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}
