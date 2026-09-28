# @earendil-works/pi-durable

Durable conversation, task, and document runtime for Pi.

This package contains the Pico runtime. Its current public API provides the durable record contracts and detached in-memory storage implementation:

```ts
import { MemoryStorage, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
```

The root export is runtime-neutral. Storage implementations also have explicit subpaths:

```ts
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
```

Node applications can open file-backed SQLite through its Node-only subpath:

```ts
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const storage = await openNodeSqliteStorage("./session.sqlite");
```

The portable SQLite core, minimal database facade, and ordered schema migrations are exported from `@earendil-works/pi-durable/storage/sqlite`. Adapters for synchronous SQLite environments such as Bun and Cloudflare Durable Objects can implement that facade without importing Node APIs. Remote asynchronous APIs such as Cloudflare D1 cannot implement this synchronous facade; they require a dedicated `Storage` backend.

The Node adapter uses WAL mode with `synchronous = NORMAL` and checkpoints the WAL on close. Acknowledged commits survive process crashes, but the newest commits may be lost after a power or host failure. One `SqliteStorage` owner must serialize writes to a database file; cross-process ID allocation is not supported.

## Storage benchmarks

From this package directory:

```sh
npm run bench:storage
npm run bench:storage:memory
```

The timing suite compares memory and file-backed SQLite across representative commits, indexed reads, pagination, fork traversal, document replay, historical reads, and SQLite reopen. The memory suite measures each backend in a separate process at 1k and 10k scales and reports heap, RSS, external memory, and SQLite file/page metrics. These deterministic synthetic workloads are baselines for regression analysis, not production capacity limits or CI pass/fail thresholds.

The normative design and implementation sequence are in:

- [`docs/pico-v5.md`](docs/pico-v5.md)
- [`docs/pico-v5-handoff.md`](docs/pico-v5-handoff.md)
- [`docs/pico-v5-chord-usage.md`](docs/pico-v5-chord-usage.md)
