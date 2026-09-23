namespace PBL4.Models
{
    public class DirectConversation
    {
        public long Id { get; set; } //[cite: 5]

        public int UserLowId { get; set; } //[cite: 5]
        public User UserLow { get; set; } = null!;

        public int UserHighId { get; set; } //[cite: 5]
        public User UserHigh { get; set; } = null!;

        public DateTime CreatedAt { get; set; } //[cite: 5]

        // Navigations
        public ICollection<Message> Messages { get; set; } = new List<Message>();
        public ICollection<FileTransfer> FileTransfers { get; set; } = new List<FileTransfer>();
        public ICollection<Call> Calls { get; set; } = new List<Call>();
    }
}
