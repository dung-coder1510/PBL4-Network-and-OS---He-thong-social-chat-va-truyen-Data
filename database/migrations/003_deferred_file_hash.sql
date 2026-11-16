-- A file-v4 offer can wait for the sender's hash. Completion still requires both hashes.
SET XACT_ABORT ON;
IF DB_NAME() IN (N'master', N'model', N'msdb', N'tempdb')
    THROW 51000, 'Select the PBL4 application database.', 1;
IF COL_LENGTH(N'dbo.FileTransfers', N'Sha256') IS NULL
    THROW 51001, 'The FileTransfers schema is missing.', 1;

BEGIN TRANSACTION;
ALTER TABLE dbo.FileTransfers DROP CONSTRAINT IF EXISTS CK_FileTransfers_Sha256;
ALTER TABLE dbo.FileTransfers DROP CONSTRAINT IF EXISTS CK_FileTransfers_VerifiedSha256;
ALTER TABLE dbo.FileTransfers DROP CONSTRAINT IF EXISTS CK_File_VerifiedSha;
ALTER TABLE dbo.FileTransfers ALTER COLUMN Sha256 VARBINARY(32) NULL;
ALTER TABLE dbo.FileTransfers WITH CHECK ADD
    CONSTRAINT CK_FileTransfers_Sha256 CHECK (Sha256 IS NULL OR DATALENGTH(Sha256) = 32),
    CONSTRAINT CK_FileTransfers_VerifiedSha256 CHECK
        ((Status = 'completed' AND Sha256 IS NOT NULL AND VerifiedSha256 IS NOT NULL
          AND DATALENGTH(VerifiedSha256) = 32 AND VerifiedSha256 = Sha256)
         OR (Status <> 'completed' AND VerifiedSha256 IS NULL));
COMMIT TRANSACTION;
