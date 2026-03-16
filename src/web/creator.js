/* ── creator.js v2 — AI chat (with vision + code context), backtest runner ─── */

'use strict';

// ── Code version history ──────────────────────────────────────────────────────
const _codeHistory = [];   // array of code strings
let _historyIdx = -1;  // current position

function _historyPush(code) {
    if (!code) return;
    // Don't duplicate consecutive identical entries
    if (_codeHistory[_historyIdx] === code) return;
    // Truncate any forward history when new code arrives
    _codeHistory.splice(_historyIdx + 1);
    _codeHistory.push(code);
    _historyIdx = _codeHistory.length - 1;
    _historyRender();
}

function _historyLoad(idx) {
    if (idx < 0 || idx >= _codeHistory.length) return;
    _historyIdx = idx;
    const code = _codeHistory[idx];
    if (window.creatorEditor) {
        window.creatorEditor.setValue(code);
        window.creatorEditor.clearHistory();
    }
    window._lastStrategyCode = code;
    _historyRender();
}

function _historyRender() {
    const nav = document.getElementById('codeHistoryNav');
    const sep = document.getElementById('codeHistSep');
    const counter = document.getElementById('codeHistCounter');
    const prev = document.getElementById('codeHistPrev');
    const next = document.getElementById('codeHistNext');
    if (!nav) return;
    const total = _codeHistory.length;
    if (total <= 1) {
        nav.style.display = 'none';
        if (sep) sep.style.display = 'none';
        return;
    }
    nav.style.display = 'flex';
    if (sep) sep.style.display = 'block';
    if (counter) counter.textContent = `${_historyIdx + 1} / ${total}`;
    if (prev) prev.disabled = _historyIdx <= 0;
    if (next) next.disabled = _historyIdx >= total - 1;
}

// Wire history buttons (after DOM ready)
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('codeHistPrev')?.addEventListener('click', () => _historyLoad(_historyIdx - 1));
    document.getElementById('codeHistNext')?.addEventListener('click', () => _historyLoad(_historyIdx + 1));
});



// ── Tab switching ─────────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        const panel = document.getElementById('panel-' + btn.dataset.panel);
        if (panel) panel.classList.add('active');
    });
});

// ── Data-point checkbox styling ───────────────────────────────────────────────
document.querySelectorAll('.data-point-item input[type=checkbox]').forEach(cb => {
    cb.closest('.data-point-item').classList.toggle('checked', cb.checked);
    cb.addEventListener('change', () => {
        cb.closest('.data-point-item').classList.toggle('checked', cb.checked);
    });
});

// ── Load pairs into creator pair select ──────────────────────────────────────
async function loadCreatorPairs() {
    const sel = document.getElementById('creatorPair');
    if (!sel) return;
    try {
        const res = await fetch('/api/pairs');
        const data = await res.json();
        const rawPairs = data.pairs || data;
        const pairs = rawPairs.map(p => typeof p === 'string' ? p : (p.pair || p.name || String(p)));
        sel.innerHTML = pairs.map(p => `<option value="${p}">${p}</option>`).join('');
        const to = new Date();
        const from = new Date(to);
        from.setFullYear(from.getFullYear() - 1);
        const fmt = d => d.toISOString().split('T')[0];
        const fromEl = document.getElementById('btFrom');
        const toEl = document.getElementById('btTo');
        if (fromEl) fromEl.value = fmt(from);
        if (toEl) toEl.value = fmt(to);
    } catch (e) {
        sel.innerHTML = '<option value="">Could not load pairs</option>';
    }
}
loadCreatorPairs();

// ── Source & strategy search filter ──────────────────────────────────────────
function wireSearch(inputId, listSelector) {
    const input = document.getElementById(inputId);
    if (!input) return;
    input.addEventListener('input', () => {
        const q = input.value.toLowerCase().trim();
        document.querySelectorAll(listSelector).forEach(card => {
            card.style.display = !q || card.textContent.toLowerCase().includes(q) ? '' : 'none';
        });
    });
}
wireSearch('sourceSearch', '#sourceList .source-card');


function switchToPanel(name) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    document.querySelector(`[data-panel="${name}"]`)?.classList.add('active');
    document.getElementById(`panel-${name}`)?.classList.add('active');
}

// ── Chat output tabs ──────────────────────────────────────────────────────────
document.querySelectorAll('.out-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        const key = tab.dataset.out;
        document.querySelectorAll('.out-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.output-pane').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('out-' + key)?.classList.add('active');
    });
});

// ══════════════════════════════════════════════════════════════════════════════
// ── IMAGE UPLOAD ─────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

let _pendingImageBase64 = null;
let _pendingImageMime = 'image/jpeg';

const attachBtn = document.getElementById('attachImageBtn');
const imageInput = document.getElementById('imageUploadInput');
const previewBar = document.getElementById('imagePreviewBar');
const previewThumb = document.getElementById('imagePreviewThumb');
const previewName = document.getElementById('imagePreviewName');
const removeImageBtn = document.getElementById('removeImageBtn');

attachBtn?.addEventListener('click', () => imageInput?.click());
removeImageBtn?.addEventListener('click', clearImage);

imageInput?.addEventListener('change', e => {
    const file = e.target.files[0];
    if (file) loadImageFile(file);
    imageInput.value = '';  // reset so same file can be re-selected
});

// Drag-and-drop onto the chat area
const chatCol = document.querySelector('.col-chat');
chatCol?.addEventListener('dragover', e => { e.preventDefault(); chatCol.classList.add('drag-over'); });
chatCol?.addEventListener('dragleave', () => chatCol.classList.remove('drag-over'));
chatCol?.addEventListener('drop', e => {
    e.preventDefault();
    chatCol.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) loadImageFile(file);
});

// Paste image support
document.addEventListener('paste', e => {
    const items = e.clipboardData?.items;
    for (const item of (items || [])) {
        if (item.type.startsWith('image/')) {
            const file = item.getAsFile();
            if (file) { loadImageFile(file); break; }
        }
    }
});

