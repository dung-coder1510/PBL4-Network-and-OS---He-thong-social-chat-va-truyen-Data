using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using PBL4.Data;

namespace PBL4.Migrations;

[DbContext(typeof(AppDbContext))]
[Migration("20261102000000_AdminSessionVersion")]
public sealed class AdminSessionVersion : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.Sql("IF COL_LENGTH(N'dbo.Users', N'SessionVersion') IS NULL ALTER TABLE dbo.Users ADD SessionVersion INT NOT NULL CONSTRAINT DF_Users_SessionVersion DEFAULT 0;");
        migrationBuilder.Sql("CREATE OR ALTER TRIGGER dbo.TR_AdminAuditLogs_AppendOnly ON dbo.AdminAuditLogs AFTER UPDATE, DELETE AS BEGIN SET NOCOUNT ON; IF EXISTS (SELECT 1 FROM deleted) THROW 51006, 'Admin audit logs cannot be updated or deleted.', 1; END;");
    }
    protected override void Down(MigrationBuilder migrationBuilder) => migrationBuilder.DropColumn("SessionVersion", "Users");
}
