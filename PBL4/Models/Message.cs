using System.ComponentModel.DataAnnotations;

namespace PBL4.Models
{
    public class Message
    {
        public long Id { get; set; } //[cite: 6]

        public Guid ClientMessageId { get; set; } //[cite: 6]

        public long ConversationId { get; set; } //[cite: 6]
        public DirectConversation Conversation { get; set; } = null!;

        public int SenderId { get; set; } //[cite: 6]
        public User Sender { get; set; } = null!;

        [Required]
        [StringLength(4000)]
        public string Content { get; set; } = null!; //[cite: 6]

        public DateTime CreatedAt { get; set; } //[cite: 6]
        public DateTime? DeliveredAt { get; set; } //[cite: 6]
        public DateTime? ReadAt { get; set; } //[cite: 6]

        [Timestamp]
        public byte[] RowVersion { get; set; } = null!; //[cite: 6]
    }
}
