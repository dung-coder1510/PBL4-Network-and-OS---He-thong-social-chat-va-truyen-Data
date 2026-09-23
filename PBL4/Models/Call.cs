using System.ComponentModel.DataAnnotations;

namespace PBL4.Models
{
    public class Call
    {
        public long Id { get; set; } //[cite: 9]

        public Guid ClientCallId { get; set; } //[cite: 9]

        public long ConversationId { get; set; } //[cite: 9]
        public DirectConversation Conversation { get; set; } = null!;

        public int CallerId { get; set; } //[cite: 9]
        public User Caller { get; set; } = null!;

        [Required]
        [StringLength(12)]
        public string Status { get; set; } = "ringing"; //[cite: 9]

        public DateTime CreatedAt { get; set; } //[cite: 9]
        public DateTime? AnsweredAt { get; set; } //[cite: 9]
        public DateTime? EndedAt { get; set; } //[cite: 9]

        [Timestamp]
        public byte[] RowVersion { get; set; } = null!; //[cite: 9]
    }
}
