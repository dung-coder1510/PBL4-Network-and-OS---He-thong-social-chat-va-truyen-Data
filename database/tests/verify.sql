-- SQL Server integration checks. ONLY run after 01_schema.sql in a fresh,
-- dedicated PBL4_Review_Test database. Example (adjust instance name):
-- sqlcmd -S "(localdb)\MSSQLLocalDB" -E -d PBL4_Review_Test -b -f 65001 -i database\tests\verify.sql
-- SQLCMD mode is required. Test rows remain for inspection; nothing is deleted.
-- Fixture PasswordHash values are test placeholders, NEVER login credentials.
-- Expected trigger failures roll back their statements. Do not wrap this suite
-- in one outer transaction; each fixture/test statement uses autocommit.
:ON ERROR EXIT
SET NOCOUNT ON;
SET XACT_ABORT ON;
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
SET ANSI_PADDING ON;
SET ANSI_WARNINGS ON;
SET CONCAT_NULL_YIELDS_NULL ON;
SET ARITHABORT ON;
SET NUMERIC_ROUNDABORT OFF;

IF DB_NAME() <> N'PBL4_Review_Test'
    THROW 52000, 'Refusing to run outside the dedicated PBL4_Review_Test database.', 1;
IF @@TRANCOUNT <> 0
    THROW 52000, 'Run the tests in autocommit mode without an outer transaction.', 1;
IF OBJECT_ID(N'dbo.Calls') IS NULL OR OBJECT_ID(N'dbo.Users') IS NULL
    THROW 52000, 'Install 01_schema.sql in the empty test database first.', 1;
IF EXISTS (SELECT 1 FROM dbo.Users)
    THROW 52000, 'Tests require a fresh empty schema. Existing rows have been preserved.', 1;

CREATE TABLE #Results (TestName NVARCHAR(200) NOT NULL PRIMARY KEY);
CREATE TABLE #Fixture
(
    A INT, B INT, C INT, ConversationId BIGINT, MessageId BIGINT,
    TransferId BIGINT, CallId BIGINT, SharedUuid UNIQUEIDENTIFIER,
    T DATETIME2(3), FileHash VARBINARY(32)
);
GO

CREATE PROCEDURE #ExpectFailure
    @Name NVARCHAR(200), @Sql NVARCHAR(MAX), @ExpectedErrors VARCHAR(100)
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @A INT, @B INT, @C INT, @Conversation BIGINT, @Message BIGINT,
        @Transfer BIGINT, @Call BIGINT, @Uuid UNIQUEIDENTIFIER,
        @T DATETIME2(3), @Hash VARBINARY(32), @Actual INT, @Detail NVARCHAR(2048);
    SELECT @A = A, @B = B, @C = C, @Conversation = ConversationId,
        @Message = MessageId, @Transfer = TransferId, @Call = CallId,
        @Uuid = SharedUuid, @T = T, @Hash = FileHash FROM #Fixture;
    BEGIN TRY
        EXEC sys.sp_executesql @Sql,
            N'@A INT, @B INT, @C INT, @Conversation BIGINT, @Message BIGINT,
              @Transfer BIGINT, @Call BIGINT, @Uuid UNIQUEIDENTIFIER,
              @T DATETIME2(3), @Hash VARBINARY(32)',
            @A, @B, @C, @Conversation, @Message, @Transfer, @Call, @Uuid, @T, @Hash;
    END TRY
    BEGIN CATCH
        SELECT @Actual = ERROR_NUMBER(), @Detail = ERROR_MESSAGE();
        IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    END CATCH;
    IF @Actual IS NULL
    BEGIN
        SET @Detail = CONCAT(N'FAIL: ', @Name, N' unexpectedly succeeded.');
        THROW 52001, @Detail, 1;
    END;
    IF CHARINDEX(',' + CONVERT(VARCHAR(12), @Actual) + ',', ',' + @ExpectedErrors + ',') = 0
    BEGIN
        SET @Detail = CONCAT(N'FAIL: ', @Name, N'; expected error ', @ExpectedErrors,
            N', got ', @Actual, N': ', @Detail);
        THROW 52002, @Detail, 1;
    END;
    INSERT #Results VALUES (@Name);
    PRINT CONCAT('PASS: ', @Name, ' (error ', @Actual, ')');
