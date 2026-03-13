/* ── backtest.js — Backtest tab logic ─────────────────────────────── */

const DEFAULT_SCRIPT = `def strategy(df, unlocks):
    """
    Short before monthly cliff events, confirmed by dual-RSI bearish crossover.

    Entry conditions (ALL must be true):
      1. Significant cliff approaching  >=  MIN_CLIFF_TOKENS unlocked
      2. RSI(fast) < RSI(slow)  —  short-term momentum below medium-term
         This is a proper momentum crossover, not an arbitrary lookback.
         Tune RSI_FAST_PERIOD (try 3–9); RSI_PERIOD is the baseline (14).

    Tuning guidance:
      ENTRY_DAYS_BEFORE  core timing — how early the market prices in the cliff
      HOLD_DAYS          exit before the typical post-cliff bounce (10–15 days)
      MIN_CLIFF_TOKENS   event quality — larger cliffs = more real sell pressure
      RSI_FAST_PERIOD    fast RSI window; lower = more sensitive (try 3, 5, 7, 9)
      RSI_PERIOD         slow RSI baseline, usually 14

    Args:
        df      : OHLCVT DataFrame  [time, open, high, low, close, volume, vwap]
        unlocks : Unlock DataFrame  [time, has_cliff_event, cliff_event_tokens, ...]

    Returns:
        list of trade dicts with keys:
            entry, exit  (unix timestamps)
            side         "short" | "long"
            entry_price, exit_price  (floats)
    """
    import numpy as np

    trades = []

    # ── Parameters ─────────────────────────────────────────────────
    ENTRY_DAYS_BEFORE = 5      # enter this many days before the cliff
    HOLD_DAYS         = 10     # hold for this many days after the cliff
    MIN_CLIFF_TOKENS  = 50000000   # ignore cliffs below this token count
    RSI_FAST_PERIOD   = 7      # fast RSI window (short-term momentum)
    RSI_PERIOD        = 14     # slow RSI window (medium-term baseline)

    # ── Compute RSI helper ──────────────────────────────────────────
    def compute_rsi(close, period):
        diff     = close.diff()
        gain     = diff.clip(lower=0)
        loss     = (-diff).clip(lower=0)
        avg_gain = gain.ewm(alpha=1 / period, min_periods=period, adjust=False).mean()
        avg_loss = loss.ewm(alpha=1 / period, min_periods=period, adjust=False).mean()
        return 100 - (100 / (1 + avg_gain / avg_loss.replace(0, np.nan)))

    df = df.copy().reset_index(drop=True)
    df['rsi_fast'] = compute_rsi(df['close'], RSI_FAST_PERIOD)
    df['rsi_slow'] = compute_rsi(df['close'], RSI_PERIOD)

    # ── Filter to significant cliff events ──────────────────────────
    cliffs = unlocks[
        (unlocks['has_cliff_event'] == 1) &
        (unlocks['cliff_event_tokens'] >= MIN_CLIFF_TOKENS)
    ].copy()

    for _, cliff in cliffs.iterrows():
        entry_ts = cliff['time'] - ENTRY_DAYS_BEFORE * 86400
        exit_ts  = cliff['time'] + HOLD_DAYS * 86400

        entry_rows = df[df['time'] >= entry_ts]
        exit_rows  = df[df['time'] >= exit_ts]

        if entry_rows.empty or exit_rows.empty:
            continue

        entry_row = entry_rows.iloc[0]
        exit_row  = exit_rows.iloc[0]

        rsi_fast = entry_row['rsi_fast']
        rsi_slow = entry_row['rsi_slow']

        # Skip if either RSI hasn't warmed up yet
        if np.isnan(rsi_fast) or np.isnan(rsi_slow):
            continue

        # ── Dual-RSI filter: short-term momentum below medium-term ──
        if rsi_fast >= rsi_slow:
            continue   # fast RSI still above slow → bullish, skip

        trades.append({
            "entry":       int(entry_row['time']),
            "exit":        int(exit_row['time']),
            "side":        "short",
            "entry_price": float(entry_row['close']),
            "exit_price":  float(exit_row['close']),
        })

    return trades
`;

let btEditor = null;  // CodeMirror instance
let btChart = null;  // LightweightCharts
let btEqChart = null;  // Chart.js equity
let btPair = 'STRKUSD';
let btInterval = 1440;
let btParamsUpdating = false; // guard against editor↔params sync loops

