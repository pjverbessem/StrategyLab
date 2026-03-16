/* ── workflow.js — Visual Strategy Workflow Builder ─────────────────────────
   Exports:  window.WorkflowBuilder
   Depends:  creator.js (for sendChat, buildRefinementPrompt), style.css
   ─────────────────────────────────────────────────────────────────────────── */
'use strict';

// ── Indicator catalog ─────────────────────────────────────────────────────────
const INDICATORS = {
    price: { label: 'Price', unit: '$', defaultVal: null, type: 'price' },
    sma: { label: 'SMA', unit: '', defaultPeriod: 20, type: 'ma' },
    ema: { label: 'EMA', unit: '', defaultPeriod: 20, type: 'ma' },
    rsi: { label: 'RSI', unit: '', defaultPeriod: 14, type: 'osc', min: 0, max: 100 },
    macd: { label: 'MACD', unit: '', defaultPeriod: 12, type: 'macd' },
    bbands: { label: 'Bollinger Band', unit: '', defaultPeriod: 20, type: 'bands' },
    volume: { label: 'Volume', unit: '', type: 'price' },
    fg: { label: 'Fear & Greed', unit: '', type: 'osc', min: 0, max: 100 },
    unlock: { label: 'Token Unlock', unit: 'tokens', type: 'event' },
    pct_change: { label: '% Change', unit: '%', defaultPeriod: 1, type: 'osc' },
};

const OPS = ['>', '<', '>=', '<=', '==', 'crosses above', 'crosses below'];
const ACTIONS = ['BUY (long)', 'SELL (short)', 'CLOSE'];
const LOGICS = ['AND', 'OR'];
const EXIT_TYPES = ['RSI overbought', 'RSI oversold', 'Take profit %', 'Stop loss %', 'Bars held', 'Crosses back', 'Manual'];

// ── Default empty workflow ────────────────────────────────────────────────────
function emptyWorkflow() {
    return {
        version: 1,
        name: 'My Strategy',
        rules: [newRule()],
    };
}

function newRule() {
    return {
        id: crypto.randomUUID(),
        enabled: true,
        entry: {
            logic: 'AND',
            conditions: [newCondition()],
        },
        action: 'BUY (long)',
        exit: {
            logic: 'OR',
            conditions: [newExitCondition()],
        },
    };
}

function newCondition() {
    return {
        id: crypto.randomUUID(),
        left: { indicator: 'rsi', params: { period: 14 } },
        op: '<',
        right: { type: 'value', value: 30 },
    };
}

function newExitCondition() {
    return {
        id: crypto.randomUUID(),
        type: 'rsi_overbought',
        params: { period: 14, threshold: 70 },
    };
}

// ── WorkflowBuilder class ─────────────────────────────────────────────────────
class WorkflowBuilder {
    constructor(containerEl, onCodeChange) {
        this.container = containerEl;
        this.onCodeChange = onCodeChange; // called with new Python code string
        this.workflow = emptyWorkflow();
        this._dirty = false;
        this._regen_timer = null;
        this.render();
    }

    // ── Load workflow from JSON (e.g. from AI response) ──
    load(wf) {
        this.workflow = wf;
        this._dirty = false;
        this.render();
    }

    // ── Serialize current state ──
    toJSON() { return JSON.parse(JSON.stringify(this.workflow)); }

    // ── Mark changed + schedule code regen ──
    _change() {
        this._dirty = true;
        clearTimeout(this._regen_timer);
        this._regen_timer = setTimeout(() => this._regenerateCode(), 600);
        this.render();
    }