function loadImageFile(file) {
    _pendingImageMime = file.type || 'image/jpeg';
    const reader = new FileReader();
    reader.onload = ev => {
        const dataUrl = ev.target.result;
        const b64 = dataUrl.split(',')[1];
        _pendingImageBase64 = b64;
        previewThumb.src = dataUrl;
        previewName.textContent = file.name;
        previewBar.style.display = 'block';
        attachBtn.classList.add('active');
    };
    reader.readAsDataURL(file);
}

function clearImage() {
    _pendingImageBase64 = null;
    previewBar.style.display = 'none';
    previewThumb.src = '';
    attachBtn.classList.remove('active');
}

// ══════════════════════════════════════════════════════════════════════════════
// ── AI CHAT ──────────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

const chatInput = document.getElementById('chatInput');
const chatSend = document.getElementById('chatSend');
const chatMessages = document.getElementById('chatMessages');
const chatOutput = document.getElementById('chatOutput');

const chatHistory = [];  // [{role:"user"|"model", text:"..."}]

function appendMsg(role, html) {
    const avatarHTML = `<div class="chat-avatar ${role === 'user' ? '' : 'ai'}">${role === 'user' ? 'Me' : 'AI'}</div>`;
    const div = document.createElement('div');
    div.className = `chat-msg ${role}`;
    if (role === 'user') {
        div.innerHTML = `<div class="chat-bubble">${html}</div>${avatarHTML}`;
    } else {
        div.innerHTML = `${avatarHTML}<div class="chat-bubble">${html}</div>`;
    }
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    return div;
}

function showThinking() {
    const div = document.createElement('div');
    div.className = 'chat-msg assistant'; div.id = 'thinkingMsg';
    div.innerHTML = `<div class="chat-avatar ai">AI</div>
    <div class="chat-thinking">
      <div class="thinking-dot"></div>
      <div class="thinking-dot"></div>
      <div class="thinking-dot"></div>
    </div>`;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}
function hideThinking() { document.getElementById('thinkingMsg')?.remove(); }

function getDataContext() {
    const pair = document.getElementById('creatorPair')?.value || 'selected pair';
    const checked = [...document.querySelectorAll('.data-point-item input:checked')].map(cb => cb.dataset.type);
    const from = document.getElementById('btFrom')?.value;
    const to = document.getElementById('btTo')?.value;
    const capital = document.getElementById('btCapital')?.value;
    const interval = document.getElementById('btInterval')?.value;
    return `Pair: ${pair}. Data sources: ${checked.join(', ')}. Period: ${from} to ${to}. Interval: ${interval}. Capital: $${capital}.`;
}

function buildSystemPrompt(context, userMsg) {
    // Detect if this strategy should use the fear_greed argument
    const useFearGreed = /fear.?greed|fear_greed|fgi|sentiment index/i.test(userMsg || '');

    const sig = useFearGreed
        ? 'def strategy(df, unlocks, fear_greed):'
        : 'def strategy(df, unlocks):';

    const dfCols = useFearGreed
        ? `  df columns: time (unix int), open, high, low, close, volume,
             date (str YYYY-MM-DD), fg_value (int 0-100), fg_class (str)
             NOTE: fg_value and fg_class are ALREADY merged onto df — do NOT try to merge them again.
             Just use df['fg_value'].iloc[i] directly.`
        : `  df columns: time (unix int), open, high, low, close, volume`;

    const argDocs = useFearGreed
        ? `  df         — pandas DataFrame (see columns above)
  unlocks    — pandas DataFrame with token unlock events (may be empty)
  fear_greed — IGNORE THIS ARGUMENT. fg_value is already in df. Do not use fear_greed directly.`
        : `  df       — pandas DataFrame with columns: time (unix timestamp int), open, high, low, close, volume
  unlocks  — pandas DataFrame with token unlock events (may be empty)`;

    const fgCondition = useFearGreed
        ? `        if df['fg_value'].iloc[i] < fgi_threshold and current_rsi < rsi_threshold:`
        : `        if current_rsi < rsi_threshold:`;

    const fgMergeExample = useFearGreed
        ? `    fgi_threshold = 30   # entry when Fear & Greed index is below this\n`
        : '';

    return `You are an expert quantitative trading strategy builder integrated into a crypto backtesting platform.
The user has selected: ${context}

═══════════════════════════════════════════════════════
CRITICAL OUTPUT FORMAT — YOU MUST FOLLOW THIS EXACTLY
═══════════════════════════════════════════════════════

Respond using EXACTLY these four labelled sections:

[Algorithm]
A clear 3-5 sentence plain-English explanation of the trading logic.

[Workflow JSON]
A JSON object representing the strategy as structured IF/THEN rules. Use this schema:
{
  "version": 1,
  "name": "Strategy Name",
  "rules": [{
    "id": "rule-1",
    "enabled": true,
    "entry": {
      "logic": "AND",
      "conditions": [{
        "id": "c1",
        "left": { "indicator": "rsi", "params": { "period": 14 } },
        "op": "<",
        "right": { "type": "value", "value": 30 }
      }]
    },
    "action": "BUY (long)",
    "exit": {
      "logic": "OR",
      "conditions": [{
        "id": "e1",
        "type": "rsi_overbought",
        "params": { "period": 14, "threshold": 70 }
      }]
    }
  }]
}
Indicators: price, sma, ema, rsi, macd, bbands, volume, fg (Fear&Greed), pct_change
Ops: >, <, >=, <=, ==, crosses above, crosses below
Actions: BUY (long), SELL (short), CLOSE
Exit types: rsi_overbought, rsi_oversold, take_profit, stop_loss, bars_held, crosses_back
Wrap the JSON in \`\`\`json ... \`\`\` fences.

[Python Code]
A COMPLETE, FULLY-IMPLEMENTED Python function. NOT a skeleton. NOT a stub. REAL working code.

[Parameters]
Key tunable parameters with defaults and recommended ranges.

═══════════════════════════════════════════════════════
PYTHON CODE RULES — READ CAREFULLY
═══════════════════════════════════════════════════════

The function MUST have this exact signature:
  ${sig}

Arguments:
${argDocs}

Return value: a Python LIST of dicts, each dict MUST have:
  entry        — unix timestamp (int) when trade opens
  exit         — unix timestamp (int) when trade closes
  side         — 'long' or 'short'
  entry_price  — float, the price at entry
  exit_price   — float, the price at exit

ABSOLUTE RULES (violating any of these breaks the backtest):
1. NEVER return a DataFrame, Series, or signal column. Return a list of dicts.
2. WRITE ALL indicator logic yourself using pandas/numpy. Do NOT leave "# your logic here" comments.
3. Every line of code must be real, working Python. ZERO placeholders like "# ..." or "pass".
4. The function MUST end with "return trades".
5. Handle edge cases: check df has enough rows (len(df) > period) before computing indicators.
6. Use df['time'].iloc[i] for entry/exit timestamps. Use df['close'].iloc[i] for prices.
7. Available libraries (already imported in the execution environment):
   - pandas as pd
   - numpy as np
   - ta.momentum.RSIIndicator, ta.trend.MACD, ta.volatility.BollingerBands, ta.trend.EMAIndicator

═══════════════════════════════════════════════════════
REFERENCE EXAMPLE — RSI MEAN REVERSION STRATEGY
═══════════════════════════════════════════════════════

[Python Code]
\`\`\`python
${sig}
    trades = []
    rsi_period = 14
    oversold = 30
    overbought = 70
    hold_bars = 5

    if len(df) < rsi_period + 2:
        return trades
${fgMergeExample}
    from ta.momentum import RSIIndicator
    rsi = RSIIndicator(close=df['close'], window=rsi_period).rsi()

    i = rsi_period
    while i < len(df) - hold_bars - 1:
        current_rsi = rsi.iloc[i]
${fgCondition}
            entry_i = i
            exit_i  = min(i + hold_bars, len(df) - 1)
            trades.append({
                'entry':       int(df['time'].iloc[entry_i]),
                'exit':        int(df['time'].iloc[exit_i]),
                'side':        'long',
                'entry_price': float(df['close'].iloc[entry_i]),
                'exit_price':  float(df['close'].iloc[exit_i]),
            })
            i = exit_i + 1
        elif current_rsi > overbought:
            entry_i = i
            exit_i  = min(i + hold_bars, len(df) - 1)
            trades.append({
                'entry':       int(df['time'].iloc[entry_i]),
                'exit':        int(df['time'].iloc[exit_i]),
                'side':        'short',
                'entry_price': float(df['close'].iloc[entry_i]),
                'exit_price':  float(df['close'].iloc[exit_i]),
            })
            i = exit_i + 1
        else:
            i += 1

    return trades
\`\`\`

═══════════════════════════════════════════════════════
NOW GENERATE THE STRATEGY REQUESTED BY THE USER
═══════════════════════════════════════════════════════

Write the FULL, COMPLETE implementation — every indicator calculation, every loop, every condition.
Your code will be executed directly in a Python sandbox. It must run without errors.
Do NOT use markdown headers (###) — only use [Algorithm], [Workflow JSON], [Python Code], [Parameters] labels.`;
}

