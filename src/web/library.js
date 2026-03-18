/* ── library.js — Strategy Library panel ──────────────────────────────────── */

'use strict';

let _allStrategies = [];

// ── Load and render strategies ────────────────────────────────────────────────
async function loadLibrary() {
    const grid = document.getElementById('libraryGrid');
    const emptyEl = document.getElementById('libraryEmpty');
    if (!grid) return;

    grid.innerHTML = '<div style="color:var(--t3);font-size:13px;padding:20px 0">Loading…</div>';

    try {
        const res = await fetch('/api/strategies');
        _allStrategies = await res.json();
        renderLibrary(_allStrategies);
    } catch (e) {
        grid.innerHTML = `<div style="color:var(--neg);font-size:13px;padding:20px 0">Failed to load strategies: ${e.message}</div>`;
    }
}

function renderLibrary(strategies) {
    const grid = document.getElementById('libraryGrid');
    const emptyEl = document.getElementById('libraryEmpty');
    if (!grid) return;

    if (!strategies.length) {
        grid.innerHTML = '';
        emptyEl.style.display = 'block';
        return;
    }
    emptyEl.style.display = 'none';

    grid.innerHTML = strategies.map(s => {
        const stats = s.stats || {};
        const ret = stats.total_return;
        const wr = stats.win_rate;
        const dd = stats.max_drawdown;
        const trades = stats.total_trades;
        const retStr = ret != null ? `<span class="${ret >= 0 ? 'lib-pos' : 'lib-neg'}">${ret >= 0 ? '+' : ''}${Number(ret).toFixed(1)}%</span>` : '<span class="lib-na">—</span>';
        const wrStr = wr != null ? `${Number(wr).toFixed(1)}%` : '—';
        const ddStr = dd != null ? `${Number(dd).toFixed(1)}%` : '—';
        const date = new Date(s.updated_at * 1000).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
        const tags = Array.isArray(s.tags) ? s.tags : [];

        return `
        <div class="lib-card" data-id="${s.id}">
          <div class="lib-card-header">
            <div class="lib-card-title">${escHtml(s.name)}</div>
            <div class="lib-card-actions">
              <button class="btn-xs lib-load-btn" data-id="${s.id}" title="Load into Creator">Load</button>
              <button class="btn-xs lib-load-bt-btn" data-id="${s.id}" title="Send to Backtesting tab">Backtest</button>
              <button class="btn-xs lib-del-btn" data-id="${s.id}" title="Delete strategy">✕</button>
            </div>
          </div>
          ${s.description ? `<div class="lib-card-desc">${escHtml(s.description)}</div>` : ''}
          ${tags.length ? `<div class="lib-card-tags">${tags.map(t => `<span class="lib-tag">${escHtml(t)}</span>`).join('')}</div>` : ''}
          <div class="lib-card-stats">
            <div class="lib-stat"><div class="lib-stat-label">Return</div><div class="lib-stat-value">${retStr}</div></div>
            <div class="lib-stat"><div class="lib-stat-label">Win Rate</div><div class="lib-stat-value">${wrStr}</div></div>
            <div class="lib-stat"><div class="lib-stat-label">Drawdown</div><div class="lib-stat-value">${ddStr}</div></div>
            <div class="lib-stat"><div class="lib-stat-label">Trades</div><div class="lib-stat-value">${trades ?? '—'}</div></div>
          </div>
          <div class="lib-card-footer">
            <span class="lib-pair">${escHtml(s.pair || 'Any')}</span>
            <span class="lib-date">Updated ${date}</span>
          </div>
        </div>`;
    }).join('');

    // Wire buttons
    grid.querySelectorAll('.lib-load-btn').forEach(btn => {
        btn.addEventListener('click', e => { e.stopPropagation(); loadStratToCreator(btn.dataset.id); });
    });
    grid.querySelectorAll('.lib-load-bt-btn').forEach(btn => {
        btn.addEventListener('click', e => { e.stopPropagation(); loadStratToBacktest(btn.dataset.id); });
    });

    grid.querySelectorAll('.lib-del-btn').forEach(btn => {
        btn.addEventListener('click', e => { e.stopPropagation(); deleteStrategy(btn.dataset.id); });
    });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function setStrategyName(name, saved = false) {
    const pill = document.getElementById('stratNamePill');
    const label = document.getElementById('stratNameLabel');
    if (label) label.textContent = name || 'New Strategy';
    if (pill) {
        pill.className = 'strat-name-pill' + (name && saved ? ' saved' : name ? ' unsaved' : '');
    }
}

// ── Load strategy into Creator ────────────────────────────────────────────────
async function loadStratToCreator(id) {
    const strat = _allStrategies.find(s => s.id === id) || (await fetchStrategy(id));
    if (!strat) return;

    window._lastStrategyCode = strat.code || '';
    window._lastStrategyAlgo = strat.algo || '';
    window._lastStrategyParams = strat.params_text || '';
    window._loadedStrategyId = strat.id;

    // ── Populate col-code sections ──
    const emptyState = document.getElementById('codeEmptyState');
    if (emptyState) emptyState.style.display = 'none';

    const secAlgo = document.getElementById('code-section-algo');
    const outAlgo = document.getElementById('out-algo');
    const secPy = document.getElementById('code-section-py');
    const codeBlock = document.getElementById('codeBlock');
    const secParams = document.getElementById('code-section-params');
    const outParams = document.getElementById('out-params');

    if (secAlgo && outAlgo) {
        outAlgo.innerHTML = strat.algo
            ? `<p>${strat.algo.replace(/\n/g, '<br>')}</p>`
            : '<p style="color:var(--t3)">No algorithm description saved.</p>';
        secAlgo.style.display = 'block';
    }
    if (secPy) {
        secPy.style.display = strat.code ? 'block' : 'none';   // show FIRST so editor has dimensions
        if (strat.code) {
            if (window.creatorEditor) {
                window.creatorEditor.setValue(strat.code || '# No code saved');
                window.creatorEditor.clearHistory();
                // Refresh at multiple delays — CodeMirror needs the container
                // to have layout (width/height) before it can render correctly
                requestAnimationFrame(() => window.creatorEditor.refresh());
                setTimeout(() => window.creatorEditor.refresh(), 100);
                setTimeout(() => window.creatorEditor.refresh(), 300);
            } else if (codeBlock) {
                codeBlock.textContent = strat.code || '# No code saved';
            }
        }
    }
    if (secParams && outParams) {
        outParams.innerHTML = strat.params_text
            ? `<p>${strat.params_text.replace(/\n/g, '<br>')}</p>`
            : '<p style="color:var(--t3)">No parameters saved.</p>';
        secParams.style.display = 'block';
    }

    // ── Update topbar name pill ──
    setStrategyName(strat.name, true);

    // ── Append a message in chat ──
    const msg = document.getElementById('chatMessages');
    if (msg) {
        msg.innerHTML += `<div class="chat-msg system">
            <div class="chat-bubble" style="border-color:rgba(34,197,94,.25);background:rgba(34,197,94,.05)">
                ✓ Loaded <strong>${escHtml(strat.name)}</strong> from Library. You can now chat to refine it, or run a backtest.
            </div>
        </div>`;
        msg.scrollTop = msg.scrollHeight;
    }

    // ── Show Save & topbar buttons ──
    const saveBtn = document.getElementById('saveChatStratBtn');
    const saveTopbarBtn = document.getElementById('saveStratTopbarBtn');
    if (saveBtn) saveBtn.style.display = 'flex';
    if (saveTopbarBtn) saveTopbarBtn.style.display = 'flex';

    // ── Set pair if stored ──
    if (strat.pair) {
        const pairSel = document.getElementById('creatorPair');
        if (pairSel) {
            // wait a tick for options to populate
            setTimeout(() => { pairSel.value = strat.pair; }, 200);
        }
        const label = document.getElementById('resultsCoinLabel');
        if (label) label.textContent = strat.pair;
    }

    switchToPanel('creator');
    showToast(`✓ Loaded "${strat.name}" into Creator`);
}

// ── Import Picker modal ───────────────────────────────────────────────────────
function showImportPicker() {
    if (!_allStrategies.length) {
        showToast('No saved strategies yet — generate one and save it first');
        return;
    }

    // Remove existing picker if any
    document.getElementById('importPickerOverlay')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'importPickerOverlay';
    overlay.className = 'modal-overlay';
    overlay.style.cssText = 'display:flex;z-index:20000';

    function buildList(strategies) {
        return strategies.map(s => {
            const date = new Date(s.updated_at * 1000).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
            const tags = Array.isArray(s.tags) ? s.tags.slice(0, 3).map(t => `<span class="lib-tag">${escHtml(t)}</span>`).join('') : '';
            return `
            <div class="import-pick-row" data-id="${s.id}" title="Load into Creator">
                <div class="import-pick-info">
                    <span class="import-pick-name">${escHtml(s.name)}</span>
                    <span class="import-pick-meta">${escHtml(s.pair || 'Any pair')} · ${date}</span>
                    ${tags ? `<div class="import-pick-tags">${tags}</div>` : ''}
                </div>
                <button class="btn-topbar accent import-pick-btn" data-id="${s.id}">Load →</button>
            </div>`;
        }).join('');
    }

    overlay.innerHTML = `
    <div class="modal-card" style="width:500px;max-height:70vh;display:flex;flex-direction:column">
        <div class="modal-header">
            <div class="modal-title">📂 Import Strategy from Library</div>
            <button class="modal-close" id="importPickerClose">✕</button>
        </div>
        <div style="padding:10px 18px;border-bottom:1px solid var(--border);flex-shrink:0">
            <input type="text" id="importPickerSearch" class="modal-input"
                placeholder="Search by name, pair, or tag…">
        </div>
        <div class="import-pick-list" id="importPickerList" style="flex:1;min-height:0;overflow-y:auto;padding:6px 0">
            ${buildList(_allStrategies)}
        </div>
        <div class="modal-footer" style="border-top:1px solid var(--border)">
            <button class="btn-outline" id="importPickerCancel">Cancel</button>
            <span style="font:400 11px var(--font);color:var(--t3)">${_allStrategies.length} saved strateg${_allStrategies.length !== 1 ? 'ies' : 'y'}</span>
        </div>
    </div>`;

    document.body.appendChild(overlay);

    function close() { overlay.remove(); }

    overlay.querySelector('#importPickerClose').addEventListener('click', close);
    overlay.querySelector('#importPickerCancel').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    // Search filter
    overlay.querySelector('#importPickerSearch').addEventListener('input', e => {
        const q = e.target.value.toLowerCase().trim();
        const filtered = q ? _allStrategies.filter(s =>
            s.name.toLowerCase().includes(q) ||
            (s.pair || '').toLowerCase().includes(q) ||
            (Array.isArray(s.tags) ? s.tags.join(' ') : '').toLowerCase().includes(q)
        ) : _allStrategies;
        document.getElementById('importPickerList').innerHTML = buildList(filtered);
        // Re-wire buttons
        wirePickerBtns();
    });

    function wirePickerBtns() {
        overlay.querySelectorAll('.import-pick-btn, .import-pick-row').forEach(el => {
            el.addEventListener('click', e => {
                const id = el.dataset.id;
                if (id) { loadStratToCreator(id); close(); }
            });
        });
    }
    wirePickerBtns();
}

// ── New Strategy (reset Creator) ──────────────────────────────────────────────
function newStrategy() {
    // ── 1. Clear global state ──────────────────────────────────────────────────
    window._lastStrategyCode = '';
    window._lastStrategyAlgo = '';
    window._lastStrategyParams = '';
    window._loadedStrategyId = null;

    // ── 2. Reset chat messages to welcome ─────────────────────────────────────
    const chatMsg = document.getElementById('chatMessages');
    if (chatMsg) {
        chatMsg.innerHTML =
            '<div class="chat-msg system">' +
            '<div class="chat-bubble">' +
            '<p>Hi — I\'m your AI strategy builder. Describe a strategy in words, or ' +
            '<strong>attach a chart screenshot</strong> and I\'ll analyze the pattern and generate Python code.</p>' +
            '<p style="margin-top:8px;opacity:.65">Try: <em>"Create an RSI divergence strategy for ARB/USD"</em></p>' +
            '</div>' +
            '</div>';
    }

    // ── 3. Clear code column ───────────────────────────────────────────────────
    const hide = id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; };
    const show = (id, d) => { const el = document.getElementById(id); if (el) el.style.display = d || ''; };
    const text = (id, t) => { const el = document.getElementById(id); if (el) el.textContent = t; };
    const html = (id, h) => { const el = document.getElementById(id); if (el) el.innerHTML = h; };

    hide('code-section-algo');
    hide('code-section-py');
    hide('code-section-params');
    show('codeEmptyState', 'flex');
    text('codeBlock', '');
    if (window.creatorEditor) { window.creatorEditor.setValue(''); window.creatorEditor.clearHistory(); }
    html('out-algo', '');
    html('out-params', '');

    // ── 4. Reset backtest strip ────────────────────────────────────────────────
    ['m-return', 'm-sharpe', 'm-drawdown', 'm-winrate', 'm-trades', 'm-avgtrade'].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.textContent = '—'; el.className = 'bt-metric-value'; }
    });
    text('btStatusLabel', 'Run a backtest to see performance');
    html('tradeRegister', '<div class="bt-register-empty">No trades yet — run a backtest first</div>');
    text('tradeCount', '');

    // Show empty chart state, hide chart wrap
    show('chartEmptyState', '');
    hide('resultChartWrap');

    // ── 5. Hide save buttons ───────────────────────────────────────────────────
    hide('saveChatStratBtn');
    hide('saveStratTopbarBtn');

    // ── 6. Reset name pill ─────────────────────────────────────────────────────
    setStrategyName('New Strategy', false);

    showToast('Started a new strategy ✦');
}



