
using Microsoft.EntityFrameworkCore;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.Diagnostics.HealthChecks;
using Microsoft.AspNetCore.HttpOverrides;
using System.Net;
using PBL4.Data;
using PBL4.Health;
using PBL4.Auth;
using PBL4.Realtime;
using PBL4.Services;

namespace PBL4
{
    public class Program
    {
        // Doc cau hinh, dang ky service va tao pipeline HTTP/SignalR de chay backend.
        public static void Main(string[] args)
        {
            var builder = WebApplication.CreateBuilder(args);

            var connectionString = builder.Configuration.GetConnectionString("DefaultConnection")
                ?? throw new InvalidOperationException("Connection string 'DefaultConnection' was not found.");

            // Production dung cung origin qua Nginx; chi cho phep origin khac khi duoc cau hinh ro.
            var allowedOrigins = builder.Configuration.GetSection("Cors:AllowedOrigins").Get<string[]>()
                ?? (builder.Environment.IsDevelopment()
                    ? ["http://localhost:5173", "http://127.0.0.1:5173"] : []);

            // Chi tin mot proxy Nginx tren loopback; khong tin header do may ngoai tu gui vao.
            builder.Services.Configure<ForwardedHeadersOptions>(options =>
            {
                options.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;
                options.ForwardLimit = 1;
                options.KnownIPNetworks.Clear();
                options.KnownProxies.Clear();
                options.KnownProxies.Add(IPAddress.Loopback);
                options.KnownProxies.Add(IPAddress.IPv6Loopback);
            });

            // Dang ky dependency: DbContext theo request, registry phien dung chung mot instance.
            builder.Services.AddCors(options =>
            {
                options.AddPolicy("AllowReactApp",
                    policy => policy.WithOrigins(allowedOrigins)
                                    .AllowAnyMethod()
                                    .AllowAnyHeader()
                                    .AllowCredentials());
            });
            builder.Services.AddDbContext<AppDbContext>(options =>
                options.UseSqlServer(connectionString));
            // Probe ready kiem tra SQL; probe live chi kiem tra tien trinh HTTP con phan hoi.
            builder.Services.AddHealthChecks().AddCheck<DatabaseHealthCheck>("sql",
                tags: ["ready"], timeout: TimeSpan.FromSeconds(5));
            builder.Services.AddControllers();
            builder.Services.AddPbl4Auth(builder.Configuration, builder.Environment);
            builder.Services.AddSignalR(options => options.AddFilter<RealtimeSessionFilter>());
            builder.Services.AddScoped<MessageService>();
            builder.Services.AddScoped<MessageReceiptService>();
            builder.Services.AddSingleton<FileTransferService>();
            builder.Services.AddSingleton<TextPeerSessionService>();
            // Worker don phien text dinh ky; khong phu thuoc viec client co gui lenh dong hay khong.
            builder.Services.AddHostedService<TextPeerMonitor>();
            builder.Services.AddHostedService<FileTransferMonitor>();
            builder.Services.AddSingleton<PresenceService>();
            builder.Services.AddScoped<RealtimeSessionFilter>();
            builder.Services.AddSingleton<PresenceTracker>();
            builder.Services.AddSingleton(TimeProvider.System);
            builder.Services.AddOptions<HeartbeatOptions>()
                .BindConfiguration("Heartbeat")
                .Validate(options => options.IntervalSeconds > 0 &&
                    options.TimeoutSeconds > options.IntervalSeconds &&
                    options.CheckIntervalSeconds > 0 &&
                    options.CheckIntervalSeconds <= options.TimeoutSeconds,
                    "Heartbeat intervals must be positive and timeout must exceed the send interval.")
                .ValidateOnStart();
            builder.Services.AddHostedService<HeartbeatMonitor>();
            builder.Services.AddSingleton<TypingRateLimiter>();
            builder.Services.AddSingleton<IUserIdProvider, SubClaimUserIdProvider>();
            // Dang ky mo ta API; chi mo endpoint tai lieu trong moi truong Development.
            builder.Services.AddOpenApi();

            var app = builder.Build();

            // Phai doc scheme/IP tu proxy truoc HTTPS redirect va rate limiter theo IP.
            app.UseForwardedHeaders();

            app.UseExceptionHandler(handler => handler.Run(async context =>
            {
                await Results.Problem(statusCode: 503,
                    title: "Dịch vụ tạm thời không khả dụng. Vui lòng thử lại.",
                    extensions: new Dictionary<string, object?> { ["code"] = "SERVICE_UNAVAILABLE" })
                    .ExecuteAsync(context);
            }));
            // Khong cache token hoac ho so xac thuc o trinh duyet/proxy.
            app.Use(async (context, next) =>
            {
                if (context.Request.Path.StartsWithSegments("/api/v1"))
                    context.Response.Headers.CacheControl = "no-store";
                await next();
            });

            // Thu tu middleware quyet dinh CORS, gioi han tan suat va xac thuc truoc khi vao Hub.
            if (app.Environment.IsDevelopment())
            {
                app.MapOpenApi();
            }

            // Probe noi bo van chay HTTP de systemd kiem tra truoc khi Nginx/HTTPS san sang.
            app.UseWhen(context => !context.Request.Path.StartsWithSegments("/health"),
                branch => branch.UseHttpsRedirection());

            app.UseRouting();

            app.UseCors("AllowReactApp");

            app.UseRateLimiter();
            app.UseAuthentication();
            app.UseAuthorization();

            // Cho phep probe khong can JWT; chi tra trang thai, khong tra loi SQL hay cau hinh.
            app.MapHealthChecks("/health/live", new HealthCheckOptions
            {
                Predicate = _ => false
            }).AllowAnonymous();
            app.MapHealthChecks("/health/ready", new HealthCheckOptions
            {
                Predicate = registration => registration.Tags.Contains("ready")
            }).AllowAnonymous();

            app.MapControllers();
            app.MapHub<ChatHub>("/hubs/chat", options =>
                options.CloseOnAuthenticationExpiration = true);

            app.Run();
        }
    }
}
