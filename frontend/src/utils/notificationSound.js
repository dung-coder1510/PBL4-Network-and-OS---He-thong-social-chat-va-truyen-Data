// Âm báo nhẹ tạo bằng Web Audio API (không cần tải tệp âm thanh ngoài).

let sharedAudioContext = null

function getAudioContext() {
  const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext
  if (!AudioCtx) return null
  sharedAudioContext ??= new AudioCtx()
  return sharedAudioContext
}

/** Phát âm báo nhẹ khi có tin nhắn mới hoặc sự kiện tệp. */
export function playNotificationSound(kind = 'message') {
  try {
    const ctx = getAudioContext()
    if (!ctx) return
    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => {})
    }

    const now = ctx.currentTime
    const firstFreq = kind === 'file' ? 659.25 : 587.33
    const secondFreq = kind === 'file' ? 880.0 : 783.99

    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(firstFreq, now)
    osc.frequency.setValueAtTime(secondFreq, now + 0.085)

    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(0.055, now + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.035, now + 0.09)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22)

    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start(now)
    osc.stop(now + 0.23)
  } catch {
    // Bỏ qua khi trình duyệt chặn AudioContext tự động hoặc môi trường headless không hỗ trợ.
  }
}
