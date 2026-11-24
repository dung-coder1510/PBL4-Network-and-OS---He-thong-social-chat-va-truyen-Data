import { request, requestFileContent, requestWithHeaders } from './apiClient.js'
import { formatFileSize } from '../utils/chatTimeline.js'
import { waitForTransferring } from './fileTransferState.js'
import {
  BUFFER_LOW, CHUNK_BYTES, DEFERRED_HASH_PROTOCOL, HIGH_SPEED_PROTOCOL, LARGE_FILE_WARNING_BYTES,
  LEGACY_MAX_FILE_BYTES, MAX_FILE_BYTES, MAX_FILE_CHANNELS, MULTICHANNEL_PROTOCOL, PARALLEL_CONNECTION_COUNT,
  PARALLEL_CONNECTIONS_PROTOCOL, STREAM_PROTOCOLS, V7_MAX_CHUNK_BYTES, V7_MAX_FILE_WINDOW,
  createFileReceiver, encodeChunk, filterIceServers, sha256, v7BlockBytes, waitForBuffer,
} from './fileProtocol.js'
import { createStreamReceiver, createStreamSender, hashFile, readStreamControl, streamControl, streamHeaderBytes } from './fileStreamProtocol.js'
import { canSaveFile, createFileStorage, createPartFileStorage, pickFileDestination } from './fileStorage.js'
import { createRelayUploadBodies, RELAY_CONNECTION_COUNTS } from './fileRelayProtocol.js'
import {
  DEFAULT_MULTIPART_CONNECTIONS, RELAY_PART_BYTES, downloadMultipartRelay, uploadMultipartRelay,
} from './fileRelayMultipart.js'
import { streamResponseToDisk } from './fileRelayStream.js'
import { MAX_FILE_WINDOW } from './fileFlowControl.js'
import { monitorFileRtc } from './fileRtcDiagnostics.js'
import { createTransferRate } from './fileTransferRate.js'

export const isFileActive = transfer => !!transfer && ['offered', 'accepted', 'transferring'].includes(transfer.status)

function versionNumber(version) {
  return [...atob(version)].reduce((value, character) => (value << 8n) + BigInt(character.charCodeAt(0)), 0n)
}

