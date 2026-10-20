namespace PBL4.Realtime;

public sealed class HeartbeatOptions
{
    public int IntervalSeconds { get; set; } = 15;
    public int TimeoutSeconds { get; set; } = 60;
    public int CheckIntervalSeconds { get; set; } = 2;
}
