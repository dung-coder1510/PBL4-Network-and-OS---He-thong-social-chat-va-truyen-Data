import { request } from './apiClient.js'
import { waitForTransferring } from './fileTransferState.js'
import {
  BUFFER_LOW, CHUNK_BYTES, DEFERRED_HASH_PROTOCOL, LARGE_FILE_WARNING_BYTES, LEGACY_MAX_FILE_BYTES,
  MAX_FILE_BYTES, MAX_FILE_CHANNELS, MULTICHANNEL_PROTOCOL, PARALLEL_CONNECTION_COUNT,
  PARALLEL_CONNECTIONS_PROTOCOL, STREAM_PROTOCOLS,
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
    clearTimeout(peer.closeTimeout)
    peer.abort.abort()
    peer.receiver?.clear()
    for (const channel of peer.channels) {
      if (!channel) continue
      channel.onclose = null
      channel.onerror = null
      channel.onmessage = null
      channel.onopen = null
      channel.close()
    }
    for (const { pc } of peer.connections) {
      pc.onicecandidate = null
      pc.onconnectionstatechange = null
      pc.ondatachannel = null
      pc.close()
    }
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
    const diskProtocol = !extra.legacy && canSaveFile(offered)
      ? offered.supportedProtocols.find(version => STREAM_PROTOCOLS.includes(version)) : null
    if (offered.fileSizeBytes > LEGACY_MAX_FILE_BYTES &&
        (!diskProtocol || diskProtocol === 'file-v2'))
      throw new Error('Tệp lớn cần phiên bản ứng dụng mới, trình duyệt hỗ trợ lưu trực tiếp và HTTPS hoặc localhost.')
    accepting.add(id)
    const storage = { abort: new AbortController(), disk: null }
    receiving.set(id, storage)
    try {
      if (diskProtocol) {
        // Gọi picker trước await mạng để giữ user activation từ nút Nhận file.
        const target = await pickFileDestination(offered.fileName)
        storage.abort.signal.throwIfAborted()
        storage.disk = await createFileStorage(target, storage.abort.signal, offered.fileSizeBytes)
      }
      await config()
      storage.abort.signal.throwIfAborted()
      const current = transfers.get(id)
      if (disposed || current?.status !== 'offered') throw new Error('Lời mời không còn hiệu lực.')
      const multipleChannels = diskProtocol === MULTICHANNEL_PROTOCOL || diskProtocol === PARALLEL_CONNECTIONS_PROTOCOL
      const channelCount = multipleChannels ? current.requestedChannelCount : 1
      return await invokeAction(method, id, { protocolVersion: diskProtocol || 'file-v1', channelCount })
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

  async function sendSignal(id, connectionIndex, kind, payload) {
    if (!peers.has(id) || disposed) return
    await connection.invoke('SendFileSignal', { transferId: id, kind, payload, connectionIndex })
  }

  async function sendFile(id) {
    const peer = peers.get(id)
    const current = transfers.get(id)
    const file = pending.get(current.clientTransferId)
    if (!file) throw new Error('Tệp gốc không còn ở tab gửi. Hãy gửi lại.')
    if (peer.streaming) {
      const finalizeHash = current.sha256Hex == null
        ? sha256Hex => action('FinalizeFileHash', id, { sha256Hex }) : undefined
      await peer.sender.send(file, () => action('BeginFileTransfer', id), finalizeHash)
      armTimeout(id, 30 * 60 * 1000)
      return
    }
    const [channel] = peer.channels
    await action('BeginFileTransfer', id)
    for (let offset = 0, index = 0; offset < file.size; offset += CHUNK_BYTES, index++) {
      await waitForBuffer(channel, peer.abort.signal)
      const chunk = await file.slice(offset, offset + CHUNK_BYTES).arrayBuffer()
      if (peer.abort.signal.aborted) return
      channel.send(encodeChunk(index, chunk))
      progress(id, offset + chunk.byteLength)
    }
    await waitForBuffer(channel, peer.abort.signal)
    channel.send(JSON.stringify({ type: 'end' }))
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
    const current = await waitForTransferring(() => transfers.get(id), changes, peer.abort.signal, 60000, true)
    const verifiedSha256Hex = peer.disk.verify(current.sha256Hex)
    phase(id, 'saving')
    const savedName = await peer.disk.commit()
    // Giữ kết quả khi trình duyệt đã chốt file mà kết nối SignalR vừa ngắt.
    transfers.set(id, { ...transfers.get(id), savedLocally: true, savedName,
      localFailure: false, error: '', localPhase: 'saved', transferredBytes: current.fileSizeBytes })
    emit()
    clearTimeout(peer.timeout)
    try {
      if (!disposed && connection.state === 'Connected')
        await action('CompleteFile', id, { receivedBytes: current.fileSizeBytes, verifiedSha256Hex })
    } catch {
      await load().catch(() => {})
    } finally {
      releasePeer(id)
      emit()
    }
    if (!disposed) onNotice(`Đã lưu trên máy: ${transfers.get(id).savedName}`)
  }

  function channelLabel(peer, index) {
    return peer.streaming ? `${peer.protocolVersion}-${index}` : 'file-v1'
  }

  function attachChannel(id, channel, sending, connectionIndex) {
    const peer = peers.get(id)
    const index = peer?.streaming ? Number(channel.label.slice(peer.protocolVersion.length + 1)) : 0
    if (!peer || !Number.isInteger(index) || index < 0 || index >= peer.channels.length || peer.channels[index] ||
        (peer.connections.length > 1 && index !== connectionIndex) ||
        channel.label !== channelLabel(peer, index) || !channel.ordered ||
        channel.maxRetransmits !== null || channel.maxPacketLifeTime !== null) {
      channel.close()
      void fail(id, new Error('Kênh dữ liệu không hợp lệ.'))
      return
    }
    const { pc } = peer.connections[connectionIndex]
    const channelsOnConnection = peer.connections.length === 1 ? peer.channels.length : 1
    peer.channels[index] = channel
    channel.binaryType = 'arraybuffer'
    channel.bufferedAmountLowThreshold = BUFFER_LOW
    channel.onopen = () => {
      const maxChannels = pc.sctp?.maxChannels
      if (channelsOnConnection > 1 && Number.isInteger(maxChannels) && maxChannels < channelsOnConnection) {
        void fail(id, new Error('WebRTC hỗ trợ ít kênh hơn mức đã chọn. Hãy giảm số kênh rồi gửi lại.'))
        return
      }
      if (peer.streaming && pc.sctp?.maxMessageSize < CHUNK_BYTES + streamHeaderBytes(peer.protocolVersion)) {
        void fail(id, new Error('WebRTC không hỗ trợ kích thước khung truyền.'))
        return
      }
      if (!peer.opened) {
        peer.opened = true
        observe(id, 'channel-open')
        peer.startedAt = performance.now()
        armTimeout(id)
        if (sending) void sendFile(id).catch(error => fail(id, error))
      }
      if (!sending && peer.streaming) {
        try { channel.send(streamControl('READY', id, undefined, index)) }
        catch (error) { void fail(id, error) }
      }
    }
    channel.onmessage = event => {
      if (peer.streaming) {
        try {
          if (sending) peer.sender.handle(event.data, index)
          else if (typeof event.data === 'string') {
            if (readStreamControl(event.data, id, index).type !== 'END') throw new Error('Khung ngoài giao thức.')
            if (peer.streamReceiver.end(index)) void receiveStreamEnd(id).catch(error => fail(id, error))
          } else void peer.streamReceiver.push(event.data, index).catch(error => fail(id, error))
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
      // Tiến độ ở các kênh còn mở không kéo dài thời gian chờ xác nhận của kênh đã đóng.
      peer.closeTimeout ??= setTimeout(() => {
        if (isFileActive(transfers.get(id)) && !peer.verifying)
          void fail(id, new Error('Kênh truyền đã đóng trước khi xác nhận.'))
      }, 2000)
    }
    channel.onerror = () => void fail(id, new Error('Lỗi kênh WebRTC.'))
  }

  function createPeer(transfer, iceServers) {
    if (peers.has(transfer.id)) return peers.get(transfer.id)
    const sending = transfer.senderId === userId
    const streaming = STREAM_PROTOCOLS.includes(transfer.protocolVersion)
    const parallelConnections = transfer.protocolVersion === PARALLEL_CONNECTIONS_PROTOCOL
    const multipleChannels = parallelConnections || transfer.protocolVersion === MULTICHANNEL_PROTOCOL
    const channelCount = multipleChannels ? transfer.channelCount : 1
    if (!Number.isInteger(channelCount) || channelCount < 1 || channelCount > MAX_FILE_CHANNELS ||
        (parallelConnections && channelCount !== PARALLEL_CONNECTION_COUNT))
      throw new Error('Số kênh truyền file không hợp lệ.')
    const storage = receiving.get(transfer.id)
    if (streaming && !sending && !storage?.disk)
      throw new Error('Vị trí lưu file không còn khả dụng. Hãy nhận lại.')
    const peer = {
      connections: [], streaming, channels: new Array(channelCount), opened: false,
      protocolVersion: transfer.protocolVersion, disk: storage?.disk, abort: storage?.abort || new AbortController(),
      receiver: sending || streaming ? null : createFileReceiver(transfer.fileSizeBytes),
      startedAt: performance.now(),
      lastUpdate: 0, verifying: false,
    }
    peers.set(transfer.id, peer)
    const connectionCount = parallelConnections ? PARALLEL_CONNECTION_COUNT : 1
    for (let connectionIndex = 0; connectionIndex < connectionCount; connectionIndex++) {
      const pc = new RTCPeerConnection({ iceServers })
      const rtc = { pc, candidates: [], incoming: Promise.resolve(), outgoing: Promise.resolve() }
      peer.connections.push(rtc)
      pc.onicecandidate = event => {
        if (!event.candidate) return
        rtc.outgoing = rtc.outgoing.then(() =>
          sendSignal(transfer.id, connectionIndex, 'ice', JSON.stringify(event.candidate.toJSON())))
          .catch(error => fail(transfer.id, error))
      }
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed') void fail(transfer.id,
          new Error('Không kết nối được WebRTC. Mạng khác NAT có thể cần TURN.'))
      }
      pc.ondatachannel = event => attachChannel(transfer.id, event.channel, false, connectionIndex)
    }
    const streamOptions = { signal: peer.abort.signal, protocolVersion: peer.protocolVersion,
      onProgress: bytes => progress(transfer.id, bytes) }
    if (sending) {
      for (let index = 0; index < channelCount; index++) {
        const connectionIndex = parallelConnections ? index : 0
        const { pc } = peer.connections[connectionIndex]
        attachChannel(transfer.id, pc.createDataChannel(channelLabel(peer, index), { ordered: true }), true, connectionIndex)
      }
      if (streaming) peer.sender = createStreamSender({ ...streamOptions, channels: peer.channels, transferId: transfer.id })
    } else if (streaming) {
      peer.streamReceiver = createStreamReceiver({ ...streamOptions, size: transfer.fileSizeBytes, channelCount,
        write: (offset, data) => peer.disk.write(offset, data),
        acknowledge: bytes => peer.channels[0].send(streamControl('ACK', transfer.id, bytes)),
      })
    }
    armTimeout(transfer.id, 45000)
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
        await Promise.all(peer.connections.map(async ({ pc }, connectionIndex) => {
          await pc.setLocalDescription(await pc.createOffer())
          await sendSignal(transfer.id, connectionIndex, 'offer', pc.localDescription.sdp)
        }))
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
      protocolVersion: transfer.protocolVersion ?? previous?.protocolVersion,
      channelCount: transfer.protocolVersion ? transfer.channelCount : previous?.channelCount,
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
      const connectionIndex = signal.connectionIndex ?? 0
      const rtc = Number.isInteger(connectionIndex) && peer.connections[connectionIndex]
      if (!rtc) throw new Error('Chỉ số kết nối báo hiệu không hợp lệ.')
      const { pc } = rtc
      // Mỗi kết nối giữ ICE đến sớm cho đến khi nhận SDP của chính nó.
      rtc.incoming = rtc.incoming.then(async () => {
        if (peer.abort.signal.aborted) return
        if (signal.kind === 'ice') {
          const candidate = JSON.parse(signal.payload)
          if (pc.remoteDescription) await pc.addIceCandidate(candidate)
          else {
            if (rtc.candidates.length >= 128) throw new Error('Quá nhiều ICE candidate.')
            rtc.candidates.push(candidate)
          }
          return
        }
        await pc.setRemoteDescription({ type: signal.kind, sdp: signal.payload })
        for (const candidate of rtc.candidates) await pc.addIceCandidate(candidate)
        rtc.candidates = []
        if (signal.kind === 'offer') {
          await pc.setLocalDescription(await pc.createAnswer())
          await sendSignal(transfer.id, connectionIndex, 'answer', pc.localDescription.sdp)
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
    async offer(conversationId, file, preferredChannelCount = null, useParallelConnections = false) {
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
        const large = file.size > LEGACY_MAX_FILE_BYTES
        const desiredChannelCount = useParallelConnections ? PARALLEL_CONNECTION_COUNT : preferredChannelCount
        const experimental = desiredChannelCount !== null && settings.maximumFileChannels > 0
        const requestedChannelCount = experimental
          ? Math.min(desiredChannelCount, settings.maximumFileChannels, MAX_FILE_CHANNELS) : 1
        const supportedProtocols = large
          ? [settings.supportsDeferredHash && typeof globalThis.Worker === 'function' ? DEFERRED_HASH_PROTOCOL : 'file-v3']
          : ['file-v1', 'file-v2']
        if (experimental) supportedProtocols.unshift(MULTICHANNEL_PROTOCOL)
        if (useParallelConnections && settings.supportsParallelFileConnections &&
            requestedChannelCount === PARALLEL_CONNECTION_COUNT)
          supportedProtocols.unshift(PARALLEL_CONNECTIONS_PROTOCOL)
        const deferred = supportedProtocols.includes(DEFERRED_HASH_PROTOCOL)
        const sha256Hex = deferred ? null : await hashFile(file, abort.signal)
        if (disposed || !pending.has(clientTransferId)) throw new Error('Phiên gửi đã bị hủy.')
        const result = await connection.invoke('OfferFile', {
          conversationId, clientTransferId, fileName: file.name, fileSizeBytes: file.size, sha256Hex,
          supportedProtocols, requestedChannelCount,
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
