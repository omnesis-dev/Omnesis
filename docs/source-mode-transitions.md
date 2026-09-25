# Source mode transitions

An explicit `exclusive` to `partitioned` transition is a cross-store migration,
not a descriptor toggle. SQLite journals the requested mode while the source is
still exclusive, all source lifecycle and ingest paths are fenced, and the
coordinator adopts DuckDB followed by bounded SQLite batches. The final SQLite
transaction moves the cursor and publishes the new mode. A boot-time resume
replays every incomplete step; each step is idempotent.

## DuckDB stream-key rebuild

DuckDB cannot add `_stream_id` to an existing primary key in place. The first
device stream therefore requires an atomic replacement table: create the new
schema, copy the old table, replace it, and mark the catalog stream-keyed in one
transaction. Checkpointing the copy would expose either two writable tables or
a partially copied replacement after a crash, so the online path deliberately
keeps the table replacement atomic.

The coordinator commits one catalog table at a time and yields between tables.
Within a table, `gateway.analyticsStreamRekeyMaxRows` is the admission boundary.
The default is 100,000 rows: a local benchmark of the exact two-column
create/copy/drop/rename transaction took about 100 ms at 100,000 rows, 374 ms at
500,000, and 713 ms at 1,000,000. Wider rows and slower storage cost more. A
metadata-backed exact `COUNT(*)` took 3.6 ms at 1,000,000 rows. A table above
the configured ceiling fails before the replacement table is created and leaves
the durable source transition pending and exclusive.

Raising the ceiling and restarting the gateway is an explicit
maintenance-window decision. A future offline migration may remove the ceiling
by quiescing analytics globally and performing the same atomic replacement
without competing with interactive writes; it must not turn the online writer
operation into an unbounded default.
