import { request } from './apiClient.js'
import { waitForTransferring } from './fileTransferState.js'
import {
  BUFFER_LOW, CHUNK_BYTES, LARGE_FILE_WARNING_BYTES, LEGACY_MAX_FILE_BYTES, MAX_FILE_BYTES,
  createFileReceiver, encodeChunk, sha256, waitForBuffer,
} from './fileProtocol.js'
import { createStreamReceiver, createStreamSender, hashFile, readStreamControl, streamControl, streamHeaderBytes } from './fileStreamProtocol.js'
import { canSaveFile, createFileStorage, pickFileDestination } from './fileStorage.js'

export const isFileActive = transfer => !!transfer && ['offered', 'accepted', 'transferring'].includes(transfer.status)

function versionNumber(version) {
  return [...atob(version)].reduce((value, character) => (value << 8n) + BigInt(character.charCodeAt(0)), 0n)
}

export function createFileTransfers({ connection, token, userId, onChange, onNotice, confirmLargeFile }) {
  const transfers = new Map()
  const pending = new Map()
  const peers = new Map()
  const downloads = new Map()
  const starting = new Map()
  const receiving = new Map()
  const accepting = new Set()
  const observations = new Map()
  // Báo cáo giám sát không chặn truyền file. Giới hạn cả tần suất và request đang chờ;
  // không gửi exception thô, SDP hoặc nội dung file. Backend xác thực endpoint độc lập.
  function observe(id, stage, bytes = null, reason = null) {
    const previous = observations.get(id)
    const now = performance.now()
    if (disposed || connection.state !== 'Connected') return
    if (previous?.busy) { previous.next = { stage, bytes, reason }; return }
    if (previous?.stage === stage && now - previous.at < 5000) return
    const state = { at: now, busy: true, stage }
    observations.set(id, state)
    void connection.invoke('ReportFileObservation', { transferId: id, stage, bytes, reason })
      .catch(() => {}).finally(() => {
        state.busy = false
        if (observations.get(id) === state && state.next)
          observe(id, state.next.stage, state.next.bytes, state.next.reason)
      })
  }
  const changes = new EventTarget()
  const conversationPages = new Map()
  const abort = new AbortController()
  let configuration
  let disposed = false
  let nextCursor = null
  let loadingPage = false
  const emit = () => {
    if (disposed) return
    changes.dispatchEvent(new Event('change'))
    onChange({
      items: [...transfers.values()].sort((left, right) => BigInt(left.id) > BigInt(right.id) ? -1 : 1),
      nextCursor,
      conversationPages: Object.fromEntries(conversationPages),
    })
  }
  const config = () => configuration ??= request('/files/configuration', { token, signal: abort.signal })
    .catch(error => { configuration = null; throw error })

  function releasePeer(id) {
    const storage = receiving.get(id)
    receiving.delete(id)
    storage?.abort.abort()
    void storage?.disk?.dispose()
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

  async function invokeAction(method, id, extra = {}) {
    const current = transfers.get(id)
    if (!current || disposed) throw new Error('Phiên truyền không còn khả dụng.')
    const result = await connection.invoke(method, {
      transferId: id, expectedVersion: current.version, ...extra,
    })
    changed(result)
    return result
  }

  async function action(method, id, extra = {}) {
    if (method !== 'AcceptFile') return invokeAction(method, id, extra)
    if (accepting.has(id)) return
    if (!globalThis.RTCPeerConnection || !globalThis.crypto?.subtle)
      throw new Error('Nhận tệp cần WebRTC và HTTPS hoặc localhost.')
    const offered = transfers.get(id)
    if (!offered || offered.status !== 'offered') throw new Error('Lời mời không còn hiệu lực.')
    if (!Number.isSafeInteger(offered.fileSizeBytes) || offered.fileSizeBytes < 0 || offered.fileSizeBytes > MAX_FILE_BYTES)
      throw new Error('Chỉ nhận tệp tối đa 10 GiB.')
    if (offered.fileSizeBytes > LEGACY_MAX_FILE_BYTES &&
        (extra.legacy || !canSaveFile(offered) || !offered.supportedProtocols.includes('file-v3')))
      throw new Error('Tệp lớn cần phiên bản ứng dụng mới, trình duyệt hỗ trợ lưu trực tiếp và HTTPS hoặc localhost.')
    accepting.add(id)
    const storage = { abort: new AbortController(), disk: null }
    receiving.set(id, storage)
    try {
      let protocolVersion = 'file-v1'
      if (!extra.legacy && canSaveFile(offered)) {
        // Gọi picker trước await mạng để giữ user activation từ nút Nhận file.
        const target = await pickFileDestination(offered.fileName)
        storage.abort.signal.throwIfAborted()
        storage.disk = await createFileStorage(target, storage.abort.signal, offered.fileSizeBytes)
        protocolVersion = offered.supportedProtocols.includes('file-v3') ? 'file-v3' : 'file-v2'
      }
      await config()
      storage.abort.signal.throwIfAborted()
      const current = transfers.get(id)
      if (disposed || current?.status !== 'offered') throw new Error('Lời mời không còn hiệu lực.')
      return await invokeAction(method, id, { protocolVersion, channelCount: 1 })
    } catch (error) {
      // Một broadcast accepted có thể đến trước lỗi mất phản hồi của invocation.
      if (peers.has(id) && transfers.get(id)?.receiverConnectionId === connection.connectionId)
        return transfers.get(id)
      releasePeer(id)
      if (error.name !== 'AbortError') throw error
    } finally { accepting.delete(id) }
  }

  async function fail(id, error) {
    const current = transfers.get(id)
    if (!current || !isFileActive(current) || disposed || current.localFailure || current.savedLocally) return
    transfers.set(id, { ...current, localFailure: true, error: error.message || 'Truyền tệp thất bại.' })
    releasePeer(id)
    pending.delete(current.clientTransferId)
    emit()
    // Chỉ báo mã phân loại; không đưa message có thể chứa thông tin riêng tư lên dashboard.
    const failureCode = /SHA-256/.test(error.message) ? 'HASH_MISMATCH'
      : /Chunk|chunk/.test(error.message) ? 'INVALID_CHUNK'
      : /WebRTC/.test(error.message) ? 'WEBRTC_FAILED'
      : /30 giây|không tiến triển/.test(error.message) ? 'TRANSFER_TIMEOUT' : 'UNKNOWN'
    try { await action('FailFile', id, { failureCode }) }
    catch { await load().catch(() => {}) }
  }

  function armTimeout(id, milliseconds = 60000) {
    const peer = peers.get(id)
    if (!peer) return
    clearTimeout(peer.timeout)
    peer.timeout = setTimeout(() => void fail(id, new Error('Phiên truyền không tiến triển.')), milliseconds)
  }

  function progress(id, bytes) {
    observe(id, 'transferring', bytes)
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
    if (peer.streaming) {
      await peer.sender.send(file, () => action('BeginFileTransfer', id))
      armTimeout(id, 30 * 60 * 1000)
      return
    }
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
    observe(id, 'verifying')
    const blob = peer.receiver.finish()
    const verifiedSha256Hex = await sha256(await blob.arrayBuffer())
    if (peer.abort.signal.aborted || disposed) return
    await waitForTransferring(() => transfers.get(id), changes, peer.abort.signal)
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

  function phase(id, localPhase) {
    const current = transfers.get(id)
    if (!current || disposed) return
    transfers.set(id, { ...current, localPhase })
    emit()
  }

  async function receiveStreamEnd(id) {
    const peer = peers.get(id)
    if (!peer || peer.verifying) throw new Error('Khung END lặp.')
    peer.verifying = true
    await peer.streamReceiver.finish()
    phase(id, 'verifying')
    observe(id, 'verifying')
    const file = await peer.disk.finish()
    const verifiedSha256Hex = await hashFile(file, peer.abort.signal, () => armTimeout(id))
    await waitForTransferring(() => transfers.get(id), changes, peer.abort.signal)
    const current = transfers.get(id)
    if (file.size !== current.fileSizeBytes || verifiedSha256Hex !== current.sha256Hex)
      throw new Error('SHA-256 không khớp; tệp đã bị loại bỏ.')
    phase(id, 'saving')
    await peer.disk.save(file, () => armTimeout(id), savedName => {
      transfers.set(id, { ...transfers.get(id), savedLocally: true, savedName,
        localFailure: false, error: '', localPhase: 'saved', transferredBytes: file.size })
      emit()
    })
    clearTimeout(peer.timeout)
    try {
      if (!disposed && connection.state === 'Connected')
        await action('CompleteFile', id, { receivedBytes: file.size, verifiedSha256Hex })
    } catch {
      await load().catch(() => {})
    } finally {
      releasePeer(id)
      emit()
    }
    if (!disposed) onNotice(`Đã lưu trên máy: ${transfers.get(id).savedName}`)
  }

  function attachChannel(id, channel, sending) {
    const peer = peers.get(id)
    if (!peer || peer.channel || channel.label !== (peer.streaming ? `${peer.protocolVersion}-0` : 'file-v1') || !channel.ordered ||
        channel.maxRetransmits !== null || channel.maxPacketLifeTime !== null) {
      channel.close()
      void fail(id, new Error('Kênh dữ liệu không hợp lệ.'))
      return
    }
    peer.channel = channel
    channel.binaryType = 'arraybuffer'
    channel.bufferedAmountLowThreshold = BUFFER_LOW
    if (peer.streaming && sending) peer.sender = createStreamSender({
      channel, transferId: id, signal: peer.abort.signal, protocolVersion: peer.protocolVersion, onProgress: bytes => progress(id, bytes),
    })
    if (peer.streaming && !sending) peer.streamReceiver = createStreamReceiver({
      size: transfers.get(id).fileSizeBytes, signal: peer.abort.signal, protocolVersion: peer.protocolVersion,
      write: (offset, data) => peer.disk.write(offset, data),
      acknowledge: bytes => channel.send(streamControl('ACK', id, bytes)),
      onProgress: bytes => progress(id, bytes),
    })
    channel.onopen = () => {
      observe(id, 'channel-open')
      peer.startedAt = performance.now()
      armTimeout(id)
      if (peer.streaming && peer.pc.sctp?.maxMessageSize < CHUNK_BYTES + streamHeaderBytes(peer.protocolVersion)) {
        void fail(id, new Error('WebRTC không hỗ trợ kích thước khung truyền.'))
        return
      }
      if (sending) void sendFile(id).catch(error => fail(id, error))
      else if (peer.streaming) {
        try { channel.send(streamControl('READY', id)) }
        catch (error) { void fail(id, error) }
      }
    }
    channel.onmessage = event => {
      if (peer.streaming) {
        try {
          if (sending) peer.sender.handle(event.data)
          else if (typeof event.data === 'string') {
            if (readStreamControl(event.data, id).type !== 'END') throw new Error('Khung ngoài giao thức.')
            void receiveStreamEnd(id).catch(error => fail(id, error))
          } else void peer.streamReceiver.push(event.data).catch(error => fail(id, error))
        } catch (error) { void fail(id, error) }
        return
      }
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
    const streaming = ['file-v2', 'file-v3'].includes(transfer.protocolVersion)
    const storage = receiving.get(transfer.id)
    if (streaming && !sending && !storage?.disk)
      throw new Error('Vị trí lưu file không còn khả dụng. Hãy nhận lại.')
    const pc = new RTCPeerConnection({ iceServers })
    const peer = {
      pc, streaming, protocolVersion: transfer.protocolVersion, disk: storage?.disk, abort: storage?.abort || new AbortController(),
      receiver: sending || streaming ? null : createFileReceiver(transfer.fileSizeBytes),
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
    if (sending) attachChannel(transfer.id, pc.createDataChannel(streaming ? `${transfer.protocolVersion}-0` : 'file-v1', { ordered: true }), true)
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
    transfers.set(transfer.id, { ...previous, ...transfer,
      localPhase: isFileActive(transfer) ? previous?.localPhase : null })
    const ownEndpoint = transfer.senderConnectionId === connection.connectionId ||
      transfer.receiverConnectionId === connection.connectionId
    if (transfer.status === 'offered' && !previous && transfer.receiverId === userId)
      onNotice(`Có lời mời nhận tệp “${transfer.fileName}”. Mở cuộc trò chuyện để nhận.`)
    if (transfer.status === 'accepted' && ownEndpoint && !previous?.localFailure)
      void startPeer(transfer)
    if (!isFileActive(transfer)) {
      observations.delete(transfer.id)
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

  // Tai tung trang file cua chat, khong de 50 file toan tai khoan lam mat lich su chat cu.
  async function loadConversation(conversationId, older = false) {
    const previous = conversationPages.get(conversationId)
    if (disposed || previous?.loading || (older && !previous?.nextCursor)) return
    conversationPages.set(conversationId, { ...previous, loading: true, error: '' })
    emit()
    try {
      const query = older ? '?' + new URLSearchParams({ beforeId: previous.nextCursor }) : ''
      const page = await request('/conversations/' + encodeURIComponent(conversationId) + '/files' + query,
        { token, signal: abort.signal })
      if (disposed) return
      for (const item of page.items) changed(item)
      conversationPages.set(conversationId, { nextCursor: page.nextCursor, loading: false, error: '' })
    } catch (error) {
      if (!disposed) conversationPages.set(conversationId,
        { ...previous, loading: false, error: error.message })
      throw error
    } finally { emit() }
  }

  function disconnected() {
    observations.clear()
    for (const id of [...peers.keys()]) releasePeer(id)
    for (const id of [...receiving.keys()]) releasePeer(id)
    pending.clear()
    starting.clear()
    for (const [id, transfer] of transfers) {
      if (isFileActive(transfer) && !transfer.savedLocally) transfers.set(id, { ...transfer,
        localFailure: true, error: 'Kết nối đã ngắt. Phiên này cần gửi lại.' })
    }
    emit()
  }

  connection.on('FileChanged', changed)
  connection.on('FileSignal', signalReceived)
  return {
    load, loadConversation, action, disconnected, forgetDownload,
    async offer(conversationId, file) {
      if (!file || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_FILE_BYTES)
        throw new Error('Chọn tệp tối đa 10 GiB.')
      if (!globalThis.RTCPeerConnection || !globalThis.crypto?.subtle)
        throw new Error('Trình duyệt cần hỗ trợ WebRTC và chạy trên HTTPS hoặc localhost.')
      if (connection.state !== 'Connected') throw new Error('Chưa kết nối máy chủ.')
      if (file.size > LARGE_FILE_WARNING_BYTES && !await confirmLargeFile(file)) return null
      if (disposed || connection.state !== 'Connected') throw new Error('Chưa kết nối máy chủ.')
      if (pending.size >= 2) throw new Error('Tab này đã có 2 tệp đang chờ hoặc đang gửi.')
      const clientTransferId = crypto.randomUUID()
      pending.set(clientTransferId, file)
      try {
        const settings = await config()
        if (file.size > (settings.maximumFileBytes ?? MAX_FILE_BYTES))
          throw new Error('Máy chủ hiện tại chưa hỗ trợ dung lượng tệp này. Hãy cập nhật máy chủ rồi thử lại.')
        const sha256Hex = await hashFile(file, abort.signal)
        if (disposed || !pending.has(clientTransferId)) throw new Error('Phiên gửi đã bị hủy.')
        const result = await connection.invoke('OfferFile', {
          conversationId, clientTransferId, fileName: file.name, fileSizeBytes: file.size, sha256Hex,
          supportedProtocols: file.size > LEGACY_MAX_FILE_BYTES ? ['file-v3'] : ['file-v1', 'file-v2'], requestedChannelCount: 1,
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
