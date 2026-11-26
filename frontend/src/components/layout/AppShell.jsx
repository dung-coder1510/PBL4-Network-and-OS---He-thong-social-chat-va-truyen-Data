import Sidebar from './Sidebar.jsx'

function AppShell({ children, currentPage, onLogout, onNavigate, user, loggingOut, theme, onThemeChange }) {
  return (
    <div className="app-shell">
      <Sidebar currentPage={currentPage} onLogout={onLogout} onNavigate={onNavigate}
        user={user} loggingOut={loggingOut} theme={theme} onThemeChange={onThemeChange} />
      <main id="main" tabIndex="-1">{children}</main>
    </div>
  )
}

export default AppShell
