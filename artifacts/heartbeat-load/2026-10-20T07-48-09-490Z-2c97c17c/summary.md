# Heartbeat load test

Run: 2026-10-20T07-48-09-490Z-2c97c17c. Completed: true.

| Phase | Connections | ACKs | ACK p95 ms | Backend CPU mean % machine | Peak working set MiB | Peak private MiB | Errors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| steady-100 | 100 | 500 | 7.69 | 2.057 | 192 | 95.44 | 0 |
| steady-500 | 500 | 2504 | 10.317 | 1.115 | 227.32 | 130.48 | 0 |
| steady-1000 | 1000 | 6011 | 19.493 | 1.345 | 270.64 | 177.04 | 0 |
| burst-1000 | 1000 | 1000 | 1188.426 | 10.056 | 276.69 | 182.25 | 0 |

All clients, backend and SQL Server ran on this machine. Each connection used a different account.
Accounts were seeded outside measured phases; login used separate loopback source IPs to represent separate clients without changing the production rate limiter.
Steady phases used 15-second heartbeats. Ten clients at 1000 connections stopped heartbeat while keeping their sockets alive.
CPU is normalized across all logical processors. Working set/private memory are process metrics, not managed live-heap measurements.
This measures heartbeat/presence, not chat throughput, file transfer, WAN latency, authentication capacity or maximum system capacity.
Memory remaining after cooldown can be allocator/GC high-water retention; a short run cannot establish or exclude a memory leak.

Errors: []

Detailed metrics: results.json. One-second samples: resources.jsonl.

## Measurement limits

- SQL Server CPU time was unavailable under the current Windows identity. The original raw sampler coerced missing SQL CPU time to zero. Ignore SQL CPU zeros in resources.jsonl; derived SQL CPU statistics are null. The sampler has been corrected for future runs.
- This run used unencrypted HTTP/WebSockets on localhost with negotiation skipped; TLS overhead and WAN latency are not measured.
- Short runs and retained unexpired sessions do not establish absence of a memory leak.

Final cooldown backend working set: 300 MiB; private memory: 207.08 MiB.
