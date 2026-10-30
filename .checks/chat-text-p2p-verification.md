# Chat text P2P verification

**Verdict: FAIL for full acceptance — C24 remains pending external infrastructure.**

**Implementation checks: C1–C23 PASS (23/24 total); no unresolved application defect found in the reviewed tree.**

Profile: light. Round: 1, full feature, including fixes made in response to this review. Verifier: independent sub-agent; application/test author is a different agent. Base and HEAD: 98fe6214928c6c17d3f28c963a8e1e9b9271d6a6. Reviewed base-to-working-tree changes, including every untracked text service, contract, monitor, protocol, transport, test/helper and document. Verification date: 2026-10-21. Changes are uncommitted; this report does not imply a committed release.

## Scope and method

Read the verification instructions, .checks/chat-text-p2p.md, .tasks/chat-text-p2p.md, docs/architecture-storage-policy.md and docs/file-transfers.md. Inspected the complete changed backend/frontend surface plus existing message saving, session filtering, presence and file integration points. Located named assertions using rg and checked their expressions against each checklist claim. The light profile does not require UI source enumeration, a Coverage join, Test policy adjudication or fault injection. The checklist has no Coverage table or Test policy section.

All commands below were run independently by this verifier against the final reviewed implementation. API and browser commands were run sequentially against the already-running localhost Vite/backend and SQL database, with an authentication cooldown. No application code, tests, checklist or database was edited manually by the verifier. Test scripts created and removed their own randomized data.

Production assembly inspection: PBL4/Program.cs:33 applies RealtimeSessionFilter; lines 37–38 register TextPeerSessionService and TextPeerMonitor; line 43 supplies TimeProvider.System. Existing MessageService.SaveAsync still performs normalization, membership/account checks and SQL UUID deduplication. New methods reuse it rather than replacing legacy SendMessage. Text and file own separate peer registries.

## Checks

Proof abbreviations: U = node --test tests/text-chat.mjs (batched with existing frontend/file tests); I = node tests/text-p2p.integration.mjs; B = node tests/text-p2p.e2e.mjs. Each named test/logged assertion group ran successfully at the reviewed working tree. File references below are repository-relative.

