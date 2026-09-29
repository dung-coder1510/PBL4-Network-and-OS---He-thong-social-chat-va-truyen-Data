-- Apply to an existing PBL4 database. Keeps existing users and data unchanged.
-- Safe to run again when the column already has the expected definition.
SET NOCOUNT ON;
SET XACT_ABORT ON;

IF DB_NAME() IN (N'master', N'model', N'msdb', N'tempdb')
    THROW 51000, 'Select the PBL4 application database before running this script.', 1;

IF OBJECT_ID(N'dbo.Users', N'U') IS NULL
    THROW 51001, 'dbo.Users does not exist in the selected database.', 1;

BEGIN TRY
    BEGIN TRANSACTION;

    IF COL_LENGTH(N'dbo.Users', N'AvatarPath') IS NULL
        ALTER TABLE dbo.Users ADD AvatarPath NVARCHAR(512) NULL;

    IF NOT EXISTS (
        SELECT 1
        FROM sys.columns
        WHERE object_id = OBJECT_ID(N'dbo.Users')
          AND name = N'AvatarPath'
          AND system_type_id = TYPE_ID(N'nvarchar')
          AND max_length = 1024 -- NVARCHAR length is reported in bytes.
          AND is_nullable = 1
          AND is_computed = 0
    )
        THROW 51002, 'AvatarPath exists with an unexpected definition; no changes were committed.', 1;

    COMMIT TRANSACTION;
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    THROW;
END CATCH;