END;
GO

DECLARE @T DATETIME2(3) = '2026-01-01T00:00:00.000',
    @Uuid UNIQUEIDENTIFIER = NEWID(), @Hash VARBINARY(32) = HASHBYTES('SHA2_256', 0x),
    @A INT, @B INT, @C INT, @Conversation BIGINT, @Message BIGINT,
    @Transfer BIGINT, @Call BIGINT;

INSERT dbo.Users (Username, PasswordHash, DisplayName, CreatedAt)
VALUES (N'review_alice', N'TEST_ONLY_NOT_A_PASSWORD_HASH', N'An Nguyễn', @T);
SET @A = CONVERT(INT, SCOPE_IDENTITY());
INSERT dbo.Users (Username, PasswordHash, DisplayName, CreatedAt)
VALUES (N'review_bob', N'TEST_ONLY_NOT_A_PASSWORD_HASH', N'Bình Trần', @T);
SET @B = CONVERT(INT, SCOPE_IDENTITY());
INSERT dbo.Users (Username, PasswordHash, DisplayName, CreatedAt)
VALUES (N'review_outsider', N'TEST_ONLY_NOT_A_PASSWORD_HASH', N'Chi Lê', @T);
SET @C = CONVERT(INT, SCOPE_IDENTITY());
INSERT #Results VALUES (N'Create three users with Unicode display names');

UPDATE dbo.Users SET Role = 'Admin' WHERE Id = @A;

INSERT dbo.DirectConversations (UserAID, UserBID, CreatedAt) VALUES (@A, @B, @T);
SET @Conversation = SCOPE_IDENTITY();
INSERT #Results VALUES (N'Create one canonical direct conversation');
INSERT dbo.Contacts (UserId, ContactUserId, Alias, CreatedAt) VALUES (@A, @B, N'Bạn cùng đồ án', @T);
IF EXISTS (SELECT 1 FROM dbo.Contacts WHERE UserId = @B AND ContactUserId = @A)
    THROW 52003, 'A one-way contact unexpectedly created a reverse contact.', 1;
INSERT #Results VALUES (N'Contacts are one-way');

INSERT dbo.Messages (ClientMessageId, ConversationId, SenderId, Content, CreatedAt)
VALUES (@Uuid, @Conversation, @A, N'Chào Bình, gửi đồ án nha!', @T);
SET @Message = SCOPE_IDENTITY();
UPDATE dbo.Messages SET DeliveredAt = DATEADD(SECOND, 1, @T), ReadAt = DATEADD(SECOND, 2, @T)
WHERE Id = @Message;
IF NOT EXISTS (SELECT 1 FROM dbo.Messages WHERE Id = @Message
    AND Content = N'Chào Bình, gửi đồ án nha!' AND DeliveredAt IS NOT NULL AND ReadAt IS NOT NULL)
    THROW 52003, 'Unicode message or valid receipts were not preserved.', 1;
INSERT #Results VALUES (N'Unicode message with valid delivered/read receipts');
INSERT dbo.Messages (ClientMessageId, ConversationId, SenderId, Content, CreatedAt)
VALUES (@Uuid, @Conversation, @B, N'UUID có thể trùng giữa hai người gửi.', @T);
INSERT #Results VALUES (N'Message UUID may be reused by a different sender');

INSERT dbo.FileTransfers (ClientTransferId, ConversationId, SenderId, FileName, FileSizeBytes, Sha256, CreatedAt)
VALUES (@Uuid, @Conversation, @A, N'tệp rỗng.txt', 0, @Hash, @T);
SET @Transfer = SCOPE_IDENTITY();
UPDATE dbo.FileTransfers SET Status = 'accepted', AcceptedAt = DATEADD(SECOND, 1, @T)
WHERE Id = @Transfer;
UPDATE dbo.FileTransfers SET Status = 'transferring' WHERE Id = @Transfer;
UPDATE dbo.FileTransfers SET Status = 'completed', FinishedAt = DATEADD(SECOND, 2, @T),
    VerifiedSha256 = @Hash WHERE Id = @Transfer;