// ── Debounce helper ───────────────────────────────────────────────────────────
function debounce(fn, ms) {
    let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ══════════════════════════════════════════════════════════════════════════════
// ── PARAM DETECTION & SYNC ───────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Scan the script for parameter lines of the form:
 *   UPPER_NAME = value   # optional comment
 * Returns array of { name, value, isNum, isFloat, comment, lineIdx }
 */
function extractParams(script) {
    const params = [];
    const lines = script.split('\n');
    // Match: optional indent + ALL_CAPS_NAME + whitespace = whitespace + value + optional # comment
    const RE = /^(\s*)([A-Z][A-Z0-9_]*)\s*=\s*([^\s#][^#\n]*?)(\s*#\s*(.+))?$/;

    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(RE);
        if (!m) continue;
        const name = m[2];
        const valStr = m[3].trim();
        const comment = m[5] ? m[5].trim() : '';

        // Strip Python underscore separators then try numeric parse
        const numStr = valStr.replace(/_/g, '');
        const numVal = Number(numStr);
        const isNum = !isNaN(numVal) && numStr !== '';
        const isFloat = isNum && (valStr.includes('.') || (Math.abs(numVal) < 1 && numVal !== 0));

        params.push({ name, value: isNum ? numVal : valStr, valStr, isNum, isFloat, comment, lineIdx: i });
    }
    return params;
}

/**
 * Update a single UPPERCASE_NAME = value line in the CodeMirror editor.
 * Uses replaceRange so undo history is preserved.
 */
function updateParamInEditor(name, newVal) {
    if (!btEditor) return;
    const doc = btEditor.getDoc();
    const count = btEditor.lineCount();
    const RE = new RegExp(`^(\\s*${name}\\s*=\\s*)([^#\\n]+?)(\\s*#[^\\n]*)?$`);

    for (let i = 0; i < count; i++) {
        const line = btEditor.getLine(i);
        const m = line.match(RE);
        if (!m) continue;
        const newLine = m[1] + newVal + (m[3] || '');
        doc.replaceRange(newLine, { line: i, ch: 0 }, { line: i, ch: line.length });
        break;
    }
}

/**
 * Read current param values from the editor and render inputs,
 * or update existing input values without recreating DOM.
 */
function syncParamsFromScript() {
    if (btParamsUpdating) return;
    const script = btEditor ? btEditor.getValue() : '';
    const params = extractParams(script);
    const panel = document.getElementById('btParamsPanel');
    const grid = document.getElementById('btParamsGrid');
    const countEl = document.getElementById('btParamsCount');

    if (!params.length) { panel.style.display = 'none'; return; }
    panel.style.display = 'block';
    countEl.textContent = `${params.length} param${params.length > 1 ? 's' : ''}`;

    // Check if we can just update values (same params, same order)
    const existing = grid.querySelectorAll('.bt-param-item');
    const sameSet = existing.length === params.length &&
        [...existing].every((el, i) => el.dataset.name === params[i].name);

    if (sameSet) {
        // Just update input values (no DOM rebuild → no cursor jump)
        existing.forEach((el, i) => {
            const inp = el.querySelector('.bt-param-input');
            // Only update if the user isn't currently focused on this input
            if (document.activeElement !== inp) {
                inp.value = params[i].value;
            }
        });
    } else {
        // Rebuild the grid
        grid.innerHTML = params.map(p => `
      <div class="bt-param-item" data-name="${p.name}">
        <div class="bt-param-name">${p.name}</div>
        ${p.comment ? `<div class="bt-param-comment"># ${p.comment}</div>` : ''}
        <input
          class="bt-param-input"
          type="${p.isNum ? 'number' : 'text'}"
          step="${p.isFloat ? 'any' : '1'}"
          value="${p.value}"
          data-name="${p.name}"
          data-is-float="${p.isFloat}"
        >
      </div>`).join('');

        // Wire up live sync: input → editor
        grid.querySelectorAll('.bt-param-input').forEach(inp => {
            inp.addEventListener('input', () => {
                const name = inp.dataset.name;
                const isFloat = inp.dataset.isFloat === 'true';
                let newVal = inp.value.trim();
                if (!newVal) return;

                // Normalise numeric values
                if (inp.type === 'number') {
                    const n = isFloat ? parseFloat(newVal) : parseInt(newVal, 10);
                    if (isNaN(n)) return;
                    newVal = String(n);
                }

                btParamsUpdating = true;
                updateParamInEditor(name, newVal);
                btParamsUpdating = false;
            });
        });
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// ── INIT ─────────────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

function initBacktest(pairs) {
    // Pair selector
    const btSel = document.getElementById('btPairSelect');
    btSel.innerHTML = pairs.map(p =>
        `<option value="${p.pair}" ${p.pair === btPair ? 'selected' : ''}>${p.pair.replace('USD', '')}  ${p.name}</option>`
    ).join('');
    btSel.addEventListener('change', e => {
        btPair = e.target.value;
        syncBtIntervals();
        setBtDefaultDates();
        loadBtChart();
    });

    syncBtIntervals();
    setBtDefaultDates();

    // CodeMirror
    btEditor = CodeMirror(document.getElementById('btEditorWrap'), {
        value: DEFAULT_SCRIPT,
        mode: 'python',
        theme: 'dracula',
        lineNumbers: true,
        matchBrackets: true,
        autoCloseBrackets: true,
        indentUnit: 4,
        tabSize: 4,
        indentWithTabs: false,
        extraKeys: {
            'Tab': cm => cm.execCommand('insertSoftTab'),
            'Ctrl-Enter': () => runBacktest(),
            'Cmd-Enter': () => runBacktest(),
        },
    });

    // Sync params after editor changes (debounced so it doesn't fire on every keystroke)
    btEditor.on('changes', debounce(() => syncParamsFromScript(), 400));
    // Initial scan
    setTimeout(() => syncParamsFromScript(), 100);

    // Run buttons
    document.getElementById('runBtBtn').addEventListener('click', runBacktest);
    document.getElementById('runBtBtn2').addEventListener('click', runBacktest);

    // Load initial candles so chart isn't blank
    loadBtChart();
}

function syncBtIntervals() {
    const wrap = document.getElementById('btIntervalGroup');
    const pairData = state.pairsData.find(p => p.pair === btPair);
    const available = pairData ? pairData.intervals : [1440];
    const labels = { 15: '15m', 60: '1h', 240: '4h', 1440: '1D' };

    wrap.innerHTML = Object.entries(labels)
        .filter(([v]) => available.includes(+v))
        .map(([v, l]) => `<button class="int-btn${+v === btInterval ? ' active' : ''}" data-val="${v}">${l}</button>`)
        .join('');

    wrap.querySelectorAll('.int-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            btInterval = +btn.dataset.val;
            wrap.querySelectorAll('.int-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            loadBtChart();
        });
    });
}

function setBtDefaultDates() {
    const pairData = state.pairsData.find(p => p.pair === btPair);
    if (!pairData) return;
    document.getElementById('btStartDate').value = pairData.start;
    document.getElementById('btEndDate').value = pairData.end;
}

// ══════════════════════════════════════════════════════════════════════════════
// ── CHART ────────────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

async function loadBtChart() {
    const start = document.getElementById('btStartDate').value;
    const end = document.getElementById('btEndDate').value;
    if (!start || !end) return;

    const candles = await fetch(
        `${API}/api/ohlcvt?pair=${btPair}&interval=${btInterval}&start=${start}&end=${end}`
    ).then(r => r.json()).catch(() => []);

    const ILABELS = { 15: '15m', 60: '1h', 240: '4h', 1440: '1D' };
    document.getElementById('btChartTitle').textContent =
        `${btPair} — ${ILABELS[btInterval] || btInterval + 'm'}`;

    if (!candles.length) {
        document.getElementById('btChartSub').textContent = 'No data for this range.';
        return;
    }
    document.getElementById('btChartSub').textContent =
        `${candles.length} candles · ${tsToDate(candles[0].time)} → ${tsToDate(candles[candles.length - 1].time)}` +
        `   ·   Ctrl+Enter to run`;

    renderBtPriceChart(candles, []);
}

function renderBtPriceChart(candles, trades) {
    const container = document.getElementById('btPriceChart');
    if (btChart) { btChart.remove(); btChart = null; }

    btChart = LightweightCharts.createChart(container, {
        width: container.clientWidth,
        height: 420,
        layout: {
            background: { color: '#ffffff' }, textColor: '#5f6368',
            fontFamily: "'JetBrains Mono', monospace", fontSize: 11,
        },
        grid: { vertLines: { color: '#f1f3f4' }, horzLines: { color: '#f1f3f4' } },
        crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
        rightPriceScale: { borderColor: '#e8eaed' },
        timeScale: { borderColor: '#e8eaed', timeVisible: true, secondsVisible: false },
    });

    const color = PAIR_COLORS[btPair] || '#6366f1';
    const btCandleSeries = btChart.addCandlestickSeries({
        upColor: '#16a34a', downColor: '#dc2626', borderVisible: false,
        wickUpColor: '#16a34a', wickDownColor: '#dc2626',
    });
    const volSeries = btChart.addHistogramSeries({
        color: `${color}40`, priceFormat: { type: 'volume' }, priceScaleId: 'vol',
    });
    btChart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    btCandleSeries.setData(candles.map(c => ({
        time: c.time, open: c.open, high: c.high, low: c.low, close: c.close,
    })));
    volSeries.setData(candles.map(c => ({
        time: c.time, value: c.volume,
        color: c.close >= c.open ? '#16a34a40' : '#dc262640',
    })));

    // ── Trade markers ──────────────────────────────────────────────────────────
    if (trades.length) {
        const allTimes = candles.map(c => c.time).sort((a, b) => a - b);
        const timeSet = new Set(allTimes);

        function snap(ts) {
            if (timeSet.has(ts)) return ts;
            let best = allTimes[0], bestDiff = Math.abs(allTimes[0] - ts);
            for (const t of allTimes) {
                const d = Math.abs(t - ts);
                if (d < bestDiff) { bestDiff = d; best = t; }
                if (t > ts + 86400 * 7) break;
            }
            return best;
        }

        const markers = [];
        for (const t of trades) {
            const win = t.return_pct > 0;
            const retTxt = (win ? '+' : '') + t.return_pct.toFixed(2) + '%';

            markers.push({
                time: snap(t.entry),
                position: t.side === 'short' ? 'aboveBar' : 'belowBar',
                color: t.side === 'short' ? '#ef4444' : '#22c55e',
                shape: t.side === 'short' ? 'arrowDown' : 'arrowUp',
                text: t.side === 'short' ? '▼ SHORT' : '▲ LONG',
                size: 1,
            });
            markers.push({
                time: snap(t.exit),
                position: t.side === 'short' ? 'belowBar' : 'aboveBar',
                color: win ? '#22c55e' : '#ef4444',
                shape: 'circle',
                text: retTxt,
                size: 1,
            });
        }

        markers.sort((a, b) => a.time - b.time);
        // Deduplicate same time+position
        const seen = new Map();
        const deduped = [];
        for (const m of markers) {
            const key = `${m.time}|${m.position}`;
            if (!seen.has(key)) { seen.set(key, true); deduped.push(m); }
        }

        btCandleSeries.setMarkers(deduped);
    }

    new ResizeObserver(() => { if (btChart) btChart.applyOptions({ width: container.clientWidth }); })
        .observe(container);
}

// ══════════════════════════════════════════════════════════════════════════════
// ── RUN BACKTEST ─────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

async function runBacktest() {
    if (!btEditor) return;
    const script = btEditor.getValue();
    const start = document.getElementById('btStartDate').value;
    const end = document.getElementById('btEndDate').value;

    const statusEl = document.getElementById('btStatus');
    statusEl.className = 'bt-status running';
    statusEl.textContent = '⟳ Running…';

    const btn1 = document.getElementById('runBtBtn');
    const btn2 = document.getElementById('runBtBtn2');
    btn1.disabled = btn2.disabled = true;

    try {
        const res = await fetch(`${API}/api/backtest`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pair: btPair, interval: btInterval, start, end, script }),
        });
        const data = await res.json();

        if (data.error) {
            statusEl.className = 'bt-status error';
            statusEl.textContent = data.error;
            return;
        }

        const s = data.stats;
        const retStr = (s.total_return >= 0 ? '+' : '') + s.total_return + '%';
        statusEl.className = 'bt-status success';
        statusEl.textContent =
            `✓  ${s.total_trades} trades  ·  ${retStr} total  ·  ${s.win_rate}% win rate  ·  PF ${s.profit_factor}`;

        // Reload candles then paint markers
        const candles = await fetch(
            `${API}/api/ohlcvt?pair=${btPair}&interval=${btInterval}&start=${start}&end=${end}`
        ).then(r => r.json()).catch(() => []);

        renderBtPriceChart(candles, data.trades);
        renderBtEquity(data.equity, data.stats);
        renderBtStats(data.stats);
        renderBtTradeLog(data.trades);

    } catch (e) {
        statusEl.className = 'bt-status error';
        statusEl.textContent = 'Network error: ' + e.message;
    } finally {
        btn1.disabled = btn2.disabled = false;
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// ── RESULTS RENDERING ────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

function renderBtEquity(equity, stats) {
    document.getElementById('btEquityCard').style.display = 'block';

    const totalRet = stats.total_return;
    const up = totalRet >= 0;
    const color = up ? '#16a34a' : '#dc2626';

    document.getElementById('btEquitySub').textContent =
        `Portfolio starting at $100  ·  Final value: $${(100 + totalRet).toFixed(2)}`;
    document.getElementById('btEquityBadge').innerHTML =
        `<span class="vesting-badge" style="background:${up ? '#dcfce7' : '#fee2e2'};color:${color}">` +
        `${up ? '+' : ''}${totalRet}%</span>`;

    if (btEqChart) { btEqChart.destroy(); btEqChart = null; }

    const eqMap = new Map();
    for (const pt of equity) eqMap.set(pt.time, pt.value);
    const pts = [...eqMap.entries()].sort((a, b) => a[0] - b[0]);

    const ctx = document.getElementById('btEquityChart').getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 0, 160);
    grad.addColorStop(0, `${color}28`);
    grad.addColorStop(1, `${color}00`);

    btEqChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: pts.map(([t]) => tsToDate(t)),
            datasets: [{
                data: pts.map(([, v]) => +v.toFixed(4)),
                borderColor: color, borderWidth: 2.5,
                backgroundColor: grad, fill: true, tension: 0.2,
                pointRadius: 0, pointHoverRadius: 4,
            }],
        },
        options: {
            responsive: true, maintainAspectRatio: true,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: '#1a1a1a', titleColor: '#9aa0a6', bodyColor: '#fff',
                    callbacks: { label: c => `$${c.parsed.y.toFixed(2)}` },
                },
            },
            scales: {
                x: { ticks: { maxTicksLimit: 8, font: { family: "'JetBrains Mono'", size: 10 }, color: '#9aa0a6' }, grid: { display: false } },
                y: { ticks: { callback: v => '$' + v, font: { family: "'JetBrains Mono'", size: 10 }, color: '#9aa0a6' }, grid: { color: '#f1f3f4' } },
            },
        },
    });
}

function renderBtStats(s) {
    const strip = document.getElementById('btStatsRow');
    strip.style.display = 'grid';
    const retUp = s.total_return >= 0;

    strip.innerHTML = [
        { label: 'Total Return', value: `${retUp ? '+' : ''}${s.total_return}%`, cls: retUp ? 'up' : 'dn' },
        { label: 'Win Rate', value: `${s.win_rate}%`, cls: s.win_rate >= 50 ? 'up' : 'dn' },
        { label: 'Total Trades', value: s.total_trades, cls: '' },
        { label: 'Wins / Losses', value: `${s.winning_trades} / ${s.losing_trades}`, cls: '' },
        { label: 'Max Drawdown', value: `${s.max_drawdown}%`, cls: 'dn' },
        { label: 'Profit Factor', value: s.profit_factor, cls: s.profit_factor >= 1 ? 'up' : 'dn' },
        { label: 'Avg Win', value: `+${s.avg_win}%`, cls: 'up' },
        { label: 'Avg Loss', value: `${s.avg_loss}%`, cls: 'dn' },
    ].map(m => `
    <div class="bt-stat-card">
      <div class="bt-stat-label">${m.label}</div>
      <div class="bt-stat-value ${m.cls}">${m.value}</div>
    </div>`).join('');
}

function renderBtTradeLog(trades) {
    document.getElementById('btTradesCard').style.display = 'block';
    document.getElementById('btTradeCount').textContent = `${trades.length} trades`;

    document.getElementById('btTradesTable').innerHTML = `
    <table>
      <thead><tr>
        <th>#</th><th>Side</th><th>Entry Date</th><th>Entry Price</th>
        <th>Exit Date</th><th>Exit Price</th><th>Return</th><th>Duration</th>
      </tr></thead>
      <tbody>${trades.map((t, i) => {
        const win = t.return_pct > 0;
        const ret = (win ? '+' : '') + t.return_pct.toFixed(2) + '%';
        const dur = Math.round((t.exit - t.entry) / 86400) + 'd';
        const sColor = t.side === 'short' ? '#dc2626' : '#16a34a';
        return `
          <tr class="${win ? 'tr-win' : 'tr-loss'}">
            <td class="td-mono" style="color:var(--gray-500)">${i + 1}</td>
            <td><span style="font-weight:800;font-family:var(--mono);color:${sColor}">${t.side.toUpperCase()}</span></td>
            <td class="td-mono">${tsToDate(t.entry)}</td>
            <td class="td-mono">$${t.entry_price.toFixed(5)}</td>
            <td class="td-mono">${tsToDate(t.exit)}</td>
            <td class="td-mono">$${t.exit_price.toFixed(5)}</td>
            <td class="td-mono" style="font-weight:700;color:${win ? '#16a34a' : '#dc2626'}">${ret}</td>
            <td class="td-mono" style="color:var(--gray-500)">${dur}</td>
          </tr>`;
    }).join('')}
      </tbody>
    </table>`;
}
