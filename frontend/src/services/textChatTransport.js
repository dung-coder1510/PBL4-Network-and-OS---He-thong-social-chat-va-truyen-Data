import { request } from './apiClient.js'
import { classifyTextRoute, hashText, parseTextFrame } from './textProtocol.js'
import { mergeChatMessages } from '../utils/chatState.js'

// Tao peer bang API trinh duyet voi cau hinh ICE; cho phep thay factory trong unit test.
const createNativePeer = config => new RTCPeerConnection(config)

// Tao bo dieu phoi text cho mot phien dang nhap: chon P2P/SignalR, cho ACK va quan ly tai nguyen.
// Tra cac thao tac gui, nhan, thu ket noi lai va huy; trang thai duoc day ra qua callback.
export function createTextChatTransport({ connection, token, userId, onMessage, onState, onSyncNeeded = () => {},
  createPeer = createNativePeer,
  loadConfiguration = signal => request('/files/configuration', { token, signal }),
  ackTimeoutMs = 5000, negotiationTimeoutMs = 15000 }) {
  const peers = new Map()
  const byConversation = new Map()
  const desired = new Set()
  const starting = new Map()
  const acknowledgements = new Map()
  const received = new Map()
  const sending = new Map()
  const controller = new AbortController()
  let configuration
  let disposed = false
  // So the he giup bo qua ket qua bat dong bo cua ket noi cu sau reconnect/logout.
  let generation = 0
  // Dung chung Promise tai cau hinh ICE; xoa cache khi loi de lan sau co the thu lai.
  const config = () => configuration ??= loadConfiguration(controller.signal)
    .catch(error => { configuration = null; throw error })
  // Day trang thai duong truyen ra UI, nhung khong cap nhat sau khi manager da huy.
  const state = (conversationId, value) => { if (!disposed) onState(conversationId, value) }

  // Gop tin theo sender/UUID, giu receipt moi nhat va phat vao cung pipeline UI.
  // Cache toi da 512 tin de gioi han RAM; lich su ben vung van doc tu SQL.
  function emit(message) {
    if (disposed) return
    const key = `${message.senderId}:${message.clientMessageId}`
    const merged = mergeChatMessages(received.has(key) ? [received.get(key)] : [], [message])[0]
    received.set(key, merged)
    if (received.size > 512) received.delete(received.keys().next().value)
    onMessage(merged)
  }

  // Don peer, channel, timer va cac Promise cho ACK cua mot phien; goi lap van an toan.
  // notify=false khi server da bao dong, tranh gui lenh dong vong lai server.
  function release(sessionId, notify = true) {
    const peer = peers.get(sessionId)
    if (!peer) return
    peers.delete(sessionId)
    if (byConversation.get(peer.session.conversationId) === sessionId)
      byConversation.delete(peer.session.conversationId)
    clearTimeout(peer.timer)
    // Bo handler truoc khi close de su kien onclose khong tu goi release long nhau.
    if (peer.pc) peer.pc.onicecandidate = peer.pc.ondatachannel = peer.pc.onconnectionstatechange = null
    if (peer.channel) {
      peer.channel.onopen = peer.channel.onmessage = peer.channel.onclose = peer.channel.onerror = null
      peer.channel.close()
    }
    peer.pc?.close()
    for (const [key, pending] of acknowledgements) {
      if (pending.sessionId === sessionId) { pending.finish(false); acknowledgements.delete(key) }
    }
    state(peer.session.conversationId, { state: 'fallback', route: 'signalr' })
    if (notify && connection.state === 'Connected')
      void connection.invoke('CloseTextSession', sessionId).catch(() => {})
  }

  // Doc candidate pair duoc chon tu getStats de phan loai truc tiep/relay tren UI.
  // Chi cap nhat neu peer nay van la phien hien tai va da ready.
  async function route(peer) {
    try {
      const selected = classifyTextRoute(await peer.pc.getStats())
      if (peers.get(peer.session.sessionId) === peer && peer.ready)
        state(peer.session.conversationId, { state: 'ready', route: selected })
    } catch { /* Khong co so lieu thi khong tu gan nhan ket noi truc tiep. */ }
  }

  // Kiem tra chat-v1 ordered/reliable va gan cac handler nhan tin, ACK, mo va dong kenh.
  function attach(peer, channel) {
    const { session } = peer
    if (peer.channel || channel.label !== 'chat-v1' || !channel.ordered ||
        channel.maxRetransmits !== null || channel.maxPacketLifeTime !== null) {
      channel.close()
      release(session.sessionId)
      return
    }
    peer.channel = channel
    // Bao server endpoint da ready truoc khi cho phep client chon duong gui P2P.
    channel.onopen = async () => {
      try {
        await connection.invoke('TextSessionReady', session.sessionId)
        if (peers.get(session.sessionId) !== peer) return
        clearTimeout(peer.timer)
        peer.ready = true
        state(session.conversationId, { state: 'ready', route: 'webrtc' })
        await route(peer)
      } catch { release(session.sessionId) }
    }
    // Tach ACK va payload: ACK phai khop ca phien, MessageId va ClientMessageId dang cho.
    channel.onmessage = event => {
      let frame
      try { frame = parseTextFrame(event.data, session, peer.remoteUserId) }
      catch { release(session.sessionId); return }
      if (frame.type === 'ack') {
        const pending = acknowledgements.get(frame.clientMessageId)
        if (pending?.sessionId === session.sessionId && pending.messageId === frame.messageId)
          pending.finish(true)
        return
      }
      // Xep Promise thanh hang doi de hash/receipt bat dong bo khong dao thu tu xu ly tin.
      peer.incoming = peer.incoming.then(async () => {
        if (peers.get(session.sessionId) !== peer || disposed) return
        const m = frame.message
        // Server doi chieu hash voi SQL truoc khi UI nhan tin va truoc khi tra ACK cho sender.
        const verified = await connection.invoke('AcknowledgePeerMessage', {
          sessionId: session.sessionId, messageId: m.id, clientMessageId: m.clientMessageId,
          contentSha256Hex: await hashText(m.content),
        })
        if (peers.get(session.sessionId) !== peer || disposed) return
        emit({ ...m, createdAt: verified.createdAt,
          deliveredAt: verified.status.deliveredAt, readAt: verified.status.readAt })
        if (channel.readyState === 'open') channel.send(JSON.stringify({
          v: 1, type: 'ack', sessionId: session.sessionId, messageId: m.id, clientMessageId: m.clientMessageId,
        }))
      }).catch(() => release(session.sessionId))
    }
    // Dong hoac loi kenh se giai phong waiter de luong gui chuyen sang fallback.
    channel.onclose = channel.onerror = () => release(session.sessionId)
  }

  // Tiep nhan phien do server cap, xac dinh minh la A/B va khoi tao peer dung mot lan.
  // Chi A tao DataChannel va offer; B cho ondatachannel va tra answer.
  async function sessionStarted(session) {
    if (disposed || connection.state !== 'Connected' || !session || peers.has(session.sessionId)) return
    const localA = session.connectionAId === connection.connectionId && session.userAId === userId
    const localB = session.connectionBId === connection.connectionId && session.userBId === userId
    if (!localA && !localB) return
    const old = byConversation.get(session.conversationId)
    if (old) release(old)
    // Dang ky peer truoc khi await cau hinh de ICE den som van tim duoc hang doi tuong ung.
    const peer = { session, remoteUserId: localA ? session.userBId : session.userAId,
      candidates: [], incoming: Promise.resolve(), signals: Promise.resolve(), outgoing: Promise.resolve(), ready: false }
    peers.set(session.sessionId, peer)
    byConversation.set(session.conversationId, session.sessionId)
    state(session.conversationId, { state: 'connecting', route: 'signalr' })
    // Promise khoi tao la hang rao: cac signal phai doi peer san sang moi duoc ap dung.
    peer.initialized = (async () => {
      const settings = await config()
      if (disposed || peers.get(session.sessionId) !== peer) return
      peer.pc = createPeer({ iceServers: settings.iceServers || [] })
      // Gui moi candidate moi qua SignalR, giu cung thu tu voi offer/answer.
      peer.pc.onicecandidate = event => {
        if (!event.candidate) return
        // Noi ICE sau offer/answer de server da ghi nhan SDP truoc khi nhan signal tiep theo.
        peer.outgoing = peer.outgoing.then(() => connection.invoke('SendTextSignal', {
          sessionId: session.sessionId, kind: 'ice', payload: JSON.stringify(event.candidate.toJSON()),
        })).catch(() => release(session.sessionId))
      }
      // Mat mang tam thi dung P2P toi da 5 giay; noi lai thi doc route, that bai thi don peer.
      peer.pc.onconnectionstatechange = () => {
        if (peer.pc.connectionState === 'failed') release(session.sessionId)
        else if (peer.pc.connectionState === 'disconnected') {
          peer.ready = false
          state(session.conversationId, { state: 'connecting', route: 'signalr' })
          clearTimeout(peer.timer)
          peer.timer = setTimeout(() => release(session.sessionId), 5000)
        } else if (peer.pc.connectionState === 'connected' && peer.channel?.readyState === 'open') {
          clearTimeout(peer.timer)
          peer.ready = true
          void route(peer)
        }
      }
      // Phia nhan lay DataChannel do ben tao offer mo, khong tao them kenh canh tranh.
      peer.pc.ondatachannel = event => attach(peer, event.channel)
      peer.timer = setTimeout(() => release(session.sessionId), negotiationTimeoutMs)
      if (localA) {
        attach(peer, peer.pc.createDataChannel('chat-v1', { ordered: true }))
        // Dat truoc hang doi outgoing vi setLocalDescription co the phat ICE ngay lap tuc.
        peer.outgoing = peer.outgoing.then(async () => {
          await peer.pc.setLocalDescription(await peer.pc.createOffer())
          await connection.invoke('SendTextSignal', {
            sessionId: session.sessionId, kind: 'offer', payload: peer.pc.localDescription.sdp,
          })
        })
        await peer.outgoing
      }
    })()
    try { await peer.initialized }
    catch { release(session.sessionId) }
  }

  // Nhan SDP/ICE cua dung phien va xu ly noi tiep, tranh goi WebRTC sai trang thai signaling.
  function signalReceived(signal) {
    const peer = peers.get(signal.sessionId)
    if (!peer || disposed) return
    peer.signals = peer.signals.then(async () => {
      await peer.initialized
      if (peers.get(signal.sessionId) !== peer || !peer.pc) return
      if (signal.kind === 'ice') {
        const candidate = JSON.parse(signal.payload)
        // ICE den truoc SDP duoc giu tam; chi addIceCandidate sau khi co remoteDescription.
        if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(candidate)
        else {
          if (peer.candidates.length >= 128) throw new Error('Quá nhiều ICE.')
          peer.candidates.push(candidate)
        }
      } else {
        await peer.pc.setRemoteDescription({ type: signal.kind, sdp: signal.payload })
        for (const candidate of peer.candidates) await peer.pc.addIceCandidate(candidate)
        peer.candidates = []
        if (signal.kind === 'offer') {
          peer.outgoing = peer.outgoing.then(async () => {
            await peer.pc.setLocalDescription(await peer.pc.createAnswer())
            await connection.invoke('SendTextSignal', {
              sessionId: signal.sessionId, kind: 'answer', payload: peer.pc.localDescription.sdp,
            })
          })
          await peer.outgoing
        }
      }
    }).catch(() => release(signal.sessionId))
  }

  // Dam bao conversation duoc thu mo P2P; tai su dung phien/Promise dang co de tranh goi trung.
  // Trinh duyet thieu WebRTC/Web Crypto van dung SignalR; chi giu toi da 8 conversation mong muon.
  async function ensure(conversationId) {
    if (disposed || connection.state !== 'Connected' || !globalThis.crypto?.subtle ||
        (createPeer === createNativePeer && typeof globalThis.RTCPeerConnection !== 'function')) return
    desired.add(conversationId)
    if (desired.size > 8) {
      const oldest = desired.values().next().value
      desired.delete(oldest)
      release(byConversation.get(oldest))
    }
    if (byConversation.has(conversationId)) return
    if (starting.has(conversationId)) return starting.get(conversationId)
    // Ket qua StartTextSession cu khong duoc tao peer lai sau khi da reconnect.
    const version = generation
    const start = connection.invoke('StartTextSession', conversationId).then(async session => {
      if (!disposed && version === generation && session) await sessionStarted(session)
    }).catch(() => state(conversationId, { state: 'fallback', route: 'signalr' }))
      .finally(() => { if (starting.get(conversationId) === start) starting.delete(conversationId) })
    starting.set(conversationId, start)
    return start
  }

  // Tao Promise cho dung tin; finish(true) khi co ACK, false khi timeout hoac phien bi dong.
  // Dang ky waiter truoc channel.send de khong bo lo ACK den rat nhanh.
  function waitForAck(peer, message) {
    let finish
    const promise = new Promise(resolve => {
      const timer = setTimeout(() => finish(false), ackTimeoutMs)
      // Xoa timer va waiter truoc khi tra ket qua de ACK/timeout den muon khong giu tai nguyen.
      finish = result => {
        clearTimeout(timer)
        acknowledgements.delete(message.clientMessageId)
        resolve(result)
      }
    })
    acknowledgements.set(message.clientMessageId, { sessionId: peer.session.sessionId,
      messageId: message.id, finish })
    return { promise, finish }
  }

  // Xu ly thong bao dong phien cua server va yeu cau tai bu lich su neu SignalR con ket noi.
  const closed = session => {
    release(session.sessionId, false)
    // Khoi phuc tin da luu neu tab gui dong giua buoc commit SQL va channel.send.
    if (!disposed && connection.state === 'Connected') onSyncNeeded()
  }
  connection.on('TextSessionStarted', sessionStarted)
  connection.on('TextSignal', signalReceived)
  connection.on('TextSessionClosed', closed)
  return {
    ensure,
    // Thu lai cac conversation da mo; ensure tu bo qua phien hien tai va yeu cau dang chay.
    refresh() { for (const id of desired) void ensure(id) },
    // Dua tin SignalR/tai bu vao pipeline chung; ACK rieng le neu caller chua ACK truoc do.
    receiveServer(message, acknowledge = true) {
      emit(message)
      if (acknowledge && message.senderId !== userId && connection.state === 'Connected')
        void connection.invoke('AcknowledgeMessage', { conversationId: message.conversationId,
          messageId: message.id }).catch(() => {})
    },
    // Gop cac lan gui lai dong thoi cua cung UUID vao mot Promise, mot commit va mot waiter.
    send(message) {
      if (disposed || connection.state !== 'Connected') return Promise.reject(new Error('Kết nối tin nhắn chưa sẵn sàng.'))
      const existing = sending.get(message.clientMessageId)
      if (existing) return existing
      const operation = sendOne(message).finally(() => {
        if (sending.get(message.clientMessageId) === operation) sending.delete(message.clientMessageId)
      })
      sending.set(message.clientMessageId, operation)
      return operation
    },
    // Tang the he va don peer khi mat SignalR; giu desired de co the mo lai sau reconnect.
    disconnected() {
      generation++
      starting.clear()
      sending.clear()
      for (const id of [...peers.keys()]) release(id, false)
    },
    // Huy toan bo tai nguyen khi logout/unmount; cac tac vu cu khong duoc cap nhat phien moi.
    dispose() {
      disposed = true
      generation++
      controller.abort()
      connection.off('TextSessionStarted', sessionStarted)
      connection.off('TextSignal', signalReceived)
      connection.off('TextSessionClosed', closed)
      for (const id of [...peers.keys()]) release(id)
      desired.clear()
      sending.clear()
      received.clear()
    },
  }

  // Gui mot tin theo thu tu: chon duong -> commit SQL -> DataChannel -> cho ACK -> relay neu can.
  // Moi lan retry/fallback giu nguyen UUID; commit thanh cong chua co nghia nguoi nhan da nhan.
  async function sendOne(message) {
      const sendGeneration = generation
      const peer = peers.get(byConversation.get(message.conversationId))
      if (!peer?.ready || peer.channel?.readyState !== 'open') {
        void ensure(message.conversationId)
        const result = await connection.invoke('SendMessage', message)
        if (!disposed && generation === sendGeneration) emit(result)
        return result
      }
      let saved
      try {
        saved = await connection.invoke('CommitPeerMessage', { sessionId: peer.session.sessionId, message })
      } catch {
        // Co the server da luu nhung response bi mat; gui SignalR cung UUID de SQL tra ban cu.
        const result = await connection.invoke('SendMessage', message)
        if (!disposed && generation === sendGeneration) {
          state(message.conversationId, { state: 'fallback', route: 'signalr' })
          emit(result)
        }
        return result
      }
      if (disposed || generation !== sendGeneration) throw new Error('Phiên gửi tin đã thay đổi.')
      void route(peer)
      emit(saved)
      const waiting = waitForAck(peer, saved)
      try {
        peer.channel.send(JSON.stringify({ v: 1, type: 'message', sessionId: peer.session.sessionId, message: saved }))
      } catch { waiting.finish(false) }
      // ACK co the mat du payload da den; relay cung ID va merge se khong tao bong tin thu hai.
      if (!await waiting.promise) {
        if (disposed || generation !== sendGeneration) throw new Error('Kết nối đã thay đổi; hãy thử lại cùng tin.')
        state(message.conversationId, { state: 'fallback', route: 'signalr' })
        try {
          const result = await connection.invoke('RelayCommittedMessage', {
            conversationId: saved.conversationId, clientMessageId: saved.clientMessageId,
          })
          if (!disposed && generation === sendGeneration) emit(result)
        } finally { release(peer.session.sessionId) }
      }
      return saved
  }
}
