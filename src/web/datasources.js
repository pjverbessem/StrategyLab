/**
 * datasources.js — Data Sources tab + Initiator exchange selector  v8
 * Entity-first investigation: pick entity (protocol/coin/symbol/pair) → pick data type → load
 */

// ── State ─────────────────────────────────────────────────────────────────────
let _selectedExchange = localStorage.getItem('selectedExchange') || 'kraken';
let _exchangeData     = [];
let _sourcesData      = [];

const _EXCHANGES = [
    { id: 'binance',     icon: 'B',  name: 'Binance',      color: '#f0b90b' },
    { id: 'bybit',       icon: 'By', name: 'Bybit',        color: '#f7a600' },
    { id: 'coinbase',    icon: 'C',  name: 'Coinbase',     color: '#0052ff' },
    { id: 'dydx',        icon: 'D',  name: 'dYdX',         color: '#6c7c99' },
    { id: 'hyperliquid', icon: 'H',  name: 'Hyperliquid',  color: '#4ade80' },
    { id: 'kraken',      icon: 'K',  name: 'Kraken',       color: '#5741d9' },
    { id: 'okx',         icon: 'O',  name: 'OKX',          color: '#1a56db' },
];

const _SUPPS = [
    { id: 'coingecko',     icon: '🦎', name: 'CoinGecko',    sub: 'Market cap' },
    { id: 'coinglass',     icon: '📊', name: 'Coinglass',    sub: 'OI · funding' },
    { id: 'coinmarketcap', icon: '📈', name: 'CMC',          sub: 'Rankings' },
    { id: 'defillama',     icon: '🦙', name: 'DefiLlama',    sub: 'TVL · yields' },
    { id: 'feargreed',     icon: '😱', name: 'Fear & Greed', sub: 'Daily index' },
    { id: 'messari',       icon: '🔗', name: 'Messari',      sub: 'On-chain' },
];

// ── Bootstrap ─────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    initDataSourcesTab();
    initInitiatorExchangeSelector();
});

// ══════════════════════════════════════════════════════════════════════════════
// DATA SOURCES TAB
// ══════════════════════════════════════════════════════════════════════════════

async function initDataSourcesTab() {
    renderDataSourcesShell();
    refreshDataSources();
    setInterval(() => {
        if (document.getElementById('panel-sources')?.classList.contains('active')) {
            refreshDataSources();
        }
    }, 60_000);
}

async function refreshDataSources() {
    try {
        const [exRes, srcRes] = await Promise.all([
            fetch('/api/exchanges').then(r => r.json()),
            fetch('/api/data-sources').then(r => r.json()),
        ]);
        _exchangeData = (exRes.exchanges || []).sort((a,b) => a.name.localeCompare(b.name));
        _sourcesData  = (srcRes.sources  || []).sort((a,b) => a.name.localeCompare(b.name));
        renderDataSourcesTab();
    } catch (e) {
        console.warn('[datasources] fetch failed:', e);
    }
}