IF NOT EXISTS (SELECT 1 FROM dbo.FileTransfers WHERE Id = @Transfer AND Status = 'completed'
    AND FileSizeBytes = 0 AND VerifiedSha256 = Sha256)
    THROW 52003, 'The zero-byte file was not completed with a matching checksum.', 1;
INSERT #Results VALUES (N'Zero-byte file: offered -> accepted -> transferring -> verified completed');
INSERT dbo.FileTransfers (ClientTransferId, ConversationId, SenderId, FileName, FileSizeBytes, Sha256, CreatedAt)
VALUES (@Uuid, @Conversation, @B, N'b.txt', 0, @Hash, @T);
INSERT #Results VALUES (N'Transfer UUID may be reused by a different sender');

INSERT dbo.Calls (ClientCallId, ConversationId, CallerId, CreatedAt)
VALUES (@Uuid, @Conversation, @A, @T);
SET @Call = SCOPE_IDENTITY();
UPDATE dbo.Calls SET Status = 'active', AnsweredAt = DATEADD(SECOND, 1, @T) WHERE Id = @Call;
UPDATE dbo.Calls SET Status = 'completed', EndedAt = DATEADD(SECOND, 5, @T) WHERE Id = @Call;
IF NOT EXISTS (SELECT 1 FROM dbo.Calls WHERE Id = @Call AND Status = 'completed'
    AND AnsweredAt = DATEADD(SECOND, 1, @T) AND EndedAt = DATEADD(SECOND, 5, @T))
    THROW 52003, 'The answered call was not completed with valid timestamps.', 1;
INSERT #Results VALUES (N'Call: ringing -> active -> completed');
INSERT dbo.Calls (ClientCallId, ConversationId, CallerId, CreatedAt)
VALUES (@Uuid, @Conversation, @B, @T);
INSERT #Results VALUES (N'Call UUID may be reused by a different caller');

INSERT dbo.AdminAuditLogs
    (RequestId, AdminUserId, TargetUserId, Action, OldIsDisabled, NewIsDisabled, Reason, CreatedAt)
VALUES
    (@Uuid, @A, @B, 'DisableUser', 0, 1, N'Kiểm tra nhật ký quản trị.', @T);
INSERT #Results VALUES (N'Admin role and valid append-only audit log');

INSERT #Fixture VALUES (@A, @B, @C, @Conversation, @Message, @Transfer, @Call, @Uuid, @T, @Hash);

-- Identity, contacts and canonical conversation pairs.
EXEC #ExpectFailure N'Username uniqueness is case-insensitive',
    N'INSERT dbo.Users (Username, PasswordHash, DisplayName) VALUES (N''REVIEW_ALICE'', N''test'', N''Duplicate'');', '2601,2627';
EXEC #ExpectFailure N'Username rejects surrounding spaces',
    N'INSERT dbo.Users (Username, PasswordHash, DisplayName) VALUES (N'' padded'', N''test'', N''Invalid'');', '547';
EXEC #ExpectFailure N'User last-seen cannot precede creation',
    N'UPDATE dbo.Users SET LastSeenAt = DATEADD(SECOND, -1, @T) WHERE Id = @A;', '547';
EXEC #ExpectFailure N'User role is case-sensitive',
    N'UPDATE dbo.Users SET Role = ''admin'' WHERE Id = @A;', '547';
EXEC #ExpectFailure N'Self contact',
    N'INSERT dbo.Contacts (UserId, ContactUserId) VALUES (@A, @A);', '547';
EXEC #ExpectFailure N'Duplicate contact',
    N'INSERT dbo.Contacts (UserId, ContactUserId) VALUES (@A, @B);', '2601,2627';
EXEC #ExpectFailure N'Contact references nonexistent user',
    N'INSERT dbo.Contacts (UserId, ContactUserId) VALUES (@A, -1);', '547';
