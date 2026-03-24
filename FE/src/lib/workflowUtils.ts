export type IndicatorId =
  | 'price' | 'sma' | 'ema' | 'rsi' | 'macd'
  | 'bbands' | 'volume' | 'fg' | 'unlock' | 'pct_change'

export type Op = '>' | '<' | '>=' | '<=' | '==' | 'crosses above' | 'crosses below'

export type ExitType =
  | 'rsi_overbought' | 'rsi_oversold' | 'take_profit'
  | 'stop_loss' | 'bars_held' | 'crosses_back'

export type ActionType = 'BUY (long)' | 'SELL (short)' | 'CLOSE'

export interface ConditionSide {
  indicator: IndicatorId
  params: Record<string, number>
}

export interface Condition {
  id: string
  left: ConditionSide
  op: Op
  right: ({ type: 'value'; value: number } | ({ type: 'indicator' } & ConditionSide))
}

export interface ExitCondition {
  id: string
  type: ExitType
  params: Record<string, number>
}

export interface Rule {
  id: string
  enabled: boolean
  entry: { logic: 'AND' | 'OR'; conditions: Condition[] }
  action: ActionType
  exit: { logic: 'AND' | 'OR'; conditions: ExitCondition[] }
}

export interface Workflow {
  version: 1
  rules: Rule[]
}

export interface IndicatorMeta {
  label: string
  unit: string
  defaultPeriod?: number
  hasPeriod: boolean
  min?: number
  max?: number
}

export const INDICATORS: Record<IndicatorId, IndicatorMeta> = {
  price:     { label: 'Price',        unit: '$',      hasPeriod: false },
  sma:       { label: 'SMA',          unit: '',       hasPeriod: true,  defaultPeriod: 20 },
  ema:       { label: 'EMA',          unit: '',       hasPeriod: true,  defaultPeriod: 20 },
  rsi:       { label: 'RSI',          unit: '',       hasPeriod: true,  defaultPeriod: 14, min: 0, max: 100 },
  macd:      { label: 'MACD',         unit: '',       hasPeriod: false },
  bbands:    { label: 'Bollinger Band', unit: '',     hasPeriod: true,  defaultPeriod: 20 },
  volume:    { label: 'Volume',        unit: '',      hasPeriod: false },
  fg:        { label: 'Fear & Greed',  unit: '',      hasPeriod: false, min: 0, max: 100 },
  unlock:    { label: 'Token Unlock',  unit: 'tokens', hasPeriod: false },
  pct_change: { label: '% Change',    unit: '%',      hasPeriod: true,  defaultPeriod: 1 },
}

export const OPS: Op[] = ['>', '<', '>=', '<=', '==', 'crosses above', 'crosses below']
export const ACTIONS: ActionType[] = ['BUY (long)', 'SELL (short)', 'CLOSE']
export const EXIT_TYPES: ExitType[] = [
  'rsi_overbought', 'rsi_oversold', 'take_profit', 'stop_loss', 'bars_held', 'crosses_back',
]
export const EXIT_TYPE_LABELS: Record<ExitType, string> = {
  rsi_overbought: 'RSI overbought',
  rsi_oversold:   'RSI oversold',
  take_profit:    'Take profit %',
  stop_loss:      'Stop loss %',
  bars_held:      'Bars held',
  crosses_back:   'Crosses back',
}

export function defaultExitParams(type: ExitType): Record<string, number> {
  return ({
    rsi_overbought: { period: 14, threshold: 70 },
    rsi_oversold:   { period: 14, threshold: 30 },
    take_profit:    { pct: 5 },
    stop_loss:      { pct: 3 },
    bars_held:      { bars: 10 },
    crosses_back:   {},
  } as Record<ExitType, Record<string, number>>)[type] ?? {}
}

export function defaultParams(id: IndicatorId): Record<string, number> {
  const meta = INDICATORS[id]
  return meta.hasPeriod && meta.defaultPeriod ? { period: meta.defaultPeriod } : {}
}