function renderDataSourcesShell() {
    const panel = document.getElementById('panel-sources');
    if (!panel) return;
    panel.innerHTML = `
    <div class="ds-page">
      <div class="ds-header">
        <div>
          <h1 class="ds-title">Data Sources</h1>
          <p class="ds-subtitle">Select your execution exchange and supplementary signals. Sources are sorted A–Z.</p>
        </div>
        <button class="ds-ask-btn" onclick="dsOpenAskModal()">
          <svg width="14" height="14" fill="none" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
          Request Data Source
        </button>
      </div>

      <div class="ds-section">
        <div class="ds-section-header">
          <span class="ds-section-title">Execution Exchanges</span>
          <span class="ds-section-desc">OHLCVT price data · bot execution venue · one active at a time</span>
        </div>
        <div class="ds-list" id="dsExchangeList">
          ${[0,1,2,3,4,5,6].map(() => '<div class="ds-row-skeleton"></div>').join('')}
        </div>
      </div>

      <div class="ds-section">
        <div class="ds-section-header">
          <span class="ds-section-title">Supplementary Signals</span>
          <span class="ds-section-desc">Toggle to enrich the AI context · each adds context to the strategy</span>
        </div>
        <div class="ds-list" id="dsSuppList">
          ${[0,1,2,3,4,5].map(() => '<div class="ds-row-skeleton"></div>').join('')}
        </div>
      </div>

      <!-- ── INVESTIGATE MODAL ─────────────────────────────────────────────── -->
      <div class="ds-inv-overlay" id="dsInvOverlay" onclick="dsInvCloseOnOverlay(event)">
        <div class="ds-inv-modal" id="dsInvModal">

          <!-- Header -->
          <div class="ds-inv-header">
            <div class="ds-inv-header-left">
              <div class="ds-inv-icon" id="dsInvIcon"></div>
              <div>
                <div class="ds-inv-title" id="dsInvTitle">Investigate Data</div>
                <div class="ds-inv-subtitle" id="dsInvSubtitle">Search below to explore the data</div>
              </div>
            </div>
            <button class="ds-inv-close" onclick="dsInvClose()">✕</button>
          </div>

          <!-- Query Builder — entity search first, then data type -->
          <div class="ds-inv-builder" id="dsInvBuilder">

            <!-- Step 1: Entity (always shown, label/placeholder changes per source+type) -->
            <div class="ds-inv-field" id="dsInvEntityField">
              <label class="ds-inv-label" id="dsInvEntityLabel">Search</label>
              <div class="ds-inv-pair-wrap">
                <input
                  class="ds-inv-pair-input"
                  id="dsInvPairInput"
                  type="text"
                  placeholder="Type to search…"
                  autocomplete="off"
                  oninput="dsInvOnPairInput(this)"
                  onfocus="dsInvOnPairFocus()"
                  onkeydown="dsInvOnPairKey(event)"
                />
                <div class="ds-inv-pair-dropdown" id="dsInvDropdown"></div>
              </div>
            </div>

            <!-- Step 2: Data Type -->
            <div class="ds-inv-field" id="dsInvTypeField">
              <label class="ds-inv-label">Data Type</label>
              <div class="ds-inv-type-pills" id="dsInvTypePills">
                <span style="color:var(--t3);font-size:12px">Loading…</span>
              </div>
            </div>

            <!-- Go -->
            <button class="ds-inv-go-btn" id="dsInvGoBtn" onclick="dsInvLoad()" disabled>
              <svg width="14" height="14" fill="none" viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
              Load Data
            </button>
          </div>

          <!-- Results -->
          <div class="ds-inv-results" id="dsInvResults" style="display:none">
            <div class="ds-inv-results-meta" id="dsInvResultsMeta"></div>
            <div class="ds-inv-table-wrap" id="dsInvTableWrap"></div>
          </div>

        </div>
      </div>

      <!-- Ask Modal -->
      <div class="ds-ask-overlay" id="dsAskOverlay" style="display:none">
        <div class="ds-ask-modal">
          <div class="ds-ask-modal-header">
            <span>Request a Data Source</span>
            <button onclick="dsCloseAskModal()" class="ds-ask-close">✕</button>
          </div>
          <p class="ds-ask-body">Tell us which exchange or data provider you need. We'll add it in a future update.</p>
          <textarea class="ds-ask-input" id="dsAskText" rows="4" placeholder="e.g. 'I want to trade on Gate.io...'"></textarea>
          <div class="ds-ask-actions">
            <button class="btn-secondary" onclick="dsCloseAskModal()">Cancel</button>
            <button class="btn-primary" onclick="dsSubmitAsk()">Submit Request</button>
          </div>
        </div>
      </div>
    </div>`;
}

function renderDataSourcesTab() {
    renderExchangeList();
    renderSuppList();
}

