/* ── multibacktest.js — Portfolio / Multi-Pair Backtest tab ──────── */
// Globals from backtest.js : debounce
// Globals from app.js      : API

// ── Default strategy for Portfolio tab (works on ANY pair, no unlocks needed) ──
const MB_DEFAULT_SCRIPT = `def strategy(df, unlocks):
    """
    Dual-RSI momentum short strategy — works on any pair.

    Short when RSI(fast) crosses below RSI(slow), confirming bearish
    momentum shift. Exit after HOLD_DAYS candles.

    Tuning guidance:
      RSI_FAST_PERIOD   short-term momentum window (try 5–9)
      RSI_PERIOD        medium-term baseline, usually 14
      RSI_MAX_ENTRY     only short if slow RSI is below this level
      HOLD_DAYS         candles to hold after entry
      MIN_VOL_MULTIPLIER skip if entry volume < N × 30-day avg volume

    Args:
        df      : OHLCVT DataFrame  [time, open, high, low, close, volume, vwap]
        unlocks : Unlock DataFrame  (may be empty — not required by this strategy)

    Returns:
        list of trade dicts with keys:
            entry, exit  (unix timestamps)
            side         "short" | "long"
            entry_price, exit_price  (floats)
    """
    import numpy as np

    trades = []

    # ── Parameters ─────────────────────────────────────────────────
    RSI_FAST_PERIOD   = 7      # fast RSI window
    RSI_PERIOD        = 14     # slow RSI window (baseline)
    RSI_MAX_ENTRY     = 60     # only short if slow RSI <= this
    HOLD_DAYS         = 20     # candles to hold after entry
    MIN_VOL_MULTIPLIER = 1.5   # volume confirmation filter

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
    df['vol_avg']  = df['volume'].rolling(30, min_periods=10).mean()

    for i in range(RSI_PERIOD + 1, len(df) - HOLD_DAYS - 1):
        prev = df.iloc[i - 1]
        cur  = df.iloc[i]
        exit_row = df.iloc[i + HOLD_DAYS]

        # Skip NaN rows
        if np.isnan(cur['rsi_fast']) or np.isnan(cur['rsi_slow']):
            continue

        # ── Entry signal: fast RSI crosses below slow RSI ───────────
        fast_crossed = (prev['rsi_fast'] >= prev['rsi_slow']) and \
                       (cur['rsi_fast']  <  cur['rsi_slow'])

        if not fast_crossed:
            continue

        # ── Slow RSI must be below threshold (not over-extended) ────
        if cur['rsi_slow'] > RSI_MAX_ENTRY:
            continue

        # ── Volume confirmation: entry volume above avg ─────────────
        if not np.isnan(cur['vol_avg']) and cur['volume'] < MIN_VOL_MULTIPLIER * cur['vol_avg']:
            continue

        trades.append({
            "entry":       int(cur['time']),
            "exit":        int(exit_row['time']),
            "side":        "short",
            "entry_price": float(cur['close']),
            "exit_price":  float(exit_row['close']),
        })

    return trades
`;

let mbEditor = null;
let mbParamsUpdating = false;
let mbAllCoins = [];       // full response from /api/coins
let mbFilteredCoins = [];       // after search filter
let mbSelectedPairs = new Set();
let mbLastResults = [];
let mbSortField = 'total_return';
let mbSortAsc = false;

// ═══════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════

