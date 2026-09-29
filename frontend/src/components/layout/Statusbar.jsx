function Statusbar() {
  return (
    <footer className="statusbar" aria-label="Thanh trạng thái ứng dụng">
      <div className="statusbar-left">
        <span className="status-item muted">SignalR: Chưa kết nối</span>
        <span className="status-divider">|</span>
        <span className="status-item muted">P2P: Chưa kết nối</span>
      </div>
      <div className="statusbar-right">
        <span className="status-item muted">PBL4 · Web Client</span>
      </div>
    </footer>
  )
}

export default Statusbar
