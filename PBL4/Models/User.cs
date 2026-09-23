
using System.ComponentModel.DataAnnotations;

namespace PBL4.Models
{
    public enum Role 
    { 
        User,
        Admin
    }

    public class User
    {
        public int Id { get; set; } //[cite: 4]

        [Required]
        [StringLength(32, MinimumLength = 3)]
        [RegularExpression(@"^[a-zA-Z0-9_.]+$")]
        public string Username { get; set; } = null!; //[cite: 4]

        [Required]
        [StringLength(512)]
        public string PasswordHash { get; set; } = null!; //[cite: 4]

        [Required]
        [StringLength(100)]
        public string DisplayName { get; set; } = null!; //[cite: 4]

        [Required]
        [StringLength(10)]
        public string Role { get; set; } = "User"; //[cite: 4]

        public bool IsDisabled { get; set; } //[cite: 4]

        public DateTime CreatedAt { get; set; } //[cite: 4]

        public DateTime? LastSeenAt { get; set; } //[cite: 4]

        [Timestamp]
        public byte[] RowVersion { get; set; } = null!; //[cite: 4]

        // Navigations
        public ICollection<Contact> ContactsOwner { get; set; } = new List<Contact>();
        public ICollection<Contact> ContactsTarget { get; set; } = new List<Contact>();
        public ICollection<DirectConversation> ConversationsAsA { get; set; } = new List<DirectConversation>();
        public ICollection<DirectConversation> ConversationsAsB { get; set; } = new List<DirectConversation>();
    }
}
