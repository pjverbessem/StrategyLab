import { create } from 'zustand'
import type { BacktestResult, Strategy } from '@/types'

interface AppState {
  // Global pair/interval selection
  selectedPair: string
  selectedInterval: number
  setPair: (pair: string) => void
  setInterval: (interval: number) => void

  // Strategy code shared between Creator, Backtest, Library
  strategyCode: string
  strategyAlgo: string
  strategyParams: string
  setStrategyCode: (code: string) => void
  setStrategyAlgo: (algo: string) => void
  setStrategyParams: (params: string) => void

  // Last backtest result
  backtestResult: BacktestResult | null
  setBacktestResult: (result: BacktestResult | null) => void

  // Currently loaded strategy (from Library)
  loadedStrategy: Strategy | null
  setLoadedStrategy: (s: Strategy | null) => void

  // Active tab
  activeTab: string
  setActiveTab: (tab: string) => void
}

export const useAppStore = create<AppState>((set) => ({
  selectedPair: 'STRKUSD',
  selectedInterval: 1440,
  setPair: (pair) => set({ selectedPair: pair }),
  setInterval: (interval) => set({ selectedInterval: interval }),

  strategyCode: '',
  strategyAlgo: '',
  strategyParams: '',
  setStrategyCode: (code) => set({ strategyCode: code }),
  setStrategyAlgo: (algo) => set({ strategyAlgo: algo }),
  setStrategyParams: (params) => set({ strategyParams: params }),

  backtestResult: null,
  setBacktestResult: (result) => set({ backtestResult: result }),

  loadedStrategy: null,
  setLoadedStrategy: (s) => set({ loadedStrategy: s }),

  activeTab: 'creator',
  setActiveTab: (tab) => set({ activeTab: tab }),
}))