// Refinement prompt — for follow-up messages when code already exists
function buildRefinementPrompt(context, userMsg) {
    const useFearGreed = /fear.?greed|fear_greed|fgi|sentiment index/i.test(userMsg || '');
    const sig = useFearGreed ? 'def strategy(df, unlocks, fear_greed):' : 'def strategy(df, unlocks):';
    const lines = [
        'You are an expert quantitative trading strategy builder.',
        'The user is REFINING an existing strategy - they want a specific change, NOT a brand-new strategy.',
        '',
        'Context: ' + context,
        '',
        'RESPOND WITH EXACTLY THESE THREE SECTIONS:',
        '',
        '[Algorithm]',
        'In 2-3 sentences, describe ONLY what changed vs the previous version. Do NOT re-explain the full strategy.',
        '',
        '[Python Code]',
        'The COMPLETE, fully-working updated ' + sig + ' function with the requested change applied.',
        'Every line must be real Python - no placeholders, no "# ...", no pass.',
        'Function must end with "return trades".',
        'Available: pandas as pd, numpy as np, ta.momentum.RSIIndicator, ta.trend.MACD, ta.volatility.BollingerBands, ta.trend.EMAIndicator',
        'Trade dicts: entry (unix int), exit (unix int), side, entry_price, exit_price.',
        '',
        '[Parameters]',
        'Only list parameters that changed or were added. Keep brief.',
        '',
        'Do NOT use markdown headers (###) - only [Algorithm], [Python Code], [Parameters] labels.',
    ];
    return lines.join('\n');
}