export function emptyCondition(): Condition {
  return {
    id: crypto.randomUUID(),
    left:  { indicator: 'rsi', params: { period: 14 } },
    op:    'crosses above',
    right: { type: 'value', value: 30 },
  }
}

export function emptyExitCondition(): ExitCondition {
  return {
    id:     crypto.randomUUID(),
    type:   'rsi_overbought',
    params: defaultExitParams('rsi_overbought'),
  }
}

export function emptyRule(): Rule {
  return {
    id:      crypto.randomUUID(),
    enabled: true,
    entry:   { logic: 'AND', conditions: [emptyCondition()] },
    action:  'BUY (long)',
    exit:    { logic: 'OR',  conditions: [emptyExitCondition()] },
  }
}

export function emptyWorkflow(): Workflow {
  return { version: 1, rules: [emptyRule()] }
}

// ── Natural language serialisation ───────────────────────────────────────────

function indicatorToText(side: ConditionSide): string {
  const meta = INDICATORS[side.indicator]
  if (!meta) return side.indicator
  const period = side.params?.period
  return meta.hasPeriod && period != null ? `${meta.label}(${period})` : meta.label
}

function conditionToText(cond: Condition): string {
  const left = indicatorToText(cond.left)
  let right: string
  if (cond.right.type === 'value') {
    right = String(cond.right.value)
  } else {
    right = indicatorToText(cond.right as ConditionSide)
  }
  return `${left} ${cond.op} ${right}`
}

function exitCondToText(ec: ExitCondition): string {
  switch (ec.type) {
    case 'rsi_overbought': return `RSI(${ec.params.period ?? 14}) > ${ec.params.threshold ?? 70}`
    case 'rsi_oversold':   return `RSI(${ec.params.period ?? 14}) < ${ec.params.threshold ?? 30}`
    case 'take_profit':    return `Take profit ${ec.params.pct ?? 5}%`
    case 'stop_loss':      return `Stop loss ${ec.params.pct ?? 3}%`
    case 'bars_held':      return `After ${ec.params.bars ?? 10} bars`
    case 'crosses_back':   return 'Price crosses back'
    default:               return ec.type
  }
}

export function workflowToNaturalLanguage(wf: Workflow): string {
  if (!wf.rules.length) return ''
  const activeRules = wf.rules.filter(r => r.enabled && r.entry.conditions.length > 0)
  if (!activeRules.length) return ''

  const lines: string[] = [
    `Strategy Workflow (rules evaluated top-to-bottom by priority):`,
    `- Rule 1 is highest priority. If Rule 1 entry triggers, skip Rules 2+.`,
    `- Only one rule can be active at a time (no overlapping positions).`,
  ]

  activeRules.forEach((rule, i) => {
    lines.push(`\nRule ${i + 1} (Priority ${i + 1}${i === 0 ? ' — highest' : ''}):`)
    const entryConds = rule.entry.conditions.map(conditionToText).join(` ${rule.entry.logic} `)
    lines.push(`  ENTRY: IF ${entryConds}`)
    lines.push(`  ACTION: ${rule.action}`)
    const exitConds = rule.exit.conditions.map(exitCondToText).join(` ${rule.exit.logic} `)
    lines.push(`  EXIT: WHEN ${exitConds}`)
  })
  return lines.join('\n')
}

// ── Parse workflow JSON from AI reply ────────────────────────────────────────

export function parseWorkflowFromReply(reply: string): Workflow | null {
  try {
    // Look for [Workflow JSON] section
    const sectionMatch = reply.match(/\[Workflow JSON\]\s*([\s\S]*?)(?:\[|$)/)
    const candidate = sectionMatch?.[1]?.trim() ?? ''
    const jsonMatch = candidate.match(/```json\s*([\s\S]+?)\s*```/) ??
                      candidate.match(/(\{[\s\S]*"rules"[\s\S]*\})/)
    const raw = jsonMatch ? jsonMatch[1] : candidate
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (parsed?.rules) return parsed as Workflow
  } catch {}
  return null
}
