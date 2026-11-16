using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using PBL4.Data;

namespace PBL4.Migrations;

[DbContext(typeof(AppDbContext))]
[Migration("20261116000000_DeferredFileHash")]
public sealed class DeferredFileHash : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropCheckConstraint("CK_File_VerifiedSha", "FileTransfers");
        migrationBuilder.AlterColumn<byte[]>("Sha256", "FileTransfers", type: "VARBINARY(32)",
            maxLength: 32, nullable: true, oldClrType: typeof(byte[]), oldType: "VARBINARY(32)", oldMaxLength: 32);
        migrationBuilder.AddCheckConstraint("CK_File_VerifiedSha", "FileTransfers",
            "[Status] <> 'completed' OR ([Sha256] IS NOT NULL AND [VerifiedSha256] IS NOT NULL AND [VerifiedSha256] = [Sha256])");
    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.Sql("""
            IF EXISTS (SELECT 1 FROM dbo.FileTransfers WHERE Sha256 IS NULL)
                THROW 51000, 'Pending sender hashes prevent reverting this migration.', 1;
            """);
        migrationBuilder.DropCheckConstraint("CK_File_VerifiedSha", "FileTransfers");
        migrationBuilder.AlterColumn<byte[]>("Sha256", "FileTransfers", type: "VARBINARY(32)",
            maxLength: 32, nullable: false, oldClrType: typeof(byte[]), oldType: "VARBINARY(32)",
            oldMaxLength: 32, oldNullable: true);
        migrationBuilder.AddCheckConstraint("CK_File_VerifiedSha", "FileTransfers",
            "[Status] <> 'completed' OR ([VerifiedSha256] IS NOT NULL AND [VerifiedSha256] = [Sha256])");
    }
}