// ── Exchange list ──────────────────────────────────────────────────────────────
function renderExchangeList() {
    const list = document.getElementById('dsExchangeList');
    if (!list || !_exchangeData.length) return;
    list.innerHTML = _exchangeData.map(ex => {
        const sel = ex.id === _selectedExchange;
        const statusCls = ex.online ? 'online' : 'offline';
        return `
        <div class="ds-row ${sel ? 'ds-row--selected' : ''}" data-exchange="${ex.id}" onclick="dsSelectExchange('${ex.id}')">
          <div class="ds-row-left">
            <div class="ds-row-icon" style="background:${ex.color}1a;border-color:${ex.color}33;color:${ex.color}">${ex.icon}</div>
            <div class="ds-row-info">
              <div class="ds-row-name">${ex.name}${sel ? '<span class="ds-row-active-tag">▶ Active</span>' : ''}</div>
              <div class="ds-row-meta">${ex.description} &nbsp;·&nbsp; ${ex.pairs_hint}</div>
            </div>
          </div>
          <div class="ds-row-right">
            <div class="ds-row-status ${statusCls}"><span class="ds-dot"></span>${ex.online ? 'Online' : 'Offline'}</div>
            <button class="ds-investigate-btn" onclick="event.stopPropagation();dsInvOpen('${ex.id}','${ex.name}','exchange')">🔍 Investigate</button>
          </div>
        </div>`;
    }).join('');
}

// ── Supplementary list ─────────────────────────────────────────────────────────
function renderSuppList() {
    const list = document.getElementById('dsSuppList');
    if (!list || !_sourcesData.length) return;
    const saved = JSON.parse(localStorage.getItem('activeSources') || '{}');
    list.innerHTML = _sourcesData.map(src => {
        const isActive = saved[src.id] === true;
        const needsKey = src.key_required && !src.has_key;
        const statusTxt = src.online ? 'Connected' : needsKey ? 'Needs API key' : 'Offline';
        const statusCls = src.online ? 'online' : needsKey ? 'needskey' : 'offline';
        return `
        <div class="ds-row ${isActive ? 'ds-row--active' : ''}">
          <div class="ds-row-left">
            <div class="ds-row-icon" style="background:${src.color}1a;color:${src.color};font-size:14px">${src.icon}</div>
            <div class="ds-row-info">
              <div class="ds-row-name">${src.name}</div>
              <div class="ds-row-meta">${src.description}</div>
              ${needsKey ? `<div class="ds-key-row" style="margin-top:6px">
                <input class="ds-key-input" type="password" placeholder="Enter API key…" id="dsKey_${src.id}" autocomplete="off">
                <button class="ds-key-save" onclick="dsSaveKey('${src.id}','${src.key_env}')">Save</button>
              </div>` : ''}
            </div>
          </div>
          <div class="ds-row-right">
            <div class="ds-row-status ${statusCls}"><span class="ds-dot"></span>${statusTxt}</div>
            <button class="ds-investigate-btn" onclick="dsInvOpen('${src.id}','${src.name}','supp')">🔍 Investigate</button>
            <label class="ds-supp-toggle" onclick="event.stopPropagation()">
              <input type="checkbox" ${isActive ? 'checked' : ''} onchange="dsToggleSource('${src.id}', this.checked)">
              <span class="ds-toggle-track"></span>
            </label>
          </div>
        </div>`;
    }).join('');
}

// ── Exchange selection ─────────────────────────────────────────────────────────
function dsSelectExchange(exId) {
    _selectedExchange = exId;
    localStorage.setItem('selectedExchange', exId);
    renderExchangeList();
    renderInitiatorExchangeSelector();
    propagateExchangeToInitiator(exId);
}

// ── Source toggle ──────────────────────────────────────────────────────────────
function dsToggleSource(srcId, active) {
    const saved = JSON.parse(localStorage.getItem('activeSources') || '{}');
    saved[srcId] = active;
    localStorage.setItem('activeSources', JSON.stringify(saved));
    renderSuppList();
    const cb = document.querySelector(`#initDsGrid input[value="${srcId}"]`);
    if (cb) { cb.checked = active; cb.closest('label')?.classList.toggle('on', active); }
    updateInitSuppCount();
}

