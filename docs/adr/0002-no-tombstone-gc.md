# 0002. No tombstone garbage collection
Status: accepted
Date: 2026-10-17

## Context
Deleted characters remain as tombstones because later inserts and remote carets may reference them. Removing a tombstone is safe only when every replica has seen the delete (causal stability).

## Options
1. Collect tombstones once all known replicas acknowledge the delete. Bounded growth. Requires membership tracking; a replica that went offline and returns later can reference a collected id and break convergence.
2. Never collect. Always correct with any number of offline peers. Documents grow with edit history.
3. Periodic snapshot compaction when the deployment can bound its replica set. Correct under that assumption only.

## Decision
Option 2 for now. With offline-first clients the replica set is unknowable, and correctness matters more than size for documents of this scale.

## Consequences
- Memory and snapshot size grow with total edits, not visible length.
- Option 3 is the path for deployments that can enforce "all clients sync within N days".
- Revisit when a real workload shows document size as a problem.
