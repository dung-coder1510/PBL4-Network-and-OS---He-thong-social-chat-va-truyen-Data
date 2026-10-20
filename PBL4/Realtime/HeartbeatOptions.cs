<<<<<<< HEAD
﻿namespace PBL4.Realtime;
=======
namespace PBL4.Realtime;
>>>>>>> d12091cdb02256a7635b50e50fc08efa47312319

public sealed class HeartbeatOptions
{
    public int IntervalSeconds { get; set; } = 15;
    public int TimeoutSeconds { get; set; } = 60;
    public int CheckIntervalSeconds { get; set; } = 2;
}
