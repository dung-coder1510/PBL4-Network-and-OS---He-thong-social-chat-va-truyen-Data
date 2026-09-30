using System.ComponentModel.DataAnnotations;

namespace PBL4.Contracts;

public sealed class CreateContactDto
{
    [Range(1, int.MaxValue)]
    public int ContactUserId { get; set; }

    [StringLength(100)]
    public string? Alias { get; set; }
}

public sealed class UpdateContactDto
{
    [StringLength(100)]
    public string? Alias { get; set; }
}

public sealed record ContactDto(ConversationUserDto User, string? Alias, DateTime CreatedAt);
