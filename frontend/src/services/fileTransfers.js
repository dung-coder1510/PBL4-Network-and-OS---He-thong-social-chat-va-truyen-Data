import { request } from './apiClient.js'
import {
  BUFFER_LOW, CHUNK_BYTES, MAX_FILE_BYTES, createFileReceiver, encodeChunk, sha256, waitForBuffer,
} from './fileProtocol.js'

export const isFileActive = transfer => !!transfer && ['offered', 'accepted', 'transferring'].includes(transfer.status)

function versionNumber(version) {
  return [...atob(version)].reduce((value, character) => (value << 8n) + BigInt(character.charCodeAt(0)), 0n)
}

export function createFileTransfers({ connection, token, userId, onChange, onNotice }) {
  const transfers = new Map()
  const pending = new Map()
  const peers = new Map()
  const downloads = new Map()
  const starting = new Map()
  const abort = new AbortController()
  let configuration
  let disposed = false
  let nextCursor = null
  let loadingPage = false
  const emit = () => {
    if (!disposed) onChange({
      items: [...transfers.values()].sort((left, right) => BigInt(left.id) > BigInt(right.id) ? -1 : 1),
      nextCursor,
    })
  }
  const config = () => configuration ??= request('/files/configuration', { token, signal: abort.signal })
    .catch(error => { configuration = null; throw error })

  function releasePeer(id) {
    const peer = peers.get(id)
    if (!peer) return
    peers.delete(id)
    clearTimeout(peer.timeout)
    peer.abort.abort()
    peer.receiver?.clear()
    peer.pc.onconnectionstatechange = null
    if (peer.channel) {
      peer.channel.onclose = null
      peer.channel.onerror = null
      peer.channel.onmessage = null
      peer.channel.onopen = null
      peer.channel.close()
    }
    peer.pc.close()
  }

  async function action(method, id, extra = {}) {
    const current = transfers.get(id)
    if (!current || disposed) throw new Error('Phiên truyền không còn khả dụng.')
    if (method === 'AcceptFile') {
      if (!globalThis.RTCPeerConnection || !globalThis.crypto?.subtle)
        throw new Error('Nhận tệp cần WebRTC và HTTPS hoặc localhost.')
      await config()
    }
    const result = await connection.invoke(method, {
      transferId: id, expectedVersion: current.version, ...extra,
    })
    changed(result)
    return result
  }

  async function fail(id, error) {
    const current = transfers.get(id)
    if (!current || !isFileActive(current) || disposed || current.localFailure) return
    transfers.set(id, { ...current, localFailure: true, error: error.message || 'Truyền tệp thất bại.' })
    releasePeer(id)
    pending.delete(current.clientTransferId)
    emit()
    try { await action('FailFile', id) }
    catch { await load().catch(() => {}) }
  }

  function armTimeout(id, milliseconds = 60000) {
    const peer = peers.get(id)
    if (!peer) return
    clearTimeout(peer.timeout)
    peer.timeout = setTimeout(() => void fail(id, new Error('Phiên truyền không tiến triển.')), milliseconds)
  }

  function progress(id, bytes) {
    const peer = peers.get(id)
    const current = transfers.get(id)
    if (!peer || !current || !isFileActive(current)) return
    armTimeout(id)
    const now = performance.now()
    if (now - peer.lastUpdate < 250 && bytes !== current.fileSizeBytes) return
    peer.lastUpdate = now
    transfers.set(id, { ...current, transferredBytes: bytes,
      bytesPerSecond: bytes / Math.max(0.001, (now - peer.startedAt) / 1000) })
    emit()
  }

  async function sendSignal(id, kind, payload) {
    if (!peers.has(id) || disposed) return
    await connection.invoke('SendFileSignal', { transferId: id, kind, payload })
  }

  async function sendFile(id) {
    const peer = peers.get(id)
    const current = transfers.get(id)
    const file = pending.get(current.clientTransferId)
    if (!file) throw new Error('Tệp gốc không còn ở tab gửi. Hãy gửi lại.')
    await action('BeginFileTransfer', id)
    for (let offset = 0, index = 0; offset < file.size; offset += CHUNK_BYTES, index++) {
      await waitForBuffer(peer.channel, peer.abort.signal)
      const chunk = await file.slice(offset, offset + CHUNK_BYTES).arrayBuffer()
      if (peer.abort.signal.aborted) return
      peer.channel.send(encodeChunk(index, chunk))
      progress(id, offset + chunk.byteLength)
    }
    await waitForBuffer(peer.channel, peer.abort.signal)
    peer.channel.send(JSON.stringify({ type: 'end' }))
    progress(id, file.size)
  }

  async function receiveEnd(id, text) {
    const peer = peers.get(id)
    if (!peer || text !== '{"type":"end"}' || peer.verifying)
      throw new Error('Khung kết thúc không hợp lệ.')
    peer.verifying = true
    const blob = peer.receiver.finish()
    const verifiedSha256Hex = await sha256(await blob.arrayBuffer())
    if (peer.abort.signal.aborted || disposed) return
    const current = transfers.get(id)
    if (verifiedSha256Hex !== current.sha256Hex) throw new Error('SHA-256 không khớp; tệp đã bị loại bỏ.')
    const completed = await action('CompleteFile', id, { receivedBytes: blob.size, verifiedSha256Hex })
    if (disposed || completed.status !== 'completed') return
    while (downloads.size >= 2) forgetDownload(downloads.keys().next().value)
    const url = URL.createObjectURL(blob)
    downloads.set(id, url)
    transfers.set(id, { ...transfers.get(id), downloadUrl: url, transferredBytes: blob.size })
    emit()
    onNotice(`Đã nhận và kiểm tra SHA-256: ${completed.fileName}`)
  }

  function attachChannel(id, channel, sending) {
    const peer = peers.get(id)
    if (!peer || peer.channel || channel.label !== 'file-v1' || !channel.ordered ||
        channel.maxRetransmits !== null || channel.maxPacketLifeTime !== null) {
      channel.close()
      void fail(id, new Error('Kênh dữ liệu không hợp lệ.'))
      return
    }
    peer.channel = channel
    channel.binaryType = 'arraybuffer'
    channel.bufferedAmountLowThreshold = BUFFER_LOW
    channel.onopen = () => {
      peer.startedAt = performance.now()
      armTimeout(id)
      if (sending) void sendFile(id).catch(error => fail(id, error))
    }
    channel.onmessage = event => {
      if (sending) {
        void fail(id, new Error('Tab gửi nhận khung dữ liệu ngoài giao thức.'))
        return
      }
      try {
        if (typeof event.data === 'string') void receiveEnd(id, event.data).catch(error => fail(id, error))
        else progress(id, peer.receiver.push(event.data))
      } catch (error) { void fail(id, error) }
    }
    channel.onclose = () => {
      if (!isFileActive(transfers.get(id)) || peer.verifying) return
      clearTimeout(peer.timeout)
      peer.timeout = setTimeout(() => {
        if (isFileActive(transfers.get(id)))
          void fail(id, new Error('Kênh truyền đã đóng trước khi xác nhận.'))
      }, 2000)
    }
    channel.onerror = () => void fail(id, new Error('Lỗi kênh WebRTC.'))
  }

  function createPeer(transfer, iceServers) {
    if (peers.has(transfer.id)) return peers.get(transfer.id)
    const sending = transfer.senderId === userId
    const pc = new RTCPeerConnection({ iceServers })
    const peer = {
      pc, abort: new AbortController(), receiver: sending ? null : createFileReceiver(transfer.fileSizeBytes),
      candidates: [], chain: Promise.resolve(), outgoing: Promise.resolve(), startedAt: performance.now(),
      lastUpdate: 0, verifying: false,
    }
    peers.set(transfer.id, peer)
    pc.onicecandidate = event => {
      if (!event.candidate) return
      peer.outgoing = peer.outgoing.then(() =>
        sendSignal(transfer.id, 'ice', JSON.stringify(event.candidate.toJSON())))
        .catch(error => fail(transfer.id, error))
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') void fail(transfer.id,
        new Error('Không kết nối được WebRTC. Mạng khác NAT có thể cần TURN.'))
    }
    pc.ondatachannel = event => attachChannel(transfer.id, event.channel, false)
    armTimeout(transfer.id, 45000)
    if (sending) attachChannel(transfer.id, pc.createDataChannel('file-v1', { ordered: true }), true)
    return peer
  }

  function startPeer(transfer) {
    if (starting.has(transfer.id)) return starting.get(transfer.id)
    const start = (async () => {
      const settings = await config()
      const current = transfers.get(transfer.id)
      if (disposed || !isFileActive(current) || current.localFailure || connection.state !== 'Connected' ||
          (current.senderConnectionId !== connection.connectionId &&
           current.receiverConnectionId !== connection.connectionId)) return
      const peer = createPeer(transfer, settings.iceServers)
      if (transfer.senderId === userId) {
        if (!pending.has(transfer.clientTransferId)) throw new Error('Tệp gốc không còn ở tab gửi.')
        await peer.pc.setLocalDescription(await peer.pc.createOffer())
        await sendSignal(transfer.id, 'offer', peer.pc.localDescription.sdp)
      }
      return peer
    })()
    starting.set(transfer.id, start)
    start.catch(error => fail(transfer.id, error))
    return start
  }

  function changed(transfer) {
    if (disposed) return
    const previous = transfers.get(transfer.id)
    if (previous && versionNumber(previous.version) > versionNumber(transfer.version)) return
    transfers.set(transfer.id, { ...previous, ...transfer })
    const ownEndpoint = transfer.senderConnectionId === connection.connectionId ||
      transfer.receiverConnectionId === connection.connectionId
    if (transfer.status === 'offered' && !previous && transfer.receiverId === userId)
      onNotice(`Có lời mời nhận tệp “${transfer.fileName}”. Mở mục Tệp để chấp nhận.`)
    if (transfer.status === 'accepted' && ownEndpoint && !previous?.localFailure)
      void startPeer(transfer)
    if (!isFileActive(transfer)) {
      releasePeer(transfer.id)
      starting.delete(transfer.id)
      pending.delete(transfer.clientTransferId)
    }
    emit()
  }

  async function signalReceived(signal) {
    const transfer = transfers.get(signal.transferId)
    if (!transfer || !isFileActive(transfer) ||
        (transfer.senderConnectionId !== connection.connectionId &&
         transfer.receiverConnectionId !== connection.connectionId)) return
    try {
      const peer = await startPeer(transfer)
      if (!peer || peer.abort.signal.aborted) return
      peer.chain = peer.chain.then(async () => {
        if (peer.abort.signal.aborted) return
        if (signal.kind === 'ice') {
          const candidate = JSON.parse(signal.payload)
          if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(candidate)
          else {
            if (peer.candidates.length >= 128) throw new Error('Quá nhiều ICE candidate.')
            peer.candidates.push(candidate)
          }
          return
        }
        await peer.pc.setRemoteDescription({ type: signal.kind, sdp: signal.payload })
        for (const candidate of peer.candidates) await peer.pc.addIceCandidate(candidate)
        peer.candidates = []
        if (signal.kind === 'offer') {
          await peer.pc.setLocalDescription(await peer.pc.createAnswer())
          await sendSignal(transfer.id, 'answer', peer.pc.localDescription.sdp)
        }
      }).catch(error => fail(transfer.id, error))
    } catch (error) { void fail(transfer.id, error) }
  }

  async function load(older = false) {
    if (loadingPage || disposed) return
    loadingPage = true
    try {
      const page = await request('/files' + (older && nextCursor
        ? '?' + new URLSearchParams({ beforeId: nextCursor }) : ''), { token, signal: abort.signal })
      if (disposed) return
      for (const item of page.items) changed(item)
      nextCursor = page.nextCursor
      emit()
    } finally { loadingPage = false }
  }

  function forgetDownload(id) {
    const url = downloads.get(id)
    if (url) URL.revokeObjectURL(url)
    downloads.delete(id)
    const transfer = transfers.get(id)
    if (transfer) transfers.set(id, { ...transfer, downloadUrl: null })
    emit()
  }

  function disconnected() {
    for (const id of [...peers.keys()]) releasePeer(id)
    pending.clear()
    starting.clear()
    for (const [id, transfer] of transfers) {
      if (isFileActive(transfer)) transfers.set(id, { ...transfer,
        localFailure: true, error: 'Kết nối đã ngắt. Phiên này cần gửi lại.' })
    }
    emit()
  }

  connection.on('FileChanged', changed)
  connection.on('FileSignal', signalReceived)
  return {
    load, action, disconnected, forgetDownload,
    async offer(conversationId, file) {
      if (!file || file.size > MAX_FILE_BYTES) throw new Error('Chọn tệp tối đa 100 MiB.')
      if (!globalThis.RTCPeerConnection || !globalThis.crypto?.subtle)
        throw new Error('Trình duyệt cần hỗ trợ WebRTC và chạy trên HTTPS hoặc localhost.')
      if (connection.state !== 'Connected') throw new Error('Chưa kết nối máy chủ.')
      if (pending.size >= 2) throw new Error('Tab này đã có 2 tệp đang chờ hoặc đang gửi.')
      const clientTransferId = crypto.randomUUID()
      pending.set(clientTransferId, file)
      try {
        await config()
        const sha256Hex = await sha256(await file.arrayBuffer())
        if (disposed || !pending.has(clientTransferId)) throw new Error('Phiên gửi đã bị hủy.')
        const result = await connection.invoke('OfferFile', {
          conversationId, clientTransferId, fileName: file.name, fileSizeBytes: file.size, sha256Hex,
        })
        changed(result)
        return result
      } catch (error) { pending.delete(clientTransferId); throw error }
    },
    dispose() {
      disposed = true
      abort.abort()
      connection.off('FileChanged', changed)
      connection.off('FileSignal', signalReceived)
      disconnected()
      for (const url of downloads.values()) URL.revokeObjectURL(url)
      downloads.clear()
    },
  }
}