EXEC #ExpectFailure N'Duplicate conversation pair',
    N'INSERT dbo.DirectConversations (UserAID, UserBID) VALUES (@A, @B);', '2601,2627';
EXEC #ExpectFailure N'Reversed conversation pair',
    N'INSERT dbo.DirectConversations (UserAID, UserBID) VALUES (@B, @A);', '547';
EXEC #ExpectFailure N'Self conversation',
    N'INSERT dbo.DirectConversations (UserAID, UserBID) VALUES (@A, @A);', '547';
EXEC #ExpectFailure N'Conversation references nonexistent user',
    N'INSERT dbo.DirectConversations (UserAID, UserBID) VALUES (-1, @A);', '547';
EXEC #ExpectFailure N'Conversation participants are immutable',
    N'UPDATE dbo.DirectConversations SET UserBID = @C WHERE Id = @Conversation;', '51002';

-- Message idempotency, ownership and receipts.
EXEC #ExpectFailure N'Duplicate message UUID for same sender',
    N'INSERT dbo.Messages (ClientMessageId, ConversationId, SenderId, Content) VALUES (@Uuid, @Conversation, @A, N''Retry'');', '2601,2627';
EXEC #ExpectFailure N'Message references nonexistent conversation',
    N'INSERT dbo.Messages (ClientMessageId, ConversationId, SenderId, Content) VALUES (NEWID(), -1, @A, N''Invalid'');', '547';
EXEC #ExpectFailure N'Message references nonexistent sender',
    N'INSERT dbo.Messages (ClientMessageId, ConversationId, SenderId, Content) VALUES (NEWID(), @Conversation, -1, N''Invalid'');', '547';
EXEC #ExpectFailure N'Outsider cannot insert message',
    N'INSERT dbo.Messages (ClientMessageId, ConversationId, SenderId, Content) VALUES (NEWID(), @Conversation, @C, N''Invalid'');', '51003';
EXEC #ExpectFailure N'Outsider cannot become message sender on update',
    N'UPDATE dbo.Messages SET SenderId = @C WHERE Id = @Message;', '51003';
EXEC #ExpectFailure N'Message content cannot be blank',
    N'INSERT dbo.Messages (ClientMessageId, ConversationId, SenderId, Content) VALUES (NEWID(), @Conversation, @A, N''   '');', '547';
EXEC #ExpectFailure N'Message read requires delivery',
    N'UPDATE dbo.Messages SET DeliveredAt = NULL WHERE Id = @Message;', '547';
EXEC #ExpectFailure N'Message delivery cannot precede creation',
    N'UPDATE dbo.Messages SET DeliveredAt = DATEADD(SECOND, -1, @T) WHERE Id = @Message;', '547';
EXEC #ExpectFailure N'Message read cannot precede delivery',
    N'UPDATE dbo.Messages SET ReadAt = @T WHERE Id = @Message;', '547';

-- File-transfer metadata, ownership, checksums and state/timestamp consistency.
EXEC #ExpectFailure N'Duplicate transfer UUID for same sender',
    N'INSERT dbo.FileTransfers (ClientTransferId, ConversationId, SenderId, FileName, FileSizeBytes, Sha256) VALUES (@Uuid, @Conversation, @A, N''x'', 0, @Hash);', '2601,2627';
EXEC #ExpectFailure N'Transfer references nonexistent conversation',
    N'INSERT dbo.FileTransfers (ClientTransferId, ConversationId, SenderId, FileName, FileSizeBytes, Sha256) VALUES (NEWID(), -1, @A, N''x'', 0, @Hash);', '547';
EXEC #ExpectFailure N'Transfer references nonexistent sender',
    N'INSERT dbo.FileTransfers (ClientTransferId, ConversationId, SenderId, FileName, FileSizeBytes, Sha256) VALUES (NEWID(), @Conversation, -1, N''x'', 0, @Hash);', '547';
EXEC #ExpectFailure N'Outsider cannot insert transfer',
    N'INSERT dbo.FileTransfers (ClientTransferId, ConversationId, SenderId, FileName, FileSizeBytes, Sha256) VALUES (NEWID(), @Conversation, @C, N''x'', 0, @Hash);', '51004';
