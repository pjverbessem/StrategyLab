/* ── portfolio.js — Portfolio overview panel ─────────────────────────────── */
'use strict';

let _portPnlChart   = null;
let _portAllocChart = null;

// Pair display names
const PAIR_LABELS = {
  ARBUSD: 'ARB/USD', OPUSD: 'OP/USD', STRKUSD: 'STRK/USD', ZKUSD: 'ZK/USD',
};
// Chart colours (green-anchored palette)
const CHART_PALETTE = [
  '#12B947', '#0ea5e9', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6',
  '#f97316', '#6366f1', '#84cc16', '#06b6d4',
];

// ── Entry point ───────────────────────────────────────────────────────────────
async function initPortfolioPanel() {
  await loadPortfolio();
}

async function loadPortfolio() {
  try {
    const [stratRes, botRes] = await Promise.all([
      fetch('/api/strategies'),
      fetch('/api/bot/status').catch(() => null),
    ]);

    const strategies = await stratRes.json().catch(() => []);
    const botStatus  = botRes ? await botRes.json().catch(() => null) : null;

    const list = Array.isArray(strategies) ? strategies : (strategies.strategies || []);
    renderPortfolio(list, botStatus);

    const el = document.getElementById('portUpdated');
    if (el) el.textContent = 'Updated ' + new Date().toLocaleTimeString();
  } catch (e) {
    console.error('Portfolio load error:', e);
  }
}

// ── Main render ───────────────────────────────────────────────────────────────
function renderPortfolio(strategies, botStatus) {
  // Only strategies that have backtest results
  const withBT = strategies.filter(s => s.backtest_results);

  // ── 1. Compute aggregates ─────────────────────────────────────────────────
  const totalPnl     = sum(withBT, r => r.backtest_results.net_pnl          ?? 0);
  const avgWinRate   = avg(withBT, r => r.backtest_results.win_rate          ?? 0);
  const avgPF        = avg(withBT, r => r.backtest_results.profit_factor     ?? 0);
  const avgSharpe    = avg(withBT, r => r.backtest_results.sharpe_ratio      ?? null, true);
  const totalTrades  = sum(withBT, r => r.backtest_results.total_trades      ?? 0);
  const worstDD      = withBT.length
    ? withBT.reduce((a, b) =>
        (b.backtest_results.max_drawdown ?? 0) > (a.backtest_results.max_drawdown ?? 0) ? b : a)
    : null;
  const bestStrat    = withBT.length
    ? withBT.reduce((a, b) =>
        (b.backtest_results.net_pnl ?? -Infinity) > (a.backtest_results.net_pnl ?? -Infinity) ? b : a)
    : null;

  // Pair counts for diversification
  const pairCounts   = {};
  strategies.forEach(s => {
    const p = s.pair || 'Unknown';
    pairCounts[p] = (pairCounts[p] || 0) + 1;
  });
  const uniquePairs  = Object.keys(pairCounts).length;

  // Active count (bot running)
  const activeCount  = botStatus?.running ? 1 : 0;

  // ROI — only meaningful if we have an allocation stored
  const totalAlloc   = sum(strategies, s => parseFloat(s.allocation || 10));
  const roi          = totalAlloc > 0 ? (totalPnl / totalAlloc) * 100 : null;

  // Correlation label (qualitative based on unique pairs)
  const corrLabel    = uniquePairs >= 4 ? 'Low' : uniquePairs >= 2 ? 'Moderate' : 'High';
  const corrClass    = uniquePairs >= 4 ? 'pos' : uniquePairs >= 2 ? 'neutral' : 'neg';

  // ── 2. KPI strip ──────────────────────────────────────────────────────────
  setText('portKpiCount',   strategies.length);
  setText('portKpiActive',  activeCount ? `${activeCount} running` : 'none running');

  const pnlEl = document.getElementById('portKpiPnl');
  if (pnlEl) {
    pnlEl.textContent = withBT.length ? fmt$(totalPnl) : '—';
    pnlEl.className   = 'port-kpi-val ' + (totalPnl > 0 ? 'pos' : totalPnl < 0 ? 'neg' : '');
  }
  setText('portKpiPnlSub', withBT.length ? `${withBT.length} backtested` : 'no backtests yet');
  setText('portKpiWinRate', withBT.length ? fmtPct(avgWinRate) : '—');

  if (bestStrat) {
    setText('portKpiBest',    bestStrat.name || bestStrat.id || 'Unnamed');
    const bv = document.getElementById('portKpiBestVal');
    if (bv) {
      bv.textContent = fmt$(bestStrat.backtest_results.net_pnl ?? 0);
      bv.className   = 'port-kpi-sub ' + ((bestStrat.backtest_results.net_pnl ?? 0) > 0 ? 'pos' : 'neg');
    }
  } else {
    setText('portKpiBest', '—');
  }

  if (worstDD) {
    const ddv = document.getElementById('portKpiDD');
    if (ddv) {
      ddv.textContent = fmtPct(worstDD.backtest_results.max_drawdown ?? 0);
      ddv.className   = 'port-kpi-val neg';
    }
    setText('portKpiDDName', worstDD.name || worstDD.id || '');
  } else {
    setText('portKpiDD', '—');
  }
  setText('portKpiPF', withBT.length ? (avgPF > 0 ? avgPF.toFixed(2) : '—') : '—');

  // ── 3. Risk grid ──────────────────────────────────────────────────────────
  setValColored('portRiskSharpe', avgSharpe !== null ? avgSharpe.toFixed(2) : '—',
                avgSharpe !== null ? (avgSharpe > 1 ? 'pos' : avgSharpe < 0 ? 'neg' : '') : '');
  setValColored('portRiskDD', worstDD ? fmtPct(worstDD.backtest_results.max_drawdown ?? 0) : '—', 'neg');
  setValColored('portRiskWin', withBT.length ? fmtPct(avgWinRate) : '—',
                avgWinRate > 55 ? 'pos' : avgWinRate < 40 ? 'neg' : '');
  setValColored('portRiskPF', withBT.length && avgPF > 0 ? avgPF.toFixed(2) : '—',
                avgPF > 1.5 ? 'pos' : avgPF < 1 ? 'neg' : '');
  setText('portRiskTrades', totalTrades || '—');
  setText('portRiskDiv',    uniquePairs ? `${uniquePairs} pair${uniquePairs > 1 ? 's' : ''}, ${strategies.length} strat${strategies.length !== 1 ? 's' : ''}` : '—');
  setValColored('portRiskCorr', corrLabel, corrClass);
  setValColored('portRiskROI', roi !== null ? (roi >= 0 ? '+' : '') + roi.toFixed(1) + '%' : '—',
                roi !== null ? (roi > 0 ? 'pos' : roi < 0 ? 'neg' : '') : '');

  // ── 4. Charts ─────────────────────────────────────────────────────────────
  renderPnlChart(withBT);
  renderAllocChart(strategies, pairCounts);

  // ── 5. Strategy table ─────────────────────────────────────────────────────
  renderStratTable(strategies, botStatus);
  setText('portStratCount', strategies.length + ' strateg' + (strategies.length === 1 ? 'y' : 'ies'));
}

