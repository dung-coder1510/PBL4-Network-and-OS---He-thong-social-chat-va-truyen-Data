using PBL4.Services;

namespace PBL4.Realtime;

public sealed class TextPeerMonitor(TextPeerSessionService sessions, ILogger<TextPeerMonitor> logger)
    : BackgroundService
{
    // Quet phien moi 5 giay den khi ung dung dung; loi mot dot khong lam worker ngung chay.
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(5));
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            try { await sessions.SweepAsync(); }
            catch (Exception error) { logger.LogError(error, "Text peer cleanup failed."); }
        }
    }
}