    // ── Generate Python from workflow JSON via AI ──
    async _regenerateCode() {
        const wf = this.toJSON();
        const wfDesc = workflowToNaturalLanguage(wf);
        const pair = document.getElementById('creatorPair')?.value || 'STRKUSD';
        const from = document.getElementById('btFrom')?.value;
        const to = document.getElementById('btTo')?.value;
        const context = `Pair: ${pair}. Period: ${from} to ${to}.`;

        // Show regen badge
        const badge = document.getElementById('wf-regen-badge');
        if (badge) { badge.style.display = 'inline-flex'; badge.textContent = '↻ syncing…'; }

        try {
            const systemPrompt = buildWorkflowCodePrompt(wfDesc, context, wf);
            const res = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: `Generate Python strategy code for this workflow:\n\n${wfDesc}`,
                    system: systemPrompt,
                    history: [],
                    current_code: window._lastStrategyCode || '',
                }),
            });
            const data = await res.json();
            if (data.error && !data.reply) throw new Error(data.error);

            const code = extractCodeFromReply(data.reply || '');
            if (code) {
                window._lastStrategyCode = code;
                if (window.creatorEditor) {
                    window.creatorEditor.setValue(code);
                    window.creatorEditor.clearHistory();
                }
                if (typeof _historyPush === 'function') _historyPush(code);
                this.onCodeChange?.(code);
                if (badge) { badge.style.display = 'inline-flex'; badge.textContent = '✓ synced'; badge.style.color = 'var(--pos)'; }
                setTimeout(() => { if (badge) badge.style.display = 'none'; }, 2000);
            }
        } catch (e) {
            if (badge) { badge.textContent = '⚠ sync failed'; badge.style.color = 'var(--neg)'; }
            setTimeout(() => { if (badge) badge.style.display = 'none'; }, 3000);
            console.warn('[workflow] code regen failed', e);
        }
    }

    // ── Main render ──
    render() {
        this.container.innerHTML = '';
        const wf = this.workflow;

        // Header bar
        const header = el('div', 'wf-header');
        header.innerHTML = `
      <span class="wf-header-title">Strategy Rules</span>
      <span class="wf-regen-badge" id="wf-regen-badge" style="display:none"></span>
      <button class="wf-btn-add-rule" id="wf-add-rule">+ Add Rule</button>`;
        this.container.appendChild(header);

        header.querySelector('#wf-add-rule').addEventListener('click', () => {
            wf.rules.push(newRule());
            this._change();
        });

        // Rules
        wf.rules.forEach((rule, ri) => {
            this.container.appendChild(this._renderRule(rule, ri));
        });

        // Summary footer
        const footer = el('div', 'wf-footer');
        footer.innerHTML = `<span class="wf-footer-hint">Click any value to edit · Changes auto-sync to code</span>`;
        this.container.appendChild(footer);
    }

    // ── Render one rule block ──
    _renderRule(rule, ri) {
        const wf = this.workflow;
        const wrap = el('div', `wf-rule ${rule.enabled ? '' : 'wf-rule--disabled'}`);
        wrap.dataset.ruleId = rule.id;

        // Rule header
        const ruleHdr = el('div', 'wf-rule-hdr');
        ruleHdr.innerHTML = `
      <span class="wf-rule-num">Rule ${ri + 1}</span>
      <div class="wf-rule-hdr-actions">
        <button class="wf-icon-btn wf-toggle-rule" title="${rule.enabled ? 'Disable' : 'Enable'} rule">
          ${rule.enabled ? '◉' : '○'}
        </button>
        ${wf.rules.length > 1 ? `<button class="wf-icon-btn wf-del-rule" title="Remove rule">×</button>` : ''}
      </div>`;
        ruleHdr.querySelector('.wf-toggle-rule').addEventListener('click', () => {
            rule.enabled = !rule.enabled; this._change();
        });
        ruleHdr.querySelector('.wf-del-rule')?.addEventListener('click', () => {
            wf.rules.splice(ri, 1); this._change();
        });
        wrap.appendChild(ruleHdr);

        // ENTRY section
        wrap.appendChild(this._renderSection('ENTRY — IF', rule.entry, rule, 'entry'));

        // ACTION
        const actionRow = el('div', 'wf-action-row');
        actionRow.innerHTML = `<span class="wf-section-arrow">▼</span>`;
        const actionSelect = elSelect(ACTIONS, rule.action, 'wf-action-select');
        actionSelect.addEventListener('change', e => { rule.action = e.target.value; this._change(); });
        actionRow.appendChild(actionSelect);
        wrap.appendChild(actionRow);

        // EXIT section
        wrap.appendChild(this._renderExitSection(rule));

        return wrap;
    }

    // ── Entry conditions section ──
    _renderSection(title, condGroup, rule, key) {
        const sec = el('div', 'wf-section');

        const secHdr = el('div', 'wf-section-hdr');
        secHdr.innerHTML = `<span class="wf-section-label">${title}</span>`;
        // Logic toggle (AND/OR)
        const logicBtn = el('button', 'wf-logic-toggle');
        logicBtn.textContent = condGroup.logic;
        logicBtn.title = 'Toggle AND / OR';
        logicBtn.addEventListener('click', () => {
            condGroup.logic = condGroup.logic === 'AND' ? 'OR' : 'AND';
            this._change();
        });
        secHdr.appendChild(logicBtn);
        sec.appendChild(secHdr);

        // Conditions
        condGroup.conditions.forEach((cond, ci) => {
            sec.appendChild(this._renderCondition(cond, ci, condGroup, rule));
            // Logic connector
            if (ci < condGroup.conditions.length - 1) {
                const conn = el('div', 'wf-connector');
                conn.textContent = condGroup.logic;
                sec.appendChild(conn);
            }
        });

        // Add condition button
        const addBtn = el('button', 'wf-btn-add-cond');
        addBtn.textContent = '+ Condition';
        addBtn.addEventListener('click', () => {
            condGroup.conditions.push(newCondition());
            this._change();
        });
        sec.appendChild(addBtn);

        return sec;
    }

    // ── One condition row ──
    _renderCondition(cond, ci, condGroup, rule) {
        const row = el('div', 'wf-cond-row');

        // Left indicator
        row.appendChild(this._renderIndicatorPicker(cond.left, (val) => {
            cond.left = val; this._change();
        }));

        // Operator
        const opSelect = elSelect(OPS, cond.op, 'wf-op-select');
        opSelect.addEventListener('change', e => { cond.op = e.target.value; this._change(); });
        row.appendChild(opSelect);

        // Right side: value or another indicator
        row.appendChild(this._renderRightSide(cond, () => this._change()));

        // Delete button (if not the only condition)
        if (condGroup.conditions.length > 1) {
            const delBtn = el('button', 'wf-icon-btn wf-del-cond');
            delBtn.textContent = '×';
            delBtn.title = 'Remove condition';
            delBtn.addEventListener('click', () => {
                condGroup.conditions.splice(ci, 1);
                this._change();
            });
            row.appendChild(delBtn);
        }

        return row;
    }

    // ── Indicator picker (left side) ──
    _renderIndicatorPicker(side, onChange) {
        const wrap = el('div', 'wf-indicator-wrap');

        // Indicator type selector
        const indSelect = elSelect(
            Object.entries(INDICATORS).map(([k, v]) => ({ value: k, label: v.label })),
            side.indicator, 'wf-ind-select'
        );
        indSelect.addEventListener('change', e => {
            side.indicator = e.target.value;
            const def = INDICATORS[e.target.value];
            side.params = def?.defaultPeriod ? { period: def.defaultPeriod } : {};
            onChange(side);
        });
        wrap.appendChild(indSelect);

        // Period input (if applicable)
        const indDef = INDICATORS[side.indicator];
        if (side.params?.period !== undefined) {
            const periodWrap = el('div', 'wf-param-wrap');
            const periodLabel = el('span', 'wf-param-label');
            periodLabel.textContent = 'period';
            const periodInput = el('input', 'wf-param-number');
            periodInput.type = 'number';
            periodInput.min = 2; periodInput.max = 500;
            periodInput.value = side.params.period;
            periodInput.addEventListener('change', e => {
                side.params.period = parseInt(e.target.value, 10) || side.params.period;
                onChange(side);
            });
            // Slider
            const slider = el('input', 'wf-param-slider');
            slider.type = 'range';
            slider.min = 2; slider.max = 200; slider.step = 1;
            slider.value = side.params.period;
            slider.addEventListener('input', e => {
                const v = parseInt(e.target.value, 10);
                side.params.period = v;
                periodInput.value = v;
                onChange(side);
            });
            periodWrap.appendChild(periodLabel);
            periodWrap.appendChild(periodInput);
            periodWrap.appendChild(slider);
            wrap.appendChild(periodWrap);
        }

        return wrap;
    }

    // ── Right side of a condition: either a numeric value or another indicator ──
    _renderRightSide(cond, onChange) {
        const wrap = el('div', 'wf-right-wrap');

        // Toggle: value vs indicator
        const toggle = el('div', 'wf-right-toggle');
        const btnVal = el('button', `wf-right-btn${cond.right.type === 'value' ? ' active' : ''}`);
        btnVal.textContent = '#'; btnVal.title = 'Compare to a fixed value';
        const btnInd = el('button', `wf-right-btn${cond.right.type === 'indicator' ? ' active' : ''}`);
        btnInd.textContent = '≈'; btnInd.title = 'Compare to another indicator';
        toggle.appendChild(btnVal); toggle.appendChild(btnInd);

        btnVal.addEventListener('click', () => {
            cond.right = { type: 'value', value: 30 }; onChange();
        });
        btnInd.addEventListener('click', () => {
            cond.right = { type: 'indicator', indicator: 'sma', params: { period: 200 } }; onChange();
        });
        wrap.appendChild(toggle);

        if (cond.right.type === 'value') {
            // Value input + slider
            const valWrap = el('div', 'wf-param-wrap');
            const valInput = el('input', 'wf-param-number');
            valInput.type = 'number';
            valInput.step = 'any';
            valInput.value = cond.right.value;
            valInput.addEventListener('change', e => {
                cond.right.value = parseFloat(e.target.value);
                onChange();
            });

            // Determine slider range from left indicator type
            const indDef = INDICATORS[cond.left?.indicator];
            const slider = el('input', 'wf-param-slider');
            slider.type = 'range';
            slider.min = indDef?.min ?? 0;
            slider.max = indDef?.max ?? 200;
            slider.step = 1;
            slider.value = cond.right.value;
            slider.addEventListener('input', e => {
                const v = parseFloat(e.target.value);
                cond.right.value = v;
                valInput.value = v;
                onChange();
            });

            valWrap.appendChild(valInput);
            valWrap.appendChild(slider);
            wrap.appendChild(valWrap);

        } else {
            // Indicator picker for right side
            wrap.appendChild(this._renderIndicatorPicker(cond.right, (val) => {
                cond.right = { ...val, type: 'indicator' };
                onChange();
            }));
        }

        return wrap;
    }

    // ── EXIT conditions section ──
    _renderExitSection(rule) {
        const sec = el('div', 'wf-section wf-section--exit');
        const secHdr = el('div', 'wf-section-hdr');
        secHdr.innerHTML = `<span class="wf-section-label">EXIT — WHEN</span>`;
        const logicBtn = el('button', 'wf-logic-toggle');
        logicBtn.textContent = rule.exit.logic;
        logicBtn.addEventListener('click', () => {
            rule.exit.logic = rule.exit.logic === 'AND' ? 'OR' : 'AND';
            this._change();
        });
        secHdr.appendChild(logicBtn);
        sec.appendChild(secHdr);

        rule.exit.conditions.forEach((exitCond, ei) => {
            sec.appendChild(this._renderExitCondition(exitCond, ei, rule));
            if (ei < rule.exit.conditions.length - 1) {
                const conn = el('div', 'wf-connector');
                conn.textContent = rule.exit.logic;
                sec.appendChild(conn);
            }
        });

        const addBtn = el('button', 'wf-btn-add-cond');
        addBtn.textContent = '+ Exit Condition';
        addBtn.addEventListener('click', () => {
            rule.exit.conditions.push(newExitCondition());
            this._change();
        });
        sec.appendChild(addBtn);
        return sec;
    }

    // ── One exit condition ──
    _renderExitCondition(exitCond, ei, rule) {
        const row = el('div', 'wf-exit-row');

        // Exit type
        const typeMap = {
            rsi_overbought: 'RSI overbought',
            rsi_oversold: 'RSI oversold',
            take_profit: 'Take profit %',
            stop_loss: 'Stop loss %',
            bars_held: 'Bars held',
            crosses_back: 'Price crosses back',
        };
        const typeOpts = Object.entries(typeMap).map(([k, v]) => ({ value: k, label: v }));
        const typeSelect = elSelect(typeOpts, exitCond.type, 'wf-exit-type-select');
        typeSelect.addEventListener('change', e => {
            exitCond.type = e.target.value;
            exitCond.params = defaultExitParams(e.target.value);
            this._change();
        });
        row.appendChild(typeSelect);

        // Params
        const paramsWrap = el('div', 'wf-exit-params');
        const params = exitCond.params || {};

        if (['rsi_overbought', 'rsi_oversold'].includes(exitCond.type)) {
            paramsWrap.appendChild(this._paramSlider('RSI period', params, 'period', 2, 50, 1));
            paramsWrap.appendChild(this._paramSlider('Threshold', params, 'threshold', 0, 100, 1));
        } else if (['take_profit', 'stop_loss'].includes(exitCond.type)) {
            paramsWrap.appendChild(this._paramSlider('%', params, 'pct', 0.5, 50, 0.5));
        } else if (exitCond.type === 'bars_held') {
            paramsWrap.appendChild(this._paramSlider('Bars', params, 'bars', 1, 100, 1));
        }
        row.appendChild(paramsWrap);

        if (rule.exit.conditions.length > 1) {
            const delBtn = el('button', 'wf-icon-btn wf-del-cond');
            delBtn.textContent = '×';
            delBtn.addEventListener('click', () => {
                rule.exit.conditions.splice(ei, 1);
                this._change();
            });
            row.appendChild(delBtn);
        }

        return row;
    }

    // ── Reusable param slider widget ──
    _paramSlider(label, params, key, min, max, step) {
        const wrap = el('div', 'wf-param-wrap');
        const lbl = el('span', 'wf-param-label');
        lbl.textContent = label;
        const numInput = el('input', 'wf-param-number');
        numInput.type = 'number';
        numInput.min = min; numInput.max = max; numInput.step = step;
        numInput.value = params[key] ?? ((min + max) / 2);
        numInput.addEventListener('change', e => {
            params[key] = parseFloat(e.target.value);
            slider.value = params[key];
            this._change();
        });
        const slider = el('input', 'wf-param-slider');
        slider.type = 'range'; slider.min = min; slider.max = max; slider.step = step;
        slider.value = params[key] ?? ((min + max) / 2);
        slider.addEventListener('input', e => {
            params[key] = parseFloat(e.target.value);
            numInput.value = params[key];
            this._change();
        });
        wrap.appendChild(lbl);
        wrap.appendChild(numInput);
        wrap.appendChild(slider);
        return wrap;
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function el(tag, cls = '') {
    const e = document.createElement(tag);
    if (cls) e.className = cls.trim();
    return e;
}

function elSelect(options, currentValue, cls) {
    const sel = el('select', cls);
    (Array.isArray(options) ? options : []).forEach(opt => {
        const o = document.createElement('option');
        if (typeof opt === 'string') {
            o.value = opt; o.textContent = opt;
        } else {
            o.value = opt.value; o.textContent = opt.label;
        }
        if (o.value === currentValue) o.selected = true;
        sel.appendChild(o);
    });
    return sel;
}

function defaultExitParams(type) {
    const map = {
        rsi_overbought: { period: 14, threshold: 70 },
        rsi_oversold: { period: 14, threshold: 30 },
        take_profit: { pct: 5 },
        stop_loss: { pct: 3 },
        bars_held: { bars: 10 },
        crosses_back: {},
    };
    return map[type] || {};
}

// ── Convert workflow JSON to a human-readable description ────────────────────
function workflowToNaturalLanguage(wf) {
    const lines = [`Strategy: ${wf.name || 'Custom'}`, ''];
    wf.rules.forEach((rule, i) => {
        if (!rule.enabled) return;
        lines.push(`Rule ${i + 1}:`);
        const entryConds = rule.entry.conditions.map(c => conditionToText(c)).join(` ${rule.entry.logic} `);
        lines.push(`  ENTRY: IF ${entryConds}`);
        lines.push(`  ACTION: ${rule.action}`);
        const exitConds = rule.exit.conditions.map(c => exitCondToText(c)).join(` ${rule.exit.logic} `);
        lines.push(`  EXIT: WHEN ${exitConds}`);
        lines.push('');
    });
    return lines.join('\n');
}

function indicatorToText(side) {
    if (!side) return 'unknown';
    const ind = INDICATORS[side.indicator];
    const label = ind?.label || side.indicator;
    const period = side.params?.period;
    return period ? `${label}(${period})` : label;
}

function conditionToText(cond) {
    const left = indicatorToText(cond.left);
    const op = cond.op;
    const right = cond.right?.type === 'indicator'
        ? indicatorToText(cond.right)
        : `${cond.right?.value ?? '?'}`;
    return `${left} ${op} ${right}`;
}

function exitCondToText(exitCond) {
    const p = exitCond.params || {};
    switch (exitCond.type) {
        case 'rsi_overbought': return `RSI(${p.period ?? 14}) > ${p.threshold ?? 70}`;
        case 'rsi_oversold': return `RSI(${p.period ?? 14}) < ${p.threshold ?? 30}`;
        case 'take_profit': return `Price up ${p.pct ?? 5}% from entry`;
        case 'stop_loss': return `Price down ${p.pct ?? 3}% from entry`;
        case 'bars_held': return `After ${p.bars ?? 10} bars`;
        case 'crosses_back': return `Price crosses back through signal`;
        default: return exitCond.type;
    }
}

// ── Build system prompt for workflow → code generation ───────────────────────
function buildWorkflowCodePrompt(wfDesc, context, wfJSON) {
    const usesFG = JSON.stringify(wfJSON).includes('"fg"') || wfDesc.includes('Fear');
    const sig = usesFG ? 'def strategy(df, unlocks, fear_greed):' : 'def strategy(df, unlocks):';

    return `You are an expert quantitative trading strategy builder.
The user has built a visual strategy workflow. Convert it EXACTLY into a working Python strategy function.

${context}

WORKFLOW:
${wfDesc}

OUTPUT FORMAT: Respond with ONLY the Python function, wrapped in a single \`\`\`python code block. No explanations.

RULES:
- Function signature MUST be: ${sig}
- Return a list of trade dicts with: entry (unix int), exit (unix int), side ('long'/'short'), entry_price (float), exit_price (float)
- Use pandas/numpy. Indicators: from ta.momentum import RSIIndicator; from ta.trend import SMAIndicator, EMAIndicator; from ta.volatility import BollingerBands
- Handle edge cases (insufficient data). No placeholders. Complete working code only.
- Function MUST end with "return trades"
- For each entry condition use proper indicator calculation (e.g. SMAIndicator(close=df['close'], window=N).sma_indicator())

Available df columns: time (unix int), open, high, low, close, volume${usesFG ? ', fg_value (0-100), fg_class' : ''}`;
}

// ── Extract code from AI reply ────────────────────────────────────────────────
function extractCodeFromReply(reply) {
    const fenceMatch = reply.match(/```(?:python)?\n([\s\S]+?)\n```/);
    if (fenceMatch) return fenceMatch[1].trim();
    const defMatch = reply.match(/(def strategy\([\s\S]+?return trades)/);
    if (defMatch) return defMatch[1].trim();
    return '';
}

// ── Parse AI workflow JSON from a chat reply ─────────────────────────────────
function parseWorkflowFromAI(reply) {
    try {
        // Look for ```json block
        const jsonMatch = reply.match(/```json\n([\s\S]+?)\n```/);
        if (jsonMatch) return JSON.parse(jsonMatch[1]);
        // Or bare JSON object with "rules" key
        const objMatch = reply.match(/\{[\s\S]*"rules"[\s\S]*\}/);
        if (objMatch) return JSON.parse(objMatch[0]);
    } catch (e) { /* ignore */ }
    return null;
}

// ── View toggle wiring ────────────────────────────────────────────────────────
function initWorkflowToggle() {
    const codePanel = document.getElementById('panel-code-inner');
    const wfPanel = document.getElementById('panel-wf-inner');
    const btnCode = document.getElementById('view-code-btn');
    const btnWf = document.getElementById('view-wf-btn');
    if (!codePanel || !wfPanel || !btnCode || !btnWf) return;

    const wfContainer = document.getElementById('workflow-builder');
    if (!wfContainer) return;

    const builder = new WorkflowBuilder(wfContainer, (newCode) => {
        const secPy = document.getElementById('code-section-py');
        if (secPy) secPy.style.display = newCode ? 'block' : 'none';
    });
    window._workflowBuilder = builder;

    btnCode.addEventListener('click', () => {
        btnCode.classList.add('active'); btnWf.classList.remove('active');
        codePanel.style.display = ''; wfPanel.style.display = 'none';
    });
    btnWf.addEventListener('click', () => {
        btnWf.classList.add('active'); btnCode.classList.remove('active');
        wfPanel.style.display = ''; codePanel.style.display = 'none';
    });

    // When a new strategy is generated by the AI, try to parse workflow JSON from the reply
    window.addEventListener('strategyGenerated', () => {
        // Auto-show workflow if AI included a workflow JSON
        // (This hook is triggered in creator.js after AI reply is processed)
        // For now just refresh the builder display
        if (window._lastWorkflowJSON) {
            builder.load(window._lastWorkflowJSON);
        }
    });
}

// ── Boot ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    initWorkflowToggle();
});

// Export for use in creator.js
window.WorkflowBuilder = WorkflowBuilder;
window.workflowToNaturalLanguage = workflowToNaturalLanguage;
window.parseWorkflowFromAI = parseWorkflowFromAI;
window.extractCodeFromReply = extractCodeFromReply;