EXEC #ExpectFailure N'Outsider cannot become transfer sender on update',
    N'UPDATE dbo.FileTransfers SET SenderId = @C WHERE Id = @Transfer;', '51004';
EXEC #ExpectFailure N'Negative file size',
    N'UPDATE dbo.FileTransfers SET FileSizeBytes = -1 WHERE Id = @Transfer;', '547';
EXEC #ExpectFailure N'Short declared SHA-256',
    N'INSERT dbo.FileTransfers (ClientTransferId, ConversationId, SenderId, FileName, FileSizeBytes, Sha256) VALUES (NEWID(), @Conversation, @A, N''x'', 0, 0x01);', '547';
EXEC #ExpectFailure N'Completed transfer requires verified checksum',
    N'UPDATE dbo.FileTransfers SET VerifiedSha256 = NULL WHERE Id = @Transfer;', '547';
EXEC #ExpectFailure N'Completed transfer rejects short verified checksum',
    N'UPDATE dbo.FileTransfers SET VerifiedSha256 = 0x01 WHERE Id = @Transfer;', '547';
EXEC #ExpectFailure N'Completed transfer rejects wrong verified checksum',
    N'UPDATE dbo.FileTransfers SET VerifiedSha256 = HASHBYTES(''SHA2_256'', 0x01) WHERE Id = @Transfer;', '547';
EXEC #ExpectFailure N'Unknown file-transfer state',
    N'UPDATE dbo.FileTransfers SET Status = ''unknown'' WHERE Id = @Transfer;', '547';
EXEC #ExpectFailure N'File-transfer state is case-sensitive',
    N'UPDATE dbo.FileTransfers SET Status = ''COMPLETED'' WHERE Id = @Transfer;', '547';
EXEC #ExpectFailure N'Accepted transfer requires acceptance timestamp',
    N'UPDATE dbo.FileTransfers SET Status = ''accepted'', AcceptedAt = NULL WHERE SenderId = @B;', '547';
EXEC #ExpectFailure N'Offered transfer cannot already be finished',
    N'UPDATE dbo.FileTransfers SET FinishedAt = @T WHERE SenderId = @B;', '547';
EXEC #ExpectFailure N'Offered transfer cannot have verified checksum',
    N'UPDATE dbo.FileTransfers SET VerifiedSha256 = @Hash WHERE SenderId = @B;', '547';
EXEC #ExpectFailure N'Completed transfer requires acceptance timestamp',
    N'UPDATE dbo.FileTransfers SET AcceptedAt = NULL WHERE Id = @Transfer;', '547';
EXEC #ExpectFailure N'Completed transfer requires finish timestamp',
    N'UPDATE dbo.FileTransfers SET FinishedAt = NULL WHERE Id = @Transfer;', '547';
EXEC #ExpectFailure N'File acceptance cannot precede creation',
    N'UPDATE dbo.FileTransfers SET AcceptedAt = DATEADD(SECOND, -1, @T) WHERE Id = @Transfer;', '547';
EXEC #ExpectFailure N'File finish cannot precede acceptance',
    N'UPDATE dbo.FileTransfers SET FinishedAt = @T WHERE Id = @Transfer;', '547';

-- Calls: idempotency, membership, state/timestamp consistency.
EXEC #ExpectFailure N'Duplicate call UUID for same caller',
    N'INSERT dbo.Calls (ClientCallId, ConversationId, CallerId) VALUES (@Uuid, @Conversation, @A);', '2601,2627';
EXEC #ExpectFailure N'Call references nonexistent conversation',
    N'INSERT dbo.Calls (ClientCallId, ConversationId, CallerId) VALUES (NEWID(), -1, @A);', '547';
EXEC #ExpectFailure N'Call references nonexistent caller',
    N'INSERT dbo.Calls (ClientCallId, ConversationId, CallerId) VALUES (NEWID(), @Conversation, -1);', '547';
