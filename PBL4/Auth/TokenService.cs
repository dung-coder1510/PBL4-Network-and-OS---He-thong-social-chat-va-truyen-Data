using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using Microsoft.IdentityModel.Tokens;
using PBL4.Contracts;
using PBL4.Models;

namespace PBL4.Auth;

public sealed class TokenService
{
    public string Issuer { get; }
    public string Audience { get; }
    public SymmetricSecurityKey SigningKey { get; }

    public TokenService(IConfiguration configuration, IHostEnvironment environment)
    {
        Issuer = configuration["Jwt:Issuer"] ?? "PBL4.Server";
        Audience = configuration["Jwt:Audience"] ?? "PBL4.Clients";
        var secret = configuration["Jwt:SigningKey"];
        if (string.IsNullOrWhiteSpace(secret))
        {
            if (!environment.IsDevelopment())
                throw new InvalidOperationException("Set Jwt:SigningKey with at least 32 random bytes.");
            // Key ngẫu nhiên mỗi lần khởi động ở Development; không hardcode secret.
            SigningKey = new SymmetricSecurityKey(RandomNumberGenerator.GetBytes(32));
        }
        else
        {
            var bytes = Encoding.UTF8.GetBytes(secret);
            if (bytes.Length < 32) throw new InvalidOperationException("Jwt:SigningKey must be at least 32 bytes.");
            SigningKey = new SymmetricSecurityKey(bytes);
        }
    }

    public AuthSessionDto Create(User user, SessionRegistry sessions)
    {
        var now = DateTimeOffset.UtcNow;
        var expires = now.AddMinutes(30);
        var sid = sessions.Create(user.Id, expires);
        var claims = new[]
        {
            new Claim("sub", user.Id.ToString(System.Globalization.CultureInfo.InvariantCulture)),
            new Claim("sid", sid),
            new Claim("role", user.Role),
            new Claim(JwtRegisteredClaimNames.Jti, Guid.NewGuid().ToString("N"))
        };
        var token = new JwtSecurityToken(Issuer, Audience, claims, now.UtcDateTime, expires.UtcDateTime,
            new SigningCredentials(SigningKey, SecurityAlgorithms.HmacSha256));
        return new AuthSessionDto(sid, new JwtSecurityTokenHandler().WriteToken(token),
            expires, CurrentUserDto.From(user));
    }
}

