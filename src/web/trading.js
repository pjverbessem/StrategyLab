/* ── trading.js — Connections + Live Trading panels ─────────────────────── */
'use strict';

// ── Shared state ──────────────────────────────────────────────────────────────
let _connected       = false;   // Kraken connected?
let _statusPollTimer = null;
const POLL_MS        = 4000;

// ══════════════════════════════════════════════════════════════════════════════
//  CONNECTIONS PANEL
// ══════════════════════════════════════════════════════════════════════════════

async function initConnectionsPanel() {
    await checkConnectionStatus();
}

/** Check /api/kraken/status and update both panels' badges */
async function checkConnectionStatus() {
    _updateBadge('connKrakenBadge',   'checking', 'Checking…');
    _updateBadge('tradingConnBadge',  'checking', 'Checking…');

    try {
        const res  = await fetch('/api/kraken/status');
        const data = await res.json();

        if (data.connected) {
            _connected = true;
            const label = `✓ Connected (${data.key_prefix})`;
            _updateBadge('connKrakenBadge',  'connected', label);
            _updateBadge('tradingConnBadge', 'connected', '✓ Kraken');
            _showConnectedState();
            await loadConnectionsBalance();
        } else {
            _connected = false;
            _updateBadge('connKrakenBadge',  'disconnected', '✗ Not connected');
            _updateBadge('tradingConnBadge', 'disconnected', '✗ Not connected');
            _showDisconnectedState();
        }
    } catch (e) {
        _connected = false;
        _updateBadge('connKrakenBadge',  'disconnected', '✗ Error');
        _updateBadge('tradingConnBadge', 'disconnected', '✗ Error');
        _showDisconnectedState();
    }
}

function _showConnectedState() {
    const form     = document.getElementById('connKrakenForm');
    const balances = document.getElementById('connBalances');
    const discBtn  = document.getElementById('connDisconnectBtn');
    const connBtn  = document.getElementById('connConnectBtn');
    if (form)    { form.style.display = 'none'; }
    if (balances){ balances.style.display = 'block'; }
    if (discBtn) { discBtn.style.display = 'inline'; }
    if (connBtn) { connBtn.style.display = 'none'; }
}

function _showDisconnectedState() {
    const form     = document.getElementById('connKrakenForm');
    const balances = document.getElementById('connBalances');
    const discBtn  = document.getElementById('connDisconnectBtn');
    const connBtn  = document.getElementById('connConnectBtn');
    if (form)    { form.style.display = 'block'; }
    if (balances){ balances.style.display = 'none'; }
    if (discBtn) { discBtn.style.display = 'none'; }
    if (connBtn) { connBtn.style.display = 'inline-flex'; }
}

async function connectKraken() {
    const keyEl    = document.getElementById('connApiKey');
    const secretEl = document.getElementById('connApiSecret');
    const btn      = document.getElementById('connConnectBtn');

    if (!keyEl || !secretEl) return;
    const key    = keyEl.value.trim();
    const secret = secretEl.value.trim();
    if (!key || !secret) { showToast('Enter both API Key and API Secret'); return; }

    btn.disabled    = true;
    btn.textContent = 'Verifying…';

    try {
        const res  = await fetch('/api/kraken/set-keys', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ api_key: key, api_secret: secret }),
        });
        const data = await res.json();

        if (data.ok) {
            keyEl.value    = '';
            secretEl.value = '';
            showToast('✓ Kraken connected!');
            await checkConnectionStatus();   // refreshes both badges + balance
        } else {
            showToast('Connection failed: ' + (data.error || 'unknown'));
            _updateBadge('connKrakenBadge',  'disconnected', '✗ Invalid credentials');
            _updateBadge('tradingConnBadge', 'disconnected', '✗ Not connected');
        }
    } catch (e) {
        showToast('Network error: ' + e.message);
    } finally {
        btn.disabled    = false;
        btn.textContent = 'Connect';
    }
}

async function disconnectKraken() {
    // Just clear by sending empty keys — server treats blank as disconnect
    try {
        await fetch('/api/kraken/set-keys', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ api_key: '', api_secret: '' }),
        });
    } catch (_) {}
    _connected = false;
    _updateBadge('connKrakenBadge',  'disconnected', '✗ Not connected');
    _updateBadge('tradingConnBadge', 'disconnected', '✗ Not connected');
    _showDisconnectedState();
    showToast('Disconnected from Kraken');
}

