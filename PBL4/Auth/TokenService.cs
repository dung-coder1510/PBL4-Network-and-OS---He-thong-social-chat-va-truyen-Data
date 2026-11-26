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
    public static readonly TimeSpan AccessTokenLifetime = TimeSpan.FromMinutes(30);
    public static readonly TimeSpan RefreshTokenLifetime = TimeSpan.FromDays(30);

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

    public AuthSessionDto CreateAccessToken(User user, string sessionId, DateTimeOffset now, DateTimeOffset expires)
    {
        var claims = new[]
        {
            new Claim("sub", user.Id.ToString(System.Globalization.CultureInfo.InvariantCulture)),
            new Claim("sid", sessionId),
            new Claim("ver", user.SessionVersion.ToString(System.Globalization.CultureInfo.InvariantCulture)),
            new Claim("role", user.Role),
            new Claim(JwtRegisteredClaimNames.Jti, Guid.NewGuid().ToString("N"))
        };
        var token = new JwtSecurityToken(Issuer, Audience, claims, now.UtcDateTime, expires.UtcDateTime,
            new SigningCredentials(SigningKey, SecurityAlgorithms.HmacSha256));
        return new AuthSessionDto(sessionId, new JwtSecurityTokenHandler().WriteToken(token),
            expires, CurrentUserDto.From(user));
    }

    public (AuthSessionDto Session, string RefreshToken, DateTimeOffset RefreshExpiresAt) CreateWithRefresh(
        User user, SessionRegistry sessions)
    {
        var now = DateTimeOffset.UtcNow;
        var accessExpires = now.Add(AccessTokenLifetime);
        var refreshExpires = now.Add(RefreshTokenLifetime);
        var (sid, refreshToken) = sessions.Create(user.Id, user.SessionVersion, accessExpires, refreshExpires);
        return (CreateAccessToken(user, sid, now, accessExpires), refreshToken, refreshExpires);
    }

    public AuthSessionDto Create(User user, SessionRegistry sessions) =>
        CreateWithRefresh(user, sessions).Session;
}