EXEC #ExpectFailure N'Outsider cannot insert call',
    N'INSERT dbo.Calls (ClientCallId, ConversationId, CallerId) VALUES (NEWID(), @Conversation, @C);', '51005';
EXEC #ExpectFailure N'Outsider cannot become caller on update',
    N'UPDATE dbo.Calls SET CallerId = @C WHERE Id = @Call;', '51005';
EXEC #ExpectFailure N'Unknown call state',
    N'UPDATE dbo.Calls SET Status = ''unknown'' WHERE Id = @Call;', '547';
EXEC #ExpectFailure N'Call state is case-sensitive',
    N'UPDATE dbo.Calls SET Status = ''COMPLETED'' WHERE Id = @Call;', '547';
EXEC #ExpectFailure N'Active call requires answer timestamp',
    N'UPDATE dbo.Calls SET Status = ''active'' WHERE CallerId = @B;', '547';
EXEC #ExpectFailure N'Ringing call cannot already be answered',
    N'UPDATE dbo.Calls SET AnsweredAt = @T WHERE CallerId = @B;', '547';
EXEC #ExpectFailure N'Completed call requires answer timestamp',
    N'UPDATE dbo.Calls SET AnsweredAt = NULL WHERE Id = @Call;', '547';
EXEC #ExpectFailure N'Completed call requires end timestamp',
    N'UPDATE dbo.Calls SET EndedAt = NULL WHERE Id = @Call;', '547';
EXEC #ExpectFailure N'Rejected call cannot have answer timestamp',
    N'UPDATE dbo.Calls SET Status = ''rejected'' WHERE Id = @Call;', '547';
EXEC #ExpectFailure N'Call answer cannot precede creation',
    N'UPDATE dbo.Calls SET AnsweredAt = DATEADD(SECOND, -1, @T) WHERE Id = @Call;', '547';
EXEC #ExpectFailure N'Call end cannot precede creation',
    N'UPDATE dbo.Calls SET EndedAt = DATEADD(SECOND, -1, @T) WHERE Id = @Call;', '547';
EXEC #ExpectFailure N'Call end cannot precede answer',
    N'UPDATE dbo.Calls SET EndedAt = @T WHERE Id = @Call;', '547';

-- Admin audit logs: idempotency, state transition and append-only history.
EXEC #ExpectFailure N'Duplicate admin request UUID',
    N'INSERT dbo.AdminAuditLogs (RequestId, AdminUserId, TargetUserId, Action, OldIsDisabled, NewIsDisabled, Reason)
      VALUES (@Uuid, @A, @B, ''DisableUser'', 0, 1, N''Retry'');', '2601,2627';
EXEC #ExpectFailure N'Admin cannot target the same account',
    N'INSERT dbo.AdminAuditLogs (RequestId, AdminUserId, TargetUserId, Action, OldIsDisabled, NewIsDisabled, Reason)
      VALUES (NEWID(), @A, @A, ''DisableUser'', 0, 1, N''Invalid'');', '547';
EXEC #ExpectFailure N'Admin action must match state change',
    N'INSERT dbo.AdminAuditLogs (RequestId, AdminUserId, TargetUserId, Action, OldIsDisabled, NewIsDisabled, Reason)
      VALUES (NEWID(), @A, @B, ''EnableUser'', 0, 1, N''Invalid'');', '547';
EXEC #ExpectFailure N'Admin audit reason cannot be blank',
    N'INSERT dbo.AdminAuditLogs (RequestId, AdminUserId, TargetUserId, Action, OldIsDisabled, NewIsDisabled, Reason)
      VALUES (NEWID(), @A, @B, ''DisableUser'', 0, 1, N''   '');', '547';
EXEC #ExpectFailure N'Admin audit log cannot be updated',
    N'UPDATE dbo.AdminAuditLogs SET Reason = N''Changed'' WHERE AdminUserId = @A AND RequestId = @Uuid;', '51006';
EXEC #ExpectFailure N'Admin audit log cannot be deleted',
    N'DELETE dbo.AdminAuditLogs WHERE AdminUserId = @A AND RequestId = @Uuid;', '51006';

