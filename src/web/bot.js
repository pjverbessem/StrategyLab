/* ── bot.js — Live Trading Bot panel ──────────────────────────────────────── */

'use strict';

let _botPollInterval = null;
let _botRunning = false;

// ── Populate strategy dropdown ─────────────────────────────────────────────────
async function refreshBotStrategies() {
    const sel = document.getElementById('botStrategySelect');
    if (!sel) return;
    try {
        const res = await fetch('/api/strategies');
        const strategies = await res.json();
        const current = sel.value;
        sel.innerHTML = '<option value="">— Select saved strategy —</option>' +
            strategies.map(s => `<option value="${s.id}" ${s.id === current ? 'selected' : ''}>${escHtml(s.name)}</option>`).join('');
    } catch (_) { }
}

window.refreshBotStrategies = refreshBotStrategies;

// ── Kraken balance check ─────────────────────────────────────────────────────
async function loadKrakenBalance() {
    const grid = document.getElementById('balanceGrid');
    if (!grid) return;
    grid.innerHTML = '<div class="balance-loading">Loading…</div>';
    try {
        const res = await fetch('/api/kraken/balance');
        const data = await res.json();
        if (data.error) {
            grid.innerHTML = `<div class="balance-empty">${data.error}</div>`;
            return;
        }
        const balances = data.balances || {};
        if (!Object.keys(balances).length) {
            grid.innerHTML = '<div class="balance-empty">No balances found</div>';
            return;
        }
        grid.innerHTML = Object.entries(balances)
            .sort(([, a], [, b]) => b - a)
            .map(([asset, amount]) => `
            <div class="balance-item">
              <span class="balance-asset">${asset}</span>
              <span class="balance-amount">${formatBalance(asset, amount)}</span>
            </div>`)
            .join('');
    } catch (e) {
        grid.innerHTML = `<div class="balance-empty">Error: ${e.message}</div>`;
    }
}

function formatBalance(asset, amount) {
    if (asset === 'ZUSD' || asset === 'USD') return `$${amount.toFixed(2)}`;
    return `${amount < 0.01 ? amount.toFixed(8) : amount.toFixed(5)} ${asset}`;
}

document.getElementById('balanceRefreshBtn')?.addEventListener('click', loadKrakenBalance);

// ── Kraken connection check ───────────────────────────────────────────────────
async function checkKrakenConn() {
    const statusEl = document.getElementById('krakenConnStatus');
    const hintEl = document.getElementById('krakenConnHint');
    const card = document.getElementById('krakenConnCard');
    if (!statusEl) return;

    statusEl.textContent = 'Checking…';
    try {
        const res = await fetch('/api/kraken/status');
        const data = await res.json();
        if (data.connected) {
            statusEl.textContent = `✓ Connected (${data.key_prefix})`;
            hintEl.textContent = 'API key is valid. Ready to trade.';
            card.classList.add('connected'); card.classList.remove('error');
            loadKrakenBalance();
        } else {
            statusEl.textContent = `✗ Not connected`;
            hintEl.textContent = data.error || 'Set KRAKEN_API_KEY and KRAKEN_API_SECRET env vars.';
            card.classList.add('error'); card.classList.remove('connected');
        }
    } catch (e) {
        statusEl.textContent = 'Connection error';
        hintEl.textContent = e.message;
    }
}

document.getElementById('krakenCheckBtn')?.addEventListener('click', checkKrakenConn);

