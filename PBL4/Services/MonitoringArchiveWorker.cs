using System.Text.Json;

namespace PBL4.Services;

// Lưu snapshot hữu hạn theo lô 30 giây, không ghi SQL cho mỗi heartbeat/chunk.
// Dữ liệu kết nối sống không được khôi phục sau restart. Telemetry lỗi không dừng chat.
public sealed class MonitoringArchiveWorker(MonitoringService monitoring, IWebHostEnvironment environment,
    ILogger<MonitoringArchiveWorker> logger) : BackgroundService
{
    private string DirectoryPath => Path.Combine(environment.ContentRootPath, "App_Data", "monitoring");
    private string ArchivePath => Path.Combine(DirectoryPath, "snapshot.json");
    public override async Task StartAsync(CancellationToken ct)
    {
        try
        {
            var file = new FileInfo(ArchivePath);
            if (file.Exists && file.Length <= 16 * 1024 * 1024)
            {
                await using var input = file.OpenRead();
                var archive = await JsonSerializer.DeserializeAsync<MonitoringService.Archive>(input, cancellationToken: ct);
                if (archive?.Samples is not null && archive.Events is not null) monitoring.Restore(archive);
            }
        }
        catch (Exception error) { logger.LogWarning(error, "Cannot restore monitoring archive; starting with available samples."); }
        await base.StartAsync(ct);
    }
    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(30));
        try { while (await timer.WaitForNextTickAsync(ct)) await Save(ct); }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
    }
    private async Task Save(CancellationToken ct)
    {
        try
        {
            Directory.CreateDirectory(DirectoryPath);
            var temp = Path.Combine(DirectoryPath, "snapshot.tmp");
            await File.WriteAllTextAsync(temp, JsonSerializer.Serialize(monitoring.Export()), ct);
            File.Move(temp, ArchivePath, overwrite: true);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
        catch (Exception error) { logger.LogWarning(error, "Cannot persist monitoring samples."); }
    }
    public override async Task StopAsync(CancellationToken ct)
    {
        await base.StopAsync(ct);
        await Save(ct);
    }
}