export function createFileTransfers({ connection: initialConnection, token, userId, onChange, onNotice,
  confirmLargeFile, onRelayActivity = () => {}, allowTurnForFiles: initialAllowTurn = false }) {
  let connection = null
  const transfers = new Map()
  const pending = new Map()
  const peers = new Map()
  const downloads = new Map()
  const starting = new Map()
  const receiving = new Map()
  const accepting = new Set()
  const observations = new Map()
  const relayJobs = new Map()
  const switching = new Set()
  // Báo cáo giám sát không chặn truyền file. Giới hạn cả tần suất và request đang chờ;
  // không gửi exception thô, SDP hoặc nội dung file. Backend xác thực endpoint độc lập.
  function observe(id, stage, bytes = null, reason = null) {
    const previous = observations.get(id)
    const now = performance.now()
    if (disposed || connection?.state !== 'Connected') return
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
  let relayAvailable = false
  let pollingRelay = false
  let allowTurnForFiles = initialAllowTurn === true
  const emit = () => {
    if (disposed) return
    changes.dispatchEvent(new Event('change'))
    onChange({
      items: [...transfers.values()].map(item => item.transport === 'https' ? {
        ...item, localRelayEndpoint: relayJobs.has(item.id) || pending.has(item.clientTransferId),
      } : item).sort((left, right) => BigInt(left.id) > BigInt(right.id) ? -1 : 1),
      nextCursor,
      conversationPages: Object.fromEntries(conversationPages),
      relayAvailable,
    })
  }
  const config = () => configuration ??= request('/files/configuration', { token, signal: abort.signal })
    .then(settings => {
      relayAvailable = settings.supportsHttpFileRelay === true
      emit()
      return settings
    })
    .catch(error => { configuration = null; throw error })

  function releasePeer(id) {
    const storage = receiving.get(id)
    receiving.delete(id)
    storage?.abort.abort()
    const cleanup = storage?.disk?.dispose()
    const peer = peers.get(id)
    if (!peer) return cleanup
    const current = transfers.get(id)
    if (current?.rtcDiagnostics)
      transfers.set(id, { ...current, rtcDiagnostics: { ...current.rtcDiagnostics,
        ...(peer.sender?.diagnostics() || peer.streamReceiver?.diagnostics()) } })
    peers.delete(id)
    peer.stopDiagnostics?.()
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
      pc.oniceconnectionstatechange = null
      pc.ondatachannel = null
      pc.close()
    }
    return cleanup
  }

  const relayPath = id => `/files/${id}/relay`

  function relayActivity() {
    onRelayActivity([...relayJobs.values()].some(job => job.active))
  }

  function releaseRelay(id) {
    const job = relayJobs.get(id)
    if (!job) return
    relayJobs.delete(id)
    job.abort.abort()
    void job.disk?.dispose()
    relayActivity()
  }

  async function endRelay(id, action) {
    const result = await request(`${relayPath(id)}?action=${action}`, {
      method: 'DELETE', token, signal: abort.signal,
    })
    changed(result)
    return result
  }

  async function failRelay(id, error) {
    const current = transfers.get(id)
    if (!isFileActive(current) || disposed || current.savedLocally) return
    transfers.set(id, { ...current, localFailure: true, error: error.message || 'Luồng HTTPS đã dừng.' })
    pending.delete(current.clientTransferId)
    emit()
    try { await endRelay(id, 'fail') }
    catch { /* Backend cũng kết thúc phiên khi luồng HTTP đóng. */ }
  }

  async function acceptRelay(id, target) {
    const current = transfers.get(id)
    if (relayJobs.has(id) || current?.status !== 'offered') return
    if (!canSaveFile(current)) throw new Error('Trình duyệt cần hỗ trợ chọn nơi lưu file qua HTTPS.')
    const job = { abort: new AbortController(), startedAt: performance.now(), lastUpdate: 0 }
    relayJobs.set(id, job)
    const { signal } = job.abort
    try {
      const destination = target ?? await pickFileDestination(current.fileName)
      signal.throwIfAborted()
      const multipart = current.relayMode === 'multipart'
      const partBytes = current.relayPartBytes || RELAY_PART_BYTES
      job.disk = multipart
        ? await createPartFileStorage(destination, signal, current.fileSizeBytes, partBytes)
        : await createFileStorage(destination, signal, current.fileSizeBytes)
      const result = await request(`${relayPath(id)}/accept`, {
        method: 'POST', body: { transferId: id, expectedVersion: current.version }, token, signal,
      })
      job.active = true
      relayActivity()
      changed(result.transfer)
      if (result.transfer.relayMode === 'multipart')
        void receiveMultipartRelay(id, result.transfer, partBytes, job, result.receiverKey)
      else void receiveRelay(id, job, result.receiverKey)
    } catch (error) {
      releaseRelay(id)
      if (error.name !== 'AbortError') throw error
    }
  }

  async function receiveMultipartRelay(id, transfer, partBytes, job, receiverKey) {
    const { signal } = job.abort
    const headers = { 'X-File-Relay-Key': receiverKey }
    const connectionCount = RELAY_CONNECTION_COUNTS.includes(transfer.relayConnectionCount)
      ? transfer.relayConnectionCount : DEFAULT_MULTIPART_CONNECTIONS
    try {
      const { receivedBytes, expectedSha256Hex } = await downloadMultipartRelay({
        fileSizeBytes: transfer.fileSizeBytes,
        partBytes,
        connectionCount,
        disk: job.disk,
        signal,
        async getPart(partIndex, ack, onChunk) {
          const params = new URLSearchParams({ key: receiverKey })
          if (ack !== null) params.set('ack', String(ack))
          const response = await requestFileContent(`${relayPath(id)}/parts/${partIndex}?${params}`, {
            token: null, signal,
          })
          const sha256Hex = response.headers.get('X-Part-SHA256')
          if (!response.body || typeof response.body.getReader !== 'function') {
            const buffer = await response.arrayBuffer()
            onChunk?.(buffer.byteLength)
            return { buffer, sha256Hex }
          }
          const reader = response.body.getReader()
          const chunks = []
          let loaded = 0
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            chunks.push(value)
            loaded += value.byteLength
            onChunk?.(value.byteLength)
          }
          if (chunks.length === 1 && chunks[0].byteOffset === 0 && chunks[0].byteLength === chunks[0].buffer.byteLength) {
            return { buffer: chunks[0].buffer, sha256Hex }
          }
          const merged = new Uint8Array(loaded)
          let offset = 0
          for (const chunk of chunks) {
            merged.set(chunk, offset)
            offset += chunk.byteLength
          }
          return { buffer: merged.buffer, sha256Hex }
        },
        ackParts(partIndices) {
          return request(`${relayPath(id)}/parts/ack`, {
            method: 'POST', token: null, signal, headers, body: { partIndices }, timeoutMs: 30000,
          })
        },
        fetchHash() {
          return request(`${relayPath(id)}/hash`, {
            method: 'GET', token: null, signal, headers, timeoutMs: 0,
          })
        },
        onProgress: bytes => progress(id, bytes),
      })
      phase(id, 'verifying')
      const verifiedSha256Hex = await job.disk.verify(expectedSha256Hex)
      phase(id, 'saving')
      const savedName = await job.disk.commit()
      transfers.set(id, { ...transfers.get(id), savedLocally: true, savedName, localPhase: 'saved',
        transferredBytes: receivedBytes })
      emit()
      try {
        const completed = await request(`${relayPath(id)}/complete`, {
          method: 'POST', token: null, headers, signal, timeoutMs: 30000,
          body: { transferId: id, expectedVersion: transfers.get(id).version, receivedBytes, verifiedSha256Hex },
        })
        changed(completed)
      } catch { await load().catch(() => {}) }
      if (!disposed) onNotice(`Đã lưu trên máy: ${savedName}`)
    } catch (error) {
      if (!signal.aborted) await failRelay(id, error)
    } finally { releaseRelay(id) }
  }

  // The receive action returns after acceptance so the user can cancel while the writer is active.
  async function receiveRelay(id, job, receiverKey) {
    const { signal } = job.abort
    const headers = { 'X-File-Relay-Key': receiverKey }
    try {
      const response = await requestFileContent(`${relayPath(id)}/content`, { token, signal, headers })
      const receivedBytes = await streamResponseToDisk(response, job.disk, signal, bytes => progress(id, bytes))
      phase(id, 'verifying')
      const verifiedSha256Hex = job.disk.verify(response.headers.get('X-File-SHA256'))
      phase(id, 'saving')
      const savedName = await job.disk.commit()
      transfers.set(id, { ...transfers.get(id), savedLocally: true, savedName, localPhase: 'saved',
        transferredBytes: receivedBytes })
      emit()
      try {
        const completed = await request(`${relayPath(id)}/complete`, {
          method: 'POST', headers, signal,
          body: { transferId: id, expectedVersion: transfers.get(id).version, receivedBytes, verifiedSha256Hex },
        })
        changed(completed)
      } catch { await load().catch(() => {}) }
      if (!disposed) onNotice(`Đã lưu trên máy: ${savedName}`)
    } catch (error) {
      if (!signal.aborted) await failRelay(id, error)
    } finally { releaseRelay(id) }
  }

  async function uploadRelay(transfer) {
    if (relayJobs.has(transfer.id)) return
    const selected = pending.get(transfer.clientTransferId)
    if (!selected) return
    const { file } = selected
    const job = { abort: new AbortController(), startedAt: performance.now(), lastUpdate: 0, active: true }
    relayJobs.set(transfer.id, job)
    relayActivity()
    const { signal } = job.abort
    try {
      if (transfer.relayMode === 'multipart') {
        let senderKey = selected.senderKey
        if (!senderKey) {
          const claimed = await request(`${relayPath(transfer.id)}/session`, { method: 'POST', token, signal })
          senderKey = selected.senderKey = claimed.senderKey
        }
        const connectionCount = RELAY_CONNECTION_COUNTS.includes(transfer.relayConnectionCount)
          ? transfer.relayConnectionCount : DEFAULT_MULTIPART_CONNECTIONS
        await uploadMultipartRelay({
          file,
          partBytes: transfer.relayPartBytes || RELAY_PART_BYTES,
          connectionCount,
          precomputedSha256Hex: transfer.sha256Hex ?? null,
          signal,
          putPart(partIndex, buffer, partSha256) {
            const params = new URLSearchParams({ key: senderKey, sha256: partSha256 })
            return requestFileContent(`${relayPath(transfer.id)}/parts/${partIndex}?${params}`, {
              method: 'POST', body: new Blob([buffer], { type: 'text/plain' }), token: null, signal,
            })
          },
          async finalizeHash(sha256Hex) {
            const finalized = await request(`${relayPath(transfer.id)}/hash`, {
              method: 'POST', token: null, signal,
              headers: { 'X-File-Relay-Sender-Key': senderKey },
              body: { sha256Hex }, timeoutMs: 30000,
            })
            changed(finalized)
          },
          onProgress: bytes => progress(transfer.id, bytes),
        })
        return
      }
      const sha = transfer.sha256Hex ?? await hashFile(file, signal)
      const settings = await config()
      const count = Math.min(selected.relayConnectionCount ?? 1, settings.maximumRelayConnections ?? 1)
      if (count > 1) {
        changed(await request(`${relayPath(transfer.id)}/upload`, {
          method: 'POST', token, signal, body: { sha256Hex: sha, connectionCount: count },
        }))
      }
      const bodies = createRelayUploadBodies(file, count)
      const responses = await Promise.all(bodies.map((body, channel) =>
        requestFileContent(`${relayPath(transfer.id)}/content${count > 1 ? `?channel=${channel}` : ''}`, {
          method: 'PUT', body, token, signal,
          headers: { 'Content-Type': 'application/octet-stream', 'X-File-SHA256': sha },
        })))
      changed(await responses[0].json())
    } catch (error) {
      if (!signal.aborted) await failRelay(transfer.id, error)
    } finally { releaseRelay(transfer.id) }
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
    if (transfers.get(id)?.transport === 'https') {
      if (method === 'AcceptFile') return acceptRelay(id)
      const end = { CancelFile: 'cancel', RejectFile: 'reject', FailFile: 'fail' }[method]
      if (end) return endRelay(id, end)
    }
    if (method !== 'AcceptFile') return invokeAction(method, id, extra)
    if (accepting.has(id)) return
    if (!globalThis.RTCPeerConnection || !globalThis.crypto?.subtle)
      throw new Error('Nhận tệp cần WebRTC và HTTPS hoặc localhost.')
    const offered = transfers.get(id)
    if (!offered || offered.status !== 'offered') throw new Error('Lời mời không còn hiệu lực.')
    if (!Number.isSafeInteger(offered.fileSizeBytes) || offered.fileSizeBytes < 0 || offered.fileSizeBytes > MAX_FILE_BYTES)
      throw new Error('Tệp vượt dung lượng nhận cho phép.')
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
        storage.target = target
        storage.abort.signal.throwIfAborted()
        storage.disk = diskProtocol === HIGH_SPEED_PROTOCOL
          ? await createPartFileStorage(target, storage.abort.signal, offered.fileSizeBytes, v7BlockBytes(offered.fileSizeBytes))
          : await createFileStorage(target, storage.abort.signal, offered.fileSizeBytes)
      }
      await config()
      storage.abort.signal.throwIfAborted()
      const current = transfers.get(id)
      if (disposed || current?.status !== 'offered') throw new Error('Lời mời không còn hiệu lực.')
      const multipleChannels = diskProtocol === MULTICHANNEL_PROTOCOL ||
        diskProtocol === PARALLEL_CONNECTIONS_PROTOCOL || diskProtocol === HIGH_SPEED_PROTOCOL
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

  async function fail(id, error, retryViaRelay = false) {
    const current = transfers.get(id)
    if (!isFileActive(current) || disposed || current.localFailure || current.savedLocally || switching.has(id)) return
    if (current.transport === 'https') return
    if (relayAvailable && retryViaRelay && STREAM_PROTOCOLS.includes(current.protocolVersion) &&
        (current.senderId !== userId || pending.has(current.clientTransferId))) {
      switching.add(id)
      try {
        const settings = await config().catch(() => null)
        const multipart = settings?.supportsMultipartHttpRelay === true && (settings?.supportsDeferredRelayHash === true || current.sha256Hex != null)
        const preferred = pending.get(current.clientTransferId)?.relayConnectionCount
        const connections = RELAY_CONNECTION_COUNTS.includes(preferred) ? preferred : DEFAULT_MULTIPART_CONNECTIONS
        const path = multipart ? `${relayPath(id)}?mode=multipart&connections=${connections}` : relayPath(id)
        const { data: switched, headers } = await requestWithHeaders(path, { method: 'POST', token, signal: abort.signal })
        const senderKey = headers.get('X-File-Relay-Sender-Key')
        if (senderKey && pending.has(current.clientTransferId))
          pending.get(current.clientTransferId).senderKey = senderKey
        changed(switched)
        return
      } catch {
        if (transfers.get(id)?.transport === 'https' || !isFileActive(transfers.get(id))) return
      } finally { switching.delete(id) }
    }
    transfers.set(id, { ...current, localFailure: true, error: error.message || 'Truyền tệp thất bại.' })
    releasePeer(id)
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
    peer.timeout = setTimeout(() => void fail(id, new Error('Phiên truyền không tiến triển.'), true), milliseconds)
  }

  function progress(id, bytes) {
    const peer = peers.get(id) ?? relayJobs.get(id)
    const current = transfers.get(id)
    if (!peer || !current || !isFileActive(current)) return
    if (current.transport !== 'https') {
      observe(id, 'transferring', bytes)
      armTimeout(id)
    }
    const now = performance.now()
    if (now - peer.lastUpdate < 250 && bytes !== current.fileSizeBytes) return
    peer.lastUpdate = now
    peer.rate ??= createTransferRate(peer.startedAt)
    transfers.set(id, { ...current, transferredBytes: bytes,
      ...peer.rate.sample(bytes, now) })
    emit()
  }

  async function sendSignal(id, connectionIndex, kind, payload) {
    if (!peers.has(id) || disposed) return
    await connection.invoke('SendFileSignal', { transferId: id, kind, payload, connectionIndex })
  }

  async function sendFile(id) {
    const peer = peers.get(id)
    const current = transfers.get(id)
    const file = pending.get(current.clientTransferId)?.file
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
    const verifiedSha256Hex = await peer.disk.verify(current.sha256Hex)
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
        void fail(id, new Error('WebRTC hỗ trợ ít kênh hơn mức đã chọn. Hãy giảm số kênh rồi gửi lại.'), true)
        return
      }
      if (peer.streaming && pc.sctp?.maxMessageSize < CHUNK_BYTES + streamHeaderBytes(peer.protocolVersion)) {
        void fail(id, new Error('WebRTC không hỗ trợ kích thước khung truyền.'), true)
        return
      }
      peer.openedChannels.add(index)
      if (!peer.opened) {
        peer.opened = true
        peer.startDiagnostics()
        observe(id, 'channel-open')
        peer.startedAt = performance.now()
        armTimeout(id)
        if (sending) void sendFile(id).catch(error => {
          const shouldFallback = peer.channels.some(item => item?.readyState === 'closed' || item?.readyState === 'closing') ||
            /Kênh truyền|WebRTC|không tiến triển/.test(error?.message || '')
          return fail(id, error, shouldFallback)
        })
      }
      if (!sending && peer.streaming) {
        try {
          const capabilities = peer.protocolVersion === HIGH_SPEED_PROTOCOL
            ? peer.streamReceiver.negotiateConnection(pc.sctp?.maxMessageSize)
            : peer.streamReceiver.capabilities
          channel.send(streamControl('READY', id, undefined, index, capabilities))
        }
        catch (error) { void fail(id, error, true) }
      }
    }
    channel.onmessage = event => {
      if (peer.streaming) {
        try {
          if (sending) peer.sender.handle(event.data, index)
          else if (typeof event.data === 'string') {
            const control = readStreamControl(event.data, id, index)
            if (control.type !== 'END') throw new Error('Khung ngoài giao thức.')
            if (peer.streamReceiver.end(index, control.activeChannels)) void receiveStreamEnd(id).catch(error => fail(id, error))
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
      if (peer.protocolVersion === HIGH_SPEED_PROTOCOL && index > 0 && !peer.openedChannels.has(index) &&
          !peer.failedConnections.has(0)) return
      // Tiến độ ở các kênh còn mở không kéo dài thời gian chờ xác nhận của kênh đã đóng.
      peer.closeTimeout ??= setTimeout(() => {
        if (isFileActive(transfers.get(id)) && !peer.verifying)
          void fail(id, new Error('Kênh truyền đã đóng trước khi xác nhận.'), true)
      }, 2000)
    }
    channel.onerror = () => {
      if (peer.protocolVersion === HIGH_SPEED_PROTOCOL && index > 0 && !peer.openedChannels.has(index) &&
          !peer.failedConnections.has(0)) return
      void fail(id, new Error('Lỗi kênh WebRTC.'), true)
    }
  }

  function createPeer(transfer, iceServers) {
    if (peers.has(transfer.id)) return peers.get(transfer.id)
    const sending = transfer.senderId === userId
    const streaming = STREAM_PROTOCOLS.includes(transfer.protocolVersion)
    const highSpeed = transfer.protocolVersion === HIGH_SPEED_PROTOCOL
    const parallelConnections = transfer.protocolVersion === PARALLEL_CONNECTIONS_PROTOCOL ||
      (highSpeed && transfer.channelCount > 1)
    const multipleChannels = parallelConnections || transfer.protocolVersion === MULTICHANNEL_PROTOCOL || highSpeed
    const channelCount = multipleChannels ? transfer.channelCount : 1
    if (!Number.isInteger(channelCount) || channelCount < 1 || channelCount > MAX_FILE_CHANNELS ||
        (transfer.protocolVersion === PARALLEL_CONNECTIONS_PROTOCOL && channelCount !== PARALLEL_CONNECTION_COUNT) ||
        (highSpeed && ![1, 2, 4].includes(channelCount)))
      throw new Error('Số kênh truyền file không hợp lệ.')
    const storage = receiving.get(transfer.id)
    if (streaming && !sending && !storage?.disk)
      throw new Error('Vị trí lưu file không còn khả dụng. Hãy nhận lại.')
    const peer = {
      connections: [], streaming, channels: new Array(channelCount), opened: false,
      openedChannels: new Set(), failedConnections: new Set(),
      protocolVersion: transfer.protocolVersion, disk: storage?.disk, abort: storage?.abort || new AbortController(),
      receiver: sending || streaming ? null : createFileReceiver(transfer.fileSizeBytes),
      startedAt: performance.now(),
      lastUpdate: 0, verifying: false,
    }
    peers.set(transfer.id, peer)
    const effectiveIceServers = filterIceServers(iceServers, allowTurnForFiles)
    const connectionCount = parallelConnections ? channelCount : 1
    for (let connectionIndex = 0; connectionIndex < connectionCount; connectionIndex++) {
      const pc = new RTCPeerConnection({ iceServers: effectiveIceServers })
      const rtc = { pc, candidates: [], incoming: Promise.resolve(), outgoing: Promise.resolve() }
      peer.connections.push(rtc)
      pc.onicecandidate = event => {
        if (!event.candidate) return
        rtc.outgoing = rtc.outgoing.then(() =>
          sendSignal(transfer.id, connectionIndex, 'ice', JSON.stringify(event.candidate.toJSON())))
          .catch(error => fail(transfer.id, error, true))
      }
      const handleConnectionFailure = () => {
        peer.failedConnections.add(connectionIndex)
        if (peer.protocolVersion === HIGH_SPEED_PROTOCOL && connectionIndex > 0 &&
            !peer.openedChannels.has(connectionIndex) && !peer.failedConnections.has(0)) return
        void fail(transfer.id,
          new Error('Không kết nối được WebRTC. Đang chuyển sang HTTPS hoặc kiểm tra mạng.'), true)
      }
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed') handleConnectionFailure()
      }
      pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === 'failed') handleConnectionFailure()
      }
      pc.ondatachannel = event => attachChannel(transfer.id, event.channel, false, connectionIndex)
    }
    const streamOptions = { signal: peer.abort.signal, protocolVersion: peer.protocolVersion,
      roundTripMs: () => peer.roundTripMs,
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
        maxWindowBytes: highSpeed ? V7_MAX_FILE_WINDOW : MAX_FILE_WINDOW,
        maxChunkBytes: highSpeed ? V7_MAX_CHUNK_BYTES : CHUNK_BYTES,
        ...(highSpeed
          ? { writePart: (blockIndex, offset, data) => peer.disk.writePart(blockIndex, offset, data) }
          : { write: (offset, data) => peer.disk.write(offset, data) }),
        acknowledge: (bytes, details) => peer.channels[0].send(streamControl('ACK', transfer.id, bytes, 0, details)),
      })
    }
    peer.startDiagnostics = () => peer.stopDiagnostics ??= monitorFileRtc({ connections: peer.connections, sending, signal: peer.abort.signal,
      onUpdate: connections => {
        const current = transfers.get(transfer.id)
        if (peers.get(transfer.id) !== peer || disposed || !isFileActive(current) || current.transport === 'https') return
        if (!allowTurnForFiles && relayAvailable && !peer.verifying &&
            connections.some(item => item.route === 'turn')) {
          void fail(transfer.id, new Error('Ưu tiên chuyển tiếp qua HTTPS thay vì TURN.'), true)
          return
        }
        const latencies = connections.map(item => item.roundTripMs).filter(value => value !== null)
        peer.roundTripMs = latencies.length ? Math.max(...latencies) : null
        const rate = peer.rate?.sample(current.transferredBytes || 0)
        transfers.set(transfer.id, { ...current, ...(rate ? { bytesPerSecond: rate.bytesPerSecond } : {}), rtcDiagnostics: { connections,
          ...(sending ? peer.sender?.diagnostics() : peer.streamReceiver?.diagnostics()) } })
        emit()
      },
    })
    const handshakeTimeoutMs = !allowTurnForFiles && relayAvailable ? 8000 : 15000
    armTimeout(transfer.id, handshakeTimeoutMs)
    return peer
  }

  function startPeer(transfer) {
    if (starting.has(transfer.id)) return starting.get(transfer.id)
    const start = (async () => {
      const settings = await config()
      const current = transfers.get(transfer.id)
      if (disposed || !isFileActive(current) || current.localFailure || current.transport === 'https' ||
          connection?.state !== 'Connected' ||
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
    start.catch(error => fail(transfer.id, error, true))
    return start
  }

  function changed(transfer) {
    if (disposed) return
    const previous = transfers.get(transfer.id)
    if (previous && versionNumber(previous.version) > versionNumber(transfer.version)) return
    const changedToRelay = transfer.transport === 'https' && previous?.transport !== 'https'
    const target = changedToRelay ? receiving.get(transfer.id)?.target : null
    const cleanup = changedToRelay ? releasePeer(transfer.id) : null
    transfers.set(transfer.id, { ...previous, ...transfer,
      transport: transfer.transport ?? previous?.transport,
      ...(changedToRelay ? { localFailure: false, error: '', transferredBytes: 0, bytesPerSecond: 0, rtcDiagnostics: undefined } : {}),
      protocolVersion: transfer.protocolVersion ?? previous?.protocolVersion,
      channelCount: transfer.protocolVersion ? transfer.channelCount : previous?.channelCount,
      localPhase: isFileActive(transfer) ? previous?.localPhase : null })
    const ownEndpoint = connection?.connectionId && (transfer.senderConnectionId === connection.connectionId ||
      transfer.receiverConnectionId === connection.connectionId)
    if (transfer.status === 'offered' && !previous && transfer.receiverId === userId)
      onNotice(`Có lời mời nhận tệp “${transfer.fileName}”. Mở cuộc trò chuyện để nhận.`)
    if (transfer.transport === 'https') {
      if (target && transfer.status === 'offered') {
        void Promise.resolve(cleanup).then(() => acceptRelay(transfer.id, target))
          .catch(error => onNotice(error.message))
      }
      if (transfer.status === 'accepted' && transfer.relayReady && transfer.senderId === userId)
        void uploadRelay(transfer)
      if (transfer.senderId === userId && transfer.relayedBytes > (previous?.transferredBytes ?? 0))
        progress(transfer.id, transfer.relayedBytes)
    } else if (transfer.status === 'accepted' && ownEndpoint && !previous?.localFailure)
      void startPeer(transfer)
    if (!isFileActive(transfer)) {
      observations.delete(transfer.id)
      releasePeer(transfer.id)
      releaseRelay(transfer.id)
      starting.delete(transfer.id)
      pending.delete(transfer.clientTransferId)
    }
    emit()
  }

  async function signalReceived(signal) {
    const transfer = transfers.get(signal.transferId)
    if (!connection || !transfer || !isFileActive(transfer) || transfer.transport === 'https' ||
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
      }).catch(error => fail(transfer.id, error, true))
    } catch (error) { void fail(transfer.id, error, true) }
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
    starting.clear()
    for (const [id, transfer] of transfers) {
      if (transfer.transport === 'https') continue
      pending.delete(transfer.clientTransferId)
      if (isFileActive(transfer) && !transfer.savedLocally) transfers.set(id, { ...transfer,
        localFailure: true, error: 'Kết nối đã ngắt. Phiên này cần gửi lại.' })
    }
    emit()
  }

  function setConnection(next) {
    if (connection === next) return
    connection?.off('FileChanged', changed)
    connection?.off('FileSignal', signalReceived)
    if (connection) disconnected()
    connection = next
    connection?.on('FileChanged', changed)
    connection?.on('FileSignal', signalReceived)
  }

  async function pollRelay() {
    if (!relayAvailable || pollingRelay || disposed) return
    const ids = [...transfers.values()]
      .filter(item => item.transport === 'https' && isFileActive(item)).map(item => item.id)
    const signalrDown = connection?.state !== 'Connected'
    if (!ids.length && !signalrDown) return
    pollingRelay = true
    try {
      const options = { token, signal: abort.signal }
      if (signalrDown) {
        const page = await request('/files', options)
        for (const item of page.items) {
          if (item.transport === 'https' || transfers.get(item.id)?.transport === 'https') changed(item)
        }
      }
      await Promise.allSettled(ids.map(id => request(`/files/${id}`, options).then(changed)))
    } catch { /* Thẻ được cập nhật ở lượt đọc hoặc biên nhận tiếp theo. */ }
    finally { pollingRelay = false }
  }

  setConnection(initialConnection ?? null)
  void config().catch(() => {})
  const relayPoll = setInterval(pollRelay, 1000)
  return {
    load, loadConversation, action, disconnected, forgetDownload, setConnection,
    setAllowTurnForFiles(enabled) { allowTurnForFiles = enabled === true },
    async offer(conversationId, file, preferredChannelCount = null, useParallelConnections = null, transport = 'webrtc',
      relayConnectionCount = null) {
      if (!file || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_FILE_BYTES)
        throw new Error(`Tệp vượt dung lượng gửi cho phép (${formatFileSize(MAX_FILE_BYTES)}).`)
      if (!globalThis.crypto?.subtle) throw new Error('Truyền file cần HTTPS hoặc localhost.')
      if (file.size > LARGE_FILE_WARNING_BYTES && !await confirmLargeFile(file)) return null
      if (disposed) throw new Error('Phiên đăng nhập đã kết thúc.')
      if (pending.size >= 2) throw new Error('Tab này đã có 2 tệp đang chờ hoặc đang gửi.')
      const clientTransferId = crypto.randomUUID()
      pending.set(clientTransferId, { file,
        relayConnectionCount: RELAY_CONNECTION_COUNTS.includes(relayConnectionCount) ? relayConnectionCount : null })
      try {
        const settings = await config()
        if (file.size > (settings.maximumFileBytes ?? MAX_FILE_BYTES))
          throw new Error('Máy chủ hiện tại chưa hỗ trợ dung lượng tệp này. Hãy cập nhật máy chủ rồi thử lại.')
        const webRtcAvailable = globalThis.RTCPeerConnection && connection?.state === 'Connected'
        if (transport === 'https' || (!webRtcAvailable && settings.supportsHttpFileRelay)) {
          if (!settings.supportsHttpFileRelay) throw new Error('Máy chủ chưa hỗ trợ chuyển tiếp qua HTTPS.')
          const multipart = settings.supportsMultipartHttpRelay === true
          const deferredRelayHash = multipart && settings.supportsDeferredRelayHash === true
          const relayConnections = multipart
            ? (RELAY_CONNECTION_COUNTS.includes(relayConnectionCount)
              ? relayConnectionCount : (settings.defaultRelayConnections ?? DEFAULT_MULTIPART_CONNECTIONS))
            : 1
          const sha256Hex = deferredRelayHash ? null : await hashFile(file, abort.signal)
          const { data: result, headers } = await requestWithHeaders('/files/relay', {
            method: 'POST', token, signal: abort.signal,
            body: {
              conversationId, clientTransferId, fileName: file.name, fileSizeBytes: file.size, sha256Hex,
              ...(multipart ? { relayMode: 'multipart', relayConnectionCount: relayConnections } : {}),
            },
          })
          const senderKey = headers.get('X-File-Relay-Sender-Key')
          if (senderKey && pending.has(clientTransferId)) pending.get(clientTransferId).senderKey = senderKey
          changed(result)
          return result
        }
        if (!webRtcAvailable) throw new Error('Chưa có kết nối WebRTC hoặc SignalR.')
        const large = file.size > LEGACY_MAX_FILE_BYTES
        const supportsV7 = settings.supportsWebRtcV7 === true
        // Chế độ thường chọn hai kết nối cho file lớn khi backend hỗ trợ.
        // Giá trị false từ nhà phát triển vẫn giữ lựa chọn kênh thủ công.
        const parallelConnections = useParallelConnections ?? (preferredChannelCount === null && large &&
          settings.supportsParallelFileConnections === true && settings.maximumFileChannels >= PARALLEL_CONNECTION_COUNT)
        const desiredChannelCount = parallelConnections ? PARALLEL_CONNECTION_COUNT : preferredChannelCount
        const experimental = desiredChannelCount !== null && settings.maximumFileChannels > 0
        const requestedChannelCount = experimental
          ? Math.min(desiredChannelCount, settings.maximumFileChannels, MAX_FILE_CHANNELS) : 1
        const supportedProtocols = large
          ? [settings.supportsDeferredHash && typeof globalThis.Worker === 'function' ? DEFERRED_HASH_PROTOCOL : 'file-v3']
          : ['file-v1', 'file-v2']
        if (experimental || (!large && preferredChannelCount === null && !parallelConnections && settings.maximumFileChannels >= 1))
          supportedProtocols.unshift(MULTICHANNEL_PROTOCOL)
        if (parallelConnections && settings.supportsParallelFileConnections &&
            requestedChannelCount === PARALLEL_CONNECTION_COUNT)
          supportedProtocols.unshift(PARALLEL_CONNECTIONS_PROTOCOL)
        const manualMultiChannel = !parallelConnections && preferredChannelCount !== null && useParallelConnections === false
        if (supportsV7 && !manualMultiChannel && settings.maximumFileChannels >= requestedChannelCount)
          supportedProtocols.unshift(HIGH_SPEED_PROTOCOL)
        const deferred = supportedProtocols.includes(DEFERRED_HASH_PROTOCOL)
        const sha256Hex = deferred ? null : await hashFile(file, abort.signal)
        if (disposed || !pending.has(clientTransferId) || connection?.state !== 'Connected')
          throw new Error('Phiên gửi đã bị hủy hoặc mất kết nối.')
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
      clearInterval(relayPoll)
      connection?.off('FileChanged', changed)
      connection?.off('FileSignal', signalReceived)
      disconnected()
      for (const id of relayJobs.keys()) releaseRelay(id)
      pending.clear()
      for (const url of downloads.values()) URL.revokeObjectURL(url)
      downloads.clear()
    },
  }
}