async function loadConnectionsBalance() {
    const grid = document.getElementById('connBalanceGrid');
    if (!grid) return;
    grid.innerHTML = '<div class="trading-empty-hint">Loading…</div>';

    try {
        const res  = await fetch('/api/kraken/balance');
        const data = await res.json();
        if (data.error) { grid.innerHTML = `<div class="trading-empty-hint" style="color:var(--neg)">${data.error}</div>`; return; }

        const bal     = data.balances || {};
        const entries = Object.entries(bal).filter(([, v]) => v > 0.000001);
        if (!entries.length) { grid.innerHTML = '<div class="trading-empty-hint">No balances found</div>'; return; }

        grid.innerHTML = entries.map(([coin, val]) => `
            <div class="conn-balance-cell">
                <div class="conn-balance-coin">${coin}</div>
                <div class="conn-balance-val">${val >= 1 ? val.toFixed(4) : val.toFixed(8)}</div>
            </div>`).join('');
    } catch (e) {
        grid.innerHTML = '<div class="trading-empty-hint" style="color:var(--neg)">Could not load balances</div>';
    }
}

// ── Badge helper ──────────────────────────────────────────────────────────────
function _updateBadge(id, state, text) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.className   = 'trading-conn-badge ' + state;
}

// ══════════════════════════════════════════════════════════════════════════════
//  TRADING PANEL
// ══════════════════════════════════════════════════════════════════════════════

async function initTradingPanel() {
    // Refresh connection badge silently whenever the tab is opened
    checkConnectionStatus();
    await loadTradingStrategies();
    pollBotStatus();
}

// ── Strategy selector ─────────────────────────────────────────────────────────
async function loadTradingStrategies() {
    const sel = document.getElementById('tradingStrategySelect');
    if (!sel) return;

    try {
        const res  = await fetch('/api/strategies');
        const data = await res.json();
        const list = Array.isArray(data) ? data : (data.strategies || []);

        if (!list.length) {
            sel.innerHTML = '<option value="">No strategies found — create one in Creator</option>';
            return;
        }

        const prev = sel.value;
        sel.innerHTML = '<option value="">— Select a strategy —</option>' +
            list.map(s => `<option value="${s.id}">${escHtmlT(s.name || s.id)}</option>`).join('');
        if (prev && sel.querySelector(`option[value="${prev}"]`)) sel.value = prev;
    } catch (e) {
        sel.innerHTML = '<option value="">Could not load strategies</option>';
    }
}

// ── Start / Stop ──────────────────────────────────────────────────────────────
async function startTrading() {
    if (!_connected) {
        showToast('Connect Kraken first (Connections tab)');
        return;
    }

    const stratId  = document.getElementById('tradingStrategySelect')?.value;
    const pair     = document.getElementById('tradingPairSelect')?.value;
    const interval = document.getElementById('tradingIntervalSelect')?.value;
    const alloc    = parseFloat(document.getElementById('tradingAllocation')?.value || '10');
    const startBtn = document.getElementById('tradingStartBtn');
    const stopBtn  = document.getElementById('tradingStopBtn');

    if (!stratId) { showToast('Select a strategy first'); return; }

    startBtn.disabled    = true;
    startBtn.textContent = 'Starting…';

    try {
        const res  = await fetch('/api/bot/start', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ strategy_id: stratId, pair, interval, allocation: alloc }),
        });
        const data = await res.json();

        if (data.error) {
            showToast('Failed to start: ' + data.error);
            startBtn.disabled    = false;
            startBtn.textContent = '▶ Start';
            return;
        }
        showToast(`✓ Strategy running on ${data.pair}`);
        if (stopBtn) stopBtn.disabled = false;
        startBtn.disabled = true;
        setRunningState(true);
    } catch (e) {
        showToast('Error: ' + e.message);
        startBtn.disabled    = false;
        startBtn.textContent = '▶ Start';
    }
}

async function stopTrading() {
    const stopBtn  = document.getElementById('tradingStopBtn');
    const startBtn = document.getElementById('tradingStartBtn');
    stopBtn.disabled = true;

    try {
        await fetch('/api/bot/stop', { method: 'POST' });
        showToast('Bot stopped');
        startBtn.disabled    = false;
        startBtn.textContent = '▶ Start';
        setRunningState(false);
    } catch (e) {
        showToast('Error stopping: ' + e.message);
        stopBtn.disabled = false;
    }
}

// ── Bot status polling ────────────────────────────────────────────────────────
async function pollBotStatus() {
    clearTimeout(_statusPollTimer);
    try {
        const res = await fetch('/api/bot/status');
        const s   = await res.json();
        renderBotStatus(s);
    } catch (_) {}
    _statusPollTimer = setTimeout(pollBotStatus, POLL_MS);
}