async function sendChat() {
    const msg = chatInput.value.trim();
    if (!msg && !_pendingImageBase64) return;

    const displayMsg = msg || '(chart image attached)';
    chatInput.value = '';
    chatSend.disabled = true;

    const hasImage = !!_pendingImageBase64;
    const imageB64 = _pendingImageBase64;
    const imageMime = _pendingImageMime;

    // Show user message with image indicator
    appendMsg('user', `${ msg.replace(/</g, '&lt;').replace(/>/g, '&gt;') }${ hasImage ? ' <span style="opacity:.7;font-size:11px">📷 chart attached</span>' : '' } `);
    if (hasImage) clearImage();
    showThinking();

    const context = getDataContext();
    const isFollowUp = chatHistory.length >= 2 && !!window._lastStrategyCode;
    const systemPrompt = isFollowUp
        ? buildRefinementPrompt(context, msg)
        : buildSystemPrompt(context, msg);
    const currentCode = window._lastStrategyCode || '';

    try {
        let res, data;

        if (hasImage && imageB64) {
            // Vision endpoint
            res = await fetch('/api/chat-vision', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: msg || 'Analyze this chart and create a trading strategy based on the patterns you see.',
                    image_base64: imageB64,
                    mime_type: imageMime,
                    system: systemPrompt,
                    current_code: currentCode,
                })
            });
        } else {
            // Text chat endpoint
            res = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: msg,
                    system: systemPrompt,
                    history: chatHistory,
                    current_code: currentCode,
                })
            });
        }

        hideThinking();
        if (!res.ok) throw new Error(`Server error ${ res.status } `);
        data = await res.json();

        if (data.error && !data.reply) {
            appendMsg('assistant', `< span style = "color:var(--neg)" >⚠️ ${ data.error }</span > `);
            chatSend.disabled = false;
            return;
        }

        const reply = data.reply || '';
        chatHistory.push({ role: 'user', text: displayMsg });
        chatHistory.push({ role: 'model', text: reply });
        if (chatHistory.length > 20) chatHistory.splice(0, 2);

        // Parse sections — normalise [Label], ## Label, and **Label** variants to [Label]
        const normalised = reply
            .replace(/^\s*\*{1,2}\s*(Algorithm|Python Code|Parameters)\s*\*{0,2}\s*:?\s*$/gim, '[$1]')
            .replace(/^\s*#{1,3}\s*(Algorithm|Python Code|Parameters)\s*:?\s*$/gim, '[$1]');

        console.log('[AI reply] length:', reply.length, '\nfirst 300:', reply.slice(0, 300));

        // Section boundaries: walk through all [Label] occurrences in order
        const sectionRe = /\[(Algorithm|Workflow JSON|Python Code|Parameters)\]/gi;
        const sections = {};
        let m2, lastKey = null, lastIdx = 0;
        sectionRe.lastIndex = 0;
        while ((m2 = sectionRe.exec(normalised)) !== null) {
            if (lastKey) sections[lastKey] = normalised.slice(lastIdx, m2.index).trim();
            lastKey = m2[1].toLowerCase().replace(/ /g, '_');  // replace ALL spaces
            lastIdx = m2.index + m2[0].length;
        }
        if (lastKey) sections[lastKey] = normalised.slice(lastIdx).trim();

        console.log('[sections found]', Object.keys(sections), '\npython_code length:', (sections['python_code'] || '').length);

        const algoText = sections['algorithm'] || reply;
        let rawCode = sections['python_code'] || '';
        const paramText = sections['parameters'] || '';

        // Strip code fences — handle ```python, ```py, ```(with or without lang tag)
    function extractCode(raw) {
        const fenceOpen = raw.indexOf('```');
        if (fenceOpen === -1) return raw.trim();
        // skip the opening fence line (e.g. ```python)
        const afterOpen = raw.indexOf('\n', fenceOpen);
        if (afterOpen === -1) return raw.slice(fenceOpen + 3).trim();
        const body = raw.slice(afterOpen + 1);
        const lastFence = body.lastIndexOf('\n```');
        return (lastFence !== -1 ? body.slice(0, lastFence) : body).trim();
    }
    rawCode = extractCode(rawCode);

    console.log('[rawCode after extractCode] length:', rawCode.length, rawCode.slice(0, 100));

    // Fallback 1: scan entire reply for a fenced code block containing def strategy
    if (!rawCode) {
        const wholeMatch = normalised.match(/```(?:python)?\n([\s\S]+?def strategy[\s\S]+?)\n```/);
        if (wholeMatch) { rawCode = wholeMatch[1].trim(); console.log('[fallback1 hit]'); }
    }
    // Fallback 2: extract the raw def strategy...return trades block without fences
    if (!rawCode) {
        const defMatch = normalised.match(/(def strategy\([\s\S]+?return trades)/);
        if (defMatch) { rawCode = defMatch[1].trim(); console.log('[fallback2 hit]'); }
    }

    const renderText = t => t
        .replace(/#{1,3}\s*/g, '')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\n/g, '<br>');

    appendMsg('assistant', renderText(algoText));

    // ── Populate right column (col-code) ──────────────────────
    const emptyState = document.getElementById('codeEmptyState');
    if (emptyState) emptyState.style.display = 'none';

    // Algorithm section
    const secAlgo = document.getElementById('code-section-algo');
    const outAlgo = document.getElementById('out-algo');
    if (secAlgo && outAlgo) {
        outAlgo.innerHTML = `<p>${renderText(algoText)}</p>`;
        secAlgo.style.display = 'block';
    }

    // Python code section — populate editor and hidden pre
    const secPy = document.getElementById('code-section-py');
    const codeBlock = document.getElementById('codeBlock');
    if (secPy) {
        // Prefer the CodeMirror editor; fallback to pre
        if (window.creatorEditor) {
            window.creatorEditor.setValue(rawCode || '');
            window.creatorEditor.clearHistory();
        } else if (codeBlock) {
            codeBlock.textContent = rawCode || '# No code generated yet';
        }
        secPy.style.display = rawCode ? 'block' : 'none';
    }

    // Parameters section
    const secParams = document.getElementById('code-section-params');
    const outParams = document.getElementById('out-params');
    if (secParams && outParams) {
        outParams.innerHTML = paramText
            ? `<p>${renderText(paramText)}</p>`
            : '<p style="color:var(--t3)">No parameters listed.</p>';
        secParams.style.display = 'block';
    }

    window._lastStrategyCode = rawCode;
    window._lastStrategyAlgo = algoText;
    window._lastStrategyParams = paramText;
    if (rawCode) _historyPush(rawCode);  // track in version history

    // Parse and load workflow JSON from AI response
    const wfRaw = sections['workflow_json'] || '';
    if (wfRaw && window.parseWorkflowFromAI) {
        const wfJSON = window.parseWorkflowFromAI(wfRaw);
        if (wfJSON) {
            window._lastWorkflowJSON = wfJSON;
            window._workflowBuilder?.load(wfJSON);
            // Auto-switch to workflow view
            document.getElementById('view-wf-btn')?.click();
        }
    }

    // Notify CodeMirror editor (in case it initialised after this)
    window.dispatchEvent(new Event('strategyGenerated'));

    // Update topbar name pill → unsaved
    window.setStrategyName?.('Unsaved Strategy', false);
    const topbarSaveBtn = document.getElementById('saveStratTopbarBtn');
    if (topbarSaveBtn && rawCode) topbarSaveBtn.style.display = 'flex';

    // Show save button in code column header
    const saveBtn = document.getElementById('saveChatStratBtn');
    if (saveBtn && rawCode) saveBtn.style.display = 'flex';

} catch (err) {
    hideThinking();
    appendMsg('assistant', `<span style="color:var(--neg)">Error: ${err.message}. Please try again.</span>`);
}
chatSend.disabled = false;
}

chatSend?.addEventListener('click', sendChat);
chatInput?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendChat(); }
});