// ── Bot Start ─────────────────────────────────────────────────────────────────
document.getElementById('botStartBtn')?.addEventListener('click', async () => {
    const stratId = document.getElementById('botStrategySelect')?.value;
    const pair = document.getElementById('botPairSelect')?.value || 'ARBUSD';
    const interval = parseInt(document.getElementById('botIntervalSelect')?.value || '1440');
    const allocation = parseFloat(document.getElementById('botAllocation')?.value || '10');

    if (!stratId) { showToast('Select a strategy first'); return; }
    if (isNaN(allocation) || allocation <= 0) { showToast('Enter a valid allocation amount'); return; }

    const btn = document.getElementById('botStartBtn');
    btn.disabled = true; btn.textContent = 'Starting…';

    try {
        const res = await fetch('/api/bot/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ strategy_id: stratId, pair, interval, allocation }),
        });
        const data = await res.json();
        if (data.error) {
            showToast('Bot error: ' + data.error);
            btn.disabled = false; btn.textContent = '▶ Start Bot';
            return;
        }
        _botRunning = true;
        setBotRunningUI(true);
        startBotPolling();
        showToast(`✓ Bot started — trading ${pair} with $${allocation}`);

        // Flash bot tab dot
        const dot = document.getElementById('botTabDot');
        if (dot) dot.style.display = 'inline-block';
    } catch (e) {
        showToast('Start failed: ' + e.message);
        btn.disabled = false; btn.textContent = '▶ Start Bot';
    }
});

// ── Bot Stop ──────────────────────────────────────────────────────────────────
document.getElementById('botStopBtn')?.addEventListener('click', async () => {
    const btn = document.getElementById('botStopBtn');
    btn.disabled = true; btn.textContent = 'Stopping…';

    try {
        const res = await fetch('/api/bot/stop', { method: 'POST' });
        const data = await res.json();
        if (data.error) {
            showToast('Stop error: ' + data.error);
        } else {
            showToast('Bot stopped');
        }
    } catch (e) {
        showToast('Stop failed: ' + e.message);
    } finally {
        _botRunning = false;
        setBotRunningUI(false);
        stopBotPolling();
        const dot = document.getElementById('botTabDot');
        if (dot) dot.style.display = 'none';
        // Do one final status refresh
        refreshBotStatus();
    }
});

// ── Bot status polling ────────────────────────────────────────────────────────
function startBotPolling() {
    stopBotPolling();
    _botPollInterval = setInterval(refreshBotStatus, 5000);
    refreshBotStatus();  // immediate
}

function stopBotPolling() {
    if (_botPollInterval) { clearInterval(_botPollInterval); _botPollInterval = null; }
}

async function refreshBotStatus() {
    try {
        const res = await fetch('/api/bot/status');
        const data = await res.json();
        renderBotStatus(data);
        renderBotLogs(data.logs || []);

        // Sync button state with server reality
        if (data.running !== _botRunning) {
            _botRunning = data.running;
            setBotRunningUI(_botRunning);
            if (_botRunning) { startBotPolling(); }
            else { stopBotPolling(); }
        }
    } catch (_) { }
}

function renderBotStatus(data) {
    const dotEl = document.getElementById('botIndicatorDot');
    const textEl = document.getElementById('botStatusText');
    const uptimeEl = document.getElementById('botUptime');

    if (data.running) {
        dotEl?.classList.remove('inactive'); dotEl?.classList.add('active');
        textEl.textContent = `Running — ${data.strategy_name || 'Strategy'} on ${data.pair}`;
        if (data.started_at) {
            const secs = Math.floor(Date.now() / 1000) - data.started_at;
            uptimeEl.textContent = `Uptime: ${fmtDuration(secs)}`;
        }
    } else {
        dotEl?.classList.remove('active'); dotEl?.classList.add('inactive');
        textEl.textContent = 'Bot Inactive';
        uptimeEl.textContent = '';
    }

    // Signal
    const signalEl = document.getElementById('botSignal');
    if (signalEl) {
        const sig = data.last_signal;
        signalEl.textContent = sig ? sig.toUpperCase() : '—';
        signalEl.style.color = sig === 'long' ? 'var(--pos)' : sig === 'short' ? 'var(--neg)' : 'var(--t2)';
    }

    // Position
    const posEl = document.getElementById('botPosition');
    if (posEl) {
        const pos = data.position;
        posEl.textContent = pos ? pos.toUpperCase() : 'Flat';
        posEl.style.color = pos === 'long' ? 'var(--pos)' : pos === 'short' ? 'var(--neg)' : 'var(--t2)';
    }

    // Entry price
    const entryEl = document.getElementById('botEntryPrice');
    if (entryEl) entryEl.textContent = data.entry_price ? `$${Number(data.entry_price).toFixed(4)}` : '—';

    // Live price
    const livePriceEl = document.getElementById('botLivePrice');
    if (livePriceEl && data.pair) {
        fetch(`/api/live-price/${data.pair}`).then(r => r.json()).then(p => {
            livePriceEl.textContent = p.last ? `$${Number(p.last).toFixed(4)}` : '—';
        }).catch(() => { });
    }

    // Unrealized P&L
    const unrealEl = document.getElementById('botUnrealizedPnl');
    if (unrealEl) {
        const u = data.unrealized_pnl;
        unrealEl.textContent = u != null ? `${u >= 0 ? '+' : ''}$${Number(u).toFixed(4)}` : '—';
        unrealEl.style.color = u > 0 ? 'var(--pos)' : u < 0 ? 'var(--neg)' : 'var(--t2)';
    }

    // Realized P&L
    const realEl = document.getElementById('botRealizedPnl');
    if (realEl) {
        const r = data.realized_pnl;
        realEl.textContent = r != null ? `${r >= 0 ? '+' : ''}$${Number(r).toFixed(4)}` : '—';
        realEl.style.color = r > 0 ? 'var(--pos)' : r < 0 ? 'var(--neg)' : 'var(--t2)';
    }
}