function initMultiBacktest() {
    // Default dates — last 2 years
    const today = new Date();
    const ago = new Date(today);
    ago.setFullYear(today.getFullYear() - 2);
    document.getElementById('mbEndDate').value = today.toISOString().slice(0, 10);
    document.getElementById('mbStartDate').value = ago.toISOString().slice(0, 10);

    // CodeMirror — uses MB_DEFAULT_SCRIPT (pair-agnostic, no unlocks dep)
    mbEditor = CodeMirror(document.getElementById('mbEditorWrap'), {
        value: MB_DEFAULT_SCRIPT,
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
            'Ctrl-Enter': () => runMultiBacktest(),
            'Cmd-Enter': () => runMultiBacktest(),
        },
    });

    mbEditor.on('changes', debounce(() => mbSyncParams(), 400));
    setTimeout(() => mbSyncParams(), 100);

    // Filter events
    document.getElementById('mbFilterBtn').addEventListener('click', applyMbFilters);
    document.getElementById('mbMaxRank').addEventListener('keydown', e => e.key === 'Enter' && applyMbFilters());
    document.getElementById('mbMinVolume').addEventListener('keydown', e => e.key === 'Enter' && applyMbFilters());
    document.getElementById('mbSearch').addEventListener('input', debounce(renderMbGrid, 200));

    // Quick-select
    document.querySelectorAll('.mb-qs-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const n = btn.dataset.n;
            if (n === 'clear') {
                mbSelectedPairs.clear();
            } else if (n === 'all') {
                mbFilteredCoins.filter(c => c.in_db).forEach(c => mbSelectedPairs.add(c.kraken_pair));
            } else {
                mbFilteredCoins.filter(c => c.in_db).slice(0, +n).forEach(c => mbSelectedPairs.add(c.kraken_pair));
            }
            renderMbGrid();
            updateMbRunBtn();
        });
    });

    // Sort dropdown
    document.getElementById('mbSortBy').addEventListener('change', e => {
        mbSortField = e.target.value;
        if (mbLastResults.length) renderMbTable(mbLastResults);
    });

    // Run
    document.getElementById('mbRunBtn').addEventListener('click', runMultiBacktest);

    // Initial load
    applyMbFilters();
}

// ═══════════════════════════════════════════════════════════════════
// PARAM SYNC (mirrors backtest.js logic with mb-prefixed variables)
// ═══════════════════════════════════════════════════════════════════

