import { Component, type ReactNode } from 'react'

interface Props { children: ReactNode; fallback?: ReactNode }
interface State { hasError: boolean; error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback ?? (
        <div style={{ padding: 24, color: 'var(--neg)' }}>
          <strong>Something went wrong:</strong>
          <pre style={{ fontSize: 12, marginTop: 8 }}>{this.state.error?.message}</pre>
        </div>
      )
    }
    return this.props.children
  }
}