// ── Regen button — rewrite bad/skeleton code ──────────────────────────────────
document.getElementById('regenCodeBtn')?.addEventListener('click', () => {
    const pair = document.getElementById('creatorPair')?.value || 'the selected pair';
    const from = document.getElementById('btFrom')?.value;
    const to = document.getElementById('btTo')?.value;
    const regenMsg =
        `The current strategy code is incomplete or a skeleton. ` +
        `Please write a COMPLETE, FULLY-WORKING implementation of the strategy() function ` +
        `for ${pair} (${from} to ${to}). ` +
        `Include ALL indicator calculations, entry/exit logic, and trade construction. ` +
        `Do NOT use any placeholders or "# ..." comments — every line must be real Python code.`;
    const input = document.getElementById('chatInput');
    if (input) { input.value = regenMsg; sendChat(); }
});

// ── Save Strategy Modal — Cancel / Close / Submit ─────────────────────────────
// (Opening this modal is handled by library.js wireTopbar for both buttons)
const saveModal = document.getElementById('saveStratModal');
const saveModalSave = document.getElementById('saveModalSave');
const saveModalCancel = document.getElementById('saveModalCancel');
const saveModalClose = document.getElementById('saveModalClose');

saveModalCancel?.addEventListener('click', () => saveModal.style.display = 'none');
saveModalClose?.addEventListener('click', () => saveModal.style.display = 'none');
saveModal?.addEventListener('click', e => { if (e.target === saveModal) saveModal.style.display = 'none'; });

saveModalSave?.addEventListener('click', async () => {
    const name = document.getElementById('saveStratName').value.trim();
    if (!name) { showToast('Please enter a strategy name'); return; }

    const code = window._lastStrategyCode || '';
    const algo = window._lastStrategyAlgo || '';
    const params = window._lastStrategyParams || '';
    const pair = document.getElementById('creatorPair')?.value || '';
    const tags = document.getElementById('saveStratTags').value
        .split(',').map(t => t.trim()).filter(Boolean);
    const desc = document.getElementById('saveStratDesc').value.trim();

    if (!code) { showToast('No strategy code to save — generate one first'); return; }

    saveModalSave.disabled = true;
    saveModalSave.textContent = 'Saving…';
    try {
        const res = await fetch('/api/strategies', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, description: desc, code, algo, params_text: params, pair, tags })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        saveModal.style.display = 'none';
        showToast(`✓ Strategy "${name}" saved to Library!`);
        window.setStrategyName?.(name, true);
        const topbarSaveBtn = document.getElementById('saveStratTopbarBtn');
        if (topbarSaveBtn) topbarSaveBtn.style.display = 'flex';
        window.loadLibrary?.();
        window.refreshBotStrategies?.();
    } catch (e) {
        showToast('Save failed: ' + e.message);
    } finally {
        saveModalSave.disabled = false;
        saveModalSave.textContent = 'Save Strategy';
    }
});

// ══════════════════════════════════════════════════════════════════════════════
// ── RUN BACKTEST (from Creator) ───────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

let resultChart = null;

document.getElementById('runBacktestBtn')?.addEventListener('click', async () => {
    const pair = document.getElementById('creatorPair')?.value;
    const start = document.getElementById('btFrom')?.value;
    const end = document.getElementById('btTo')?.value;
    const script = window._lastStrategyCode || '';

    const intervalLabel = document.getElementById('btInterval')?.value || '1D';
    const intervalMap = { '1m': 1, '5m': 5, '15m': 15, '1h': 60, '4h': 240, '1D': 1440 };
    const interval = intervalMap[intervalLabel] ?? 1440;

    if (!pair) { showToast('Select a pair first'); return; }
    if (!script) { showToast('Generate a strategy first — ask the AI in the chat'); return; }

    // Show spinner in the large price chart zone
    const priceChartWrap = document.getElementById('priceChartWrap');
    const priceChartEl = document.getElementById('priceChart');
    const priceEmpty = document.getElementById('chartEmptyState');
    if (priceEmpty) priceEmpty.style.display = 'none';
    if (priceChartWrap) priceChartWrap.style.display = 'block';
    const chartEl = priceChartEl; // keep alias for error handler below
    if (chartEl) chartEl.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;"><div class="spinner"></div></div>';


    try {
        const res = await fetch('/api/backtest', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pair, start, end, interval, script })
        });
        const data = await res.json();

        if (data.error) {
            const isZeroTrades = data.error.includes('0 trades');
            const color = isZeroTrades ? 'var(--amber)' : 'var(--neg)';
            const icon = isZeroTrades ? '⚠️' : '❌';
            const hint = isZeroTrades
                ? `The strategy ran but found no signals for <strong>${pair}</strong> between ${start} and ${end}.<br><br>
                   Try loosening the entry conditions, or click below to ask the AI to fix it.`
                : `<pre style="text-align:left;font-size:10px;overflow-x:auto;white-space:pre-wrap">${data.error}</pre>`;

            chartEl.innerHTML = `
                <div style="padding:20px;text-align:center;font-size:12px;line-height:1.7;color:${color}">
                    <div style="font-size:22px;margin-bottom:8px">${icon}</div>
                    ${hint}
                    ${isZeroTrades ? `<button onclick="autoFixStrategy()" style="margin-top:12px;padding:7px 18px;background:var(--amber);border:none;border-radius:6px;color:#fff;font-size:12px;font-weight:600;cursor:pointer">Ask AI to fix →</button>` : ''}
                </div>`;
            return;
        }

        // Store stats for potential save
        window._lastBacktestStats = data.stats || {};

        // Auto-switch to Overview tab
        document.querySelectorAll('.bt-tab').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.bt-tab-panel').forEach(p => p.classList.remove('active'));
        document.getElementById('bttab-overview')?.classList.add('active');
        document.getElementById('bt-panel-overview')?.classList.add('active');

        const trades = data.trades || [];

        // 1. Large price chart (middle zone) — candles + arrows
        renderPriceChart(data);

        // 2. Equity curve (inside Overview tab)
        const equityEmpty = document.getElementById('equityEmptyState');
        const equityWrap = document.getElementById('resultChartWrap');
        if (data.equity?.length) {
            if (equityEmpty) equityEmpty.style.display = 'none';
            if (equityWrap) { equityWrap.style.display = 'block'; }
            renderResultChart(data, document.getElementById('resultChart'), pair);
        }

        // 3. Metrics, trades, monthly, performance
        renderMetrics(data.stats || {}, trades);
        renderTradeRegister(data);
        renderMonthlyTable(trades);
        renderPerformance(data.stats || {}, trades);

        const n = trades.length;
        document.getElementById('btStatusLabel').textContent =
            `${n} trade${n !== 1 ? 's' : ''} · ${pair} · ${start} → ${end}`;

    } catch (err) {
        chartEl.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--neg);font-size:12px;padding:16px;text-align:center;">${err.message}</div>`;
        showToast('Backtest failed — see results panel');
    }
});