// ── API key save ───────────────────────────────────────────────────────────────
async function dsSaveKey(srcId, keyEnv) {
    const input = document.getElementById(`dsKey_${srcId}`);
    if (!input || !input.value.trim()) return;
    try {
        const res  = await fetch('/api/save-api-key', {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ key_name: keyEnv, key_value: input.value.trim() }),
        });
        const data = await res.json();
        if (data.ok) { input.value = ''; dsShowToast('✅ Key saved'); refreshDataSources(); }
        else dsShowToast('❌ ' + data.error);
    } catch { dsShowToast('❌ Failed to save key'); }
}

// ══════════════════════════════════════════════════════════════════════════════
// INVESTIGATE MODAL — entity-first search + data type selection
// ══════════════════════════════════════════════════════════════════════════════

let _invSourceId      = null;
let _invSourceName    = null;
let _invKind          = null;   // 'exchange' | 'supp'
let _invPair          = null;   // selected entity value (slug, coin id, symbol, …)
let _invDataType      = null;
let _invDropdownItems = [];
let _invDropdownLabels= {};
let _invDropdownIdx   = -1;
let _invPairDebounce  = null;

/**
 * Returns entity field config for a given source+dataType combination.
 * { show: bool, label: string, placeholder: string }
 */
function _invEntityConfig(sourceId, dataType) {
    const dt = (dataType || '').toLowerCase();

    // Exchanges — trading pair
    if (_invKind === 'exchange') {
        return { show: true, label: 'Trading Pair', placeholder: 'Type to search pairs… e.g. BTCUSDT' };
    }

    // Fear & Greed — global, no entity
    if (sourceId === 'feargreed') {
        return { show: false };
    }

    // DefiLlama — entity changes based on data type
    if (sourceId === 'defillama') {
        if (dt.includes('chain'))  return { show: true, label: 'Blockchain', placeholder: 'e.g. Ethereum, Arbitrum, Solana, BSC…' };
        if (dt.includes('stable')) return { show: true, label: 'Stablecoin', placeholder: 'e.g. USDT, USDC, DAI…' };
        if (dt.includes('yield'))  return { show: true, label: 'Protocol / Pool', placeholder: 'e.g. Aave, Curve, Convex, Uniswap…' };
        return { show: true, label: 'Protocol', placeholder: 'e.g. Lido, Aave, MakerDAO, Uniswap…' };
    }

    // CoinGecko
    if (sourceId === 'coingecko') {
        return { show: true, label: 'Coin', placeholder: 'e.g. bitcoin, ethereum, solana…' };
    }

    // Coinglass
    if (sourceId === 'coinglass') {
        return { show: true, label: 'Asset Symbol', placeholder: 'e.g. BTC, ETH, SOL…' };
    }

    // Messari
    if (sourceId === 'messari') {
        return { show: true, label: 'Asset', placeholder: 'e.g. bitcoin, ethereum, solana…' };
    }

    // CoinMarketCap
    if (sourceId === 'coinmarketcap') {
        return { show: true, label: 'Symbol', placeholder: 'e.g. BTC, ETH, SOL…' };
    }

    return { show: false };
}

async function dsInvOpen(sourceId, sourceName, kind) {
    _invSourceId   = sourceId;
    _invSourceName = sourceName;
    _invKind       = kind;
    _invPair       = null;
    _invDataType   = null;

    // Header icon + labels
    const allMeta = [..._EXCHANGES, ..._SUPPS];
    const meta = allMeta.find(m => m.id === sourceId) || {};
    document.getElementById('dsInvIcon').textContent = meta.icon || '📊';
    document.getElementById('dsInvTitle').textContent    = `${sourceName} — Investigate`;
    document.getElementById('dsInvSubtitle').textContent =
        kind === 'exchange'
            ? 'Search a trading pair, choose data type, then press Load Data'
            : 'Search below to explore specific data for this source';

    // Reset
    const pairInput = document.getElementById('dsInvPairInput');
    pairInput.value = '';
    document.getElementById('dsInvDropdown').innerHTML = '';
    document.getElementById('dsInvDropdown').style.display = 'none';
    document.getElementById('dsInvResults').style.display  = 'none';
    document.getElementById('dsInvTableWrap').innerHTML    = '';
    document.getElementById('dsInvResultsMeta').textContent = '';

    // Show overlay
    document.getElementById('dsInvOverlay').style.display = 'flex';

    // Load data types (updates entity field config too)
    await _invLoadDataTypes();

    // Focus entity if shown
    const cfg = _invEntityConfig(sourceId, _invDataType);
    if (cfg.show) setTimeout(() => pairInput.focus(), 80);

    // If supplementary, show default suggestions immediately
    if (kind === 'supp' && cfg.show) {
        _invFetchPairs('');
    }
}