| Check | Proof run and decisive assertion evidence | Result |
|---|---|---|
| C1 ordered/reliable chat-v1 | B, P2P payload reaches selected browser. tests/text-p2p.e2e.mjs:126 asserts deep equality with { label: 'chat-v1', ordered: true, maxRetransmits: null, maxPacketLifeTime: null }; :124 asserts an observed DataChannel message contains the proof text. | PASS |
| C2 outsider/wrong endpoint/stale session | I, session authorization and stale signals. tests/text-p2p.integration.mjs:31 rejects outsider StartTextSession; :33 rejects outsider and secondary-tab ICE; :94 rejects old-session ICE; :96 rejects readiness from the new connection against the old session. | PASS |
| C3 concurrent starts/early ICE | I, concurrent starts converge: tests/text-p2p.integration.mjs:23 assert.equal(s1.sessionId, s2.sessionId). U, queues ICE before SDP: tests/text-chat.mjs:118 asserts zero applied candidates before SDP; :121 deep-equals [{ candidate: 'early' }]; :124 remains one after stale-session ICE. | PASS |
| C4 one bound target/secondary sync | I, commit excludes target and syncs secondary tab: tests/text-p2p.integration.mjs:48 waits for secondary count === 1; :49 asserts targetMessages.length === 0. B, secondary tab history: tests/text-p2p.e2e.mjs:139 waits for the new message in the secondary thread; :140 asserts no DataChannel message there. | PASS |
| C5 validated, persisted before delivery | I, commit persists without target fanout. tests/text-p2p.integration.mjs:44 checks normalized saved.content equals request.content.trim(); :47 checks SQL count '1'; :49 target count zero; :52–54 reject empty/4001-character content. | PASS |
| C6 payload arrives over DataChannel | B, P2P payload reaches selected browser. tests/text-p2p.e2e.mjs:124 asserts observed frame content; :125 asserts no server MessageReceived payload for that text. | PASS |
| C7 one UUID row/conflict/history | I, idempotent commit and fallback. tests/text-p2p.integration.mjs:67 same request returns saved.id; :68 rejects changed content; :72 SQL sender/UUID count is '1'. B, reload history: tests/text-p2p.e2e.mjs:220 waits for proof text after reload/login; :221 duplicate-fallback text count is 1. | PASS |
| C8 merge once/unread once | U, duplicate delivery and receipts never regress: tests/text-chat.mjs:181 rows.length === 1; :186 unreadCount === 1; :195 and :197 late duplicate unread remains 2. B, fallback after lost ACK has one bubble: tests/text-p2p.e2e.mjs:201 count === 1. | PASS |
| C9 commit/send are not delivery | I, commit persists without target fanout: tests/text-p2p.integration.mjs:45–46 deliveredAt/readAt are null. U, ACK prevents relay and remains separate from commit: tests/text-chat.mjs:83 incoming committed DTO deliveredAt === null. | PASS |
| C10 invalid frames/hash rejected | U, rejects invalid frames: tests/text-chat.mjs:168–175 assert.throws for wrong session/sender/conversation, oversized text, local ID, invalid UUID, non-string and oversized frames. I, peer receipt checks content and sender: tests/text-p2p.integration.mjs:58 rejects wrong hash; :59 rejects outsider; :61–63 exact accepted receipt has correct ID, delivery and no read. | PASS |
| C11 authorized/idempotent exact receipt | I, exact receipts preserve gaps: tests/text-p2p.integration.mjs:81 rejects outsider read; :82 rejects sender ACK; :87 duplicate readAt equals the first status. Peer duplicate delivery timestamp is also stable at :64. | PASS |
| C12 no gaps/only visible thread reads | I: tests/text-p2p.integration.mjs:86 SQL count '1' for earlier gap with DeliveredAt IS NULL AND ReadAt IS NULL; :85 unreadCount === 2. B, mobile hidden thread is not read or cleared: tests/text-p2p.e2e.mjs:148 waits for hidden thread, :153 requires ReadAt IS NULL, :154 requires unread badge, :157 waits for read only after opening. B, hidden thread is not read: :167 requires delivered/non-read while on Files. | PASS |
| C13 immediate legacy fallback | U, not ready uses legacy send immediately: tests/text-chat.mjs:53 SendMessage count === 1; :54 CommitPeerMessage count === 0. | PASS |
| C14 timeout/send failure retain UUID | U, lost ACK falls back with original UUID: tests/text-chat.mjs:62 deep-equals relay reference with original UUID; :64 frame server ID is '20'; :65 no SendMessage call. Failed channel send relays the committed message: :74 relay count === 1. B also observes actual fallback payload at tests/text-p2p.e2e.mjs:199–203. | PASS |
| C15 duplicates/late copies never regress | U, duplicate delivery and receipts never regress: tests/text-chat.mjs:181 one merged row, :182 server ID retained, :183 read timestamp retained; :191 earlier gap delivery stays null. B, lost-ACK fallback duplicates the peer-delivered message and still has one bubble at tests/text-p2p.e2e.mjs:201. | PASS |
| C16 offline catchup/ambiguous retry | I, offline catchup: tests/text-p2p.integration.mjs:104 pending items contain offline.id and exact offline content. U, ambiguous commit retries original UUID: tests/text-chat.mjs:109 legacy retry clientMessageId === uuid. | PASS |
| C17 receive while Chat unmounted/remount | B, receive while on Files: tests/text-p2p.e2e.mjs:162 opens Files, :165–167 waits for sender delivery and confirms SQL delivered/non-read. :191–192 opens the conversation and waits for hidden text in the remounted thread. | PASS |
| C18 reconnect invalidates old endpoints | I, session authorization and stale signals: tests/text-p2p.integration.mjs:92 stops old sender; :94 old ICE rejects; :95 creates new connection; :96 old-session readiness rejects. U, disconnect cleans pending ACKs and peers: tests/text-chat.mjs:133 rejects pending send; :134–136 closed peer, removed handler and no relay. | PASS |
| C19 close/logout/revocation cleanup | U, dispose active peer cleans ACK timer channel and listeners: tests/text-chat.mjs:146 pending send rejects; :147–150 assert closed peer/channel, null message handler and zero listeners; :151 no relay after dispose. I, revocation closes sessions: tests/text-p2p.integration.mjs:114 revoke returns 204; :115 requires TextSessionClosed for exact session; :116 readiness rejects. | PASS |
| C20 text/file independent | B, file transfer while text stays ready: tests/text-p2p.e2e.mjs:185 received Blob hash equals source SHA-256; :186 text route remains 'direct'; :187 observes the during-file DataChannel text. Existing file protocol/state suites also passed. | PASS |
| C21 actual selected candidate route | U, route classification follows selected candidate pair: tests/text-chat.mjs:201 empty stats -> 'webrtc'; :209 selected host/srflx -> 'direct'; :211 selected relay -> 'turn'. B waits for measured direct route at tests/text-p2p.e2e.mjs:114–115. A TURN-shaped unit fixture is not physical TURN evidence. | PASS |
| C22 blocked server payload/archive | B, P2P payload reaches selected browser: tests/text-p2p.e2e.mjs:118 configures MessageReceived filtering; :124 observed peer payload; :125 no server payload; :128 SQL count '1'. Reload history at :220 proves archive retrieval after reload/login. | PASS |
| C23 channel failure/ACK loss one row/bubble | B, fallback after lost ACK has one bubble: tests/text-p2p.e2e.mjs:201–203 bubble 1, SQL row '1', observed server fallback. Channel cut after commit falls back once: :213 bubble 1, :214 SQL row '1', with actual native channel close instrumented at :27 and activated at :209. Sender crash after commit loads pending message additionally waits for recovered thread text at :231 and SQL row '1' at :232. Concurrent-start/multi-tab/stale endpoint evidence is C2–C4/C18 above. | PASS |
| C24 physical LAN/WAN/forced TURN | No two-device LAN, different-network/NAT or forced real TURN run was available. docs/text-p2p.md:155 explicitly says these are not accepted yet. Local Chrome contexts and mocked relay stats cannot establish them. | PENDING / NOT PROVEN |