function autoFixStrategy() {
    const pair = document.getElementById('creatorPair')?.value || 'the selected pair';
    const from = document.getElementById('btFrom')?.value;
    const to = document.getElementById('btTo')?.value;
    const fixMsg = `The strategy returned 0 trades for ${pair} from ${from} to ${to}. ` +
        `Please rewrite the strategy with looser entry conditions so it generates more signals. ` +
        `Keep the same overall logic but relax the thresholds.`;
    const input = document.getElementById('chatInput');
    if (input) { input.value = fixMsg; input.focus(); }
}

// ── Backtest tab switching ────────────────────────────────────────────────────
document.querySelectorAll('.bt-tab').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.bt-tab').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.bt-tab-panel').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        const panel = document.getElementById(`bt-panel-${btn.dataset.btTab}`);
        if (panel) panel.classList.add('active');
    });
});

function renderResultChart(data, el, pair) {
    el.innerHTML = '';
    if (!window.LightweightCharts) {
        el.innerHTML = '<p style="padding:16px;color:var(--t3);font-size:12px">Chart library not loaded</p>';
        return;
    }
    const chart = LightweightCharts.createChart(el, {
        layout: { background: { color: 'transparent' }, textColor: '#52525b' },
        grid: { vertLines: { color: 'rgba(255,255,255,.04)' }, horzLines: { color: 'rgba(255,255,255,.04)' } },
        crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
        rightPriceScale: { borderColor: 'rgba(255,255,255,.08)', scaleMargins: { top: 0.1, bottom: 0.1 } },
        timeScale: { borderColor: 'rgba(255,255,255,.08)', timeVisible: true },
        handleScroll: true, handleScale: true,
    });

    if (data.equity?.length) {
        const totalRet = data.stats?.total_return ?? 0;
        const lineColor = totalRet >= 0 ? '#22c55e' : '#ef4444';
        const series = chart.addAreaSeries({
            lineColor,
            topColor: totalRet >= 0 ? 'rgba(34,197,94,.22)' : 'rgba(239,68,68,.18)',
            bottomColor: 'rgba(0,0,0,0)',
            lineWidth: 2,
            title: pair + ' Equity',
        });
        series.setData(data.equity);
    }
    chart.timeScale().fitContent();

    if (typeof ResizeObserver !== 'undefined') {
        new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth })).observe(el);
    }
}

function renderMetrics(stats, trades) {
    const fmt = (v, suffix = '') => v != null ? (v >= 0 ? '+' : '') + Number(v).toFixed(2) + suffix : '—';
    const fmtN = v => v != null ? Number(v).toFixed(2) : '—';

    // Fill .bt-ov-value tiles (TradingView style)
    const setOV = (id, val, cls) => {
        const el = document.getElementById(id); if (!el) return;
        el.textContent = val;
        el.className = 'bt-ov-value' + (cls ? ' ' + cls : '');
    };
    const setSub = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    const setBar = (id, pct) => { const el = document.getElementById(id); if (el) el.style.width = Math.min(100, Math.abs(pct || 0)) + '%'; };

    const ret = stats.total_return;
    const wr = stats.win_rate;
    const dd = Math.abs(stats.max_drawdown || 0);
    const winCount = stats.winning_trades ?? (trades ? trades.filter(t => t.return_pct > 0).length : null);
    const lossCount = stats.losing_trades ?? (trades ? trades.filter(t => t.return_pct <= 0).length : null);

    setOV('m-return', fmt(ret, '%'), ret >= 0 ? 'pos' : 'neg');
    setSub('m-return-sub', 'Net return on equity');
    setOV('m-drawdown', '-' + dd.toFixed(2) + '%', 'neg');
    setBar('m-drawdown-bar', dd);
    setOV('m-sharpe', fmtN(stats.profit_factor));
    const avgTrade = stats.total_trades ? (ret / stats.total_trades) : null;
    setSub('m-avgtrade-sub', avgTrade != null ? `Avg ${fmt(avgTrade, '%')} per trade` : '');
    setOV('m-trades', stats.total_trades != null ? String(stats.total_trades) : '—');
    const elWon = document.getElementById('m-winning-trades');
    const elLost = document.getElementById('m-losing-trades');
    if (elWon) elWon.textContent = winCount != null ? String(winCount) : '—';
    if (elLost) elLost.textContent = lossCount != null ? String(lossCount) : '—';
    setOV('m-winrate', wr != null ? Number(wr).toFixed(1) + '%' : '—');
    setBar('m-winrate-bar', wr);
}

