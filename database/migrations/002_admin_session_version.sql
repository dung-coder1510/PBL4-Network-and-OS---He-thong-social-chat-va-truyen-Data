-- Additive migration for an existing application database; preserves users/history.
SET XACT_ABORT ON;
IF DB_NAME() IN (N'master',N'model',N'msdb',N'tempdb') THROW 51000, 'Select an application database.', 1;
IF OBJECT_ID(N'dbo.Users', N'U') IS NULL OR OBJECT_ID(N'dbo.AdminAuditLogs', N'U') IS NULL
    THROW 51001, 'Application schema is missing.', 1;
BEGIN TRANSACTION;
IF COL_LENGTH(N'dbo.Users', N'SessionVersion') IS NULL
    ALTER TABLE dbo.Users ADD SessionVersion INT NOT NULL CONSTRAINT DF_Users_SessionVersion DEFAULT 0;
EXEC sys.sp_executesql N'CREATE OR ALTER TRIGGER dbo.TR_AdminAuditLogs_AppendOnly
ON dbo.AdminAuditLogs AFTER UPDATE, DELETE AS
BEGIN
    SET NOCOUNT ON;
    IF EXISTS (SELECT 1 FROM deleted) THROW 51006, ''Admin audit logs cannot be updated or deleted.'', 1;
END;';
COMMIT TRANSACTION;
