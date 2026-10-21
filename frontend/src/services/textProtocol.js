// Kiem tra hinh dang ID SQL duong dang chuoi; server se kiem tra mien gia tri va quyen truy cap.
const id = value => typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value)
// Kiem tra dinh dang UUID truoc khi dung lam khoa chong trung hoac doi chieu ACK.
const uuid = value => typeof value === 'string' && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value)

// Giai ma JSON text/ACK va rang buoc dung protocol v1, phien, conversation va sender cua peer.
// Tra frame hop le; nem loi voi binary, payload qua lon hoac du lieu gia mao/sai dinh dang.
export function parseTextFrame(data, session, remoteUserId) {
  if (typeof data !== 'string' || data.length > 28000) throw new Error('Khung text không hợp lệ.')
  const frame = JSON.parse(data)
  if (!frame || frame.v !== 1 || frame.sessionId !== session.sessionId)
    throw new Error('Sai phiên text.')
  if (frame.type === 'ack') {
    if (!id(frame.messageId) || !uuid(frame.clientMessageId)) throw new Error('ACK không hợp lệ.')
    return frame
  }
  const m = frame.message
  if (frame.type !== 'message' || !m || !id(m.id) || !uuid(m.clientMessageId) ||
      m.conversationId !== session.conversationId || m.senderId !== remoteUserId ||
      typeof m.content !== 'string' || m.content.length < 1 || m.content.length > 4000 ||
      m.content.trim() !== m.content || !Number.isFinite(Date.parse(m.createdAt)))
    throw new Error('Tin nhắn P2P không hợp lệ.')
  return frame
}

// Ma hoa text thanh byte UTF-8, bam SHA-256 va tra chuoi hex 64 ky tu de doi chieu ban SQL.
// Web Crypto can HTTPS hoac localhost; hash la kiem tra noi dung, khong phai ma hoa bao mat text.
export async function hashText(content) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content))
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')
}

// Lan theo selectedCandidatePairId den hai ICE candidate dang duoc dung.
// Co candidate relay thi tra turn; du lieu du ma khong relay thi direct; thieu so lieu thi webrtc.
export function classifyTextRoute(stats) {
  const transport = [...stats.values()].find(item => item.type === 'transport' && item.selectedCandidatePairId)
  const pair = transport ? stats.get(transport.selectedCandidatePairId)
    : [...stats.values()].find(item => item.type === 'candidate-pair' && item.selected && item.state === 'succeeded')
  if (!pair) return 'webrtc'
  const local = stats.get(pair.localCandidateId)
  const remote = stats.get(pair.remoteCandidateId)
  if (!local?.candidateType || !remote?.candidateType) return 'webrtc'
  return local.candidateType === 'relay' || remote.candidateType === 'relay' ? 'turn' : 'direct'
}

// Doi trang thai ky thuat sang nhan UI; khong suy ra ket noi truc tiep chi tu trang thai connected.
export const textRouteLabel = state => {
  if (state?.state === 'connecting') return 'Đang kết nối P2P · tạm dùng SignalR'
  if (state?.route === 'direct') return 'WebRTC trực tiếp'
  if (state?.route === 'turn') return 'WebRTC qua TURN'
  if (state?.route === 'webrtc') return 'WebRTC · chưa xác định đường mạng'
  return 'SignalR dự phòng'
}
