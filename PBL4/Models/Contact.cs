using System.ComponentModel.DataAnnotations;

namespace PBL4.Models
{
    public class Contact
    {
        public int UserId { get; set; } //[cite: 5]
        public User User { get; set; } = null!;

        public int ContactUserId { get; set; } //[cite: 5]
        public User ContactUser { get; set; } = null!;

        [StringLength(100)]
        public string? Alias { get; set; } //[cite: 5]

        public DateTime CreatedAt { get; set; } //[cite: 5]
    }
}
