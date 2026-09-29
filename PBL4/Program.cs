
using Microsoft.EntityFrameworkCore;
using PBL4.Data;
using PBL4.Auth;

namespace PBL4
{
    public class Program
    {
        public static void Main(string[] args)
        {
            var builder = WebApplication.CreateBuilder(args);

            var connectionString = builder.Configuration.GetConnectionString("DefaultConnection")
                ?? throw new InvalidOperationException("Connection string 'DefaultConnection' was not found.");

            // Add services to the container.
            builder.Services.AddCors(options =>
            {
                options.AddPolicy("AllowReactApp",
                    policy => policy.WithOrigins("http://localhost:5173", "http://127.0.0.1:5173")
                                    .AllowAnyMethod()
                                    .AllowAnyHeader());
            });
            builder.Services.AddDbContext<AppDbContext>(options =>
                options.UseSqlServer(connectionString));
            builder.Services.AddControllers();
            builder.Services.AddPbl4Auth(builder.Configuration, builder.Environment);
            // Learn more about configuring OpenAPI at https://aka.ms/aspnet/openapi
            builder.Services.AddOpenApi();

            var app = builder.Build();

            app.UseExceptionHandler(handler => handler.Run(async context =>
            {
                await Results.Problem(statusCode: 503,
                    title: "Dịch vụ tạm thời không khả dụng. Vui lòng thử lại.",
                    extensions: new Dictionary<string, object?> { ["code"] = "SERVICE_UNAVAILABLE" })
                    .ExecuteAsync(context);
            }));
            // Không cache token hoặc hồ sơ xác thực ở trình duyệt/proxy.
            app.Use(async (context, next) =>
            {
                if (context.Request.Path.StartsWithSegments("/api/v1"))
                    context.Response.Headers.CacheControl = "no-store";
                await next();
            });

            // Configure the HTTP request pipeline.
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

            app.Run();
        }
    }
}