async function _invLoadDataTypes() {
    const pills = document.getElementById('dsInvTypePills');
    pills.innerHTML = '<span style="color:var(--t3);font-size:12px">Loading…</span>';
    try {
        const r = await fetch(`/api/data-sources/data-types/${_invSourceId}`);
        const d = await r.json();
        const types = d.data_types || [];
        if (!types.length) {
            pills.innerHTML = '<span style="color:var(--t3);font-size:12px">No data types available</span>';
            return;
        }
        // Auto-select first
        _invDataType = types[0];
        pills.innerHTML = types.map((t, i) =>
            `<button class="ds-inv-type-pill${i === 0 ? ' active' : ''}"
                     onclick="dsInvSelectType(this,'${t}')">${t}</button>`
        ).join('');
        // Update entity field for the auto-selected type
        _invUpdateEntityField();
        _invUpdateGoBtn();
    } catch {
        pills.innerHTML = '<span style="color:var(--t3);font-size:12px">Failed to load types</span>';
    }
}

function dsInvSelectType(btn, type) {
    document.querySelectorAll('.ds-inv-type-pill').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    _invDataType = type;

    // Clear entity when type changes (entity context may change)
    _invPair = null;
    const pairInput = document.getElementById('dsInvPairInput');
    pairInput.value = '';
    document.getElementById('dsInvDropdown').style.display = 'none';

    // Update entity field config
    _invUpdateEntityField();
    _invUpdateGoBtn();

    // Reload default suggestions with new data_type
    const cfg = _invEntityConfig(_invSourceId, type);
    if (cfg.show && _invKind === 'supp') {
        _invFetchPairs('');
    }
}

function _invUpdateEntityField() {
    const cfg   = _invEntityConfig(_invSourceId, _invDataType);
    const field = document.getElementById('dsInvEntityField');
    const label = document.getElementById('dsInvEntityLabel');
    const input = document.getElementById('dsInvPairInput');

    if (!cfg.show) {
        field.style.display = 'none';
        // No entity needed — allow Load with just data_type selected
        _invPair = '__no_entity__';
    } else {
        field.style.display = '';
        label.textContent   = cfg.label;
        input.placeholder   = cfg.placeholder;
        if (_invPair === '__no_entity__') _invPair = null;
    }
}

function _invUpdateGoBtn() {
    const btn    = document.getElementById('dsInvGoBtn');
    const cfg    = _invEntityConfig(_invSourceId, _invDataType);
    const pairOk = !cfg.show || (_invPair && _invPair !== '__no_entity__' && _invPair.trim().length > 0);
    btn.disabled = !(pairOk && _invDataType);
}

// ── Pair/entity autocomplete ───────────────────────────────────────────────────
function dsInvOnPairFocus() {
    const q = document.getElementById('dsInvPairInput').value.trim();
    if (q.length < 1 && _invKind === 'supp') {
        _invFetchPairs('');
    }
}

function dsInvOnPairInput(input) {
    _invPair = null;
    _invUpdateGoBtn();
    clearTimeout(_invPairDebounce);
    _invPairDebounce = setTimeout(() => _invFetchPairs(input.value.trim()), 200);
}

async function _invFetchPairs(q) {
    const dropdown = document.getElementById('dsInvDropdown');
    if (q.length < 1 && _invKind === 'exchange') { dropdown.style.display = 'none'; return; }
    const dtParam = _invDataType ? `&data_type=${encodeURIComponent(_invDataType)}` : '';
    try {
        const r = await fetch(`/api/data-sources/pairs/${_invSourceId}?q=${encodeURIComponent(q)}${dtParam}`);
        const d = await r.json();
        _invDropdownItems  = d.pairs  || [];
        _invDropdownLabels = d.labels || {};
        _invDropdownIdx    = -1;
        _invRenderDropdown();
    } catch { dropdown.style.display = 'none'; }
}

