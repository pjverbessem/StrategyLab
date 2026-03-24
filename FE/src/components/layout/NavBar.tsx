import { useNavigate, useLocation } from 'react-router-dom'

const TABS = [
  { id: 'initiator', label: 'Initiator', path: '/initiator' },
  { id: 'creator',   label: 'Creator',   path: '/' },
  { id: 'library',   label: 'Library',   path: '/library' },
  { id: 'trading',   label: 'Trading',   path: '/trading' },
  { id: 'portfolio', label: 'Portfolio', path: '/portfolio' },
  { id: 'sources',   label: 'Data Sources', path: '/sources' },
]

export function NavBar() {
  const navigate = useNavigate()
  const location = useLocation()

  return (
    <nav className="nav">
      <div className="nav-brand">
        <div className="brand-icon">SL</div>
        <span>Strategy Lab</span>
      </div>
      <div className="nav-tabs" role="tablist">
        {TABS.map((tab) => {
          const active = location.pathname === tab.path ||
            (tab.path !== '/' && location.pathname.startsWith(tab.path))
          return (
            <button
              key={tab.id}
              className={`tab-btn${active ? ' active' : ''}`}
              role="tab"
              onClick={() => navigate(tab.path)}
            >
              {tab.label}
            </button>
          )
        })}
      </div>
      <div className="nav-right"></div>
    </nav>
  )
}
