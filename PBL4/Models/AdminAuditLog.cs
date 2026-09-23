using System.ComponentModel.DataAnnotations;

namespace PBL4.Models
{
    public class AdminAuditLog
    {
        public long Id { get; set; } //

        public Guid RequestId { get; set; } //[cite: 10]

        public int AdminUserId { get; set; } //[cite: 10]
        public User AdminUser { get; set; } = null!;

        public int TargetUserId { get; set; } //[cite: 10]
        public User TargetUser { get; set; } = null!;

        [Required]
        [StringLength(20)]
        public string Action { get; set; } = null!; //[cite: 10]

        public bool OldIsDisabled { get; set; } //[cite: 10]
        public bool NewIsDisabled { get; set; } //[cite: 10]

        [Required]
        [StringLength(500)]
        public string Reason { get; set; } = null!; //[cite: 10]

        public DateTime CreatedAt { get; set; } //[cite: 10]
    }   
}
