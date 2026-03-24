import { type ReactNode } from 'react'
import { NavBar } from './NavBar'

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="app-shell">
      <NavBar />
      <main className="main-content">
        {children}
      </main>
    </div>
  )
}