async function loadStratToBacktest(id) {
    const strat = _allStrategies.find(s => s.id === id) || (await fetchStrategy(id));
    if (!strat) return;

    // backtest.js exposes btEditor globally
    if (window.btEditor && strat.code) {
        window.btEditor.setValue(strat.code);
        window._loadedStrategyId = strat.id;
        window._loadedStrategyName = strat.name;
        switchToPanel('backing');
        showToast(`Loaded "${strat.name}" into Backtesting editor`);
    } else {
        showToast('Backtesting editor not ready. Open the Backtesting tab first.');
    }
}



// ── Delete strategy ───────────────────────────────────────────────────────────
async function deleteStrategy(id) {
    const strat = _allStrategies.find(s => s.id === id);
    if (!confirm(`Delete "${strat?.name || id}"? This cannot be undone.`)) return;

    try {
        const res = await fetch(`/api/strategies/${id}`, { method: 'DELETE' });
        const d = await res.json();
        if (d.error) throw new Error(d.error);
        _allStrategies = _allStrategies.filter(s => s.id !== id);
        renderLibrary(_allStrategies);
        showToast('Strategy deleted');
    } catch (e) {
        showToast('Delete failed: ' + e.message);
    }
}

async function fetchStrategy(id) {
    try {
        const res = await fetch(`/api/strategies/${id}`);
        return await res.json();
    } catch (e) {
        showToast('Could not load strategy: ' + e.message);
        return null;
    }
}

