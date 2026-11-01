using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using PBL4.Controllers;
using PBL4.Services;

static void Check(bool condition, string message)
{
    if (!condition) throw new Exception(message);
    Console.WriteLine("PASS " + message);
}
static JsonElement Snapshot(MonitoringService service) => JsonSerializer.SerializeToElement(service.Snapshot());

var monitoring = new MonitoringService();
monitoring.Record("HTTP", "GET test/{id}", 10, "ok", 0, 100);
monitoring.Record("HTTP", "GET test/{id}", 90, "error", 5, 200);
monitoring.Record("HTTP", "GET test/{id}", 20, "cancelled", 0, 0);
monitoring.Record("SignalR", "Heartbeat", 5, "rejected");
var operation = Snapshot(monitoring).GetProperty("operations")[0];
Check(operation.GetProperty("count").GetInt32() == 3, "HTTP and Hub are grouped separately");
Check(operation.GetProperty("p95Ms").GetDouble() == 90, "p95 uses actual duration samples");
Check(operation.GetProperty("errors").GetInt32() == 1 && operation.GetProperty("cancelled").GetInt32() == 1, "cancellation is not a server error");
Check(operation.GetProperty("outBytes").GetInt64() == 300, "payload totals are preserved");
Check(Snapshot(monitoring).GetProperty("operations")[1].GetProperty("outBytes").ValueKind == JsonValueKind.Null, "missing byte measurement is not zero");
Parallel.For(0, 25000, i => monitoring.Record("HTTP", "GET test/{id}", i, "ok"));
Check(Snapshot(monitoring).GetProperty("operations").EnumerateArray().Sum(x => x.GetProperty("count").GetInt32()) == 20000, "concurrent recording has bounded storage");
for (var i = 0; i < 6000; i++) monitoring.File("1", "client-B", "transferring", i);
Check(Snapshot(monitoring).GetProperty("fileEvents").GetArrayLength() == 5000, "file events are bounded");
var bytes = Enumerable.Range(0, 65536).Select(i => (byte)i).ToArray();
using var original = new MemoryStream();
var counted = new MeasuredStream(original);
await counted.WriteAsync(bytes.AsMemory());
counted.Write(bytes, 0, bytes.Length);
Check(counted.Bytes == 2 * bytes.Length, "sync and async writes count bytes");
original.Position = 0;
var reader = new MeasuredStream(original);
using var copied = new MemoryStream();
await reader.CopyToAsync(copied);
Check(reader.Bytes == 2 * bytes.Length && copied.ToArray().SequenceEqual(original.ToArray()), "stream measurement preserves data");
reader.Dispose();
Check(original.CanRead, "measurement does not dispose underlying stream");
var auth = typeof(MonitoringController).GetCustomAttributes(typeof(AuthorizeAttribute), true).Cast<AuthorizeAttribute>().Single();
Check(auth.Policy == "Admin", "monitoring endpoint declares server-side Admin policy");
var restored = new MonitoringService();
restored.Restore(monitoring.Export());
Check(Snapshot(restored).GetProperty("fileEvents").GetArrayLength() == 5000, "bounded archive restores file evidence");
Check(Snapshot(restored).GetProperty("connections").GetArrayLength() == 0, "archive never restores live connections");
Check(Snapshot(restored).GetProperty("activeHttp").GetInt64() == 0, "request counters initially zero");
restored.EnterHttp();
Check(Snapshot(restored).GetProperty("activeHttp").GetInt64() == 1, "in-flight request counted");
restored.LeaveHttp();
