[migrate] applied 001_core.sql
[migrate] applied 002_ownership_finance_alerts.sql
## Load measurement (2026-11-21T21:55:06.607Z)

Environment: 4 vCPU (Intel(R) Xeon(R) Processor @ 2.10GHz), 17 GB RAM, Node v22.23.5, PostgreSQL 16 local, single process, no network hop (domain functions called directly inside one transaction per call; HTTP overhead excluded).

Dataset: stock_items 48800 · movements 53800 · balances 48800 · cases 1600 · upcoming 600 · requirements 3000 · reservations 1740 · usage_events 5000 · hospitals 30 · locations 100. Board window held 600 cases.

| Operation | Runs | Median ms | Max ms |
|---|---|---|---|
| Readiness board, 72 h, ops manager (first load creates issues) | 1 | 13655 | 13655 |
| Readiness board, 72 h, ops manager (steady state) | 3 | 7391 | 7501 |
| Exact-item search "LD-0101" (no case) | 5 | 144 | 159 |
| Exact-item rescue ranking for a case requirement | 5 | 250 | 328 |
| Lot recall trace (LLD-0138-5) | 5 | 10 | 11 |