function mbExtractParams(script) {
    const params = [];
    const RE = /^(\s*)([A-Z][A-Z0-9_]*)\s*=\s*([^\s#][^#\n]*?)(\s*#\s*(.+))?$/;
    script.split('\n').forEach((line, i) => {
        const m = line.match(RE);
        if (!m) return;
        const name = m[2];
        const valStr = m[3].trim();
        const comment = m[5] ? m[5].trim() : '';
        const numStr = valStr.replace(/_/g, '');
        const numVal = Number(numStr);
        const isNum = !isNaN(numVal) && numStr !== '';
        const isFloat = isNum && (valStr.includes('.') || (Math.abs(numVal) < 1 && numVal !== 0));
        params.push({ name, value: isNum ? numVal : valStr, isNum, isFloat, comment });
    });
    return params;
}

function mbUpdateParamLine(name, newVal) {
    if (!mbEditor) return;
    const doc = mbEditor.getDoc();
    const RE = new RegExp(`^(\\s*${name}\\s*=\\s*)([^#\\n]+?)(\\s*#[^\\n]*)?$`);
    for (let i = 0; i < mbEditor.lineCount(); i++) {
        const line = mbEditor.getLine(i);
        const m = line.match(RE);
        if (!m) continue;
        doc.replaceRange(m[1] + newVal + (m[3] || ''), { line: i, ch: 0 }, { line: i, ch: line.length });
        break;
    }
}

function mbSyncParams() {
    if (mbParamsUpdating) return;
    const params = mbExtractParams(mbEditor ? mbEditor.getValue() : '');
    const panel = document.getElementById('mbParamsPanel');
    const grid = document.getElementById('mbParamsGrid');
    const countEl = document.getElementById('mbParamsCount');

    if (!params.length) { panel.style.display = 'none'; return; }
    panel.style.display = 'block';
    countEl.textContent = `${params.length} param${params.length > 1 ? 's' : ''}`;

    const existing = grid.querySelectorAll('.bt-param-item');
    const sameSet = existing.length === params.length &&
        [...existing].every((el, i) => el.dataset.name === params[i].name);

    if (sameSet) {
        existing.forEach((el, i) => {
            const inp = el.querySelector('.bt-param-input');
            if (document.activeElement !== inp) inp.value = params[i].value;
        });
        return;
    }

    grid.innerHTML = params.map(p => `
    <div class="bt-param-item" data-name="${p.name}">
      <div class="bt-param-name">${p.name}</div>
      ${p.comment ? `<div class="bt-param-comment"># ${p.comment}</div>` : ''}
      <input class="bt-param-input" type="${p.isNum ? 'number' : 'text'}"
        step="${p.isFloat ? 'any' : '1'}" value="${p.value}"
        data-name="${p.name}" data-is-float="${p.isFloat}">
    </div>`).join('');

    grid.querySelectorAll('.bt-param-input').forEach(inp => {
        inp.addEventListener('input', () => {
            let v = inp.value.trim();
            if (!v) return;
            if (inp.type === 'number') {
                const n = inp.dataset.isFloat === 'true' ? parseFloat(v) : parseInt(v, 10);
                if (isNaN(n)) return;
                v = String(n);
            }
            mbParamsUpdating = true;
            mbUpdateParamLine(inp.dataset.name, v);
            mbParamsUpdating = false;
        });
    });
}

// ═══════════════════════════════════════════════════════════════════
// COIN LOADING & PAIR PICKER
// ═══════════════════════════════════════════════════════════════════

async function applyMbFilters() {
    const maxRank = parseInt(document.getElementById('mbMaxRank').value) || 500;
    const minVol = parseFloat(document.getElementById('mbMinVolume').value) || 0;

    document.getElementById('mbPairGrid').innerHTML = '<div class="mb-loading">Loading…</div>';

    try {
        const params = new URLSearchParams({
            max_rank: maxRank, min_volume_24h: minVol, kraken_only: 'true', limit: 500,
        });
        mbAllCoins = await fetch(`${API}/api/coins?${params}`).then(r => r.json());
        mbFilteredCoins = mbAllCoins;

        // Prune selected pairs not in new filter
        const valid = new Set(mbFilteredCoins.filter(c => c.in_db).map(c => c.kraken_pair));
        for (const p of [...mbSelectedPairs]) if (!valid.has(p)) mbSelectedPairs.delete(p);

        renderMbGrid();
        updateMbRunBtn();
    } catch (e) {
        document.getElementById('mbPairGrid').innerHTML =
            `<div class="mb-empty">Failed to load coins: ${e.message}</div>`;
    }
}

function renderMbGrid() {
    const q = (document.getElementById('mbSearch').value || '').toLowerCase();
    const grid = document.getElementById('mbPairGrid');

    let coins = mbFilteredCoins;
    if (q) coins = coins.filter(c =>
        c.symbol.toLowerCase().includes(q) ||
        (c.name || '').toLowerCase().includes(q));

    const inDb = coins.filter(c => c.in_db).length;
    document.getElementById('mbTotalCount').textContent =
        `${inDb} with data`;

    if (!coins.length) {
        grid.innerHTML = '<div class="mb-empty">No pairs match filters</div>';
        return;
    }

    function rankColor(r) {
        if (r <= 10) return { bg: '#f59e0b22', fg: '#f59e0b', border: '#f59e0b44' };
        if (r <= 50) return { bg: '#3b82f622', fg: '#3b82f6', border: '#3b82f644' };
        if (r <= 100) return { bg: '#10b98122', fg: '#10b981', border: '#10b98144' };
        return { bg: '#6b728022', fg: '#9aa0a6', border: '#6b728044' };
    }
    function fmtVol(v) {
        if (!v) return '—';
        if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
        if (v >= 1e6) return `$${(v / 1e6).toFixed(0)}M`;
        if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
        return `$${v.toFixed(0)}`;
    }

    grid.innerHTML = coins.map(c => {
        const pair = c.kraken_pair || '';
        const checked = mbSelectedPairs.has(pair) ? 'checked' : '';
        const dis = !c.in_db;
        const rc = rankColor(c.cmc_rank);
        const dbMark = c.in_db
            ? '<span class="mb-db-dot">✓</span>'
            : '<span class="mb-db-dot mb-db-dot-no">✗</span>';

        return `<label class="mb-pair-item${dis ? ' mb-pair-disabled' : ''}" title="${c.name} — ${pair}">
      <input type="checkbox" class="mb-pair-cb" data-pair="${pair}" ${checked} ${dis ? 'disabled' : ''}>
      <span class="mb-rank-badge" style="background:${rc.bg};color:${rc.fg};border-color:${rc.border}">#${c.cmc_rank}</span>
      <span class="mb-pair-symbol">${c.symbol}</span>
      <span class="mb-pair-name">${(c.name || '').slice(0, 18)}</span>
      <span class="mb-pair-vol">${fmtVol(c.volume_24h_usd)}</span>
      ${dbMark}
    </label>`;
    }).join('');

    grid.querySelectorAll('.mb-pair-cb').forEach(cb => {
        cb.addEventListener('change', () => {
            if (cb.checked) mbSelectedPairs.add(cb.dataset.pair);
            else mbSelectedPairs.delete(cb.dataset.pair);
            updateMbSelectedCount();
            updateMbRunBtn();
        });
    });

    updateMbSelectedCount();
}

function updateMbSelectedCount() {
    document.getElementById('mbSelectedCount').textContent =
        `${mbSelectedPairs.size} selected`;
}

function updateMbRunBtn() {
    const n = mbSelectedPairs.size;
    const btn = document.getElementById('mbRunBtn');
    btn.textContent = `▶  Run on ${n} pair${n !== 1 ? 's' : ''}`;
    btn.disabled = n === 0;
}

// ═══════════════════════════════════════════════════════════════════
// RUN
// ═══════════════════════════════════════════════════════════════════

async function runMultiBacktest() {
    const pairs = [...mbSelectedPairs];
    if (!pairs.length || !mbEditor) return;

    const statusEl = document.getElementById('mbStatus');
    statusEl.className = 'bt-status running';
    statusEl.textContent = `⟳  Running on ${pairs.length} pairs…`;

    const btn = document.getElementById('mbRunBtn');
    btn.disabled = true;
    btn.textContent = '⟳  Running…';

    try {
        const res = await fetch(`${API}/api/backtest-multi`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                pairs,
                interval: parseInt(document.getElementById('mbInterval').value),
                start: document.getElementById('mbStartDate').value,
                end: document.getElementById('mbEndDate').value,
                script: mbEditor.getValue(),
            }),
        });
        const data = await res.json();

        if (data.error) {
            statusEl.className = 'bt-status error';
            statusEl.textContent = data.error;
            return;
        }

        const a = data.aggregate;
        const avg = a.avg_return_per_trade;
        statusEl.className = 'bt-status success';
        statusEl.textContent =
            `✓  ${a.pairs_with_trades}/${a.pairs_run} pairs traded  ·  ` +
            `${a.total_trades} trades  ·  avg/trade ${avg >= 0 ? '+' : ''}${avg}%  ·  Sharpe ${a.sharpe_ratio}`;

        mbLastResults = data.results;
        renderMbAggregate(a);
        renderMbTable(mbLastResults);

    } catch (e) {
        statusEl.className = 'bt-status error';
        statusEl.textContent = 'Error: ' + e.message;
    } finally {
        updateMbRunBtn();
    }
}

// ═══════════════════════════════════════════════════════════════════
// RESULTS
// ═══════════════════════════════════════════════════════════════════

function renderMbAggregate(a) {
    const el = document.getElementById('mbAggregate');
    el.style.display = 'grid';

    const avgUp = a.avg_return_per_trade >= 0;
    const sharpeUp = a.sharpe_ratio >= 0;

    el.innerHTML = [
        { label: 'Avg Return / Trade', value: `${avgUp ? '+' : ''}${a.avg_return_per_trade}%`, cls: avgUp ? 'up' : 'dn' },
        { label: 'Median / Trade', value: `${a.median_return_per_trade >= 0 ? '+' : ''}${a.median_return_per_trade}%`, cls: a.median_return_per_trade >= 0 ? 'up' : 'dn' },
        { label: 'Sharpe Ratio', value: a.sharpe_ratio, cls: sharpeUp ? 'up' : 'dn' },
        { label: 'Win Rate', value: `${a.win_rate}%`, cls: a.win_rate >= 50 ? 'up' : 'dn' },
        { label: 'Profit Factor', value: a.profit_factor, cls: a.profit_factor >= 1 ? 'up' : 'dn' },
        { label: 'Total Trades', value: a.total_trades, cls: '' },
        { label: 'Pairs w/ Trades', value: `${a.pairs_with_trades} / ${a.pairs_run}`, cls: '' },
        { label: 'Best Pair', value: `${a.best_pair.replace('USD', '')} +${a.best_pair_return}%`, cls: 'up' },
    ].map(m => `
    <div class="bt-stat-card">
      <div class="bt-stat-label">${m.label}</div>
      <div class="bt-stat-value ${m.cls}">${m.value}</div>
    </div>`).join('');
}

function renderMbTable(results) {
    document.getElementById('mbResultsCard').style.display = 'block';

    const sorted = [...results].sort((a, b) => {
        const av = a.stats ? (a.stats[mbSortField] ?? -99999) : -99999;
        const bv = b.stats ? (b.stats[mbSortField] ?? -99999) : -99999;
        return mbSortAsc ? av - bv : bv - av;
    });

    const good = results.filter(r => !r.error && r.stats).length;
    document.getElementById('mbResultsCount').textContent = `${good} pairs`;

    const coinMap = {};
    mbAllCoins.forEach(c => { if (c.kraken_pair) coinMap[c.kraken_pair] = c; });

    function colRet(v) { return v >= 0 ? '#16a34a' : '#dc2626'; }

    document.getElementById('mbResultsTable').innerHTML = `
    <table>
      <thead><tr>
        <th>#</th>
        <th>Symbol</th>
        <th>Name</th>
        <th class="mb-th-sort" data-field="total_return">Return</th>
        <th class="mb-th-sort" data-field="total_trades">Trades</th>
        <th class="mb-th-sort" data-field="win_rate">Win %</th>
        <th class="mb-th-sort" data-field="profit_factor">PF</th>
        <th class="mb-th-sort" data-field="max_drawdown">Max DD</th>
        <th class="mb-th-sort" data-field="avg_win">Avg Win</th>
        <th class="mb-th-sort" data-field="avg_loss">Avg Loss</th>
      </tr></thead>
      <tbody>
        ${sorted.map((r, i) => {
        const coin = coinMap[r.pair];
        const sym = r.pair.replace('USD', '');
        const name = coin ? coin.name : r.pair;
        const rank = coin ? `<span class="mb-rank-mini">#${coin.cmc_rank}</span>` : '';

        if (r.error && r.error.startsWith('⚠️')) {
            return `<tr style="opacity:.45">
              <td class="td-mono" style="color:#585b70">${i + 1}</td>
              <td class="td-mono" style="font-weight:700">${sym}</td>
              <td style="color:#585b70;font-size:10px">${name}</td>
              <td colspan="7" style="color:#585b70;font-size:10px">${r.error}</td>
            </tr>`;
        }
        if (r.error) {
            return `<tr style="opacity:.35">
              <td class="td-mono">${i + 1}</td>
              <td class="td-mono" style="font-weight:700">${sym}</td>
              <td style="font-size:10px;color:#dc2626" colspan="8">${String(r.error).slice(0, 120)}</td>
            </tr>`;
        }

        const s = r.stats;
        const up = s.total_return >= 0;
        const ret = `${up ? '+' : ''}${s.total_return}%`;
        return `<tr class="${up ? 'tr-win' : 'tr-loss'}">
            <td class="td-mono" style="color:#585b70">${i + 1}</td>
            <td class="td-mono" style="font-weight:800">${sym} ${rank}</td>
            <td style="color:#9aa0a6;font-size:11px">${name}</td>
            <td class="td-mono" style="font-weight:700;color:${colRet(s.total_return)}">${ret}</td>
            <td class="td-mono">${s.total_trades}</td>
            <td class="td-mono" style="color:${s.win_rate >= 50 ? '#16a34a' : '#dc2626'}">${s.win_rate}%</td>
            <td class="td-mono" style="color:${s.profit_factor >= 1 ? '#16a34a' : '#dc2626'}">${s.profit_factor}</td>
            <td class="td-mono" style="color:#dc2626">${s.max_drawdown}%</td>
            <td class="td-mono" style="color:#16a34a">+${s.avg_win}%</td>
            <td class="td-mono" style="color:#dc2626">${s.avg_loss}%</td>
          </tr>`;
    }).join('')}
      </tbody>
    </table>`;

    // Sortable column headers
    document.getElementById('mbResultsTable').querySelectorAll('.mb-th-sort').forEach(th => {
        th.style.cursor = 'pointer';
        if (th.dataset.field === mbSortField) th.style.color = '#89b4fa';
        th.addEventListener('click', () => {
            if (mbSortField === th.dataset.field) mbSortAsc = !mbSortAsc;
            else { mbSortField = th.dataset.field; mbSortAsc = false; }
            document.getElementById('mbSortBy').value = mbSortField;
            renderMbTable(mbLastResults);
        });
    });
}
