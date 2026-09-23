-- Read-only examples. The API must obtain @CurrentUserId from authenticated claims.
-- Ids below are examples; replace them with values in your development database.
SET NOCOUNT ON;
DECLARE @CurrentUserId INT = 1;
DECLARE @ConversationId BIGINT = 1;
DECLARE @BeforeCreatedAt DATETIME2(3) = NULL;
DECLARE @BeforeId BIGINT = NULL;
DECLARE @PageSize INT = 50;

-- 1. Conversation list and latest TEXT message (file/call history is separate).
SELECT c.Id AS ConversationId, peer.Id AS PeerId, peer.DisplayName,
       peer.LastSeenAt, lastMessage.Id AS LastMessageId,
       lastMessage.Content AS LastMessage, lastMessage.CreatedAt AS LastMessageAt,
       unread.Total AS UnreadMessages
FROM dbo.DirectConversations c
JOIN dbo.Users peer
  ON peer.Id = CASE WHEN c.UserAID = @CurrentUserId THEN c.UserBID ELSE c.UserAID END
OUTER APPLY
(
    SELECT TOP (1) m.Id, m.Content, m.CreatedAt
    FROM dbo.Messages m WHERE m.ConversationId = c.Id
    ORDER BY m.CreatedAt DESC, m.Id DESC
) lastMessage
OUTER APPLY
(
    SELECT COUNT_BIG(*) AS Total FROM dbo.Messages m
    WHERE m.ConversationId = c.Id AND m.SenderId <> @CurrentUserId AND m.ReadAt IS NULL
) unread
WHERE c.UserAID = @CurrentUserId OR c.UserBID = @CurrentUserId
ORDER BY COALESCE(lastMessage.CreatedAt, c.CreatedAt) DESC, c.Id DESC;

-- 2. A history page. For the next page, supply BOTH cursor values from the last row.
-- Sorting is server persistence order, not a claim about two devices' wall clocks.
IF (@BeforeCreatedAt IS NULL AND @BeforeId IS NOT NULL)
   OR (@BeforeCreatedAt IS NOT NULL AND @BeforeId IS NULL)
    THROW 51100, 'Both history cursor values must be supplied together.', 1;
SELECT TOP (@PageSize) m.Id, m.ClientMessageId, m.ConversationId, m.SenderId,
       m.Content, m.CreatedAt, m.DeliveredAt, m.ReadAt,
       CASE WHEN m.ReadAt IS NOT NULL THEN 'read'
            WHEN m.DeliveredAt IS NOT NULL THEN 'delivered' ELSE 'stored' END AS Status
FROM dbo.Messages m
JOIN dbo.DirectConversations c ON c.Id = m.ConversationId
WHERE m.ConversationId = @ConversationId
  AND (@CurrentUserId = c.UserAID OR @CurrentUserId = c.UserBID)
  AND (@BeforeCreatedAt IS NULL OR m.CreatedAt < @BeforeCreatedAt
       OR (m.CreatedAt = @BeforeCreatedAt AND m.Id < @BeforeId))
ORDER BY m.CreatedAt DESC, m.Id DESC;

-- 3. Replay unacknowledged incoming messages on reconnect, in bounded batches.
-- Re-read the oldest batch after ACKs; do not advance a permanent identity watermark.
-- An older identity can commit after a later one under concurrent transactions.
-- Sending via SignalR is NOT an ACK. Retain these rows as message history after ACK.
SELECT TOP (@PageSize) m.Id, m.ClientMessageId, m.ConversationId, m.SenderId,
       m.Content, m.CreatedAt
FROM dbo.Messages m
JOIN dbo.DirectConversations c ON c.Id = m.ConversationId
WHERE (c.UserAID = @CurrentUserId OR c.UserBID = @CurrentUserId)
  AND m.SenderId <> @CurrentUserId AND m.DeliveredAt IS NULL
ORDER BY m.CreatedAt, m.Id;

-- 4. Call history. Duration is computed, not stored in a second mutable column.
SELECT TOP (@PageSize) call.Id, call.ClientCallId, call.CallerId,
       CASE WHEN call.CallerId = c.UserAID THEN c.UserBID ELSE c.UserAID END AS CalleeId,
       call.Status, call.CreatedAt, call.AnsweredAt, call.EndedAt,
       CASE WHEN call.AnsweredAt IS NOT NULL AND call.EndedAt IS NOT NULL
            THEN DATEDIFF_BIG(SECOND, call.AnsweredAt, call.EndedAt) END AS DurationSeconds
FROM dbo.Calls call
JOIN dbo.DirectConversations c ON c.Id = call.ConversationId
WHERE c.Id = @ConversationId
  AND (@CurrentUserId = c.UserAID OR @CurrentUserId = c.UserBID)
ORDER BY call.CreatedAt DESC, call.Id DESC;

-- 5. File history: metadata only, no server download path exists in this design.
SELECT TOP (@PageSize) f.Id, f.ClientTransferId, f.SenderId, f.FileName,
       f.FileSizeBytes, CONVERT(VARCHAR(64), f.Sha256, 2) AS Sha256Hex,
       f.Status, f.CreatedAt, f.AcceptedAt, f.FinishedAt
FROM dbo.FileTransfers f
JOIN dbo.DirectConversations c ON c.Id = f.ConversationId
WHERE c.Id = @ConversationId
  AND (@CurrentUserId = c.UserAID OR @CurrentUserId = c.UserBID)
ORDER BY f.CreatedAt DESC, f.Id DESC;

-- 6. One-way contact list, including the current owner's private alias.
SELECT ct.ContactUserId, u.Username, u.DisplayName, ct.Alias, u.LastSeenAt
FROM dbo.Contacts ct JOIN dbo.Users u ON u.Id = ct.ContactUserId
WHERE ct.UserId = @CurrentUserId
ORDER BY COALESCE(ct.Alias, u.DisplayName), u.Id;