-- A valid row followed by an outsider must reject the entire multi-row statement.
DECLARE @Before BIGINT = (SELECT COUNT_BIG(*) FROM dbo.Messages);
EXEC #ExpectFailure N'Multi-row message insert checks every sender',
    N'INSERT dbo.Messages (ClientMessageId, ConversationId, SenderId, Content)
      VALUES (NEWID(), @Conversation, @A, N''valid''), (NEWID(), @Conversation, @C, N''outsider'');', '51003';
IF (SELECT COUNT_BIG(*) FROM dbo.Messages) <> @Before
    THROW 52003, 'Rejected multi-row message insert left partial writes.', 1;
INSERT #Results VALUES (N'Multi-row message insert is atomic');

SET @Before = (SELECT COUNT_BIG(*) FROM dbo.FileTransfers);
EXEC #ExpectFailure N'Multi-row transfer insert checks every sender',
    N'INSERT dbo.FileTransfers (ClientTransferId, ConversationId, SenderId, FileName, FileSizeBytes, Sha256)
      VALUES (NEWID(), @Conversation, @A, N''valid'', 0, @Hash),
             (NEWID(), @Conversation, @C, N''outsider'', 0, @Hash);', '51004';
IF (SELECT COUNT_BIG(*) FROM dbo.FileTransfers) <> @Before
    THROW 52003, 'Rejected multi-row transfer insert left partial writes.', 1;
INSERT #Results VALUES (N'Multi-row transfer insert is atomic');

SET @Before = (SELECT COUNT_BIG(*) FROM dbo.Calls);
EXEC #ExpectFailure N'Multi-row call insert checks every caller',
    N'INSERT dbo.Calls (ClientCallId, ConversationId, CallerId)
      VALUES (NEWID(), @Conversation, @A), (NEWID(), @Conversation, @C);', '51005';
IF (SELECT COUNT_BIG(*) FROM dbo.Calls) <> @Before
    THROW 52003, 'Rejected multi-row call insert left partial writes.', 1;
INSERT #Results VALUES (N'Multi-row call insert is atomic');

-- Confirm that rejected updates preserved the original valid data.
IF NOT EXISTS (SELECT 1 FROM dbo.DirectConversations
    WHERE Id = @Conversation AND UserAID = @A AND UserBID = @B)
    THROW 52003, 'A rejected update changed conversation participants.', 1;
IF NOT EXISTS (SELECT 1 FROM dbo.Messages WHERE Id = @Message AND SenderId = @A
    AND DeliveredAt = DATEADD(SECOND, 1, @T) AND ReadAt = DATEADD(SECOND, 2, @T))
    THROW 52003, 'A rejected update changed the valid message.', 1;
IF NOT EXISTS (SELECT 1 FROM dbo.FileTransfers WHERE Id = @Transfer AND SenderId = @A
    AND Status = 'completed' AND FileSizeBytes = 0 AND Sha256 = @Hash AND VerifiedSha256 = @Hash
    AND AcceptedAt = DATEADD(SECOND, 1, @T) AND FinishedAt = DATEADD(SECOND, 2, @T))
    THROW 52003, 'A rejected update changed the valid file transfer.', 1;
IF NOT EXISTS (SELECT 1 FROM dbo.Calls WHERE Id = @Call AND CallerId = @A
    AND Status = 'completed' AND AnsweredAt = DATEADD(SECOND, 1, @T) AND EndedAt = DATEADD(SECOND, 5, @T))
    THROW 52003, 'A rejected update changed the valid call.', 1;
IF @@TRANCOUNT <> 0
    THROW 52003, 'A test left an open transaction.', 1;
INSERT #Results VALUES (N'Rejected updates preserve valid fixtures and leave no transaction');

DECLARE @Passed INT = (SELECT COUNT(*) FROM #Results);
PRINT CONCAT('SUCCESS: ', @Passed, ' checks passed. Test fixtures remain in PBL4_Review_Test.');
SELECT @Passed AS PassedChecks, DB_NAME() AS TestDatabase;
GO