function renderBotLogs(logs) {
    const body = document.getElementById('botLogBody');
    if (!body || !logs.length) {
        if (body) body.innerHTML = '<div class="bot-log-empty">No activity yet</div>';
        return;
    }

    const levelClass = { info: 'log-info', success: 'log-success', warn: 'log-warn', error: 'log-error' };
    const levelIcon = { info: 'ℹ', success: '✓', warn: '⚠', error: '✕' };

    body.innerHTML = logs.map(entry => {
        const t = new Date(entry.ts * 1000).toLocaleTimeString('en-GB', { hour12: false });
        const cls = levelClass[entry.level] || 'log-info';
        const ico = levelIcon[entry.level] || 'ℹ';
        return `<div class="bot-log-entry ${cls}">
          <span class="log-icon">${ico}</span>
          <span class="log-time">${t}</span>
          <span class="log-msg">${escHtml(entry.msg)}</span>
        </div>`;
    }).join('');

    body.scrollTop = body.scrollHeight;
}

// ── Clear log button ──────────────────────────────────────────────────────────
document.getElementById('clearLogBtn')?.addEventListener('click', () => {
    const body = document.getElementById('botLogBody');
    if (body) body.innerHTML = '<div class="bot-log-empty">Log cleared</div>';
});

// ── UI helpers ────────────────────────────────────────────────────────────────
function setBotRunningUI(running) {
    const startBtn = document.getElementById('botStartBtn');
    const stopBtn = document.getElementById('botStopBtn');
    if (startBtn) { startBtn.disabled = running; startBtn.textContent = '▶ Start Bot'; }
    if (stopBtn) { stopBtn.disabled = !running; }

    // Lock config while running
    ['botStrategySelect', 'botPairSelect', 'botIntervalSelect', 'botAllocation'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.disabled = running;
    });
}

function fmtDuration(secs) {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function showToast(msg) {
    if (window.showToast && window.showToast !== showToast) { window.showToast(msg); return; }
    const t = document.createElement('div');
    t.className = 'toast'; t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3200);
}

// ── Init on Bot tab click ─────────────────────────────────────────────────────
document.querySelector('[data-panel="bot"]')?.addEventListener('click', () => {
    refreshBotStrategies();
    checkKrakenConn();
    refreshBotStatus();
    if (_botRunning) startBotPolling();
});

// ── Initial bot status check ──────────────────────────────────────────────────
(async () => {
    try {
        const res = await fetch('/api/bot/status');
        const data = await res.json();
        if (data.running) {
            _botRunning = true;
            setBotRunningUI(true);
            startBotPolling();
            const dot = document.getElementById('botTabDot');
            if (dot) dot.style.display = 'inline-block';
        }
    } catch (_) { }
})();
