/* ── initiator.js — Guided strategy creation flow ──────────────────────────── */
'use strict';

(function () {

    /* ── State ----------------------------------------------------------------- */
    const state = {
        pair:       'STRKUSD',
        interval:   1440,
        datasets:   new Set(['price']),   // 'price' | 'feargreed' | 'unlocks'
        indicators: [],                   // [{id, col, period, ...params}]
        pairsData:  [],
    };

    /* ── Pair colours ---------------------------------------------------------- */
    const PAIR_COLORS = {
        ARBUSD: '#0891b2', OPUSD: '#dc2626', STRKUSD: '#7c3aed', ZKUSD: '#2563eb',
    };

    /* ── Boot ------------------------------------------------------------------ */
    async function init() {
        await loadPairs();
        wireDataSourceCards();
        wireIndicatorCards();
        wireIntervalButtons();
        wirePromptCounter();
        wireLaunchButton();
        setDefaultDates();
    }

    /* ── Load pairs ------------------------------------------------------------ */
    async function loadPairs() {
        try {
            const data = await fetch('/api/pairs').then(r => r.json());
            const raw  = data.pairs || data;
            state.pairsData = raw.map(p => ({
                pair:      typeof p === 'string' ? p : (p.pair || String(p)),
                name:      typeof p === 'object' ? (p.name      || '') : '',
                start:     typeof p === 'object' ? (p.start     || '') : '',
                end:       typeof p === 'object' ? (p.end       || '') : '',
                intervals: typeof p === 'object' ? (p.intervals || [1440]) : [1440],
            }));
        } catch (e) {
            state.pairsData = [
                { pair: 'ARBUSD',  name: 'Arbitrum', start: '2023-01-01', end: '', intervals: [1440] },
                { pair: 'OPUSD',   name: 'Optimism', start: '2023-01-01', end: '', intervals: [1440] },
                { pair: 'STRKUSD', name: 'Starknet', start: '2024-01-01', end: '', intervals: [1440] },
                { pair: 'ZKUSD',   name: 'ZKsync',   start: '2024-01-01', end: '', intervals: [1440] },
            ];
        }
        renderPairChips();
        setDefaultDates();
    }

    /* ── Pair chips ------------------------------------------------------------ */
    const FEATURED_PAIRS = ['ARBUSD', 'OPUSD', 'STRKUSD', 'ZKUSD'];

    function chipHtml(p) {
        const sym      = p.pair.replace('USD', '');
        const color    = PAIR_COLORS[p.pair] || '#6366f1';
        const active   = p.pair === state.pair;
        const featured = FEATURED_PAIRS.includes(p.pair);
        return `<button
            class="init-pair-chip ${featured ? 'init-pair-chip-featured' : ''} ${active ? 'active' : ''}"
            data-pair="${p.pair}"
            style="--chip-color:${color}"
            title="${p.name || sym}"
        >${sym}</button>`;
    }

    function renderPairChips() {
        const wrap = document.getElementById('initPairChips');
        if (!wrap) return;
        const featured = state.pairsData.filter(p =>  FEATURED_PAIRS.includes(p.pair));
        const others   = state.pairsData.filter(p => !FEATURED_PAIRS.includes(p.pair));
        wrap.innerHTML =
            `<div class="init-pair-row featured-row">${featured.map(chipHtml).join('')}</div>` +
            (others.length
                ? `<details class="init-pair-more"><summary>All pairs (${others.length + featured.length} available)</summary><div class="init-pair-row init-pair-row-all">${others.map(chipHtml).join('')}</div></details>`
                : '');
        wrap.querySelectorAll('.init-pair-chip').forEach(btn => {
            btn.addEventListener('click', () => {
                state.pair = btn.dataset.pair;
                wrap.querySelectorAll('.init-pair-chip').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                setDefaultDates();
            });
        });
    }

    /* ── Default dates --------------------------------------------------------- */
    function setDefaultDates() {
        const pd    = state.pairsData.find(p => p.pair === state.pair);
        const today = new Date().toISOString().slice(0, 10);
        const startEl = document.getElementById('initStart');
        const endEl   = document.getElementById('initEnd');
        if (!startEl || !endEl) return;
        startEl.value = pd?.start || '2024-01-01';
        endEl.value   = pd?.end   || today;
    }

    /* ── Data source cards ----------------------------------------------------- */
    function wireDataSourceCards() {
        document.querySelectorAll('.init-ds-card').forEach(card => {
            const cb  = card.querySelector('input[type=checkbox]');
            const key = card.dataset.key;
            if (cb.checked) { state.datasets.add(key); card.classList.add('checked'); }
            card.addEventListener('click', () => {
                cb.checked = !cb.checked;
                card.classList.toggle('checked', cb.checked);
                cb.checked ? state.datasets.add(key) : state.datasets.delete(key);
                if (key === 'price' && !cb.checked) {
                    cb.checked = true;
                    card.classList.add('checked');
                    state.datasets.add('price');
                }
            });
        });
    }

    /* ── Indicator cards ------------------------------------------------------- */
    function wireIndicatorCards() {
        document.querySelectorAll('.init-ind-card').forEach(card => {
            const cb     = card.querySelector('.init-ind-cb');
            const params = card.querySelector('.init-ind-params');

            cb.addEventListener('change', () => {
                card.classList.toggle('active', cb.checked);
                if (params) params.style.display = cb.checked ? 'flex' : 'none';
                syncIndicatorState(card, cb.checked);
                updateIndCount();
                updateColPreviews(card);
            });

            // Update previews when any param changes
            card.querySelectorAll('.init-ind-param').forEach(input => {
                input.addEventListener('input', () => {
                    updateColPreviews(card);
                    syncIndicatorState(card, cb.checked);
                });
                // Prevent card click from toggling when interacting with inputs
                input.addEventListener('click', e => e.stopPropagation());
            });
        });
    }

    function updateColPreviews(card) {
        const iid     = card.dataset.id;
        const preview = card.querySelector('.init-ind-col-preview');
        if (!preview) return;

        const p = getParam(card, 'period');
        const templates = {
            sma:    () => `df['SMA_${p}']`,
            ema:    () => `df['EMA_${p}']`,
            vwap:   () => `df['VWAP']`,
            rsi:    () => `df['RSI_${p}']`,
            macd:   () => `df['MACD'], df['MACD_SIGNAL'], df['MACD_HIST']`,
            stoch:  () => `df['STOCH_K'], df['STOCH_D']`,
            wr:     () => `df['WR_${p}']`,
            bbands: () => `df['BB_UPPER'], df['BB_MID'], df['BB_LOWER'], df['BB_WIDTH']`,
            atr:    () => `df['ATR_${p}']`,
            obv:    () => `df['OBV']`,
        };
        if (templates[iid]) preview.textContent = templates[iid]();
    }

    function getParam(card, name) {
        const el = card.querySelector(`[data-param="${name}"]`);
        return el ? +el.value : undefined;
    }

    function getAllParams(card) {
        const out = {};
        card.querySelectorAll('.init-ind-param').forEach(el => {
            out[el.dataset.param] = +el.value;
        });
        return out;
    }

    function syncIndicatorState(card, active) {
        if (!active) {
            state.indicators = state.indicators.filter(i => i.id !== card.dataset.id);
            return;
        }
        const iid    = card.dataset.id;
        const params = getAllParams(card);
        // Compute canonical col name
        const p   = params.period || 14;
        const col = card.dataset.col
            ? card.dataset.col.replace('{p}', p)
            : iid.toUpperCase();

        const entry = { id: iid, col, ...params };
        state.indicators = state.indicators.filter(i => i.id !== iid);
        state.indicators.push(entry);
    }

    function updateIndCount() {
        const el = document.getElementById('initIndCount');
        if (!el) return;
        const n = state.indicators.length;
        el.textContent = n > 0 ? `${n} selected` : '';
    }

    /* ── Interval buttons ------------------------------------------------------ */
    function wireIntervalButtons() {
        const group = document.getElementById('initIntervalGroup');
        if (!group) return;
        group.querySelectorAll('.init-int-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                state.interval = +btn.dataset.val;
                group.querySelectorAll('.init-int-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
            });
        });
    }

    /* ── Character counter ----------------------------------------------------- */
    function wirePromptCounter() {
        const ta    = document.getElementById('initPrompt');
        const count = document.getElementById('initCharCount');
        if (!ta || !count) return;
        ta.addEventListener('input', () => {
            const n = ta.value.length;
            count.textContent = `${n} chars`;
            count.classList.toggle('warn', n > 400);
        });
    }

    /* ── Launch button --------------------------------------------------------- */
    function wireLaunchButton() {
        const btn = document.getElementById('initLaunchBtn');
        if (!btn) return;
        btn.addEventListener('click', launch);
    }

    async function launch() {
        const prompt = (document.getElementById('initPrompt')?.value || '').trim();
        if (!prompt) { document.getElementById('initPrompt')?.focus(); return; }

        const pair      = state.pair;
        const interval  = state.interval;
        const start     = document.getElementById('initStart')?.value || '';
        const end       = document.getElementById('initEnd')?.value   || '';
        const datasets  = [...state.datasets];
        const indicators = state.indicators;

        /* 1 — Save config to sessionStorage so Creator can pick it up */
        sessionStorage.setItem('initConfig', JSON.stringify({
            pair, interval, start, end,
            datasets, indicators,
        }));

        /* 2 — Switch to Creator tab */
        document.querySelector('[data-panel="creator"]')?.click();

        /* 3 — Set pair in Creator */
        await tick();
        const pairSel = document.getElementById('creatorPair');
        if (pairSel) {
            pairSel.value = pair;
            pairSel.dispatchEvent(new Event('change'));
        }

        /* 4 — Set backtest dates */
        const allDateInputs = document.querySelectorAll('.ctrl-date-inline, .creator-topbar input[type=date]');
        if (allDateInputs.length >= 2) {
            allDateInputs[0].value = start;
            allDateInputs[1].value = end;
        }

        /* 5 — Build enriched prompt */
        const dsLabels = {
            price:     'Kraken OHLCVT price data (open, high, low, close, volume)',
            feargreed: 'Crypto Fear & Greed Index → df[\'fg_value\'] (0-100), df[\'fg_class\']',
            unlocks:   'Token unlock/vesting schedule → unlocks DataFrame',
        };
        const dataDesc = datasets.map(k => `  • ${dsLabels[k] || k}`).join('\n');
        const pairLabel = pair.replace('USD', '');
        const intLabel  = { 60: '1-hour', 240: '4-hour', 1440: 'daily' }[interval] || 'daily';

        const indDesc = indicators.length
            ? '\nPre-computed indicators ready in df:\n' +
              indicators.map(ind => {
                  const lines = { sma: `df['${ind.col}'] — SMA(${ind.period})`,
                      ema: `df['${ind.col}'] — EMA(${ind.period})`,
                      rsi: `df['${ind.col}'] — RSI(${ind.period})`,
                      macd: `df['MACD'], df['MACD_SIGNAL'], df['MACD_HIST'] — MACD(${ind.fast}/${ind.slow}/${ind.signal})`,
                      bbands: `df['BB_UPPER'], df['BB_MID'], df['BB_LOWER'], df['BB_WIDTH'] — BBands(${ind.period},${ind.std})`,
                      atr: `df['${ind.col}'] — ATR(${ind.period})`,
                      stoch: `df['STOCH_K'], df['STOCH_D'] — Stochastic(${ind.k}/${ind.d})`,
                      vwap: `df['VWAP']`,
                      obv: `df['OBV']`,
                      wr: `df['${ind.col}'] — Williams%R(${ind.period})`
                  };
                  return '  • ' + (lines[ind.id] || ind.id);
              }).join('\n')
            : '';

        const enrichedPrompt =
`${prompt}

Context:
  - Pair: ${pairLabel}/USD · Interval: ${intLabel} · Period: ${start} → ${end}
  - Data sources:\n${dataDesc}${indDesc}

IMPORTANT: Use ONLY the exact column names listed above. Do not invent or derive other column names.
Use def strategy(df, unlocks${datasets.includes('feargreed') ? ', fear_greed_df' : ''}):
Return list of trade dicts: entry_time, exit_time, side ('long'/'short'), entry_price, exit_price.`;

        /* 6 — Inject into chat and fire */
        await tick(150);
        const chatInput = document.getElementById('chatInput');
        if (chatInput) {
            chatInput.value = enrichedPrompt;
            chatInput.dispatchEvent(new Event('input'));

            // Attach context to the next /api/chat call via a global
            window._initContext = {
                selected_sources:    datasets,
                selected_indicators: indicators,
            };

            await tick(300);
            document.getElementById('chatSend')?.click();
        }
    }

    function tick(ms = 50) { return new Promise(r => setTimeout(r, ms)); }

    /* ── Boot on tab show ------------------------------------------------------- */
    document.addEventListener('DOMContentLoaded', () => {
        const initTab = document.querySelector('[data-panel="initiator"]');
        initTab?.addEventListener('click', () => {
            if (!state.pairsData.length) init();
        });
        if (document.getElementById('panel-initiator')?.classList.contains('active')) {
            init();
        }
    });

    window.initInitiatorPanel = init;

})();
