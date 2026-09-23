-- PBL4: SQL Server 2022+ / LocalDB. Run once in a NEW, dedicated database.
-- Seven tables including AdminAuditLogs. No CREATE DATABASE, DROP or seed credentials.
-- UserAID/UserBID are ordered by numeric ID; A/B do not mean sender/receiver.
SET NOCOUNT ON;
SET XACT_ABORT ON;
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
SET ANSI_PADDING ON;
SET ANSI_WARNINGS ON;
SET CONCAT_NULL_YIELDS_NULL ON;
SET ARITHABORT ON;
SET NUMERIC_ROUNDABORT OFF;
GO

IF DB_NAME() IN (N'master', N'model', N'msdb', N'tempdb')
    THROW 51000, 'Select a dedicated PBL4 database before running this script.', 1;
IF OBJECT_ID(N'dbo.Users') IS NOT NULL
   OR OBJECT_ID(N'dbo.Contacts') IS NOT NULL
   OR OBJECT_ID(N'dbo.DirectConversations') IS NOT NULL
   OR OBJECT_ID(N'dbo.Messages') IS NOT NULL
   OR OBJECT_ID(N'dbo.FileTransfers') IS NOT NULL
   OR OBJECT_ID(N'dbo.Calls') IS NOT NULL
   OR OBJECT_ID(N'dbo.AdminAuditLogs') IS NOT NULL
    THROW 51001, 'A target object already exists. Use a new database; this is not a migration.', 1;

BEGIN TRY
BEGIN TRANSACTION;

CREATE TABLE dbo.Users
(
    Id INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Users PRIMARY KEY,
    Username NVARCHAR(32) COLLATE Latin1_General_100_CI_AS NOT NULL,
    PasswordHash NVARCHAR(512) NOT NULL,
    DisplayName NVARCHAR(100) NOT NULL,
    Role VARCHAR(10) COLLATE Latin1_General_100_BIN2 NOT NULL
        CONSTRAINT DF_Users_Role DEFAULT 'User',
    CreatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_Users_CreatedAt DEFAULT SYSUTCDATETIME(),
    LastSeenAt DATETIME2(3) NULL,
    IsDisabled BIT NOT NULL CONSTRAINT DF_Users_IsDisabled DEFAULT 0,
    RowVersion ROWVERSION NOT NULL,
    CONSTRAINT UQ_Users_Username UNIQUE (Username),
    CONSTRAINT CK_Users_Role CHECK
        (Role IN ('User', 'Admin') AND DATALENGTH(Role) = DATALENGTH(RTRIM(Role))),
    CONSTRAINT CK_Users_Username CHECK
        (LEN(Username) BETWEEN 3 AND 32
         AND DATALENGTH(Username) = DATALENGTH(LTRIM(RTRIM(Username)))
         AND Username COLLATE Latin1_General_100_BIN2 NOT LIKE N'%[^a-zA-Z0-9_.]%'),
    CONSTRAINT CK_Users_PasswordHash CHECK (LEN(LTRIM(RTRIM(PasswordHash))) > 0),
    CONSTRAINT CK_Users_DisplayName CHECK (LEN(LTRIM(RTRIM(DisplayName))) > 0),
    CONSTRAINT CK_Users_LastSeenAt CHECK (LastSeenAt IS NULL OR LastSeenAt >= CreatedAt)
);

CREATE TABLE dbo.Contacts
(
    UserId INT NOT NULL,
    ContactUserId INT NOT NULL,
    Alias NVARCHAR(100) NULL,
    CreatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_Contacts_CreatedAt DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_Contacts PRIMARY KEY (UserId, ContactUserId),
    CONSTRAINT FK_Contacts_User FOREIGN KEY (UserId) REFERENCES dbo.Users(Id),
    CONSTRAINT FK_Contacts_ContactUser FOREIGN KEY (ContactUserId) REFERENCES dbo.Users(Id),
    CONSTRAINT CK_Contacts_NoSelf CHECK (UserId <> ContactUserId),
    CONSTRAINT CK_Contacts_Alias CHECK (Alias IS NULL OR LEN(LTRIM(RTRIM(Alias))) > 0)
);
CREATE INDEX IX_Contacts_ContactUserId ON dbo.Contacts(ContactUserId);

CREATE TABLE dbo.DirectConversations
(
    Id BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_DirectConversations PRIMARY KEY,
    UserAID INT NOT NULL,
    UserBID INT NOT NULL,
    CreatedAt DATETIME2(3) NOT NULL
        CONSTRAINT DF_DirectConversations_CreatedAt DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_DirectConversations_UserA FOREIGN KEY (UserAID) REFERENCES dbo.Users(Id),
    CONSTRAINT FK_DirectConversations_UserB FOREIGN KEY (UserBID) REFERENCES dbo.Users(Id),
    CONSTRAINT CK_DirectConversations_OrderedPair CHECK (UserAID < UserBID),
    CONSTRAINT UQ_DirectConversations_Pair UNIQUE (UserAID, UserBID)
);
CREATE INDEX IX_DirectConversations_UserBID
    ON dbo.DirectConversations(UserBID, Id) INCLUDE (UserAID, CreatedAt);

