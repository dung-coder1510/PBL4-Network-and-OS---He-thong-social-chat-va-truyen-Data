using System.ComponentModel.DataAnnotations;

namespace PBL4.Models
{
    public class FileTransfer
    {
        public long Id { get; set; } //

        public Guid ClientTransferId { get; set; } //[cite: 7]

        public long ConversationId { get; set; } //[cite: 7]
        public DirectConversation Conversation { get; set; } = null!;

        public int SenderId { get; set; } //[cite: 7]
        public User Sender { get; set; } = null!;

        [Required]
        [StringLength(255)]
        public string FileName { get; set; } = null!; //[cite: 7]

        public long FileSizeBytes { get; set; } //[cite: 7]

        [Required]
        [MaxLength(32)]
        public byte[] Sha256 { get; set; } = null!; //[cite: 7]

        [MaxLength(32)]
        public byte[]? VerifiedSha256 { get; set; } //[cite: 7]

        [Required]
        [StringLength(12)]
        public string Status { get; set; } = "offered"; //[cite: 7]

        public DateTime CreatedAt { get; set; } //[cite: 7]
        public DateTime? AcceptedAt { get; set; } //[cite: 7]
        public DateTime? FinishedAt { get; set; } //[cite: 7]

        [Timestamp]
        public byte[] RowVersion { get; set; } = null!; //[cite: 7]
    }
}