function _invRenderDropdown() {
    const dropdown = document.getElementById('dsInvDropdown');
    if (!_invDropdownItems.length) { dropdown.style.display = 'none'; return; }
    dropdown.innerHTML = _invDropdownItems.map((p, i) => {
        const display = _invDropdownLabels[p] || p;
        return `<div class="ds-inv-dd-item" data-idx="${i}"
            onmousedown="dsInvSelectPair('${p.replace(/'/g,"\\'")}','${display.replace(/'/g,"\\'")}')">
          ${display}
        </div>`;
    }).join('');
    dropdown.style.display = 'block';
}

function dsInvSelectPair(pair, display) {
    _invPair = pair;
    document.getElementById('dsInvPairInput').value = display || pair;
    document.getElementById('dsInvDropdown').style.display = 'none';
    _invUpdateGoBtn();
}

function dsInvOnPairKey(e) {
    const dropdown = document.getElementById('dsInvDropdown');
    const items    = dropdown.querySelectorAll('.ds-inv-dd-item');
    if (!items.length) {
        if (e.key === 'Enter') {
            const v = document.getElementById('dsInvPairInput').value.trim();
            if (v) { _invPair = v; _invUpdateGoBtn(); }
        }
        return;
    }
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        _invDropdownIdx = Math.min(_invDropdownIdx + 1, items.length - 1);
        items.forEach((el, i) => el.classList.toggle('highlight', i === _invDropdownIdx));
        items[_invDropdownIdx]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        _invDropdownIdx = Math.max(_invDropdownIdx - 1, 0);
        items.forEach((el, i) => el.classList.toggle('highlight', i === _invDropdownIdx));
        items[_invDropdownIdx]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
        e.preventDefault();
        if (_invDropdownIdx >= 0 && _invDropdownItems[_invDropdownIdx]) {
            const slug = _invDropdownItems[_invDropdownIdx];
            dsInvSelectPair(slug, _invDropdownLabels[slug] || slug);
        } else {
            _invPair = document.getElementById('dsInvPairInput').value.trim().toUpperCase();
            dropdown.style.display = 'none';
            _invUpdateGoBtn();
        }
    } else if (e.key === 'Escape') {
        dropdown.style.display = 'none';
    }
}

// ── Load Data ─────────────────────────────────────────────────────────────────
async function dsInvLoad() {
    const resultsDiv = document.getElementById('dsInvResults');
    const tableWrap  = document.getElementById('dsInvTableWrap');
    const metaDiv    = document.getElementById('dsInvResultsMeta');

    resultsDiv.style.display = 'block';
    tableWrap.innerHTML = `<div class="ds-inv-loading"><span class="ds-spinner"></span> Fetching data…</div>`;
    metaDiv.innerHTML = '';

    const params = new URLSearchParams();
    if (_invPair && _invPair !== '__no_entity__') params.set('pair', _invPair);
    if (_invDataType) params.set('data_type', _invDataType);

    try {
        const r = await fetch(`/api/data-sources/preview/${_invSourceId}?${params}`);
        const d = await r.json();

        if (d.error) {
            tableWrap.innerHTML = `<div class="ds-inv-error">⚠️ ${d.error}</div>`;
            return;
        }
        if (!d.columns?.length) {
            tableWrap.innerHTML = `<div class="ds-inv-error">${d.note || 'No data returned for this selection.'}</div>`;
            return;
        }

        const entityLabel = _invPair && _invPair !== '__no_entity__'
            ? (_invDropdownLabels[_invPair] || _invPair)
            : null;

        metaDiv.innerHTML = `
            <span class="ds-inv-meta-tag">${d.source || _invSourceName}</span>
            ${entityLabel ? `<span class="ds-inv-meta-tag">${entityLabel}</span>` : ''}
            ${_invDataType ? `<span class="ds-inv-meta-tag">${_invDataType}</span>` : ''}
            <span class="ds-inv-meta-count">${d.rows.length} rows · ${d.columns.length} columns</span>`;

        tableWrap.innerHTML = `
        <table class="ds-data-table">
          <thead><tr>${d.columns.map(c => `<th>${c}</th>`).join('')}</tr></thead>
          <tbody>
            ${d.rows.map(row =>
                `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`
            ).join('')}
          </tbody>
        </table>`;
    } catch (e) {
        tableWrap.innerHTML = `<div class="ds-inv-error">❌ Network error: ${e.message}</div>`;
    }
}