CREATE TABLE dbo.Messages
(
    Id BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Messages PRIMARY KEY,
    ClientMessageId UNIQUEIDENTIFIER NOT NULL,
    ConversationId BIGINT NOT NULL,
    SenderId INT NOT NULL,
    Content NVARCHAR(4000) NOT NULL,
    CreatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_Messages_CreatedAt DEFAULT SYSUTCDATETIME(),
    DeliveredAt DATETIME2(3) NULL,
    ReadAt DATETIME2(3) NULL,
    RowVersion ROWVERSION NOT NULL,
    CONSTRAINT FK_Messages_Conversation FOREIGN KEY (ConversationId)
        REFERENCES dbo.DirectConversations(Id),
    CONSTRAINT FK_Messages_Sender FOREIGN KEY (SenderId) REFERENCES dbo.Users(Id),
    CONSTRAINT UQ_Messages_ClientId UNIQUE (SenderId, ClientMessageId),
    CONSTRAINT CK_Messages_Content CHECK (LEN(LTRIM(RTRIM(Content))) > 0),
    CONSTRAINT CK_Messages_DeliveredAt CHECK (DeliveredAt IS NULL OR DeliveredAt >= CreatedAt),
    CONSTRAINT CK_Messages_ReadAt CHECK
        (ReadAt IS NULL OR (DeliveredAt IS NOT NULL AND ReadAt >= DeliveredAt))
);
CREATE INDEX IX_Messages_History ON dbo.Messages(ConversationId, CreatedAt DESC, Id DESC)
    INCLUDE (SenderId, DeliveredAt, ReadAt);
CREATE INDEX IX_Messages_Pending ON dbo.Messages(ConversationId, CreatedAt, Id)
    INCLUDE (SenderId, DeliveredAt) WHERE DeliveredAt IS NULL;
CREATE INDEX IX_Messages_Unread ON dbo.Messages(ConversationId, SenderId)
    INCLUDE (ReadAt) WHERE ReadAt IS NULL;

CREATE TABLE dbo.FileTransfers
(
    Id BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_FileTransfers PRIMARY KEY,
    ClientTransferId UNIQUEIDENTIFIER NOT NULL,
    ConversationId BIGINT NOT NULL,
    SenderId INT NOT NULL,
    FileName NVARCHAR(255) NOT NULL,
    FileSizeBytes BIGINT NOT NULL,
    Sha256 VARBINARY(32) NOT NULL,
    VerifiedSha256 VARBINARY(32) NULL,
    Status VARCHAR(12) COLLATE Latin1_General_100_BIN2 NOT NULL
        CONSTRAINT DF_FileTransfers_Status DEFAULT 'offered',
    CreatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_FileTransfers_CreatedAt DEFAULT SYSUTCDATETIME(),
    AcceptedAt DATETIME2(3) NULL,
    FinishedAt DATETIME2(3) NULL,
    RowVersion ROWVERSION NOT NULL,
    CONSTRAINT FK_FileTransfers_Conversation FOREIGN KEY (ConversationId)
        REFERENCES dbo.DirectConversations(Id),
    CONSTRAINT FK_FileTransfers_Sender FOREIGN KEY (SenderId) REFERENCES dbo.Users(Id),
    CONSTRAINT UQ_FileTransfers_ClientId UNIQUE (SenderId, ClientTransferId),
    CONSTRAINT CK_FileTransfers_FileName CHECK (LEN(LTRIM(RTRIM(FileName))) > 0),
    CONSTRAINT CK_FileTransfers_FileSize CHECK (FileSizeBytes >= 0),
    CONSTRAINT CK_FileTransfers_Sha256 CHECK (DATALENGTH(Sha256) = 32),
    CONSTRAINT CK_FileTransfers_VerifiedSha256 CHECK
        ((Status = 'completed' AND VerifiedSha256 IS NOT NULL
          AND DATALENGTH(VerifiedSha256) = 32 AND VerifiedSha256 = Sha256)
         OR (Status <> 'completed' AND VerifiedSha256 IS NULL)),
    CONSTRAINT CK_FileTransfers_Status CHECK
        (Status IN ('offered','accepted','transferring','completed','rejected','cancelled','failed','expired')
         AND DATALENGTH(Status) = DATALENGTH(RTRIM(Status))),
    CONSTRAINT CK_FileTransfers_StateTimes CHECK
        ((Status = 'offered' AND AcceptedAt IS NULL AND FinishedAt IS NULL)
         OR (Status IN ('accepted','transferring') AND AcceptedAt IS NOT NULL AND FinishedAt IS NULL)
         OR (Status = 'completed' AND AcceptedAt IS NOT NULL AND FinishedAt IS NOT NULL)
         OR (Status IN ('rejected','expired') AND AcceptedAt IS NULL AND FinishedAt IS NOT NULL)
         OR (Status IN ('cancelled','failed') AND FinishedAt IS NOT NULL)),
    CONSTRAINT CK_FileTransfers_TimeOrder CHECK
        ((AcceptedAt IS NULL OR AcceptedAt >= CreatedAt)
         AND (FinishedAt IS NULL OR FinishedAt >= CreatedAt)
         AND (AcceptedAt IS NULL OR FinishedAt IS NULL OR FinishedAt >= AcceptedAt))
);
CREATE INDEX IX_FileTransfers_History
    ON dbo.FileTransfers(ConversationId, CreatedAt DESC, Id DESC) INCLUDE (SenderId, Status);
