# Chat text P2P

Sources: `.tasks/chat-text-p2p.md` (24 criteria), conversation approval “oke triển khaii dii”, `docs/architecture-storage-policy.md`, `docs/file-transfers.md`.

Profile: light. Feature base: `98fe621`. Review working-tree diff, including untracked feature files. No push or deployment.

## Out of scope

Desktop, calls, local-only storage, schema migration and full offline web sending. WAN/TURN acceptance needs external infrastructure; record it as pending, never mark it passed from localhost tests.

## Landing

Reuse MessageService, SQL UUID dedupe, ChatHub, existing session/presence validation and ICE configuration. Text owns a separate peer connection. User approved the proposed defaults; proceed without another approval round.

| Door | Literal shape | Alternative rejected |
|---|---|---|
| Session binding | Server-created UUID, conversation + two connection IDs; original initiator offers; concurrent starts by the two endpoints return the same session | Broadcast SDP to all tabs creates multiple incompatible answers |
| New Hub contracts | StartTextSession, SendTextSignal, TextSessionReady, CloseTextSession, CommitPeerMessage, RelayCommittedMessage, AcknowledgePeerMessage, AcknowledgeMessage, ReadMessage | Changing SendMessage breaks existing clients/tests |
| Exact receipts | Optional MessageId in MessageStatusDto distinguishes exact from cumulative; receiver verifies peer payload against committed hash before acknowledging | Using cumulative ACK for a single P2P frame marks gaps delivered |
| Bounds | ACK 5s; negotiation 15s; idle session 20min; max 1,000 sessions and 8 per account; SDP 24,000 chars, ICE 4,096 chars and 128/side | Unbounded registry/signaling retains resources indefinitely |
| Storage | Commit before P2P; fan-out excludes selected target, fallback looks up the original sender-owned committed UUID | Calling SendMessage before P2P already delivers the payload through server |

## Checks

### S1 — bound sessions (criteria 1–4)

**C1** opens ordered/reliable chat-v1. Proof: `node tests/text-p2p.e2e.mjs` — `P2P payload reaches selected browser`.
**C2** rejects outsider/wrong endpoint/stale session. Proof: `node tests/text-p2p.integration.mjs` — `session authorization and stale signals`.
**C3** concurrent starts converge; early ICE queued. Proof: integration — `concurrent starts converge`; `node --test tests/text-chat.mjs` — `queues ICE before SDP`.
**C4** only bound tab uses P2P; secondary tab synchronizes. Proof: integration — `commit excludes target and syncs secondary tab`; browser — `secondary tab history`.

### S2 — persisted P2P delivery (criteria 5–8)

**C5** validates text and commits before delivery. Proof: integration — `commit persists without target fanout`.
**C6** target receives DataChannel payload, not MessageReceived. Proof: browser — `P2P payload reaches selected browser`.
**C7** retry one row, conflicting UUID rejected, reload history preserved. Proof: integration — `idempotent commit and fallback`; browser — `reload history`.
**C8** merge duplicate delivery once, unread once. Proof: `node --test tests/text-chat.mjs` — `duplicate delivery and receipts never regress`; browser — `fallback after lost ACK has one bubble`.

### S3 — exact receipt semantics (criteria 9–12)

**C9** send/commit do not imply delivered. Proof: integration — `commit persists without target fanout`.
**C10** malformed peer payload and conflicting hash rejected. Proof: unit — `rejects invalid frames`; integration — `peer receipt checks content and sender`.
**C11** exact receipt authorized/idempotent. Proof: integration — `exact receipts preserve gaps`.
**C12** no read/delivery across gaps; only visible thread reads. Proof: integration — `exact receipts preserve gaps`; browser — `hidden thread is not read`.

### S4 — fallback (criteria 13–16)

