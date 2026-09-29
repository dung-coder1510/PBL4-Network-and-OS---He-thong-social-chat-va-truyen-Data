using System.ComponentModel.DataAnnotations;
using PBL4.Models;

namespace PBL4.Contracts;

public sealed class RegisterUserDto
{
    [Required, StringLength(32, MinimumLength = 3)]
    [RegularExpression(@"^[a-zA-Z0-9_.]+$", ErrorMessage = "Tên đăng nhập chỉ gồm chữ không dấu, số, dấu chấm và gạch dưới.")]
    public string Username { get; set; } = "";

    [Required, StringLength(100)]
    public string DisplayName { get; set; } = "";

    [Required, StringLength(128, MinimumLength = 12, ErrorMessage = "Mật khẩu cần từ 12 đến 128 ký tự.")]
    public string Password { get; set; } = "";
}

public sealed class CreateSessionDto
{
    [Required, StringLength(32)]
    public string Username { get; set; } = "";

    [Required, StringLength(128)]
    public string Password { get; set; } = "";
}

// Chỉ công khai các trường cần thiết; không serialize entity cùng PasswordHash.
public sealed record CurrentUserDto(int Id, string Username, string DisplayName, string Role, string? AvatarPath)
{
    public static CurrentUserDto From(User user) =>
        new(user.Id, user.Username, user.DisplayName, user.Role, user.AvatarPath);
}

public sealed record AuthSessionDto(string SessionId, string AccessToken,
    DateTimeOffset ExpiresAt, CurrentUserDto User);

