using Microsoft.AspNetCore.Identity;
using PBL4.Models;

namespace PBL4.Auth;

public sealed class PasswordService
{
    private readonly PasswordHasher<User> hasher = new();
    private readonly User dummy = new();
    private readonly string dummyHash;

    public PasswordService()
    {
        dummyHash = hasher.HashPassword(dummy, Guid.NewGuid().ToString("N"));
    }

    public string Hash(User user, string password) => hasher.HashPassword(user, password);

    // Tài khoản không tồn tại vẫn thực hiện phép băm để giảm khác biệt thời gian login.
    public PasswordVerificationResult Verify(User? user, string password)
    {
        try
        {
            var result = hasher.VerifyHashedPassword(user ?? dummy, user?.PasswordHash ?? dummyHash, password);
            return user is null ? PasswordVerificationResult.Failed : result;
        }
        catch (FormatException) { return PasswordVerificationResult.Failed; }
    }
}

