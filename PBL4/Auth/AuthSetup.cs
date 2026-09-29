using System.Threading.RateLimiting;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.IdentityModel.Tokens;

namespace PBL4.Auth;

public static class AuthSetup
{
    public static IServiceCollection AddPbl4Auth(this IServiceCollection services,
        IConfiguration configuration, IHostEnvironment environment)
    {
        var tokens = new TokenService(configuration, environment);
        services.AddSingleton(tokens);
        services.AddSingleton<SessionRegistry>();
        services.AddSingleton<PasswordService>();
        services.AddScoped<SessionValidationEvents>();
        services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme).AddJwtBearer(options =>
        {
            options.MapInboundClaims = false;
            options.EventsType = typeof(SessionValidationEvents);
            options.TokenValidationParameters = new TokenValidationParameters
            {
                ValidateIssuer = true, ValidIssuer = tokens.Issuer,
                ValidateAudience = true, ValidAudience = tokens.Audience,
                ValidateIssuerSigningKey = true, IssuerSigningKey = tokens.SigningKey,
                ValidateLifetime = true, RequireExpirationTime = true,
                ClockSkew = TimeSpan.Zero, NameClaimType = "sub", RoleClaimType = "role",
                ValidAlgorithms = [SecurityAlgorithms.HmacSha256]
            };
        });
        services.AddAuthorization(options =>
        {
            options.FallbackPolicy = new AuthorizationPolicyBuilder().RequireAuthenticatedUser().Build();
            options.AddPolicy("Admin", policy => policy.RequireAuthenticatedUser().RequireRole("Admin"));
        });
        services.Configure<ApiBehaviorOptions>(options =>
        {
            options.InvalidModelStateResponseFactory = context =>
            {
                var problem = new ValidationProblemDetails(context.ModelState)
                {
                    Status = 400, Title = "Thông tin nhập chưa hợp lệ."
                };
                problem.Extensions["code"] = "VALIDATION_ERROR";
                return new BadRequestObjectResult(problem);
            };
        });
        services.AddRateLimiter(options =>
        {
            // Giới hạn riêng theo IP; không tin X-Forwarded-For chưa được proxy xác thực.
            options.AddPolicy("auth", context => RateLimitPartition.GetFixedWindowLimiter(
                context.Connection.RemoteIpAddress?.ToString() ?? "unknown",
                _ => new FixedWindowRateLimiterOptions
                {
                    PermitLimit = 20, Window = TimeSpan.FromMinutes(1), QueueLimit = 0
                }));
            options.OnRejected = async (context, ct) =>
            {
                context.HttpContext.Response.Headers.RetryAfter = "60";
                await Results.Problem(statusCode: 429, title: "Bạn thử quá nhiều lần. Vui lòng chờ một phút.",
                    extensions: new Dictionary<string, object?> { ["code"] = "RATE_LIMITED" })
                    .ExecuteAsync(context.HttpContext);
            };
        });
        return services;
    }
}
