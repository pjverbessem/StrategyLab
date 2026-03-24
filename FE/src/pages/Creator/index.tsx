import { useState, useRef, useCallback, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import { backtestApi } from '@/api/backtest'
import { chatApi } from '@/api/chat'
import { strategiesApi } from '@/api/strategies'
import { marketDataApi } from '@/api/marketData'
import { useAppStore } from '@/store'
import { CodeEditor } from '@/components/CodeEditor'
import { CandlestickChart } from '@/components/CandlestickChart'
import { EquityChart } from '@/components/EquityChart'
import { IndicatorPanel } from '@/components/IndicatorPanel'
import { parseIndicators } from '@/lib/parseIndicators'
import type { IChartApi } from 'lightweight-charts'
import { WorkflowBuilder } from '@/components/WorkflowBuilder'
import { Spinner } from '@/components/ui/Spinner'
import { Modal } from '@/components/ui/Modal'
import {
  emptyWorkflow, workflowToNaturalLanguage, parseWorkflowFromReply,
  type Workflow,
} from '@/lib/workflowUtils'
import type { ChatMessage, BacktestResult, Trade } from '@/types'

function buildSystemPrompt(context: string, userMsg: string): string {
  const useFearGreed = /fear.?greed|fear_greed|fgi|sentiment index/i.test(userMsg || '')
  const sig = useFearGreed ? 'def strategy(df, unlocks, fear_greed):' : 'def strategy(df, unlocks):'
  return `You are an expert quantitative trading strategy builder integrated into a crypto backtesting platform.
The user has selected: ${context}

CRITICAL OUTPUT FORMAT — YOU MUST FOLLOW THIS EXACTLY

Respond using EXACTLY these four labelled sections:

[Algorithm]
A clear 3-5 sentence plain-English explanation of the trading logic.

[Python Code]
A COMPLETE, FULLY-IMPLEMENTED Python function. NOT a skeleton. NOT a stub. REAL working code.

[Parameters]
Key tunable parameters with defaults and recommended ranges.

The function MUST have this exact signature:
  ${sig}

DataFrame columns (EXACT names, no others exist):
  df['time']   — unix timestamp (int) for each candle
  df['open'], df['high'], df['low'], df['close'], df['volume'], df['vwap']
  df['fg_value'] — Fear & Greed 0-100 (always present, defaults to 50)
  df['fg_class'] — Fear & Greed label string
NEVER use df['timestamp'], df['date'], df['price'] or any other column name.

Return value: a Python LIST of dicts, each dict MUST have:
  entry        — unix timestamp (int) from df['time'], when trade opens
  exit         — unix timestamp (int) from df['time'], when trade closes
  side         — 'long' or 'short'
  entry_price  — float, the price at entry
  exit_price   — float, the price at exit

Do NOT use any placeholders or "# ..." comments — every line must be real Python code.
Function must end with "return trades".

Compute indicators inline using ONLY these exact patterns (no other method names):
  EMA:     df['close'].ewm(span=N, adjust=False).mean()
  SMA:     df['close'].rolling(N).mean()
  RSI:     use ta.momentum.RSIIndicator(df['close'], window=N).rsi()
  MACD:    use ta.trend.MACD(df['close'], window_slow=26, window_fast=12, window_sign=9) then .macd() / .macd_signal() / .macd_diff()
  BBands:  use ta.volatility.BollingerBands(df['close'], window=N, window_dev=2) then .bollinger_hband() / .bollinger_lband() / .bollinger_mavg()
  ATR:     use ta.volatility.AverageTrueRange(df['high'], df['low'], df['close'], window=N).average_true_range()
  Stoch:   use ta.momentum.StochasticOscillator(df['high'], df['low'], df['close'], window=N).stoch()
NEVER call .ema_N, .rsi_N, or any method with the period in the name — those do not exist.

Optionally, after [Parameters], include a [Workflow JSON] section with a JSON object representing the strategy as visual rules:
[Workflow JSON]
{ "version": 1, "rules": [{ "id": "r1", "enabled": true, "entry": { "logic": "AND", "conditions": [{ "id": "c1", "left": { "indicator": "rsi", "params": { "period": 14 } }, "op": "crosses above", "right": { "type": "value", "value": 30 } }] }, "action": "BUY (long)", "exit": { "logic": "OR", "conditions": [{ "id": "e1", "type": "rsi_overbought", "params": { "period": 14, "threshold": 70 } }] } }] }
Valid indicator ids: price, sma, ema, rsi, macd, bbands, volume, fg, unlock, pct_change
Valid exit types: rsi_overbought, rsi_oversold, take_profit, stop_loss, bars_held, crosses_back`
}

function buildWorkflowCodePrompt(context: string): string {
  return `You are an expert quantitative trading strategy builder.
Convert the following visual workflow description EXACTLY into a working Python strategy function.

Context: ${context}

RULES:
- Function signature: def strategy(df, unlocks):
- Return list of trade dicts: entry (unix int from df['time']), exit (unix int from df['time']), side ('long'/'short'), entry_price (float), exit_price (float)
- DataFrame columns: df['time'] (unix int), df['open'], df['high'], df['low'], df['close'], df['volume'], df['vwap']
- NEVER use df['timestamp'], df['date'], df['price']
- EMA: df['close'].ewm(span=N, adjust=False).mean()
- RSI: ta.momentum.RSIIndicator(df['close'], window=N).rsi()
- SMA: df['close'].rolling(N).mean()
- ATR: ta.volatility.AverageTrueRange(df['high'], df['low'], df['close'], window=N).average_true_range()
- No placeholders. Complete working code. Function must end with "return trades".

MULTI-RULE PRIORITY (CRITICAL):
- Rules are ordered top-to-bottom by priority. Rule 1 is checked first.
- On each bar, evaluate rules in order. The FIRST rule whose entry conditions are met triggers a trade.
- Once a rule triggers an entry, skip all lower-priority rules for that bar.
- Only ONE position can be open at a time — no overlapping trades.
- Each rule manages its own exit independently once it has opened a position.
- Implement this as a priority waterfall: check rule 1, elif rule 2, elif rule 3, etc.

OUTPUT: Respond with ONLY the Python function in a single \`\`\`python code block. No explanations.`
}

function buildRefinementPrompt(context: string, _userMsg: string): string {
  return `You are an expert quantitative trading strategy builder.
The user is REFINING an existing strategy - they want a specific change, NOT a brand-new strategy.

Context: ${context}

RESPOND WITH EXACTLY THESE THREE SECTIONS:

[Algorithm]
In 2-3 sentences, describe ONLY what changed vs the previous version.

[Python Code]
The COMPLETE, fully-working updated strategy function with the requested change applied.
Every line must be real Python - no placeholders, no "# ...", no pass.
Function must end with "return trades".

[Parameters]
Only list parameters that changed or were added. Keep brief.

Do NOT use markdown headers (###) - only [Algorithm], [Python Code], [Parameters] labels.
DataFrame columns: df['time'] (unix int), df['open'], df['high'], df['low'], df['close'], df['volume'], df['vwap']. NEVER use df['timestamp'], df['date'], df['price'].
Indicator patterns: EMA → .ewm(span=N, adjust=False).mean() | RSI → ta.momentum.RSIIndicator(close, window=N).rsi() | MACD → ta.trend.MACD(close).macd()/.macd_signal() | BBands → ta.volatility.BollingerBands(close, window=N).bollinger_hband()/.bollinger_lband() | ATR → ta.volatility.AverageTrueRange(high,low,close,window=N).average_true_range()
NEVER use method names like .ema_50, .rsi_14 etc.`
}

function extractCode(raw: string): string {
  const fenceOpen = raw.indexOf('```')
  if (fenceOpen === -1) return raw.trim()
  const afterOpen = raw.indexOf('\n', fenceOpen)
  if (afterOpen === -1) return raw.slice(fenceOpen + 3).trim()
  const body = raw.slice(afterOpen + 1)
  const lastFence = body.lastIndexOf('\n```')
  return (lastFence !== -1 ? body.slice(0, lastFence) : body).trim()
}

function parseSections(reply: string): { algorithm: string; python_code: string; parameters: string } {
  const normalised = reply
    .replace(/^\s*\*{1,2}\s*(Algorithm|Python Code|Parameters)\s*\*{0,2}\s*:?\s*$/gim, '[$1]')
    .replace(/^\s*#{1,3}\s*(Algorithm|Python Code|Parameters)\s*:?\s*$/gim, '[$1]')
  const sectionRe = /\[(Algorithm|Python Code|Parameters)\]/gi
  const sections: Record<string, string> = {}
  let m: RegExpExecArray | null
  let lastKey = ''
  let lastIdx = 0
  sectionRe.lastIndex = 0
  while ((m = sectionRe.exec(normalised)) !== null) {
    if (lastKey) sections[lastKey] = normalised.slice(lastIdx, m.index).trim()
    lastKey = m[1].toLowerCase().replace(/ /g, '_')
    lastIdx = m.index + m[0].length
  }
  if (lastKey) sections[lastKey] = normalised.slice(lastIdx).trim()
  return {
    algorithm: sections['algorithm'] || reply,
    python_code: sections['python_code'] || '',
    parameters: sections['parameters'] || '',
  }
}

function renderText(t: string): string {
  return t
    .replace(/#{1,3}\s*/g, '')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>')
}

function fmtDate(ts: number): string {
  if (!ts) return '—'
  return new Date(ts * 1000).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  })
}

function fmtPrice(p: number | null | undefined): string {
  if (p == null) return '—'
  return p < 1 ? p.toFixed(4) : p.toFixed(2)
}

function fmtPct(v: number | null | undefined): string {
  if (v == null) return '—'
  return (v >= 0 ? '+' : '') + Number(v).toFixed(2) + '%'
}

interface ChatMsgItem {
  role: 'user' | 'assistant' | 'system'
  html: string
}

export function Creator() {
  const navigate = useNavigate()
  const {
    selectedPair, selectedInterval,
    setPair, setInterval,
    strategyCode, strategyAlgo, strategyParams,
    setStrategyCode, setStrategyAlgo, setStrategyParams,
    backtestResult, setBacktestResult,
    loadedStrategy, setLoadedStrategy,
  } = useAppStore()

  const [chatMessages, setChatMessages] = useState<ChatMsgItem[]>([
    {
      role: 'system',
      html: `<p>Hi — I'm your AI strategy builder. Describe a trading strategy in plain English, or <strong>attach a chart screenshot</strong> for pattern analysis.</p><p style="margin-top:6px;opacity:.5;font-size:11px">Try: <em>"RSI mean-reversion on ARB/USD"</em></p>`,
    },
  ])
  const [chatInput, setChatInput] = useState('')
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([])
  const [pendingImage, setPendingImage] = useState<{ base64: string; mime: string; name: string } | null>(null)
  const [priceChartH, setPriceChartH] = useState(240)
  const [rightColH, setRightColH] = useState(0)
  const rightColRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!rightColRef.current) return
    const h = rightColRef.current.clientHeight
    setRightColH(h)
    setPriceChartH(Math.floor(h * 0.4))
  }, [])
  const [btTo, setBtTo] = useState(() => new Date().toISOString().split('T')[0])
  const [btInterval, setBtInterval] = useState('1D')
  const [btFrom, setBtFrom] = useState(() => {
    // Default: 720 candles back at 1D = 720 days
    const d = new Date(); d.setDate(d.getDate() - 720); return d.toISOString().split('T')[0]
  })
  const [activeTab, setActiveTab] = useState('overview')
  const [stratName, setStratName] = useState('New Strategy')
  const [stratSaved, setStratSaved] = useState(false)
  const [saveModalOpen, setSaveModalOpen] = useState(false)
  const [saveNameInput, setSaveNameInput] = useState('')
  const [saveDescInput, setSaveDescInput] = useState('')
  const [saveTagsInput, setSaveTagsInput] = useState('')
  const [codeHistory, setCodeHistory] = useState<string[]>([])
  const [historyIdx, setHistoryIdx] = useState(-1)
  const [btStatusLabel, setBtStatusLabel] = useState('Run a backtest to see performance')
  const [localBtResult, setLocalBtResult] = useState<BacktestResult | null>(null)
  const [workflow, setWorkflow] = useState<Workflow>(emptyWorkflow)
  const [panelMode, setPanelMode] = useState<'chat' | 'workflow'>('chat')
  const [leftSplit, setLeftSplit] = useState(50) // % height for top-left panel

  const chatMessagesRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const leftColRef = useRef<HTMLDivElement>(null)
  const mainChartRef = useRef<IChartApi | null>(null)

  function onRowResizerMouseDown(e: React.MouseEvent) {
    e.preventDefault()
    const col = leftColRef.current
    if (!col) return
    const startY = e.clientY
    const startPct = leftSplit
    const totalH = col.clientHeight

    const onMove = (mv: MouseEvent) => {
      const delta = mv.clientY - startY
      const newPct = Math.min(80, Math.max(20, startPct + (delta / totalH) * 100))
      setLeftSplit(newPct)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  function onRightResizerMouseDown(e: React.MouseEvent) {
    e.preventDefault()
    const startY = e.clientY
    const startH = priceChartH
    const onMove = (mv: MouseEvent) => {
      const newH = Math.max(80, Math.min(800, startH + mv.clientY - startY))
      setPriceChartH(newH)
    }
    const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  function onPriceResizerMouseDown(e: React.MouseEvent) {
    e.preventDefault()
    const startY = e.clientY
    const startH = priceChartH
    const onMove = (mv: MouseEvent) => {
      const newH = Math.max(80, Math.min(600, startH + mv.clientY - startY))
      setPriceChartH(newH)
    }
    const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // Load pairs for selector
  const { data: pairsData } = useQuery({
    queryKey: ['pairs'],
    queryFn: marketDataApi.getPairs,
    staleTime: 5 * 60_000,
  })

  // If loadedStrategy is set, populate the form
  useEffect(() => {
    if (loadedStrategy) {
      setStrategyCode(loadedStrategy.code || '')
      setStrategyAlgo(loadedStrategy.algo || '')
      setStrategyParams(loadedStrategy.params_text || '')
      setStratName(loadedStrategy.name)
      setStratSaved(true)
      if (loadedStrategy.pair) setPair(loadedStrategy.pair)
      setChatMessages(prev => [...prev, {
        role: 'system',
        html: `<p style="color:var(--accent)">✓ Loaded <strong>${loadedStrategy.name}</strong> from Library. You can now chat to refine it, or run a backtest.</p>`,
      }])
      setLoadedStrategy(null)
      setPanelMode('chat')
    }
  }, [loadedStrategy, setLoadedStrategy, setStrategyCode, setStrategyAlgo, setStrategyParams, setPair])

  // Pick up initConfig from Initiator
  useEffect(() => {
    const raw = sessionStorage.getItem('initConfig')
    if (!raw) return
    try {
      const cfg = JSON.parse(raw)
      sessionStorage.removeItem('initConfig')
      if (cfg.pair) setPair(cfg.pair)
      if (cfg.interval) setInterval(cfg.interval)
      if (cfg.start) setBtFrom(cfg.start)
      if (cfg.end) setBtTo(cfg.end)
      if (cfg.enrichedPrompt) {
        // Auto-send after a short delay so React state has settled
        setTimeout(() => {
          setChatMessages((prev) => [
            ...prev,
            { role: 'user', html: `<p>${cfg.enrichedPrompt.replace(/\n/g, '<br>')}</p>` },
            { role: 'assistant', html: '<div class="chat-thinking"><div class="thinking-dot"></div><div class="thinking-dot"></div><div class="thinking-dot"></div></div>' },
          ])
          chatMutation.mutate(cfg.enrichedPrompt, {
            onSettled: () => {
              setChatMessages(prev => prev.filter(m => !m.html.includes('thinking-dot')))
            },
          })
        }, 300)
      }
    } catch {}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Scroll chat to bottom
  useEffect(() => {
    if (chatMessagesRef.current) {
      chatMessagesRef.current.scrollTop = chatMessagesRef.current.scrollHeight
    }
  }, [chatMessages])

  const intervalMap: Record<string, number> = { '1m': 1, '5m': 5, '15m': 15, '1h': 60, '4h': 240, '1D': 1440 }

  const MAX_CANDLES = 720
  const maxDays = Math.floor(MAX_CANDLES * (intervalMap[btInterval] ?? 1440) / 1440) || 1

  function clampFrom(from: string, to: string, maxD: number): string {
    const toDate = new Date(to)
    const earliest = new Date(toDate)
    earliest.setDate(earliest.getDate() - maxD)
    const fromDate = new Date(from)
    return fromDate < earliest ? earliest.toISOString().split('T')[0] : from
  }

  // Clamp btFrom whenever interval or btTo changes
  useEffect(() => {
    setBtFrom(prev => clampFrom(prev, btTo, maxDays))
  }, [btInterval, btTo, maxDays])

  const candleCount = Math.round((new Date(btTo).getTime() - new Date(btFrom).getTime()) / (1000 * 60 * (intervalMap[btInterval] ?? 1440)))

  const chatMutation = useMutation({
    mutationFn: async (msg: string) => {
      const pair = selectedPair
      const context = `Pair: ${pair}. Period: ${btFrom} to ${btTo}. Interval: ${btInterval}.`
      const isFollowUp = chatHistory.length >= 2 && !!strategyCode
      const systemPrompt = isFollowUp
        ? buildRefinementPrompt(context, msg)
        : buildSystemPrompt(context, msg)

      if (pendingImage) {
        return chatApi.sendVision({
          message: msg || 'Analyze this chart and create a trading strategy based on the patterns you see.',
          image_base64: pendingImage.base64,
          mime_type: pendingImage.mime,
          system: systemPrompt,
          current_code: strategyCode,
        })
      }
      return chatApi.send({
        message: msg,
        system: systemPrompt,
        history: chatHistory,
        current_code: strategyCode,
      })
    },
    onSuccess: (data) => {
      if (data.error && !data.reply) {
        setChatMessages(prev => [...prev, { role: 'assistant', html: `<span style="color:var(--neg)">⚠️ ${data.error}</span>` }])
        return
      }
      const reply = data.reply || ''
      const sections = parseSections(reply)
      let rawCode = extractCode(sections.python_code)
      if (!rawCode) {
        const wholeMatch = reply.match(/```(?:python)?\n([\s\S]+?def strategy[\s\S]+?)\n```/)
        if (wholeMatch) rawCode = wholeMatch[1].trim()
      }
      if (!rawCode) {
        const defMatch = reply.match(/(def strategy\([\s\S]+?return trades)/)
        if (defMatch) rawCode = defMatch[1].trim()
      }

      setChatHistory(prev => {
        const next = [...prev, { role: 'user' as const, text: chatInput }, { role: 'model' as const, text: reply }]
        return next.length > 20 ? next.slice(next.length - 20) : next
      })

      setChatMessages(prev => [...prev, {
        role: 'assistant',
        html: renderText(sections.algorithm),
      }])

      if (rawCode) {
        setStrategyCode(rawCode)
        setStrategyAlgo(sections.algorithm)
        setStrategyParams(sections.parameters)
        setStratName('Unsaved Strategy')
        setStratSaved(false)
        setCodeHistory(prev => {
          const last = prev[prev.length - 1]
          if (last === rawCode) return prev
          return [...prev, rawCode]
        })
        setHistoryIdx(prev => prev + 1)
      }
      // Parse optional workflow JSON from AI reply
      const parsedWf = parseWorkflowFromReply(reply)
      if (parsedWf) setWorkflow(parsedWf)
    },
    onError: (err: Error) => {
      setChatMessages(prev => [...prev, { role: 'assistant', html: `<span style="color:var(--neg)">Error: ${err.message}</span>` }])
    },
  })

  const sendChat = useCallback(() => {
    const msg = chatInput.trim()
    if (!msg && !pendingImage) return
    const displayMsg = msg || '(chart image attached)'
    setChatMessages(prev => [...prev, {
      role: 'user',
      html: `${msg.replace(/</g, '&lt;').replace(/>/g, '&gt;')}${pendingImage ? ' <span style="opacity:.7;font-size:11px">📷 chart attached</span>' : ''}`,
    }])
    setChatMessages(prev => [...prev, { role: 'assistant', html: '<div class="chat-thinking"><div class="thinking-dot"></div><div class="thinking-dot"></div><div class="thinking-dot"></div></div>' }])
    chatMutation.mutate(displayMsg, {
      onSettled: () => {
        setChatMessages(prev => prev.filter(m => !m.html.includes('thinking-dot')))
      },
    })
    setChatInput('')
    setPendingImage(null)
  }, [chatInput, pendingImage, chatMutation])

  const wfChatMutation = useMutation({
    mutationFn: (desc: string) => {
      const context = `Pair: ${selectedPair}. Period: ${btFrom} to ${btTo}. Interval: ${btInterval}.`
      return chatApi.send({
        message: desc,
        system: buildWorkflowCodePrompt(context),
        history: [],
        current_code: '',
      })
    },
    onSuccess: (data) => {
      const reply = data.reply || ''
      let rawCode = extractCode(reply)
      if (!rawCode) {
        const m = reply.match(/(def strategy\([\s\S]+?return trades)/)
        if (m) rawCode = m[1].trim()
      }
      if (rawCode) {
        setStrategyCode(rawCode)
        setStratName('Unsaved Strategy')
        setStratSaved(false)
        setCodeHistory(prev => [...prev, rawCode])
        setHistoryIdx(prev => prev + 1)
      }
    },
  })

  function handleWorkflowChange(wf: Workflow) {
    setWorkflow(wf)
  }

  function submitWorkflow() {
    const activeRules = workflow.rules.filter(r => r.enabled && r.entry.conditions.length > 0)
    if (!activeRules.length) return
    const desc = workflowToNaturalLanguage(workflow)
    wfChatMutation.mutate(desc)
  }

  const backtestMutation = useMutation({
    mutationFn: () => {
      const interval = intervalMap[btInterval] ?? 1440
      const indicators = parseIndicators(strategyCode, workflow)
      return backtestApi.run({
        pair: selectedPair,
        interval,
        start: btFrom,
        end: btTo,
        script: strategyCode,
        indicators,
      })
    },
    onSuccess: (data) => {
      if (data.error) {
        setBtStatusLabel(`Error: ${data.error}`)
        return
      }
      setLocalBtResult(data)
      setBacktestResult(data)
      const n = data.trades?.length ?? 0
      setBtStatusLabel(`${n} trade${n !== 1 ? 's' : ''} · ${selectedPair} · ${btFrom} → ${btTo}`)
      setActiveTab('overview')
    },
    onError: (err: Error) => {
      setBtStatusLabel(`Backtest failed: ${err.message}`)
    },
  })

  const saveMutation = useMutation({
    mutationFn: () => strategiesApi.save({
      name: saveNameInput.trim(),
      description: saveDescInput.trim(),
      code: strategyCode,
      algo: strategyAlgo,
      params_text: strategyParams,
      pair: selectedPair,
      interval: intervalMap[btInterval] ?? 1440,
      tags: saveTagsInput.split(',').map(t => t.trim()).filter(Boolean),
      stats: localBtResult?.stats,
    }),
    onSuccess: () => {
      setSaveModalOpen(false)
      setStratName(saveNameInput.trim())
      setStratSaved(true)
    },
  })

  const handleImageFile = (file: File) => {
    const reader = new FileReader()
    reader.onload = (ev) => {
      const dataUrl = ev.target?.result as string
      const b64 = dataUrl.split(',')[1]
      setPendingImage({ base64: b64, mime: file.type || 'image/jpeg', name: file.name })
    }
    reader.readAsDataURL(file)
  }

  const result = localBtResult || backtestResult
  const trades = result?.trades || []
  const stats = result?.stats

  // Monthly P&L calculation
  const monthlyMap: Record<number, Record<number, number>> = {}
  trades.forEach(t => {
    if (!t.exit || t.return_pct == null) return
    const d = new Date(t.exit * 1000)
    const yr = d.getUTCFullYear()
    const mo = d.getUTCMonth()
    if (!monthlyMap[yr]) monthlyMap[yr] = {}
    monthlyMap[yr][mo] = (monthlyMap[yr][mo] || 0) + t.return_pct
  })

  function heatClass(v: number | undefined): string {
    if (v == null) return ''
    if (v === 0) return 'zero'
    const abs = Math.abs(v)
    const lvl = abs > 10 ? 3 : abs > 4 ? 2 : 1
    return (v > 0 ? 'pos-' : 'neg-') + lvl
  }

  const MONTHS = ['J','F','M','A','M','J','J','A','S','O','N','D']
  const years = Object.keys(monthlyMap).sort()

  // Performance tab stats
  function buildPerfStats(subset: Trade[]) {
    if (!subset.length) return []
    const wins = subset.filter(t => t.return_pct > 0)
    const losses = subset.filter(t => t.return_pct <= 0)
    const total = subset.reduce((a, t) => a + (t.return_pct || 0), 0)
    const avgW = wins.length ? wins.reduce((a, t) => a + t.return_pct, 0) / wins.length : null
    const avgL = losses.length ? losses.reduce((a, t) => a + t.return_pct, 0) / losses.length : null
    return [
      { label: 'Trades', val: String(subset.length), cls: '' },
      { label: 'Win Rate', val: (100 * wins.length / subset.length).toFixed(1) + '%', cls: '' },
      { label: 'Net P&L', val: (total >= 0 ? '+' : '') + total.toFixed(2) + '%', cls: total >= 0 ? 'pos' : 'neg' },
      { label: 'Avg Win', val: avgW != null ? '+' + avgW.toFixed(2) + '%' : '—', cls: 'pos' },
      { label: 'Avg Loss', val: avgL != null ? avgL.toFixed(2) + '%' : '—', cls: 'neg' },
      { label: 'Best', val: subset.reduce((m, t) => Math.max(m, t.return_pct || 0), -Infinity).toFixed(2) + '%', cls: 'pos' },
      { label: 'Worst', val: subset.reduce((m, t) => Math.min(m, t.return_pct || 0), Infinity).toFixed(2) + '%', cls: 'neg' },
    ]
  }

  const longs = trades.filter((t: Trade) => t.side === 'long')
  const shorts = trades.filter((t: Trade) => t.side === 'short')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Topbar */}
      <div className="creator-topbar">
        <div className="topbar-left">
          <div className={`strat-name-pill${stratSaved ? ' saved' : strategyCode ? ' unsaved' : ''}`}>
            <svg width="9" height="9" viewBox="0 0 12 12" fill="none">
              <path d="M2 10V4l4-2 4 2v6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
              <rect x="4" y="6" width="4" height="4" rx=".5" stroke="currentColor" strokeWidth="1.2"/>
            </svg>
            <span>{stratName}</span>
          </div>
          <div className="topbar-sep"></div>
          <button className="btn-topbar" onClick={() => {
            setStrategyCode(''); setStrategyAlgo(''); setStrategyParams('')
            setStratName('New Strategy'); setStratSaved(false)
            setLocalBtResult(null); setBacktestResult(null)
            setChatMessages([{ role: 'system', html: '<p>Ready for a new strategy. Describe what you want to build.</p>' }])
            setChatHistory([])
          }}>New</button>
          <button className="btn-topbar" onClick={() => navigate('/library')}>Import</button>
          {strategyCode && (
            <button className="btn-topbar accent" onClick={() => {
              setSaveNameInput(stratSaved ? stratName : '')
              setSaveDescInput('')
              setSaveTagsInput('')
              setSaveModalOpen(true)
            }}>Save</button>
          )}
        </div>
        <div className="topbar-controls">
          <div className="ctrl-group">
            <label className="ctrl-label">Pair</label>
            <select className="ctrl-select-inline" value={selectedPair} onChange={e => setPair(e.target.value)}>
              {pairsData?.map(p => (
                <option key={p.pair} value={p.pair}>{p.pair}</option>
              )) || <option value={selectedPair}>{selectedPair}</option>}
            </select>
          </div>
          <div className="ctrl-sep"></div>
          <div className="ctrl-group">
            <label className="ctrl-label">From</label>
            <input
              type="date"
              className="ctrl-date-inline"
              value={btFrom}
              min={(() => { const d = new Date(btTo); d.setDate(d.getDate() - maxDays); return d.toISOString().split('T')[0] })()}
              max={btTo}
              onChange={e => setBtFrom(clampFrom(e.target.value, btTo, maxDays))}
            />
          </div>
          <div className="ctrl-group">
            <label className="ctrl-label">To</label>
            <input type="date" className="ctrl-date-inline" value={btTo} max={new Date().toISOString().split('T')[0]} onChange={e => setBtTo(e.target.value)} />
          </div>
          <div className="ctrl-group">
            <label className="ctrl-label">Interval</label>
            <select className="ctrl-select-inline sm" value={btInterval} onChange={e => setBtInterval(e.target.value)}>
              <option value="1D">1D</option>
              <option value="4h">4H</option>
              <option value="1h">1H</option>
              <option value="15m">15m</option>
            </select>
          </div>
          <div className="ctrl-group" style={{ opacity: 0.5 }}>
            <label className="ctrl-label">Candles</label>
            <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>{candleCount} / {MAX_CANDLES}</span>
          </div>
        </div>
      </div>

      {/* 2x2 Grid */}
      <div className="creator-grid" style={{ flex: 1, minHeight: 0 }}>
        {/* Left Column */}
        <div className="grid-left" ref={leftColRef}>
          {/* Chat / Workflow Panel */}
          <div className="grid-panel panel-chat" style={{ flex: `0 0 ${leftSplit}%` }}>
            <div className="panel-header">
              <div className="view-toggle" role="group">
                <button className={`view-toggle-btn${panelMode === 'chat' ? ' active' : ''}`} onClick={() => setPanelMode('chat')}>💬 Chat</button>
                <button className={`view-toggle-btn${panelMode === 'workflow' ? ' active' : ''}`} onClick={() => setPanelMode('workflow')}>⬡ Workflow</button>
              </div>
            </div>

            {/* Chat mode */}
            {panelMode === 'chat' && (<>
              <div className="chat-messages" ref={chatMessagesRef}>
                {chatMessages.map((msg, i) => (
                  <div key={i} className={`chat-msg ${msg.role}`}>
                    {msg.role !== 'system' && (
                      <div className={`chat-avatar${msg.role === 'assistant' ? ' ai' : ''}`}>
                        {msg.role === 'user' ? 'Me' : 'AI'}
                      </div>
                    )}
                    <div className="chat-bubble" dangerouslySetInnerHTML={{ __html: msg.html }} />
                  </div>
                ))}
              </div>
              {pendingImage && (
                <div className="image-preview-bar">
                  <div className="image-preview-inner">
                    <img src={`data:${pendingImage.mime};base64,${pendingImage.base64}`} alt="preview" className="image-thumb" />
                    <div className="image-preview-info">
                      <span className="image-name">{pendingImage.name}</span>
                      <span className="image-hint">AI will analyze this chart</span>
                    </div>
                    <button className="btn-remove-image" onClick={() => setPendingImage(null)}>✕</button>
                  </div>
                </div>
              )}
              <div className="chat-input-bar">
                <input type="file" ref={fileInputRef} accept="image/*" style={{ display: 'none' }}
                  onChange={e => { const f = e.target.files?.[0]; if (f) handleImageFile(f); e.target.value = '' }} />
                <div className="chat-input-row">
                  <textarea
                    className="chat-input" rows={2} placeholder="Describe your strategy…"
                    value={chatInput}
                    onChange={e => setChatInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendChat() } }}
                  />
                </div>
                <div className="chat-action-row">
                  <button className={`btn-attach${pendingImage ? ' active' : ''}`} onClick={() => fileInputRef.current?.click()}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="3" width="18" height="18" rx="2"/>
                      <circle cx="8.5" cy="8.5" r="1.5"/>
                      <polyline points="21 15 16 10 5 21"/>
                    </svg>
                    <span>Chart</span>
                  </button>
                  <button className="btn-generate" onClick={sendChat} disabled={chatMutation.isPending}>
                    {chatMutation.isPending ? 'Thinking…' : 'Generate'}
                    {!chatMutation.isPending && (
                      <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
                        <path d="M2 8h12M10 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    )}
                  </button>
                </div>
              </div>
            </>)}

            {/* Workflow mode */}
            {panelMode === 'workflow' && (<>
              <div className="wf-view-panel" style={{ flex: 1, minHeight: 0 }}>
                <WorkflowBuilder workflow={workflow} onChange={handleWorkflowChange} />
              </div>
              <div className="chat-input-bar" style={{ borderTop: '1px solid var(--border)' }}>
                <div className="chat-action-row" style={{ justifyContent: 'flex-end' }}>
                  <button
                    className="btn-generate"
                    onClick={submitWorkflow}
                    disabled={wfChatMutation.isPending || !workflow.rules.some(r => r.enabled)}
                  >
                    {wfChatMutation.isPending ? (
                      <><Spinner size={11} /> Generating…</>
                    ) : (
                      <>Generate Code
                        <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
                          <path d="M2 8h12M10 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      </>
                    )}
                  </button>
                </div>
              </div>
            </>)}
          </div>

          <div className="row-resizer" onMouseDown={onRowResizerMouseDown} style={{ cursor: 'row-resize' }}></div>

          {/* Code Panel */}
          <div className="grid-panel panel-code" style={{ flex: `0 0 ${100 - leftSplit}%` }}>
            <div className="panel-header">
              <span className="panel-title" style={{ fontSize: 11, fontWeight: 600, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>&lt;/&gt; Code</span>
              {codeHistory.length > 1 && (
                <div className="code-history-nav" style={{ display: 'flex', alignItems: 'center', gap: 2, marginLeft: 'auto' }}>
                  <button className="btn-update-code" disabled={historyIdx <= 0}
                    onClick={() => { const idx = historyIdx - 1; setHistoryIdx(idx); setStrategyCode(codeHistory[idx]) }}>‹</button>
                  <span className="code-hist-counter">{historyIdx + 1} / {codeHistory.length}</span>
                  <button className="btn-update-code" disabled={historyIdx >= codeHistory.length - 1}
                    onClick={() => { const idx = historyIdx + 1; setHistoryIdx(idx); setStrategyCode(codeHistory[idx]) }}>›</button>
                </div>
              )}
            </div>
            <div className="col-code-inner" style={{ flex: 1, minHeight: 0 }}>
              <>
                {!strategyCode && (
                  <div className="code-empty-state">
                    <svg width="28" height="28" viewBox="0 0 40 40" fill="none">
                      <path d="M12 16l-6 4 6 4M28 16l6 4-6 4M22 12l-4 16" stroke="#2a2a2a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                    <span>Generate a strategy to see the code</span>
                  </div>
                )}
                {strategyCode && (
                  <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                    {strategyAlgo && (
                      <div className="code-section">
                        <div className="code-section-label">Algorithm <span className="code-section-tag">Logic</span></div>
                        <div className="code-algo-body" dangerouslySetInnerHTML={{ __html: `<p>${renderText(strategyAlgo)}</p>` }} />
                      </div>
                    )}
                    <div className="code-section" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                      <div className="code-section-label">
                        Python Code <span className="code-section-tag">Strategy</span>
                        <button className="btn-update-code" onClick={() => {
                          setStratName('Unsaved Strategy'); setStratSaved(false)
                        }}>Update</button>
                      </div>
                      <div style={{ flex: 1, minHeight: 200 }}>
                        <CodeEditor
                          value={strategyCode}
                          onChange={(v) => setStrategyCode(v)}
                          height="100%"
                        />
                      </div>
                    </div>
                    {strategyParams && (
                      <div className="code-section">
                        <div className="code-section-label">Parameters <span className="code-section-tag">Config</span></div>
                        <div id="out-params" dangerouslySetInnerHTML={{ __html: `<p>${renderText(strategyParams)}</p>` }} />
                      </div>
                    )}
                  </div>
                )}
              </>
            </div>
          </div>
        </div>

        <div className="col-resizer"></div>

        {/* Right Column */}
        <div className="grid-right" ref={rightColRef}>
          {/* Price Chart */}
          <div className="grid-panel panel-chart">
            <div className="panel-header">
              <span className="panel-title">Price Chart</span>
              <span className="panel-hint">
                {result ? `${selectedPair} · ${btFrom} → ${btTo}` : 'Run a backtest to see trade entries & exits'}
              </span>
            </div>
            <div className="panel-body chart-body">
              {!result && (
                <div className="bt-chart-empty">
                  <svg width="28" height="28" viewBox="0 0 48 48" fill="none">
                    <rect x="4" y="28" width="7" height="16" rx="1.5" fill="#1e1e22"/>
                    <rect x="15" y="18" width="7" height="26" rx="1.5" fill="#1e1e22"/>
                    <rect x="26" y="22" width="7" height="22" rx="1.5" fill="#1e1e22"/>
                    <rect x="37" y="10" width="7" height="34" rx="1.5" fill="#1e1e22"/>
                  </svg>
                  <span>Run a backtest to see candlesticks with trade entries &amp; exits</span>
                </div>
              )}
              {backtestMutation.isPending && (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 10 }}>
                  <Spinner size={22} />
                  <span style={{ color: 'var(--t3)', fontSize: 12 }}>Running backtest…</span>
                </div>
              )}
              {result && !backtestMutation.isPending && result.ohlcv?.length > 0 && (() => {
                const hasOscillators = Object.keys(result.indicator_data ?? {}).length > 0
                return (
                  <div style={{ width: '100%' }}>
                    <div style={{ height: priceChartH }}>
                      <CandlestickChart
                        candles={result.ohlcv}
                        trades={trades}
                        indicatorData={result.indicator_data ?? {}}
                        indicatorMeta={result.indicator_meta ?? {}}
                        chartRef={mainChartRef}
                      />
                    </div>
                    {hasOscillators && <div className="panel-drag-handle" onMouseDown={onPriceResizerMouseDown} />}
                    {hasOscillators && (
                      <IndicatorPanel
                        indicatorData={result.indicator_data ?? {}}
                        indicatorMeta={result.indicator_meta ?? {}}
                        mainChartRef={mainChartRef}
                        containerH={rightColH}
                      />
                    )}
                  </div>
                )
              })()}
            </div>
          </div>

          <div className="row-resizer" onMouseDown={onRightResizerMouseDown}></div>

          {/* Results Panel */}
          <div className="grid-panel panel-results">
            <div className="panel-header results-header">
              <div className="bt-tabs">
                {['overview', 'perfsummary', 'trades', 'properties'].map(tab => (
                  <button key={tab} className={`bt-tab${activeTab === tab ? ' active' : ''}`}
                    onClick={() => setActiveTab(tab)}>
                    {tab === 'perfsummary' ? 'Performance' : tab === 'trades'
                      ? <>Trades {trades.length > 0 && <span className="bt-trade-badge">{trades.length}</span>}</>
                      : tab.charAt(0).toUpperCase() + tab.slice(1)}
                  </button>
                ))}
              </div>
              <button className="btn-run" onClick={() => backtestMutation.mutate()} disabled={!strategyCode || backtestMutation.isPending}>
                {backtestMutation.isPending ? <Spinner size={12} /> : (
                  <svg width="9" height="9" viewBox="0 0 14 14" fill="none">
                    <path d="M3 2l9 5-9 5V2z" fill="currentColor"/>
                  </svg>
                )}
                {backtestMutation.isPending ? 'Running…' : 'Run Backtest'}
              </button>
            </div>
            <div className="results-status">{btStatusLabel}</div>

            {/* Overview Tab */}
            {activeTab === 'overview' && (
              <div className="bt-tab-panel active" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden' }}>
                <div className="bt-overview-metrics">
                  <div className="bt-ov-metric">
                    <div className="bt-ov-label">Net P&L</div>
                    <div className={`bt-ov-value${stats ? (stats.total_return! >= 0 ? ' pos' : ' neg') : ''}`}>
                      {stats ? fmtPct(stats.total_return) : '—'}
                    </div>
                    <div className="bt-ov-sub">Net return on equity</div>
                  </div>
                  <div className="bt-ov-metric">
                    <div className="bt-ov-label">Max Drawdown</div>
                    <div className="bt-ov-value neg">{stats ? '-' + Math.abs(stats.max_drawdown || 0).toFixed(2) + '%' : '—'}</div>
                    <div className="bt-ov-bar-wrap"><div className="bt-ov-bar neg" style={{ width: `${Math.min(100, Math.abs(stats?.max_drawdown || 0))}%` }}></div></div>
                  </div>
                  <div className="bt-ov-metric">
                    <div className="bt-ov-label">Profit Factor</div>
                    <div className="bt-ov-value">{stats?.profit_factor != null ? Number(stats.profit_factor).toFixed(2) : '—'}</div>
                  </div>
                  <div className="bt-ov-metric">
                    <div className="bt-ov-label">Win Rate</div>
                    <div className="bt-ov-value">{stats?.win_rate != null ? Number(stats.win_rate).toFixed(1) + '%' : '—'}</div>
                    <div className="bt-ov-bar-wrap"><div className="bt-ov-bar pos" style={{ width: `${Math.min(100, stats?.win_rate || 0)}%` }}></div></div>
                  </div>
                  <div className="bt-ov-metric">
                    <div className="bt-ov-label">Trades</div>
                    <div className="bt-ov-value">{stats?.total_trades ?? '—'}</div>
                    <div className="bt-ov-sub">
                      <span className="pos">{stats?.winning_trades ?? '—'}</span> W ·{' '}
                      <span className="neg">{stats?.losing_trades ?? '—'}</span> L
                    </div>
                  </div>
                </div>
                <div className="bt-equity-zone">
                  {!result && (
                    <div className="bt-chart-empty">
                      <svg width="20" height="20" viewBox="0 0 40 40" fill="none">
                        <polyline points="2,32 10,20 18,26 28,12 38,16" stroke="#2a2a2a" strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                      <span>Equity curve appears here after backtest</span>
                    </div>
                  )}
                  {result?.equity && result.equity.length > 0 && (
                    <EquityChart equity={result.equity} height={150} />
                  )}
                </div>
                <div className="bt-monthly-strip">
                  <div className="bt-monthly-strip-label">Monthly P&L</div>
                  <div className="bt-monthly-scroll">
                    {years.length === 0 ? (
                      <div className="bt-monthly-empty">—</div>
                    ) : (
                      <table className="bt-monthly-grid">
                        <thead>
                          <tr>
                            <th></th>
                            {MONTHS.map(m => <th key={m}>{m}</th>)}
                            <th style={{ textAlign: 'right', paddingLeft: 4 }}>Yr</th>
                          </tr>
                        </thead>
                        <tbody>
                          {years.map(yr => {
                            const yrNum = Number(yr)
                            const yrTotal = Object.values(monthlyMap[yrNum]).reduce((a, b) => a + b, 0)
                            return (
                              <tr key={yr}>
                                <td className="bt-monthly-year">{yr}</td>
                                {Array.from({ length: 12 }, (_, m) => {
                                  const v = monthlyMap[yrNum]?.[m]
                                  if (v == null) return <td key={m}></td>
                                  const txt = (v >= 0 ? '+' : '') + v.toFixed(1) + '%'
                                  return <td key={m}><div className={`bt-monthly-cell ${heatClass(v)}`} title={txt}>{txt}</div></td>
                                })}
                                <td className={`bt-monthly-total bt-cell-pnl ${heatClass(yrTotal)}`}>
                                  {(yrTotal >= 0 ? '+' : '') + yrTotal.toFixed(1) + '%'}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Performance Tab */}
            {activeTab === 'perfsummary' && (
              <div className="bt-tab-panel active" style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
                <div className="bt-perf-grid">
                  {[
                    { header: 'All Trades', rows: stats ? [
                      { label: 'Net P&L', val: fmtPct(stats.total_return), cls: (stats.total_return ?? 0) >= 0 ? 'pos' : 'neg' },
                      { label: 'Profit Factor', val: stats.profit_factor != null ? Number(stats.profit_factor).toFixed(2) : '—', cls: '' },
                      { label: 'Max Drawdown', val: Number(stats.max_drawdown).toFixed(2) + '%', cls: 'neg' },
                      { label: 'Win Rate', val: Number(stats.win_rate).toFixed(1) + '%', cls: '' },
                      { label: 'Total Trades', val: String(stats.total_trades), cls: '' },
                      { label: 'Winning', val: String(stats.winning_trades ?? '—'), cls: 'pos' },
                      { label: 'Losing', val: String(stats.losing_trades ?? '—'), cls: 'neg' },
                    ] : [] },
                    { header: '▲ Long', rows: buildPerfStats(longs) },
                    { header: '▼ Short', rows: buildPerfStats(shorts) },
                  ].map(col => (
                    <div key={col.header} className="bt-perf-col">
                      <div className="bt-perf-col-header">{col.header}</div>
                      <div className="bt-perf-stats">
                        {col.rows.length === 0
                          ? <div className="bt-perf-empty">No data</div>
                          : col.rows.map(r => (
                            <div key={r.label} className="bt-perf-row">
                              <span className="bt-perf-row-label">{r.label}</span>
                              <span className={`bt-perf-row-value ${r.cls}`}>{r.val}</span>
                            </div>
                          ))
                        }
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Trades Tab */}
            {activeTab === 'trades' && (
              <div className="bt-tab-panel active" style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
                <div className="bt-trade-table-wrap">
                  <table className="bt-trade-table">
                    <thead>
                      <tr>
                        <th>#</th><th>Date</th><th>Type</th><th>Entry</th><th>Exit</th>
                        <th>P&L %</th><th>Cum.</th><th>Run-up</th><th>DD</th>
                      </tr>
                    </thead>
                    <tbody>
                      {trades.length === 0 ? (
                        <tr><td colSpan={9} className="bt-register-empty">Run a backtest to see trades</td></tr>
                      ) : (() => {
                        let cum = 0
                        return trades.map((t: Trade, i: number) => {
                          const pnl = t.return_pct ?? 0
                          cum += pnl
                          const cumStr = (cum >= 0 ? '+' : '') + cum.toFixed(2) + '%'
                          return (
                            <tr key={i}>
                              <td style={{ color: 'var(--t3)' }}>{i + 1}</td>
                              <td>{fmtDate(t.entry)}</td>
                              <td><span className={`bt-cell-side ${t.side}`}>{t.side === 'long' ? 'Entry Long' : 'Entry Short'}</span></td>
                              <td>{fmtPrice(t.entry_price)}</td>
                              <td>{fmtPrice(t.exit_price)}</td>
                              <td className={`bt-cell-pnl ${pnl >= 0 ? 'pos' : 'neg'}`}>{fmtPct(pnl)}</td>
                              <td className={`bt-cell-pnl ${cum >= 0 ? 'pos' : 'neg'}`}>{cumStr}</td>
                              <td className="pos">{pnl > 0 ? fmtPct(pnl) : '—'}</td>
                              <td className="neg">{pnl < 0 ? fmtPct(pnl) : '—'}</td>
                            </tr>
                          )
                        })
                      })()}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Properties Tab */}
            {activeTab === 'properties' && (
              <div className="bt-tab-panel active" style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
                <div className="bt-props-grid">
                  <div className="bt-props-section">
                    <div className="bt-props-title">Backtest Settings</div>
                    {[
                      ['Initial Capital', '$10,000'],
                      ['Order Size', '100% equity'],
                      ['Commission', '0%'],
                      ['Pyramiding', 'Off'],
                      ['Pair', selectedPair],
                      ['Interval', btInterval],
                      ['From', btFrom],
                      ['To', btTo],
                    ].map(([k, v]) => (
                      <div key={k} className="bt-props-row">
                        <label className="bt-props-label">{k}</label>
                        <div className="bt-props-value">{v}</div>
                      </div>
                    ))}
                  </div>
                  <div className="bt-props-section">
                    <div className="bt-props-title">Strategy Parameters</div>
                    {strategyParams ? (
                      <div style={{ fontSize: 12, color: 'var(--t2)', lineHeight: 1.6 }}
                        dangerouslySetInnerHTML={{ __html: renderText(strategyParams) }} />
                    ) : (
                      <div className="bt-perf-empty">No parameters</div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Save Modal */}
      <Modal open={saveModalOpen} onClose={() => setSaveModalOpen(false)} title="💾 Save Strategy" width={420}>
        <label className="modal-label">Strategy Name</label>
        <input className="modal-input" value={saveNameInput} onChange={e => setSaveNameInput(e.target.value)}
          placeholder="e.g. RSI Breakout v2" />
        <label className="modal-label" style={{ marginTop: 12 }}>Description (optional)</label>
        <textarea className="modal-textarea" rows={3} value={saveDescInput}
          onChange={e => setSaveDescInput(e.target.value)}
          placeholder="Briefly describe the strategy logic…" />
        <label className="modal-label" style={{ marginTop: 12 }}>Tags (comma-separated)</label>
        <input className="modal-input" value={saveTagsInput}
          onChange={e => setSaveTagsInput(e.target.value)}
          placeholder="e.g. rsi, mean-reversion, daily" />
        <div className="modal-footer">
          <button className="btn-outline" onClick={() => setSaveModalOpen(false)}>Cancel</button>
          <button className="btn-run" disabled={saveMutation.isPending || !saveNameInput.trim()}
            onClick={() => saveMutation.mutate()}>
            {saveMutation.isPending ? 'Saving…' : 'Save Strategy'}
          </button>
        </div>
      </Modal>
    </div>
  )
}
