
using Microsoft.EntityFrameworkCore;
using Microsoft.AspNetCore.SignalR;
using PBL4.Data;
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

            // Dang ky dependency: DbContext theo request, registry phien dung chung mot instance.
            builder.Services.AddCors(options =>
            {
                options.AddPolicy("AllowReactApp",
                    policy => policy.WithOrigins("http://localhost:5173", "http://127.0.0.1:5173")
                                    .AllowAnyMethod()
                                    .AllowAnyHeader()
                                    .AllowCredentials());
            });
            builder.Services.AddDbContext<AppDbContext>(options =>
                options.UseSqlServer(connectionString));
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

            app.UseHttpsRedirection();

            app.UseRouting();

            app.UseCors("AllowReactApp");

            app.UseRateLimiter();
            app.UseAuthentication();
            app.UseAuthorization();

            app.MapControllers();
            app.MapHub<ChatHub>("/hubs/chat", options =>
                options.CloseOnAuthenticationExpiration = true);

            app.Run();
        }
    }
}
