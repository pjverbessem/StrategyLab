/* ── initiator.js — Guided strategy creation flow ──────────────────────────── */
'use strict';

(function () {

    /* ── State ----------------------------------------------------------------- */
    const state = {
        pair: 'STRKUSD',
        interval: 1440,
        datasets: new Set(['price']),   // 'price' | 'feargreed' | 'unlocks'
        pairsData: [],
    };

    /* ── Pair colours (matches app.js) ---------------------------------------- */
    const PAIR_COLORS = {
        ARBUSD: '#0891b2',
        OPUSD: '#dc2626',
        STRKUSD: '#7c3aed',
        ZKUSD: '#2563eb',
    };

    /* ── Boot ------------------------------------------------------------------ */
    async function init() {
        await loadPairs();
        wireDataSourceCards();
        wireIntervalButtons();
        wirePromptCounter();
        wireLaunchButton();
        setDefaultDates();
    }

    /* ── Load pairs from API --------------------------------------------------- */
    async function loadPairs() {
        try {
            const data = await fetch('/api/pairs').then(r => r.json());
            const raw = data.pairs || data;
            state.pairsData = raw.map(p => ({
                pair: typeof p === 'string' ? p : (p.pair || String(p)),
                name: typeof p === 'object' ? (p.name || '') : '',
                start: typeof p === 'object' ? (p.start || '') : '',
                end: typeof p === 'object' ? (p.end || '') : '',
                intervals: typeof p === 'object' ? (p.intervals || [1440]) : [1440],
            }));
        } catch (e) {
            state.pairsData = [
                { pair: 'ARBUSD', name: 'Arbitrum', start: '2023-01-01', end: '', intervals: [1440] },
                { pair: 'OPUSD', name: 'Optimism', start: '2023-01-01', end: '', intervals: [1440] },
                { pair: 'STRKUSD', name: 'Starknet', start: '2024-01-01', end: '', intervals: [1440] },
                { pair: 'ZKUSD', name: 'ZKsync', start: '2024-01-01', end: '', intervals: [1440] },
            ];
        }
        renderPairChips();
        setDefaultDates();
    }

    /* ── Pair chips ------------------------------------------------------------ */
    const FEATURED_PAIRS = ['ARBUSD', 'OPUSD', 'STRKUSD', 'ZKUSD'];

    function chipHtml(p) {
        const sym = p.pair.replace('USD', '');
        const color = PAIR_COLORS[p.pair] || '#6366f1';
        const active = p.pair === state.pair;
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

        const featured = state.pairsData.filter(p => FEATURED_PAIRS.includes(p.pair));
        const others = state.pairsData.filter(p => !FEATURED_PAIRS.includes(p.pair));

        wrap.innerHTML =
            `<div class="init-pair-row featured-row">${featured.map(chipHtml).join('')}</div>` +
            (others.length ? `<details class="init-pair-more"><summary>All pairs (${others.length + featured.length} available)</summary><div class="init-pair-row init-pair-row-all">${others.map(chipHtml).join('')}</div></details>` : '');

        wrap.querySelectorAll('.init-pair-chip').forEach(btn => {
            btn.addEventListener('click', () => {
                state.pair = btn.dataset.pair;
                wrap.querySelectorAll('.init-pair-chip').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                setDefaultDates();
            });
        });
    }

    /* ── Default dates from pair data ------------------------------------------ */
    function setDefaultDates() {
        const pd = state.pairsData.find(p => p.pair === state.pair);
        const today = new Date().toISOString().slice(0, 10);

        const startEl = document.getElementById('initStart');
        const endEl = document.getElementById('initEnd');
        if (!startEl || !endEl) return;

        if (pd) {
            startEl.value = pd.start || '2024-01-01';
            endEl.value = pd.end || today;
        } else {
            startEl.value = '2024-01-01';
            endEl.value = today;
        }
    }

    /* ── Data source cards ----------------------------------------------------- */
    function wireDataSourceCards() {
        document.querySelectorAll('.init-ds-card').forEach(card => {
            const cb = card.querySelector('input[type=checkbox]');
            const key = card.dataset.key;

            // Sync initial checked state from HTML
            if (cb.checked) {
                state.datasets.add(key);
                card.classList.add('checked');
            }

            card.addEventListener('click', () => {
                cb.checked = !cb.checked;
                card.classList.toggle('checked', cb.checked);
                if (cb.checked) state.datasets.add(key);
                else state.datasets.delete(key);

                // Price data is required — prevent unchecking
                if (key === 'price' && !cb.checked) {
                    cb.checked = true;
                    card.classList.add('checked');
                    state.datasets.add('price');
                }
            });
        });
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
        const ta = document.getElementById('initPrompt');
        const count = document.getElementById('initCharCount');
        if (!ta || !count) return;
        const MAX = 500;
        ta.addEventListener('input', () => {
            const n = ta.value.length;
            count.textContent = `${n} / ${MAX}`;
            count.classList.toggle('warn', n > MAX * 0.85);
            if (n > MAX) ta.value = ta.value.slice(0, MAX);
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
        if (!prompt) {
            document.getElementById('initPrompt')?.focus();
            return;
        }

        const pair = state.pair;
        const interval = state.interval;
        const start = document.getElementById('initStart')?.value || '';
        const end = document.getElementById('initEnd')?.value || '';
        const datasets = [...state.datasets];

        /* 1 ─ Switch to Creator tab */
        const creatorBtn = document.querySelector('[data-panel="creator"]');
        creatorBtn?.click();

        /* 2 ─ Set the trading pair in the Creator topbar */
        await tick();
        const pairSel = document.getElementById('creatorPair');
        if (pairSel) {
            pairSel.value = pair;
            pairSel.dispatchEvent(new Event('change'));
        }

        /* 3 ─ Set backtest dates */
        const fromEl = document.querySelector('#creatorTopbar [name="fromDate"], #creatorFrom, [id^="creatorStart"]');
        // Use the creator topbar date inputs (data- or id based)
        const allDateInputs = document.querySelectorAll('.ctrl-date-inline, .creator-topbar input[type=date]');
        if (allDateInputs.length >= 2) {
            allDateInputs[0].value = start;
            allDateInputs[1].value = end;
        }

        /* 4 ─ Build the enriched prompt for the AI */
        const dsLabels = {
            price: 'Kraken OHLCVT price data (open, high, low, close, volume)',
            feargreed: 'Crypto Fear & Greed Index (daily, 0–100 scale)',
            unlocks: 'Token unlock / vesting schedule data',
        };
        const dataDesc = datasets.map(k => `  • ${dsLabels[k] || k}`).join('\n');
        const pairLabel = pair.replace('USD', '');
        const intLabel = { 60: '1-hour', 240: '4-hour', 1440: 'daily' }[interval] || 'daily';

        const enrichedPrompt = `${prompt}

Context:
  - Trading pair: ${pairLabel}/USD on Kraken
  - Candle interval: ${intLabel}
  - Backtest period: ${start} → ${end}
  - Available data sources:
${dataDesc}

Please generate a complete Python strategy function using only the data sources listed above.
Use def strategy(df, unlocks${datasets.includes('feargreed') ? ', fear_greed' : ''}):
Return a list of trade dicts with: entry_time, exit_time, side ('long'/'short'), entry_price, exit_price.`;

        /* 5 ─ Inject the prompt into the chat input and fire it */
        await tick(150);
        const chatInput = document.getElementById('chatInput');
        if (chatInput) {
            chatInput.value = enrichedPrompt;
            chatInput.dispatchEvent(new Event('input'));
            // Trigger generation after a beat so the Creator has fully settled
            await tick(300);
            const sendBtn = document.getElementById('chatSend');
            sendBtn?.click();
        }
    }

    function tick(ms = 50) { return new Promise(r => setTimeout(r, ms)); }

    /* ── Run when panel becomes visible --------------------------------------- */
    // Observe tab switches so we can lazy-init if needed
    document.addEventListener('DOMContentLoaded', () => {
        // Wire existing tab switching to also init the initiator
        const initTab = document.querySelector('[data-panel="initiator"]');
        initTab?.addEventListener('click', () => {
            if (!state.pairsData.length) init();
        });

        // If Initiator is the active panel on load, init immediately
        if (document.getElementById('panel-initiator')?.classList.contains('active')) {
            init();
        }
    });

    // Expose reset so library.js / other code can call it
    window.initInitiatorPanel = init;

})();