function renderBotStatus(s) {
    const dot   = document.getElementById('tradingIndicatorDot');
    const label = document.getElementById('tradingStatusText');
    if (dot)   { dot.className = 'trading-indicator-dot ' + (s.running ? 'active' : 'inactive'); }
    if (label) { label.textContent = s.running ? `Running · ${s.strategy_name || ''}` : 'Inactive'; }

    // Uptime in banner
    const uptime = document.getElementById('tradingUptime');
    if (uptime && s.started_at && s.running) {
        const secs = Math.floor(Date.now() / 1000) - s.started_at;
        const h    = Math.floor(secs / 3600);
        const m    = Math.floor((secs % 3600) / 60);
        uptime.textContent = `${h}h ${m}m`;
    } else if (uptime) {
        uptime.textContent = '';
    }

    const tick = document.getElementById('tradingLastTick');
    if (tick && s.last_tick) {
        tick.textContent = 'Last tick: ' + new Date(s.last_tick * 1000).toLocaleTimeString();
    }

    setText('tradingMetricSignal',   s.last_signal ? s.last_signal.toUpperCase() : '—');
    setText('tradingMetricPosition', s.position    ? s.position.toUpperCase()    : 'Flat');
    setText('tradingMetricPair',     s.pair        || '—');
    setText('tradingMetricEntry',    s.entry_price ? '$' + s.entry_price.toFixed(4) : '—');

    _setPnlCell('tradingMetricUnrealized', s.unrealized_pnl ?? 0);
    _setPnlCell('tradingMetricRealized',   s.realized_pnl   ?? 0);

    // Buttons
    const startBtn = document.getElementById('tradingStartBtn');
    const stopBtn  = document.getElementById('tradingStopBtn');
    if (startBtn) { startBtn.disabled = s.running; startBtn.textContent = '▶ Start'; }
    if (stopBtn)  { stopBtn.disabled  = !s.running; }

    setRunningState(s.running);

    // Activity log
    const logEl = document.getElementById('tradingLog');
    if (logEl && s.logs) {
        if (!s.logs.length) {
            logEl.innerHTML = '<div class="trading-log-empty">No activity yet</div>';
        } else {
            logEl.innerHTML = s.logs.map(l => {
                const t   = new Date(l.ts * 1000).toLocaleTimeString();
                const cls = l.level === 'error'   ? 'err'  :
                            l.level === 'success'  ? 'ok'   :
                            l.level === 'warn'     ? 'warn' : '';
                return `<div class="trading-log-row ${cls}">
                    <span class="trading-log-time">${t}</span>
                    <span class="trading-log-msg">${escHtmlT(l.msg)}</span>
                </div>`;
            }).join('');
        }
    }
}

function _setPnlCell(id, val) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = (val >= 0 ? '+' : '') + '$' + val.toFixed(4);
    el.className   = 'trading-metric-val ' + (val > 0 ? 'pos' : val < 0 ? 'neg' : '');
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function setRunningState(running) {
    const banner = document.getElementById('tradingRunBanner');
    if (banner) banner.style.display = running ? 'flex' : 'none';
}

function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
}

function escHtmlT(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Wire up events ────────────────────────────────────────────────────────────

// Connections panel
document.getElementById('connConnectBtn')?.addEventListener('click', connectKraken);
document.getElementById('connDisconnectBtn')?.addEventListener('click', disconnectKraken);
document.getElementById('connBalanceRefreshBtn')?.addEventListener('click', loadConnectionsBalance);

// Trading panel
document.getElementById('tradingStartBtn')?.addEventListener('click', startTrading);
document.getElementById('tradingStopBtn')?.addEventListener('click', stopTrading);
document.getElementById('tradingStratRefreshBtn')?.addEventListener('click', loadTradingStrategies);

// "Go to Connections tab" shortcut link in Trading sidebar
document.getElementById('tradingGotoConnBtn')?.addEventListener('click', () => {
    document.querySelector('[data-panel="connections"]')?.click();
});

// Tab activation
document.querySelector('[data-panel="trading"]')?.addEventListener('click', initTradingPanel);
document.querySelector('[data-panel="connections"]')?.addEventListener('click', initConnectionsPanel);

// Expose for app.js
window.initTradingPanel     = initTradingPanel;
window.initConnectionsPanel = initConnectionsPanel;