CREATE INDEX IX_FileTransfers_Open ON dbo.FileTransfers(CreatedAt, Id)
    INCLUDE (Status, AcceptedAt, FinishedAt) WHERE FinishedAt IS NULL;

CREATE TABLE dbo.Calls
(
    Id BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Calls PRIMARY KEY,
    ClientCallId UNIQUEIDENTIFIER NOT NULL,
    ConversationId BIGINT NOT NULL,
    CallerId INT NOT NULL,
    Status VARCHAR(12) COLLATE Latin1_General_100_BIN2 NOT NULL
        CONSTRAINT DF_Calls_Status DEFAULT 'ringing',
    CreatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_Calls_CreatedAt DEFAULT SYSUTCDATETIME(),
    AnsweredAt DATETIME2(3) NULL,
    EndedAt DATETIME2(3) NULL,
    RowVersion ROWVERSION NOT NULL,
    CONSTRAINT FK_Calls_Conversation FOREIGN KEY (ConversationId)
        REFERENCES dbo.DirectConversations(Id),
    CONSTRAINT FK_Calls_Caller FOREIGN KEY (CallerId) REFERENCES dbo.Users(Id),
    CONSTRAINT UQ_Calls_ClientId UNIQUE (CallerId, ClientCallId),
    CONSTRAINT CK_Calls_Status CHECK
        (Status IN ('ringing','active','completed','rejected','cancelled','missed','failed')
         AND DATALENGTH(Status) = DATALENGTH(RTRIM(Status))),
    CONSTRAINT CK_Calls_StateTimes CHECK
        ((Status = 'ringing' AND AnsweredAt IS NULL AND EndedAt IS NULL)
         OR (Status = 'active' AND AnsweredAt IS NOT NULL AND EndedAt IS NULL)
         OR (Status = 'completed' AND AnsweredAt IS NOT NULL AND EndedAt IS NOT NULL)
         OR (Status IN ('rejected','cancelled','missed') AND AnsweredAt IS NULL AND EndedAt IS NOT NULL)
         OR (Status = 'failed' AND EndedAt IS NOT NULL)),
    CONSTRAINT CK_Calls_TimeOrder CHECK
        ((AnsweredAt IS NULL OR AnsweredAt >= CreatedAt)
         AND (EndedAt IS NULL OR EndedAt >= CreatedAt)
         AND (AnsweredAt IS NULL OR EndedAt IS NULL OR EndedAt >= AnsweredAt))
);
CREATE INDEX IX_Calls_History ON dbo.Calls(ConversationId, CreatedAt DESC, Id DESC)
    INCLUDE (CallerId, Status, AnsweredAt, EndedAt);
CREATE INDEX IX_Calls_Open ON dbo.Calls(CreatedAt, Id)
    INCLUDE (Status, AnsweredAt, EndedAt) WHERE EndedAt IS NULL;

