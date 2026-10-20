using PBL4.Services;

namespace PBL4.Realtime;

public sealed class FileTransferMonitor(FileTransferService files,
    ILogger<FileTransferMonitor> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(5));
        while (!stoppingToken.IsCancellationRequested)
        {
            try { await files.SweepAsync(); }
            catch (Exception error) { logger.LogError(error, "File transfer cleanup failed."); }
            if (!await timer.WaitForNextTickAsync(stoppingToken)) break;
        }
    }
}