// ── Search filter ─────────────────────────────────────────────────────────────
document.getElementById('librarySearch')?.addEventListener('input', e => {
    const q = e.target.value.toLowerCase().trim();
    if (!q) { renderLibrary(_allStrategies); return; }
    const filtered = _allStrategies.filter(s =>
        s.name.toLowerCase().includes(q) ||
        (s.description || '').toLowerCase().includes(q) ||
        (s.pair || '').toLowerCase().includes(q) ||
        (Array.isArray(s.tags) ? s.tags.join(' ') : '').toLowerCase().includes(q)
    );
    renderLibrary(filtered);
});

// ── Refresh button ────────────────────────────────────────────────────────────
document.getElementById('libraryRefreshBtn')?.addEventListener('click', loadLibrary);

// ── Load library when tab is clicked ─────────────────────────────────────────
document.querySelector('[data-panel="library"]')?.addEventListener('click', loadLibrary);

// ── Initialise Initiator panel when its tab is clicked ───────────────────────
document.querySelector('[data-panel="initiator"]')?.addEventListener('click', () => {
    window.initInitiatorPanel?.();
});

// ── Expose globally ───────────────────────────────────────────────────────────
window.loadLibrary = loadLibrary;
window.loadStratToCreator = loadStratToCreator;
window.setStrategyName = setStrategyName;
window.newStrategy = newStrategy;
window.showImportPicker = showImportPicker;

// ── Utilities ─────────────────────────────────────────────────────────────────
function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function switchToPanel(name) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    document.querySelector(`[data-panel="${name}"]`)?.classList.add('active');
    document.getElementById(`panel-${name}`)?.classList.add('active');
}

// ── Initial load if Library tab is active ────────────────────────────────────
if (document.getElementById('panel-library')?.classList.contains('active')) {
    loadLibrary();
}
