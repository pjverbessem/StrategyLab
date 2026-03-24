import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import { AppShell } from '@/components/layout/AppShell'
import { ErrorBoundary } from '@/components/ui/ErrorBoundary'
import { Creator } from '@/pages/Creator'
import { Initiator } from '@/pages/Initiator'
import { Library } from '@/pages/Library'
import { Trading } from '@/pages/Trading'
import { Portfolio } from '@/pages/Portfolio'
import { DataSources } from '@/pages/DataSources'

const router = createBrowserRouter([
  {
    path: '/',
    element: (
      <ErrorBoundary>
        <AppShell>
          <Creator />
        </AppShell>
      </ErrorBoundary>
    ),
  },
  {
    path: '/initiator',
    element: (
      <ErrorBoundary>
        <AppShell>
          <Initiator />
        </AppShell>
      </ErrorBoundary>
    ),
  },
  {
    path: '/library',
    element: (
      <ErrorBoundary>
        <AppShell>
          <Library />
        </AppShell>
      </ErrorBoundary>
    ),
  },
  {
    path: '/trading',
    element: (
      <ErrorBoundary>
        <AppShell>
          <Trading />
        </AppShell>
      </ErrorBoundary>
    ),
  },
  {
    path: '/portfolio',
    element: (
      <ErrorBoundary>
        <AppShell>
          <Portfolio />
        </AppShell>
      </ErrorBoundary>
    ),
  },
  {
    path: '/sources',
    element: (
      <ErrorBoundary>
        <AppShell>
          <DataSources />
        </AppShell>
      </ErrorBoundary>
    ),
  },
])

export function Router() {
  return <RouterProvider router={router} />
}
