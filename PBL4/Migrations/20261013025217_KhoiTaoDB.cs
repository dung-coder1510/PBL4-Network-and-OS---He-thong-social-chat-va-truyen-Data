using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace PBL4.Migrations
{
    /// <inheritdoc />
    public partial class KhoiTaoDB : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "Users",
                columns: table => new
                {
                    Id = table.Column<int>(type: "int", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    Username = table.Column<string>(type: "nvarchar(32)", maxLength: 32, nullable: false, collation: "Latin1_General_100_CI_AS"),
                    PasswordHash = table.Column<string>(type: "nvarchar(512)", maxLength: 512, nullable: false),
                    DisplayName = table.Column<string>(type: "nvarchar(100)", maxLength: 100, nullable: false),
                    AvatarPath = table.Column<string>(type: "nvarchar(512)", maxLength: 512, nullable: true),
                    Role = table.Column<string>(type: "VARCHAR(10)", maxLength: 10, nullable: false, defaultValue: "User"),
                    IsDisabled = table.Column<bool>(type: "bit", nullable: false, defaultValue: false),
                    CreatedAt = table.Column<DateTime>(type: "DATETIME2(3)", nullable: false, defaultValueSql: "SYSUTCDATETIME()"),
                    LastSeenAt = table.Column<DateTime>(type: "DATETIME2(3)", nullable: true),
                    RowVersion = table.Column<byte[]>(type: "rowversion", rowVersion: true, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Users", x => x.Id);
                    table.CheckConstraint("CK_User_DisplayName_NoEmpty", "LTRIM(RTRIM([DisplayName])) <> ''");
                    table.CheckConstraint("CK_User_LastSeenAt", "[LastSeenAt] IS NULL OR [LastSeenAt] >= [CreatedAt]");
                    table.CheckConstraint("CK_User_Role", "[Role] IN ('User', 'Admin')");
                    table.CheckConstraint("CK_User_Username", "[Username] NOT LIKE '%[^a-zA-Z0-9_.]%' AND LEN([Username]) >= 3");
                });

            migrationBuilder.CreateTable(
                name: "AdminAuditLogs",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    RequestId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    AdminUserId = table.Column<int>(type: "int", nullable: false),
                    TargetUserId = table.Column<int>(type: "int", nullable: false),
                    Action = table.Column<string>(type: "VARCHAR(20)", maxLength: 20, nullable: false),
                    OldIsDisabled = table.Column<bool>(type: "bit", nullable: false),
                    NewIsDisabled = table.Column<bool>(type: "bit", nullable: false),
                    Reason = table.Column<string>(type: "nvarchar(500)", maxLength: 500, nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "DATETIME2(3)", nullable: false, defaultValueSql: "SYSUTCDATETIME()")
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AdminAuditLogs", x => x.Id);
                    table.CheckConstraint("CK_AdminLog_ActionLogic", "([Action] = 'DisableUser' AND [OldIsDisabled] = 0 AND [NewIsDisabled] = 1) OR ([Action] = 'EnableUser' AND [OldIsDisabled] = 1 AND [NewIsDisabled] = 0)");
                    table.CheckConstraint("CK_AdminLog_NotSelf", "[AdminUserId] <> [TargetUserId]");
                    table.CheckConstraint("CK_AdminLog_Reason_NoWhiteSpace", "LTRIM(RTRIM([Reason])) <> ''");
                    table.ForeignKey(
                        name: "FK_AdminAuditLogs_Users_AdminUserId",
                        column: x => x.AdminUserId,
                        principalTable: "Users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_AdminAuditLogs_Users_TargetUserId",
                        column: x => x.TargetUserId,
                        principalTable: "Users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "Contacts",
                columns: table => new
                {
                    UserId = table.Column<int>(type: "int", nullable: false),
                    ContactUserId = table.Column<int>(type: "int", nullable: false),
                    Alias = table.Column<string>(type: "nvarchar(100)", maxLength: 100, nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "DATETIME2(3)", nullable: false, defaultValueSql: "SYSUTCDATETIME()")
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Contacts", x => new { x.UserId, x.ContactUserId });
                    table.CheckConstraint("CK_Contact_Alias_NoWhiteSpace", "[Alias] IS NULL OR LTRIM(RTRIM([Alias])) <> ''");
                    table.CheckConstraint("CK_Contact_NotSelf", "[UserId] <> [ContactUserId]");
                    table.ForeignKey(
                        name: "FK_Contacts_Users_ContactUserId",
                        column: x => x.ContactUserId,
                        principalTable: "Users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_Contacts_Users_UserId",
                        column: x => x.UserId,
                        principalTable: "Users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "DirectConversations",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    UserAID = table.Column<int>(type: "int", nullable: false),
                    UserBID = table.Column<int>(type: "int", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "DATETIME2(3)", nullable: false, defaultValueSql: "SYSUTCDATETIME()")
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_DirectConversations", x => x.Id);
                    table.CheckConstraint("CK_Conversation_AB", "[UserAID] < [UserBID]");
                    table.ForeignKey(
                        name: "FK_DirectConversations_Users_UserAID",
                        column: x => x.UserAID,
                        principalTable: "Users",
                        principalColumn: "Id");
                    table.ForeignKey(
                        name: "FK_DirectConversations_Users_UserBID",
                        column: x => x.UserBID,
                        principalTable: "Users",
                        principalColumn: "Id");
                });

            migrationBuilder.CreateTable(
                name: "Calls",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    ClientCallId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    ConversationId = table.Column<long>(type: "bigint", nullable: false),
                    CallerId = table.Column<int>(type: "int", nullable: false),
                    Status = table.Column<string>(type: "VARCHAR(12)", maxLength: 12, nullable: false, defaultValue: "ringing"),
                    CreatedAt = table.Column<DateTime>(type: "DATETIME2(3)", nullable: false, defaultValueSql: "SYSUTCDATETIME()"),
                    AnsweredAt = table.Column<DateTime>(type: "DATETIME2(3)", nullable: true),
                    EndedAt = table.Column<DateTime>(type: "DATETIME2(3)", nullable: true),
                    RowVersion = table.Column<byte[]>(type: "rowversion", rowVersion: true, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Calls", x => x.Id);
                    table.CheckConstraint("CK_Call_Status", "[Status] IN ('ringing', 'active', 'completed', 'rejected', 'cancelled', 'missed', 'failed')");
                    table.CheckConstraint("CK_Call_Timeline", "([AnsweredAt] IS NULL OR [AnsweredAt] >= [CreatedAt]) AND ([EndedAt] IS NULL OR [EndedAt] >= ISNULL([AnsweredAt], [CreatedAt]))");
                    table.ForeignKey(
                        name: "FK_Calls_DirectConversations_ConversationId",
                        column: x => x.ConversationId,
                        principalTable: "DirectConversations",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_Calls_Users_CallerId",
                        column: x => x.CallerId,
                        principalTable: "Users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "FileTransfers",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    ClientTransferId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    ConversationId = table.Column<long>(type: "bigint", nullable: false),
                    SenderId = table.Column<int>(type: "int", nullable: false),
                    FileName = table.Column<string>(type: "nvarchar(255)", maxLength: 255, nullable: false),
                    FileSizeBytes = table.Column<long>(type: "bigint", nullable: false),
                    Sha256 = table.Column<byte[]>(type: "VARBINARY(32)", maxLength: 32, nullable: false),
                    VerifiedSha256 = table.Column<byte[]>(type: "VARBINARY(32)", maxLength: 32, nullable: true),
                    Status = table.Column<string>(type: "VARCHAR(12)", maxLength: 12, nullable: false, defaultValue: "offered"),
                    CreatedAt = table.Column<DateTime>(type: "DATETIME2(3)", nullable: false, defaultValueSql: "SYSUTCDATETIME()"),
                    AcceptedAt = table.Column<DateTime>(type: "DATETIME2(3)", nullable: true),
                    FinishedAt = table.Column<DateTime>(type: "DATETIME2(3)", nullable: true),
                    RowVersion = table.Column<byte[]>(type: "rowversion", rowVersion: true, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_FileTransfers", x => x.Id);
                    table.CheckConstraint("CK_File_FileName", "LTRIM(RTRIM([FileName])) <> ''");
                    table.CheckConstraint("CK_File_Size", "[FileSizeBytes] >= 0");
                    table.CheckConstraint("CK_File_Timeline", "([AcceptedAt] IS NULL OR [AcceptedAt] >= [CreatedAt]) AND ([FinishedAt] IS NULL OR [FinishedAt] >= ISNULL([AcceptedAt], [CreatedAt]))");
                    table.CheckConstraint("CK_File_VerifiedSha", "[Status] <> 'completed' OR ([VerifiedSha256] IS NOT NULL AND [VerifiedSha256] = [Sha256])");
                    table.ForeignKey(
                        name: "FK_FileTransfers_DirectConversations_ConversationId",
                        column: x => x.ConversationId,
                        principalTable: "DirectConversations",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_FileTransfers_Users_SenderId",
                        column: x => x.SenderId,
                        principalTable: "Users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "Messages",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    ClientMessageId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    ConversationId = table.Column<long>(type: "bigint", nullable: false),
                    SenderId = table.Column<int>(type: "int", nullable: false),
                    Content = table.Column<string>(type: "nvarchar(4000)", maxLength: 4000, nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "DATETIME2(3)", nullable: false, defaultValueSql: "SYSUTCDATETIME()"),
                    DeliveredAt = table.Column<DateTime>(type: "DATETIME2(3)", nullable: true),
                    ReadAt = table.Column<DateTime>(type: "DATETIME2(3)", nullable: true),
                    RowVersion = table.Column<byte[]>(type: "rowversion", rowVersion: true, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Messages", x => x.Id);
                    table.CheckConstraint("CK_Message_Content", "LTRIM(RTRIM([Content])) <> ''");
                    table.CheckConstraint("CK_Message_Timeline", "([DeliveredAt] IS NULL OR [DeliveredAt] >= [CreatedAt]) AND ([ReadAt] IS NULL OR ([DeliveredAt] IS NOT NULL AND [ReadAt] >= [DeliveredAt]))");
                    table.ForeignKey(
                        name: "FK_Messages_DirectConversations_ConversationId",
                        column: x => x.ConversationId,
                        principalTable: "DirectConversations",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_Messages_Users_SenderId",
                        column: x => x.SenderId,
                        principalTable: "Users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "IX_AdminAuditLogs_AdminUserId_RequestId",
                table: "AdminAuditLogs",
                columns: new[] { "AdminUserId", "RequestId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_AdminAuditLogs_TargetUserId",
                table: "AdminAuditLogs",
                column: "TargetUserId");

            migrationBuilder.CreateIndex(
                name: "IX_Calls_CallerId_ClientCallId",
                table: "Calls",
                columns: new[] { "CallerId", "ClientCallId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_Calls_ConversationId",
                table: "Calls",
                column: "ConversationId");

            migrationBuilder.CreateIndex(
                name: "IX_Contacts_ContactUserId",
                table: "Contacts",
                column: "ContactUserId");

            migrationBuilder.CreateIndex(
                name: "IX_DirectConversations_UserAID_UserBID",
                table: "DirectConversations",
                columns: new[] { "UserAID", "UserBID" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_DirectConversations_UserBID",
                table: "DirectConversations",
                column: "UserBID");

            migrationBuilder.CreateIndex(
                name: "IX_FileTransfers_ConversationId",
                table: "FileTransfers",
                column: "ConversationId");

            migrationBuilder.CreateIndex(
                name: "IX_FileTransfers_SenderId_ClientTransferId",
                table: "FileTransfers",
                columns: new[] { "SenderId", "ClientTransferId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_Messages_ConversationId",
                table: "Messages",
                column: "ConversationId");

            migrationBuilder.CreateIndex(
                name: "IX_Messages_SenderId_ClientMessageId",
                table: "Messages",
                columns: new[] { "SenderId", "ClientMessageId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_Users_Username",
                table: "Users",
                column: "Username",
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "AdminAuditLogs");

            migrationBuilder.DropTable(
                name: "Calls");

            migrationBuilder.DropTable(
                name: "Contacts");

            migrationBuilder.DropTable(
                name: "FileTransfers");

            migrationBuilder.DropTable(
                name: "Messages");

            migrationBuilder.DropTable(
                name: "DirectConversations");

            migrationBuilder.DropTable(
                name: "Users");
        }
    }
}
