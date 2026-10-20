<<<<<<< HEAD
﻿using Microsoft.Extensions.Options;
=======
using Microsoft.Extensions.Options;
>>>>>>> d12091cdb02256a7635b50e50fc08efa47312319

namespace PBL4.Realtime;

public sealed class HeartbeatMonitor(PresenceService presence, IOptions<HeartbeatOptions> options,
    ILogger<HeartbeatMonitor> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(options.Value.CheckIntervalSeconds));
        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken))
            {
                try { await presence.CheckTimeoutsAsync(stoppingToken); }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
                catch (Exception exception)
                {
                    logger.LogError(exception, "Could not publish heartbeat presence changes.");
                }
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
    }
}
