using Microsoft.EntityFrameworkCore;
using PBL4.Models;

namespace PBL4.Data
{
    public class AppDbContext : DbContext
    {
        public AppDbContext(DbContextOptions<AppDbContext> options) : base(options) { }

        public DbSet<User> Users { get; set; }
        public DbSet<Contact> Contacts { get; set; }
        public DbSet<DirectConversation> DirectConversations { get; set; }
        public DbSet<Message> Messages { get; set; }
        public DbSet<FileTransfer> FileTransfers { get; set; }
        public DbSet<Call> Calls { get; set; }
        public DbSet<AdminAuditLog> AdminAuditLogs { get; set; }

        protected override void OnModelCreating(ModelBuilder modelBuilder)
        {
            base.OnModelCreating(modelBuilder);

            // ==========================================
            // 1. USERS[cite: 4]
            // ==========================================
            modelBuilder.Entity<User>(entity =>
            {
                entity.HasIndex(e => e.Username).IsUnique();
                entity.Property(e => e.Username).UseCollation("Latin1_General_100_CI_AS");
                entity.Property(e => e.Role).HasColumnType("VARCHAR(10)").HasDefaultValue("User");
                entity.Property(e => e.IsDisabled).HasDefaultValue(false);
                entity.Property(e => e.CreatedAt).HasColumnType("DATETIME2(3)").HasDefaultValueSql("SYSUTCDATETIME()");
                entity.Property(e => e.LastSeenAt).HasColumnType("DATETIME2(3)");
                entity.Property(e => e.RowVersion).IsRowVersion();

                entity.ToTable(t =>
                {
                    t.HasCheckConstraint("CK_User_Role", "[Role] IN ('User', 'Admin')");
                    t.HasCheckConstraint("CK_User_LastSeenAt", "[LastSeenAt] IS NULL OR [LastSeenAt] >= [CreatedAt]");
                    t.HasCheckConstraint("CK_User_Username", "[Username] NOT LIKE '%[^a-zA-Z0-9_.]%' AND LEN([Username]) >= 3");
                    t.HasCheckConstraint("CK_User_DisplayName_NoEmpty", "LTRIM(RTRIM([DisplayName])) <> ''");
                });
            });

            // ==========================================
            // 2. CONTACTS[cite: 5]
            // ==========================================
            modelBuilder.Entity<Contact>(entity =>
            {
                entity.HasKey(e => new { e.UserId, e.ContactUserId });
                entity.Property(e => e.CreatedAt).HasColumnType("DATETIME2(3)").HasDefaultValueSql("SYSUTCDATETIME()");

                entity.HasOne(e => e.User).WithMany(u => u.ContactsOwner).HasForeignKey(e => e.UserId).OnDelete(DeleteBehavior.Restrict);
                entity.HasOne(e => e.ContactUser).WithMany(u => u.ContactsTarget).HasForeignKey(e => e.ContactUserId).OnDelete(DeleteBehavior.Restrict);

                entity.ToTable(t =>
                {
                    t.HasCheckConstraint("CK_Contact_NotSelf", "[UserId] <> [ContactUserId]");
                    t.HasCheckConstraint("CK_Contact_Alias_NoWhiteSpace", "[Alias] IS NULL OR LTRIM(RTRIM([Alias])) <> ''");
                });
            });

            // ==========================================
            // 3. DIRECT CONVERSATIONS[cite: 5]
            // ==========================================
            modelBuilder.Entity<DirectConversation>(entity =>
            {
                entity.HasIndex(e => new { e.UserAID, e.UserBID }).IsUnique();
                entity.Property(e => e.CreatedAt).HasColumnType("DATETIME2(3)").HasDefaultValueSql("SYSUTCDATETIME()");

                entity.HasOne(e => e.UserA).WithMany(u => u.ConversationsAsA).HasForeignKey(e => e.UserAID).OnDelete(DeleteBehavior.NoAction);
                entity.HasOne(e => e.UserB).WithMany(u => u.ConversationsAsB).HasForeignKey(e => e.UserBID).OnDelete(DeleteBehavior.NoAction);

                entity.ToTable(t =>
                {
                    t.UseSqlOutputClause(false);
                    t.HasCheckConstraint("CK_Conversation_AB", "[UserAID] < [UserBID]");
                });
            });

            // ==========================================
            // 4. MESSAGES[cite: 6]
            // ==========================================
            modelBuilder.Entity<Message>(entity =>
            {
                entity.HasIndex(e => new { e.SenderId, e.ClientMessageId }).IsUnique();
                entity.Property(e => e.CreatedAt).HasColumnType("DATETIME2(3)").HasDefaultValueSql("SYSUTCDATETIME()");
                entity.Property(e => e.DeliveredAt).HasColumnType("DATETIME2(3)");
                entity.Property(e => e.ReadAt).HasColumnType("DATETIME2(3)");
                entity.Property(e => e.RowVersion).IsRowVersion();

                entity.HasOne(e => e.Conversation).WithMany(c => c.Messages).HasForeignKey(e => e.ConversationId).OnDelete(DeleteBehavior.Cascade);
                entity.HasOne(e => e.Sender).WithMany().HasForeignKey(e => e.SenderId).OnDelete(DeleteBehavior.Restrict);

                entity.ToTable(t =>
                {
                    t.UseSqlOutputClause(false);
                    t.HasCheckConstraint("CK_Message_Content", "LTRIM(RTRIM([Content])) <> ''");
                    t.HasCheckConstraint("CK_Message_Timeline",
                        "([DeliveredAt] IS NULL OR [DeliveredAt] >= [CreatedAt]) AND ([ReadAt] IS NULL OR ([DeliveredAt] IS NOT NULL AND [ReadAt] >= [DeliveredAt]))");
                });
            });

            // ==========================================
            // 5. FILE TRANSFERS[cite: 7, 8]
            // ==========================================
            modelBuilder.Entity<FileTransfer>(entity =>
            {
                entity.HasIndex(e => new { e.SenderId, e.ClientTransferId }).IsUnique();
                entity.Property(e => e.Sha256).HasColumnType("VARBINARY(32)");
                entity.Property(e => e.VerifiedSha256).HasColumnType("VARBINARY(32)");
                entity.Property(e => e.Status).HasColumnType("VARCHAR(12)").HasDefaultValue("offered");
                entity.Property(e => e.CreatedAt).HasColumnType("DATETIME2(3)").HasDefaultValueSql("SYSUTCDATETIME()");
                entity.Property(e => e.AcceptedAt).HasColumnType("DATETIME2(3)");
                entity.Property(e => e.FinishedAt).HasColumnType("DATETIME2(3)");
                entity.Property(e => e.RowVersion).IsRowVersion();

                entity.HasOne(e => e.Conversation).WithMany(c => c.FileTransfers).HasForeignKey(e => e.ConversationId).OnDelete(DeleteBehavior.Cascade);
                entity.HasOne(e => e.Sender).WithMany().HasForeignKey(e => e.SenderId).OnDelete(DeleteBehavior.Restrict);

                entity.ToTable(t =>
                {
                    t.UseSqlOutputClause(false);
                    t.HasCheckConstraint("CK_File_Size", "[FileSizeBytes] >= 0");
                    t.HasCheckConstraint("CK_File_FileName", "LTRIM(RTRIM([FileName])) <> ''");
                    t.HasCheckConstraint("CK_File_Timeline",
                        "([AcceptedAt] IS NULL OR [AcceptedAt] >= [CreatedAt]) AND ([FinishedAt] IS NULL OR [FinishedAt] >= ISNULL([AcceptedAt], [CreatedAt]))");
                    t.HasCheckConstraint("CK_File_VerifiedSha", "[Status] <> 'completed' OR ([VerifiedSha256] IS NOT NULL AND [VerifiedSha256] = [Sha256])");
                });
            });

            // ==========================================
            // 6. CALLS[cite: 9]
            // ==========================================
            modelBuilder.Entity<Call>(entity =>
            {
                entity.HasIndex(e => new { e.CallerId, e.ClientCallId }).IsUnique();
                entity.Property(e => e.Status).HasColumnType("VARCHAR(12)").HasDefaultValue("ringing");
                entity.Property(e => e.CreatedAt).HasColumnType("DATETIME2(3)").HasDefaultValueSql("SYSUTCDATETIME()");
                entity.Property(e => e.AnsweredAt).HasColumnType("DATETIME2(3)");
                entity.Property(e => e.EndedAt).HasColumnType("DATETIME2(3)");
                entity.Property(e => e.RowVersion).IsRowVersion();

                entity.HasOne(e => e.Conversation).WithMany(c => c.Calls).HasForeignKey(e => e.ConversationId).OnDelete(DeleteBehavior.Cascade);
                entity.HasOne(e => e.Caller).WithMany().HasForeignKey(e => e.CallerId).OnDelete(DeleteBehavior.Restrict);

                entity.ToTable(t =>
                {
                    t.UseSqlOutputClause(false);
                    t.HasCheckConstraint("CK_Call_Status", "[Status] IN ('ringing', 'active', 'completed', 'rejected', 'cancelled', 'missed', 'failed')");
                    t.HasCheckConstraint("CK_Call_Timeline",
                        "([AnsweredAt] IS NULL OR [AnsweredAt] >= [CreatedAt]) AND ([EndedAt] IS NULL OR [EndedAt] >= ISNULL([AnsweredAt], [CreatedAt]))");
                });
            });

            // ==========================================
            // 7. ADMIN AUDIT LOGS[cite: 10]
            // ==========================================
            modelBuilder.Entity<AdminAuditLog>(entity =>
            {
                entity.HasIndex(e => new { e.AdminUserId, e.RequestId }).IsUnique();
                entity.Property(e => e.Action).HasColumnType("VARCHAR(20)");
                entity.Property(e => e.CreatedAt).HasColumnType("DATETIME2(3)").HasDefaultValueSql("SYSUTCDATETIME()");

                entity.HasOne(e => e.AdminUser).WithMany().HasForeignKey(e => e.AdminUserId).OnDelete(DeleteBehavior.Restrict);
                entity.HasOne(e => e.TargetUser).WithMany().HasForeignKey(e => e.TargetUserId).OnDelete(DeleteBehavior.Restrict);

                entity.ToTable(t =>
                {
                    t.UseSqlOutputClause(false);
                    t.HasCheckConstraint("CK_AdminLog_NotSelf", "[AdminUserId] <> [TargetUserId]");
                    t.HasCheckConstraint("CK_AdminLog_Reason_NoWhiteSpace", "LTRIM(RTRIM([Reason])) <> ''");
                    t.HasCheckConstraint("CK_AdminLog_ActionLogic",
                        "([Action] = 'DisableUser' AND [OldIsDisabled] = 0 AND [NewIsDisabled] = 1) OR " +
                        "([Action] = 'EnableUser' AND [OldIsDisabled] = 1 AND [NewIsDisabled] = 0)");
                });
            });
        }
    }
}