// ── P&L bar chart ─────────────────────────────────────────────────────────────
function renderPnlChart(withBT) {
  const empty  = document.getElementById('portPnlEmpty');
  const canvas = document.getElementById('portPnlChart');
  if (!canvas) return;

  if (!withBT.length) {
    canvas.style.display = 'none';
    if (empty) empty.style.display = 'block';
    return;
  }
  canvas.style.display = '';
  if (empty) empty.style.display = 'none';

  if (_portPnlChart) { _portPnlChart.destroy(); _portPnlChart = null; }

  const labels = withBT.map(s => (s.name || s.id || 'Unnamed').slice(0, 22));
  const values = withBT.map(s => +(s.backtest_results.net_pnl ?? 0).toFixed(4));
  const colors = values.map(v => v >= 0 ? 'rgba(18,185,71,.75)' : 'rgba(220,38,38,.7)');
  const borders= values.map(v => v >= 0 ? '#12B947' : '#dc2626');

  _portPnlChart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Net P&L ($)',
        data: values,
        backgroundColor: colors,
        borderColor: borders,
        borderWidth: 1,
        borderRadius: 4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => ' $' + ctx.parsed.y.toFixed(4),
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { font: { family: 'Inter', size: 10 }, color: '#9b9285' },
        },
        y: {
          grid: { color: 'rgba(0,0,0,.06)' },
          ticks: { font: { family: 'Inter', size: 10 }, color: '#9b9285',
                   callback: v => '$' + v },
        },
      },
    },
  });
}