// renderPriceChart — main large candlestick chart with trade entry/exit markers
// This IS TradingView's primary chart view: price candles + arrows
function renderPriceChart(data) {
    const emptyEl = document.getElementById('chartEmptyState');
    const wrapEl = document.getElementById('priceChartWrap');
    const chartEl = document.getElementById('priceChart');
    if (!chartEl) return;

    const trades = data.trades || [];
    const hasData = trades.length > 0 && window.LightweightCharts && data.ohlcv?.length;

    if (emptyEl) emptyEl.style.display = hasData ? 'none' : 'flex';
    if (wrapEl) wrapEl.style.display = hasData ? 'block' : 'none';
    if (!hasData) return;

    chartEl.innerHTML = '';
    const chart = LightweightCharts.createChart(chartEl, {
        layout: { background: { color: 'transparent' }, textColor: '#52525b' },
        grid: { vertLines: { color: 'rgba(255,255,255,.03)' }, horzLines: { color: 'rgba(255,255,255,.03)' } },
        crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
        rightPriceScale: { borderColor: 'rgba(255,255,255,.08)', scaleMargins: { top: 0.05, bottom: 0.05 } },
        timeScale: { borderColor: 'rgba(255,255,255,.08)', timeVisible: true, secondsVisible: false },
        handleScroll: true, handleScale: true,
        width: chartEl.clientWidth, height: chartEl.clientHeight || 200,
    });

    const candles = chart.addCandlestickSeries({
        upColor: '#16a34a', downColor: '#dc2626', borderVisible: false,
        wickUpColor: '#16a34a', wickDownColor: '#dc2626',
    });
    candles.setData(data.ohlcv.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })));

    const markers = [];
    for (const t of trades) {
        const isShort = t.side === 'short';
        const pnlTxt = (t.return_pct >= 0 ? '+' : '') + Number(t.return_pct).toFixed(1) + '%';
        markers.push({
            time: t.entry, position: isShort ? 'aboveBar' : 'belowBar',
            color: isShort ? '#dc2626' : '#16a34a', shape: isShort ? 'arrowDown' : 'arrowUp',
            text: isShort ? 'Short' : 'Long', size: 1
        });
        markers.push({
            time: t.exit, position: isShort ? 'belowBar' : 'aboveBar',
            color: t.return_pct >= 0 ? '#16a34a' : '#dc2626', shape: isShort ? 'arrowUp' : 'arrowDown',
            text: pnlTxt, size: 1
        });
    }
    markers.sort((a, b) => a.time - b.time);
    candles.setMarkers(markers);
    chart.timeScale().fitContent();

    if (typeof ResizeObserver !== 'undefined') {
        new ResizeObserver(() => chart.applyOptions({ width: chartEl.clientWidth, height: chartEl.clientHeight || 200 })).observe(chartEl);
    }
}
// Alias for backward compat
function renderTradeChart(data) { renderPriceChart(data); }

function renderTradeRegister(data) {
    const tbody = document.getElementById('tradeRegister');
    const badge = document.getElementById('tradeCount');
    if (!tbody) return;

    const trades = data.trades || [];
    if (badge) badge.textContent = trades.length || '';

    if (!trades.length) {
        tbody.innerHTML = '<tr><td colspan="9" class="bt-register-empty">No trades executed</td></tr>';
        return;
    }

    const fmtDate = ts => ts ? new Date(ts * 1000).toLocaleString('en-GB', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: false
    }) : '—';
    const fmtPrice = p => p != null ? (p < 1 ? p.toFixed(4) : p.toFixed(2)) : '—';
    const fmtPct = v => v != null ? (v >= 0 ? '+' : '') + Number(v).toFixed(2) + '%' : '—';

    let cum = 0;
    tbody.innerHTML = trades.map((t, i) => {
        const pnl = t.return_pct ?? 0;
        const pnlCls = pnl >= 0 ? 'pos' : 'neg';
        const sideCls = t.side === 'long' ? 'long' : 'short';
        cum += pnl;
        const cumCls = cum >= 0 ? 'pos' : 'neg';
        const cumStr = (cum >= 0 ? '+' : '') + cum.toFixed(2) + '%';
        // Run-up = profit if positive (max favorable), Drawdown = loss if negative
        const runUp = pnl > 0 ? fmtPct(pnl) : '—';
        const drawDn = pnl < 0 ? fmtPct(pnl) : '—';
        return `<tr>
            <td style="color:var(--t3)">${i + 1}</td>
            <td>${fmtDate(t.entry)}</td>
            <td><span class="bt-cell-side ${sideCls}">${t.side === 'long' ? 'Entry Long' : 'Entry Short'}</span></td>
            <td>${fmtPrice(t.entry_price)}</td>
            <td>${fmtPrice(t.exit_price)}</td>
            <td class="bt-cell-pnl ${pnlCls}">${fmtPct(pnl)}</td>
            <td class="bt-cell-pnl ${cumCls}">${cumStr}</td>
            <td class="pos">${runUp}</td>
            <td class="neg">${drawDn}</td>
        </tr>`;
    }).join('');
}