## Findings and practical limits

The initial review found a real C12 issue: at mobile widths, Back hid the thread with CSS while selectedId remained set, causing document-visible incoming messages to be read and their unread count cleared. The author fixed the visibility predicate at frontend/src/pages/ChatPage.jsx:61–63, the receive activity checks and the read guard at :255–270, and added responsive visibility change handling. The independent browser run now passes the dedicated mobile regression. This is resolved, not an outstanding finding.

The author also strengthened evidence following review: real channel reliability options, a native channel cut after commit, and disposal with an active pending ACK now have direct assertions. The current tree has no remaining actionable application finding from this review.

C24 is the remaining acceptance gap: run two physical LAN devices, different networks/NAT, and a forced real TURN path; record selected candidate evidence and message/history/fallback results separately. No latency, throughput or WAN acceptance claim follows from this localhost run.

The 30-minute JWT expiry was not waited out in a browser, nor was account-lock monitor cleanup separately exercised end-to-end. Their shared invalid-session/account checks were inspected in RealtimeSessionFilter, PresenceTracker and TextPeerSessionService.SweepLockedAsync. Revocation and active disposal were actually exercised; this report does not relabel them as an expiry/lock experiment. No load or prolonged memory test was performed. Fault injection is not required by the light profile and was not performed.

## Independent gate results

- node --test tests/text-chat.mjs tests/frontend-chat-state.mjs tests/frontend-heartbeat.mjs tests/file-protocol.mjs tests/file-transfer-state.mjs: exit 0, 33 passed, 0 failed; all 13 named text tests ran.
- dotnet run --project tests/presence/PresenceChecks.csproj --no-restore: exit 0, all 9 named checks passed.
- dotnet build PBL4/PBL4.csproj --no-restore -o $env:TEMP/pbl4-text-verifier-build -p:UseAppHost=false: exit 0, zero errors. Output isolated to avoid replacing the running server.
- frontend npm run build: exit 0; npm run lint: exit 0.
- node tests/text-p2p.integration.mjs: exit 0, all 11 named checks passed, randomized data cleanup completed.
- node tests/text-p2p.e2e.mjs: exit 0, all 11 named browser checks passed, no unhandled browser errors, randomized data cleanup completed.
- node tests/chat-ui.e2e.mjs: exit 0, legacy SignalR chat states/reconnect/UUID fallback/one-way contacts UI regression passed; randomized data cleanup completed. This run followed the final mobile and silent-sync changes and explicitly disabled WebRTC to isolate the legacy path.
- Final read-only SQL cleanup check: zero Users rows with the generated p2ptest_ or uitest_ prefixes remained.

The builds report existing NU1902/NU1903 warnings for System.Security.Cryptography.Pkcs 9.0.11. This feature does not change the dependency. No commit, push or deployment was performed.