**C13** no ready channel uses SignalR immediately. Proof: unit — `not ready uses legacy send immediately`.
**C14** ACK timeout or failed send relays same committed UUID. Proof: unit — `lost ACK falls back with original UUID`; browser — `fallback after lost ACK has one bubble`.
**C15** late/duplicate frames and ACKs never duplicate or regress. Proof: unit — `duplicate delivery and receipts never regress`.
**C16** offline catchup and ambiguous commit retry preserve IDs. Proof: integration — `offline catchup`; unit — `ambiguous commit retries original UUID`.

### S5 — lifecycle (criteria 17–20)

**C17** provider receives while Chat unmounted and remount loads history. Proof: browser — `receive while on Files`.
**C18** reconnect invalidates old endpoint. Proof: integration — `session authorization and stale signals`; unit — `disconnect cleans pending ACKs and peers`.
**C19** close/logout/revocation cleanup. Proof: unit — `disconnect cleans pending ACKs and peers`; integration — `revocation closes sessions`.
**C20** text/file peers independent. Proof: browser — `file transfer while text stays ready`; existing `node --test tests/file-protocol.mjs tests/file-transfer-state.mjs`.

### S6 — route evidence (criteria 21–24)

**C21** labels reflect actual selected candidate pair. Proof: unit — `route classification follows selected candidate pair`; browser — `P2P payload reaches selected browser`.
**C22** browser receipt works with target MessageReceived payload blocked, archive reload intact. Proof: browser — `P2P payload reaches selected browser`, `reload history`.
**C23** failure/ACK loss keeps one SQL row/bubble. Proof: browser — `fallback after lost ACK has one bubble`; unit — `lost ACK falls back with original UUID`.
**C24** physical LAN/WAN/forced TURN. Proof: manual two-device/network run recorded in `docs/text-p2p.md`. Pending external environment; localhost is insufficient.

## Swept

- validation: C5, C10
- failure modes: C13–C16
- idempotency: C7, C8, C11, C15
- authorization: C2, C10, C11, C19 and existing JWT filter
- concurrency: C3, C4, C12, C18
- data lifecycle: C17–C20; SQL unchanged
- dependency failure: C13–C16, C24
- state transitions: C9–C19
- observability: C21–C24; no payload/token logs

## Handoff

One build batch: existing backend/frontend/test surfaces are under 150k tokens of reading; no mid-build handoff required. Fresh read-only verifier reviews all checks after implementation. No user-owned changes existed except the planning artifact.

## Evidence

Author runs on 21/10/2026:

- Backend Release build: passed; existing NU1902/NU1903 for transitive Pkcs 9.0.11 remain.
- Frontend build/lint: passed.
- Node unit/regression: 33 passed (13 text transport/protocol/state, 20 existing checks).
- Presence: 9 passed.
- New API/SignalR: 11 named checks passed, including actual session concurrency, endpoint authorization, SQL dedupe, exact receipts, revocation and historical read for disabled peers.
- New browser: 11 named checks passed on real headless Chrome, including bound DataChannel options, server payload blocked for P2P proof, secondary tab, mobile hidden thread, file 1 MiB hash, ACK loss, channel cut, crash recovery and reload.
- Legacy messages API/SignalR: 21 passed.
- Legacy SignalR browser chat/contacts: passed with WebRTC explicitly disabled to isolate that path.
- Test-owned SQL accounts/data cleaned after each completed run. An initially interrupted legacy run was cleaned by its exact three generated usernames, never by deleting real users.
- C24 remains pending: these are Chrome contexts on localhost, not physical LAN/WAN/TURN.
- Actual 30-minute JWT expiry is enforced by existing auth/CloseOnAuthenticationExpiration and reviewed wiring; the browser test does not wait 30 minutes. Active dispose, disconnect and revocation are exercised directly.

Independent verifier report: `chat-text-p2p-verification.md` (separate author).

Final independent result: C1–C23 PASS; C24 pending external physical-network acceptance.
Independent unit, presence, builds/lint, 11 API, 11 P2P browser checks and the
final legacy SignalR UI regression all passed. Zero generated test users remain.
The two local servers started for this verification were stopped after testing.