// ── Exposure doughnut ─────────────────────────────────────────────────────────
function renderAllocChart(strategies, pairCounts) {
  const empty  = document.getElementById('portAllocEmpty');
  const canvas = document.getElementById('portAllocChart');
  if (!canvas) return;

  if (!strategies.length) {
    canvas.style.display = 'none';
    if (empty) empty.style.display = 'block';
    return;
  }
  canvas.style.display = '';
  if (empty) empty.style.display = 'none';

  if (_portAllocChart) { _portAllocChart.destroy(); _portAllocChart = null; }

  const labels = Object.keys(pairCounts).map(p => PAIR_LABELS[p] || p);
  const values = Object.values(pairCounts);

  _portAllocChart = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: CHART_PALETTE.slice(0, labels.length),
        borderColor: '#F5F4F1',
        borderWidth: 3,
        hoverOffset: 6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '62%',
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            font: { family: 'Inter', size: 10 },
            color: '#6b6256',
            padding: 12,
            boxWidth: 10,
            boxHeight: 10,
          },
        },
        tooltip: {
          callbacks: {
            label: ctx => ` ${ctx.label}: ${ctx.parsed} strat${ctx.parsed > 1 ? 's' : ''}`,
          },
        },
      },
    },
  });
}

// ── Strategy table ────────────────────────────────────────────────────────────
function renderStratTable(strategies, botStatus) {
  const tbody = document.getElementById('portStratTable');
  if (!tbody) return;

  if (!strategies.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="port-table-empty">No strategies saved yet — create one in Creator</td></tr>';
    return;
  }

  const running = botStatus?.running ? botStatus.strategy_id : null;

  tbody.innerHTML = strategies.map(s => {
    const bt     = s.backtest_results;
    const isLive = s.id === running || running === null && false;
    const status = isLive
      ? '<span class="port-status-badge port-status-live">Live</span>'
      : bt
      ? '<span class="port-status-badge port-status-bt">Backtested</span>'
      : '<span class="port-status-badge port-status-draft">Draft</span>';

    const pairLabel = PAIR_LABELS[s.pair] || s.pair || '—';

    if (!bt) {
      return `<tr>
        <td class="port-td-name">${esc(s.name || s.id || 'Unnamed')}</td>
        <td>${pairLabel}</td>
        <td>${status}</td>
        <td class="port-td-r" colspan="6" style="color:var(--t3);font-style:italic">No backtest data</td>
      </tr>`;
    }

    const pnl = bt.net_pnl ?? 0;
    const dd  = bt.max_drawdown ?? 0;
    const wr  = bt.win_rate ?? 0;
    const pf  = bt.profit_factor ?? 0;
    const sh  = bt.sharpe_ratio ?? null;

    return `<tr>
      <td class="port-td-name">${esc(s.name || s.id || 'Unnamed')}</td>
      <td>${pairLabel}</td>
      <td>${status}</td>
      <td class="port-td-r">${bt.total_trades ?? '—'}</td>
      <td class="port-td-r ${wr > 55 ? 'pos' : wr < 40 ? 'neg' : ''}">${fmtPct(wr)}</td>
      <td class="port-td-r ${pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : ''}">${fmt$(pnl)}</td>
      <td class="port-td-r neg">${dd > 0 ? fmtPct(dd) : '—'}</td>
      <td class="port-td-r ${pf > 1.5 ? 'pos' : pf < 1 ? 'neg' : ''}">${pf > 0 ? pf.toFixed(2) : '—'}</td>
      <td class="port-td-r ${sh !== null ? (sh > 1 ? 'pos' : sh < 0 ? 'neg' : '') : ''}">${sh !== null ? sh.toFixed(2) : '—'}</td>
    </tr>`;
  }).join('');
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function sum(arr, fn) { return arr.reduce((a, x) => a + (fn(x) || 0), 0); }

function avg(arr, fn, skipNull = false) {
  const vals = arr.map(fn).filter(v => skipNull ? v !== null && v !== undefined : true);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
}

function fmt$(v)   { return (v >= 0 ? '+' : '') + '$' + Math.abs(v).toFixed(4); }
function fmtPct(v) { return (v * (v <= 1 ? 100 : 1)).toFixed(1) + '%'; }
function setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function setValColored(id, text, cls) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className   = 'port-risk-val ' + (cls || '');
}

// ── Wire up ───────────────────────────────────────────────────────────────────
document.getElementById('portRefreshBtn')?.addEventListener('click', loadPortfolio);
document.querySelector('[data-panel="portfolio"]')?.addEventListener('click', initPortfolioPanel);

window.initPortfolioPanel = initPortfolioPanel;