CREATE TABLE dbo.AdminAuditLogs
(
    Id BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_AdminAuditLogs PRIMARY KEY,
    RequestId UNIQUEIDENTIFIER NOT NULL,
    AdminUserId INT NOT NULL,
    TargetUserId INT NOT NULL,
    Action VARCHAR(20) COLLATE Latin1_General_100_BIN2 NOT NULL,
    OldIsDisabled BIT NOT NULL,
    NewIsDisabled BIT NOT NULL,
    Reason NVARCHAR(500) NOT NULL,
    CreatedAt DATETIME2(3) NOT NULL
        CONSTRAINT DF_AdminAuditLogs_CreatedAt DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_AdminAuditLogs_AdminUser FOREIGN KEY (AdminUserId)
        REFERENCES dbo.Users(Id) ON DELETE NO ACTION,
    CONSTRAINT FK_AdminAuditLogs_TargetUser FOREIGN KEY (TargetUserId)
        REFERENCES dbo.Users(Id) ON DELETE NO ACTION,
    CONSTRAINT UQ_AdminAuditLogs_Request UNIQUE (AdminUserId, RequestId),
    CONSTRAINT CK_AdminAuditLogs_NoSelf CHECK (AdminUserId <> TargetUserId),
    CONSTRAINT CK_AdminAuditLogs_Action CHECK
        (Action IN ('DisableUser', 'EnableUser')
         AND DATALENGTH(Action) = DATALENGTH(RTRIM(Action))),
    CONSTRAINT CK_AdminAuditLogs_StateChange CHECK
        ((Action = 'DisableUser' AND OldIsDisabled = 0 AND NewIsDisabled = 1)
         OR (Action = 'EnableUser' AND OldIsDisabled = 1 AND NewIsDisabled = 0)),
    CONSTRAINT CK_AdminAuditLogs_Reason CHECK
        (LEN(LTRIM(RTRIM(REPLACE(REPLACE(REPLACE(REPLACE(
            Reason, NCHAR(9), N''), NCHAR(10), N''), NCHAR(13), N''), NCHAR(160), N'')))) > 0)
);
CREATE INDEX IX_AdminAuditLogs_TargetHistory
    ON dbo.AdminAuditLogs(TargetUserId, CreatedAt DESC, Id DESC)
    INCLUDE (AdminUserId, Action, OldIsDisabled, NewIsDisabled);
CREATE INDEX IX_AdminAuditLogs_Recent
    ON dbo.AdminAuditLogs(CreatedAt DESC, Id DESC)
    INCLUDE (AdminUserId, TargetUserId, Action);

-- Dynamic batches keep CREATE TRIGGER first in its batch while preserving one
-- transaction for the whole installation, even when a trigger cannot compile.
EXEC sys.sp_executesql N'
CREATE TRIGGER dbo.TR_DirectConversations_ImmutablePair
ON dbo.DirectConversations AFTER UPDATE AS
BEGIN
    SET NOCOUNT ON;
    IF EXISTS (SELECT 1 FROM inserted i JOIN deleted d ON d.Id = i.Id
               WHERE i.UserAID <> d.UserAID OR i.UserBID <> d.UserBID)
        THROW 51002, ''Conversation participants cannot be changed.'', 1;
END;';

EXEC sys.sp_executesql N'
CREATE TRIGGER dbo.TR_Messages_Member
ON dbo.Messages AFTER INSERT, UPDATE AS
BEGIN
    SET NOCOUNT ON;
    IF EXISTS (SELECT 1 FROM inserted i JOIN dbo.DirectConversations c ON c.Id = i.ConversationId
               WHERE i.SenderId <> c.UserAID AND i.SenderId <> c.UserBID)
        THROW 51003, ''Message sender must belong to the conversation.'', 1;
END;';

EXEC sys.sp_executesql N'
CREATE TRIGGER dbo.TR_FileTransfers_Member
ON dbo.FileTransfers AFTER INSERT, UPDATE AS
BEGIN
    SET NOCOUNT ON;
    IF EXISTS (SELECT 1 FROM inserted i JOIN dbo.DirectConversations c ON c.Id = i.ConversationId
               WHERE i.SenderId <> c.UserAID AND i.SenderId <> c.UserBID)
        THROW 51004, ''File sender must belong to the conversation.'', 1;
END;';

EXEC sys.sp_executesql N'
CREATE TRIGGER dbo.TR_Calls_Member
ON dbo.Calls AFTER INSERT, UPDATE AS
BEGIN
    SET NOCOUNT ON;
    IF EXISTS (SELECT 1 FROM inserted i JOIN dbo.DirectConversations c ON c.Id = i.ConversationId
               WHERE i.CallerId <> c.UserAID AND i.CallerId <> c.UserBID)
        THROW 51005, ''Caller must belong to the conversation.'', 1;
END;';

EXEC sys.sp_executesql N'
CREATE TRIGGER dbo.TR_AdminAuditLogs_AppendOnly
ON dbo.AdminAuditLogs AFTER UPDATE, DELETE AS
BEGIN
    SET NOCOUNT ON;
    IF EXISTS (SELECT 1 FROM deleted)
        THROW 51006, ''Admin audit logs cannot be updated or deleted.'', 1;
END;';

COMMIT TRANSACTION;
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    THROW;
END CATCH;
PRINT 'PBL4 schema installed: 7 tables, 5 triggers.';
