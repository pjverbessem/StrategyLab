import {
  INDICATORS, OPS, ACTIONS, EXIT_TYPES, EXIT_TYPE_LABELS,
  defaultExitParams, defaultParams, emptyCondition, emptyExitCondition, emptyRule,
  type Workflow, type Rule, type Condition, type ExitCondition,
  type ConditionSide, type IndicatorId, type Op, type ExitType, type ActionType,
} from '@/lib/workflowUtils'

interface Props {
  workflow: Workflow
  onChange: (wf: Workflow) => void
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function updateRule(wf: Workflow, ruleId: string, fn: (r: Rule) => Rule): Workflow {
  return { ...wf, rules: wf.rules.map(r => r.id === ruleId ? fn(r) : r) }
}

// ── ParamSlider ───────────────────────────────────────────────────────────────

function ParamSlider({
  label, value, min, max, step = 1,
  onChange,
}: {
  label: string; value: number; min: number; max: number; step?: number
  onChange: (v: number) => void
}) {
  return (
    <div className="wf-param-wrap">
      <label className="wf-param-label">{label}</label>
      <input
        type="number" className="wf-param-number"
        value={value} min={min} max={max} step={step}
        onChange={e => onChange(Number(e.target.value))}
      />
      <input
        type="range" className="wf-param-slider"
        value={value} min={min} max={max} step={step}
        onChange={e => onChange(Number(e.target.value))}
      />
    </div>
  )
}

// ── IndicatorPicker ───────────────────────────────────────────────────────────

function IndicatorPicker({
  side, onChange,
}: {
  side: ConditionSide
  onChange: (s: ConditionSide) => void
}) {
  const meta = INDICATORS[side.indicator]
  const period = side.params?.period ?? meta?.defaultPeriod ?? 14

  return (
    <div className="wf-indicator-wrap">
      <select
        className="wf-ind-select"
        value={side.indicator}
        onChange={e => {
          const id = e.target.value as IndicatorId
          onChange({ indicator: id, params: defaultParams(id) })
        }}
      >
        {Object.entries(INDICATORS).map(([id, m]) => (
          <option key={id} value={id}>{m.label}</option>
        ))}
      </select>
      {meta?.hasPeriod && (
        <ParamSlider
          label="Period" value={period} min={2} max={200}
          onChange={v => onChange({ ...side, params: { ...side.params, period: v } })}
        />
      )}
    </div>
  )
}

// ── ConditionRow ──────────────────────────────────────────────────────────────

function ConditionRow({
  cond, onUpdate, onDelete,
}: {
  cond: Condition
  onUpdate: (c: Condition) => void
  onDelete: () => void
}) {
  const rightIsIndicator = cond.right.type === 'indicator'

  function setLeft(left: ConditionSide) { onUpdate({ ...cond, left }) }
  function setOp(op: Op) { onUpdate({ ...cond, op }) }
  function setRightValue(value: number) {
    onUpdate({ ...cond, right: { type: 'value', value } })
  }
  function setRightIndicator(s: ConditionSide) {
    onUpdate({ ...cond, right: { type: 'indicator', ...s } })
  }
  function toggleRightType() {
    if (rightIsIndicator) {
      onUpdate({ ...cond, right: { type: 'value', value: 50 } })
    } else {
      onUpdate({ ...cond, right: { type: 'indicator', indicator: 'sma', params: { period: 50 } } })
    }
  }

  const rightSideAsSide: ConditionSide = rightIsIndicator
    ? (cond.right as ConditionSide)
    : { indicator: 'sma', params: { period: 50 } }

  const rightValue = cond.right.type === 'value' ? (cond.right as { type: 'value'; value: number }).value : 50
  const rightMeta = rightIsIndicator ? INDICATORS[rightSideAsSide.indicator] : null
  const rightPeriod = rightIsIndicator ? (rightSideAsSide.params?.period ?? rightMeta?.defaultPeriod ?? 14) : 50

  return (
    <div className="wf-cond-row">
      <IndicatorPicker side={cond.left} onChange={setLeft} />

      <select
        className="wf-op-select"
        value={cond.op}
        onChange={e => setOp(e.target.value as Op)}
      >
        {OPS.map(op => <option key={op} value={op}>{op}</option>)}
      </select>

      <div className="wf-right-wrap">
        <div className="wf-right-toggle">
          <button
            className={`wf-right-btn${!rightIsIndicator ? ' active' : ''}`}
            onClick={!rightIsIndicator ? undefined : toggleRightType}
          >Value</button>
          <button
            className={`wf-right-btn${rightIsIndicator ? ' active' : ''}`}
            onClick={rightIsIndicator ? undefined : toggleRightType}
          >Indicator</button>
        </div>

        {!rightIsIndicator ? (
          <ParamSlider
            label="" value={rightValue} min={0} max={200} step={0.5}
            onChange={setRightValue}
          />
        ) : (
          <IndicatorPicker
            side={rightSideAsSide}
            onChange={s => setRightIndicator(s)}
          />
        )}
      </div>

      <button className="wf-del-cond" onClick={onDelete} title="Remove condition">×</button>
    </div>
  )
}

// ── ExitConditionRow ──────────────────────────────────────────────────────────

function ExitConditionRow({
  ec, onUpdate, onDelete,
}: {
  ec: ExitCondition
  onUpdate: (ec: ExitCondition) => void
  onDelete: () => void
}) {
  function setType(type: ExitType) {
    onUpdate({ ...ec, type, params: defaultExitParams(type) })
  }
  function setParam(key: string, value: number) {
    onUpdate({ ...ec, params: { ...ec.params, [key]: value } })
  }

  return (
    <div className="wf-exit-row">
      <select
        className="wf-exit-type-select"
        value={ec.type}
        onChange={e => setType(e.target.value as ExitType)}
      >
        {EXIT_TYPES.map(t => <option key={t} value={t}>{EXIT_TYPE_LABELS[t]}</option>)}
      </select>

      <div className="wf-exit-params">
        {(ec.type === 'rsi_overbought' || ec.type === 'rsi_oversold') && (
          <>
            <ParamSlider label="Period" value={ec.params.period ?? 14} min={2} max={50}
              onChange={v => setParam('period', v)} />
            <ParamSlider
              label="Threshold" value={ec.params.threshold ?? (ec.type === 'rsi_overbought' ? 70 : 30)}
              min={0} max={100}
              onChange={v => setParam('threshold', v)}
            />
          </>
        )}
        {(ec.type === 'take_profit' || ec.type === 'stop_loss') && (
          <ParamSlider label="%" value={ec.params.pct ?? 5} min={0.5} max={50} step={0.5}
            onChange={v => setParam('pct', v)} />
        )}
        {ec.type === 'bars_held' && (
          <ParamSlider label="Bars" value={ec.params.bars ?? 10} min={1} max={100}
            onChange={v => setParam('bars', v)} />
        )}
      </div>

      <button className="wf-del-cond" onClick={onDelete} title="Remove exit">×</button>
    </div>
  )
}

// ── RuleBlock ─────────────────────────────────────────────────────────────────

function RuleBlock({
  rule, index, onChange, onDelete,
}: {
  rule: Rule
  index: number
  onChange: (r: Rule) => void
  onDelete: () => void
}) {
  function toggleEnabled() { onChange({ ...rule, enabled: !rule.enabled }) }
  function setEntryLogic() {
    onChange({ ...rule, entry: { ...rule.entry, logic: rule.entry.logic === 'AND' ? 'OR' : 'AND' } })
  }
  function setExitLogic() {
    onChange({ ...rule, exit: { ...rule.exit, logic: rule.exit.logic === 'AND' ? 'OR' : 'AND' } })
  }
  function setAction(action: ActionType) { onChange({ ...rule, action }) }

  function updateEntryCond(ci: number, c: Condition) {
    const conditions = rule.entry.conditions.map((x, i) => i === ci ? c : x)
    onChange({ ...rule, entry: { ...rule.entry, conditions } })
  }
  function deleteEntryCond(ci: number) {
    const conditions = rule.entry.conditions.filter((_, i) => i !== ci)
    onChange({ ...rule, entry: { ...rule.entry, conditions } })
  }
  function addEntryCond() {
    onChange({ ...rule, entry: { ...rule.entry, conditions: [...rule.entry.conditions, emptyCondition()] } })
  }

  function updateExitCond(ci: number, ec: ExitCondition) {
    const conditions = rule.exit.conditions.map((x, i) => i === ci ? ec : x)
    onChange({ ...rule, exit: { ...rule.exit, conditions } })
  }
  function deleteExitCond(ci: number) {
    const conditions = rule.exit.conditions.filter((_, i) => i !== ci)
    onChange({ ...rule, exit: { ...rule.exit, conditions } })
  }
  function addExitCond() {
    onChange({ ...rule, exit: { ...rule.exit, conditions: [...rule.exit.conditions, emptyExitCondition()] } })
  }

  return (
    <div className={`wf-rule${!rule.enabled ? ' wf-rule--disabled' : ''}`}>
      <div className="wf-rule-hdr">
        <span className="wf-rule-num">Rule {index + 1}</span>
        <div className="wf-rule-hdr-actions">
          <button
            className="wf-icon-btn wf-toggle-rule"
            title={rule.enabled ? 'Disable rule' : 'Enable rule'}
            onClick={toggleEnabled}
          >
            {rule.enabled ? '◉' : '○'}
          </button>
          <button className="wf-icon-btn wf-del-rule" title="Delete rule" onClick={onDelete}>
            ×
          </button>
        </div>
      </div>

      {/* ENTRY section */}
      <div className="wf-section">
        <div className="wf-section-hdr">
          <span className="wf-section-label">ENTRY</span>
          {rule.entry.conditions.length > 1 && (
            <button className="wf-logic-toggle" onClick={setEntryLogic}>
              {rule.entry.logic}
            </button>
          )}
        </div>
        {rule.entry.conditions.map((cond, ci) => (
          <div key={cond.id}>
            {ci > 0 && <div className="wf-connector">{rule.entry.logic}</div>}
            <ConditionRow
              cond={cond}
              onUpdate={c => updateEntryCond(ci, c)}
              onDelete={() => deleteEntryCond(ci)}
            />
          </div>
        ))}
        <button className="wf-btn-add-cond" onClick={addEntryCond}>＋ Add Condition</button>
      </div>

      {/* Action row */}
      <div className="wf-action-row">
        <span className="wf-section-arrow">↓</span>
        <select
          className="wf-action-select"
          value={rule.action}
          onChange={e => setAction(e.target.value as ActionType)}
        >
          {ACTIONS.map(a => <option key={a} value={a}>{a}</option>)}
        </select>
        <span className="wf-section-arrow">↓</span>
      </div>

      {/* EXIT section */}
      <div className="wf-section wf-section--exit">
        <div className="wf-section-hdr">
          <span className="wf-section-label">EXIT</span>
          {rule.exit.conditions.length > 1 && (
            <button className="wf-logic-toggle" onClick={setExitLogic}>
              {rule.exit.logic}
            </button>
          )}
        </div>
        {rule.exit.conditions.map((ec, ci) => (
          <div key={ec.id}>
            {ci > 0 && <div className="wf-connector">{rule.exit.logic}</div>}
            <ExitConditionRow
              ec={ec}
              onUpdate={c => updateExitCond(ci, c)}
              onDelete={() => deleteExitCond(ci)}
            />
          </div>
        ))}
        <button className="wf-btn-add-cond" onClick={addExitCond}>＋ Add Exit</button>
      </div>
    </div>
  )
}

// ── WorkflowBuilder ───────────────────────────────────────────────────────────

export function WorkflowBuilder({ workflow, onChange }: Props) {
  function addRule() {
    onChange({ ...workflow, rules: [...workflow.rules, emptyRule()] })
  }

  function updateRule(ruleId: string, r: Rule) {
    onChange({ ...workflow, rules: workflow.rules.map(x => x.id === ruleId ? r : x) })
  }

  function deleteRule(ruleId: string) {
    onChange({ ...workflow, rules: workflow.rules.filter(r => r.id !== ruleId) })
  }

  return (
    <div className="workflow-builder">
      <div className="wf-header">
        <span className="wf-header-title">Visual Strategy Builder</span>
        <button className="wf-btn-add-rule" onClick={addRule}>＋ Add Rule</button>
      </div>

      {workflow.rules.map((rule, i) => (
        <RuleBlock
          key={rule.id}
          rule={rule}
          index={i}
          onChange={r => updateRule(rule.id, r)}
          onDelete={() => deleteRule(rule.id)}
        />
      ))}

      {workflow.rules.length === 0 && (
        <div className="wf-footer">
          <span className="wf-footer-hint">No rules yet — click ＋ Add Rule to start building.</span>
        </div>
      )}
    </div>
  )
}