// ── Close helpers ─────────────────────────────────────────────────────────────
function dsInvClose() { document.getElementById('dsInvOverlay').style.display = 'none'; }
function dsInvCloseOnOverlay(e) { if (e.target === document.getElementById('dsInvOverlay')) dsInvClose(); }

// ── Ask modal ──────────────────────────────────────────────────────────────────
function dsOpenAskModal()  { document.getElementById('dsAskOverlay').style.display = 'flex'; }
function dsCloseAskModal() { document.getElementById('dsAskOverlay').style.display = 'none'; }
function dsSubmitAsk() {
    const text = document.getElementById('dsAskText')?.value?.trim();
    if (!text) return;
    dsShowToast("✅ Request noted — we'll review it soon!");
    dsCloseAskModal();
    document.getElementById('dsAskText').value = '';
}

// ══════════════════════════════════════════════════════════════════════════════
// INITIATOR EXCHANGE SELECTOR
// ══════════════════════════════════════════════════════════════════════════════

function initInitiatorExchangeSelector() {
    const exRow    = document.getElementById('initExchangeRow');
    const suppWrap = document.getElementById('initDsGrid');
    if (!exRow && !suppWrap) return;
    if (exRow)    exRow.innerHTML    = buildInitiatorExchangePills();
    if (suppWrap) suppWrap.innerHTML = buildInitiatorSuppPills();
    updateInitSuppCount();
}

function renderInitiatorExchangeSelector() {
    const row = document.getElementById('initExchangeRow');
    if (row) row.innerHTML = buildInitiatorExchangePills();
}

function buildInitiatorExchangePills() {
    return _EXCHANGES.map(ex => {
        const sel = ex.id === _selectedExchange;
        return `<button class="init-ex-pill${sel?' active':''}" onclick="dsSelectExchange('${ex.id}')"
            style="${sel?`border-color:${ex.color};color:${ex.color};background:${ex.color}11`:''}">
          <span class="init-ex-dot" style="background:${ex.color}"></span>${ex.name}
        </button>`;
    }).join('');
}

function buildInitiatorSuppPills() {
    const saved = JSON.parse(localStorage.getItem('activeSources') || '{}');
    return _SUPPS.map(s => {
        const on = saved[s.id] === true;
        return `<label class="init-supp-pill${on?' on':''}" data-key="${s.id}">
          <input type="checkbox" value="${s.id}" ${on?'checked':''} onchange="dsToggleSource('${s.id}',this.checked)">
          ${s.icon} ${s.name}
        </label>`;
    }).join('');
}

function updateInitSuppCount() {
    const saved  = JSON.parse(localStorage.getItem('activeSources') || '{}');
    const active = Object.values(saved).filter(Boolean).length;
    const el = document.getElementById('initSuppCount');
    if (el) el.textContent = active > 0 ? `${active} active` : '';
}

function propagateExchangeToInitiator(exId) {
    try {
        const cfg = JSON.parse(sessionStorage.getItem('initConfig') || '{}');
        cfg.exchange = exId;
        sessionStorage.setItem('initConfig', JSON.stringify(cfg));
    } catch {}
    renderInitiatorExchangeSelector();
}

// ── Toast ──────────────────────────────────────────────────────────────────────
function dsShowToast(msg) {
    if (typeof showToast === 'function') { showToast(msg); return; }
    const t = document.createElement('div');
    t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#1a1a2e;color:#f1f5f9;padding:10px 20px;border-radius:8px;font-size:13px;z-index:9999;border:1px solid rgba(255,255,255,.12);';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3000);
}
