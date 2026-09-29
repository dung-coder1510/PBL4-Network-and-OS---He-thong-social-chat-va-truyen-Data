import Sidebar from './Sidebar.jsx'
import Statusbar from './Statusbar.jsx'
import Topbar from './Topbar.jsx'

function AppShell({ children, currentPage, onLogout, onNavigate, user, loggingOut }) {
  return (
    <div className="app-shell">
      <Sidebar currentPage={currentPage} onLogout={onLogout} onNavigate={onNavigate} user={user} loggingOut={loggingOut} />
      <Topbar currentPage={currentPage} onOpenSettings={() => onNavigate('settings')} user={user} />
      <main id="main" tabIndex="-1">{children}</main>
      <Statusbar />
    </div>
  )
}

export default AppShell