function renderMonthlyTable(trades) {
    const el = document.getElementById('monthlyTable');
    if (!el) return;
    if (!trades?.length) { el.innerHTML = '<div class="bt-monthly-empty">No trades</div>'; return; }

    // Group return_pct by year-month
    const map = {};
    for (const t of trades) {
        if (!t.exit || t.return_pct == null) continue;
        const d = new Date(t.exit * 1000);
        const yr = d.getUTCFullYear();
        const mo = d.getUTCMonth(); // 0-11
        if (!map[yr]) map[yr] = {};
        map[yr][mo] = (map[yr][mo] || 0) + t.return_pct;
    }

    const years = Object.keys(map).sort();
    const MONTHS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];

    function heatClass(v) {
        if (v == null) return '';
        if (v === 0) return 'zero';
        const abs = Math.abs(v);
        const lvl = abs > 10 ? 3 : abs > 4 ? 2 : 1;
        return (v > 0 ? 'pos-' : 'neg-') + lvl;
    }

    let html = `<table class="bt-monthly-grid">
        <thead><tr>
            <th></th>
            ${MONTHS.map(m => `<th>${m}</th>`).join('')}
            <th style="text-align:right;padding-left:4px">Yr</th>
        </tr></thead><tbody>`;

    for (const yr of years) {
        const yrTotal = Object.values(map[yr]).reduce((a, b) => a + b, 0);
        const yrCls = heatClass(yrTotal);
        html += `<tr><td class="bt-monthly-year">${yr}</td>`;
        for (let m = 0; m < 12; m++) {
            const v = map[yr][m];
            if (v == null) { html += '<td></td>'; continue; }
            const cls = heatClass(v);
            const txt = (v >= 0 ? '+' : '') + v.toFixed(1) + '%';
            html += `<td><div class="bt-monthly-cell ${cls}" title="${txt}">${txt}</div></td>`;
        }
        const yrTxt = (yrTotal >= 0 ? '+' : '') + yrTotal.toFixed(1) + '%';
        html += `<td class="bt-monthly-total bt-cell-pnl ${yrCls}">${yrTxt}</td></tr>`;
    }
    html += '</tbody></table>';
    el.innerHTML = html;
}

function renderPerformance(stats, trades) {
    const longs = trades.filter(t => t.side === 'long');
    const shorts = trades.filter(t => t.side === 'short');

    function buildStats(subset, label) {
        if (!subset.length) return [{ label, val: '—', cls: '' }];
        const wins = subset.filter(t => t.return_pct > 0);
        const losses = subset.filter(t => t.return_pct <= 0);
        const total = subset.reduce((a, t) => a + (t.return_pct || 0), 0);
        const avgW = wins.length ? wins.reduce((a, t) => a + t.return_pct, 0) / wins.length : null;
        const avgL = losses.length ? losses.reduce((a, t) => a + t.return_pct, 0) / losses.length : null;

        return [
            { label: 'Trades', val: subset.length, cls: '' },
            { label: 'Win Rate', val: (100 * wins.length / subset.length).toFixed(1) + '%', cls: '' },
            { label: 'Net P&L', val: (total >= 0 ? '+' : '') + total.toFixed(2) + '%', cls: total >= 0 ? 'pos' : 'neg' },
            { label: 'Avg Win', val: avgW != null ? '+' + avgW.toFixed(2) + '%' : '—', cls: 'pos' },
            { label: 'Avg Loss', val: avgL != null ? avgL.toFixed(2) + '%' : '—', cls: 'neg' },
            { label: 'Best', val: subset.reduce((m, t) => Math.max(m, t.return_pct || 0), -Infinity).toFixed(2) + '%', cls: 'pos' },
            { label: 'Worst', val: subset.reduce((m, t) => Math.min(m, t.return_pct || 0), Infinity).toFixed(2) + '%', cls: 'neg' },
        ];
    }

    function buildAll(st, trades) {
        return [
            { label: 'Net P&L', val: (st.total_return >= 0 ? '+' : '') + Number(st.total_return).toFixed(2) + '%', cls: st.total_return >= 0 ? 'pos' : 'neg' },
            { label: 'Profit Factor', val: st.profit_factor != null ? Number(st.profit_factor).toFixed(2) : '—', cls: '' },
            { label: 'Max Drawdown', val: Number(st.max_drawdown).toFixed(2) + '%', cls: 'neg' },
            { label: 'Win Rate', val: Number(st.win_rate).toFixed(1) + '%', cls: '' },
            { label: 'Total Trades', val: st.total_trades, cls: '' },
            { label: 'Winning', val: st.winning_trades ?? '—', cls: 'pos' },
            { label: 'Losing', val: st.losing_trades ?? '—', cls: 'neg' },
        ];
    }

    function render(id, rows) {
        const el = document.getElementById(id);
        if (!el) return;
        el.innerHTML = rows.map(r => `
            <div class="bt-perf-row">
                <span class="bt-perf-row-label">${r.label}</span>
                <span class="bt-perf-row-value ${r.cls}">${r.val}</span>
            </div>`).join('');
    }

    render('perfLongStats', buildStats(longs, 'Long'));
    render('perfShortStats', buildStats(shorts, 'Short'));
    render('perfAllStats', buildAll(stats, trades));
}


// ── LIVE TICKER ───────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

const _prevPrices = {};

async function refreshTicker() {
    try {
        const res = await fetch('/api/live-prices?pairs=ARBUSD,OPUSD,STRKUSD,ZKUSD');
        const data = await res.json();
        for (const [pair, info] of Object.entries(data)) {
            const el = document.getElementById(`tick-${pair}`);
            if (!el || info.error) continue;
            const price = info.last;
            const prev = _prevPrices[pair];
            el.textContent = `$${price.toFixed(price < 1 ? 4 : 3)}`;
            el.className = 'ticker-price' + (prev == null ? '' : price >= prev ? ' tick-up' : ' tick-dn');
            _prevPrices[pair] = price;
            // Remove flash after animation
            setTimeout(() => { el.className = 'ticker-price'; }, 800);
        }
    } catch (_) { }
}

// Kraken connection status
async function checkKrakenStatus() {
    try {
        const res = await fetch('/api/kraken/status');
        const data = await res.json();
        const label = document.getElementById('krakenLabel');
        const el = document.getElementById('krakenStatus');
        if (data.connected) {
            label.textContent = 'Kraken ✓';
            el.classList.add('connected');
        } else {
            label.textContent = 'Kraken ✗';
            el.classList.add('disconnected');
        }
    } catch (_) { }
}

// Toast utility
function showToast(msg) {
    const t = document.createElement('div');
    t.className = 'toast'; t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3200);
}
window.showToast = showToast;

// Start periodic updates
refreshTicker();
checkKrakenStatus();
setInterval(refreshTicker, 15_000);   // every 15 s
setInterval(checkKrakenStatus, 60_000);   // every 60 s
