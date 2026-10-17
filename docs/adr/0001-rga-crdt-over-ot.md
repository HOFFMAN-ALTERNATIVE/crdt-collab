# 0001. RGA CRDT instead of operational transformation
Status: accepted
Date: 2026-10-17

## Context
Concurrent text edits must merge so that every replica ends with the same document. The project needs offline editing, multi-tab sync without a server, and a relay server that does not have to understand edits.

## Options
1. Operational transformation. Compact operations, mature in Google Docs-style systems. Needs a central server to order and transform operations; offline merges and peer-to-peer sync are hard to get right.
2. A sequence CRDT (RGA). Any replica can merge any set of operations in any order. Every character carries an id, and deleted characters stay as tombstones.
3. Use Yjs or Automerge. Fast and battle-tested. Defeats the purpose of a from-scratch implementation that shows the algorithm.

## Decision
Option 2. Merge-anywhere semantics are what make offline editing, the multi-tab mesh and a simple relay server possible.

## Consequences
- Metadata per character and tombstones (see ADR 0002).
- Convergence, commutativity, idempotence and model equivalence are property-tested with fast-check.
- A flat array keeps integration O(n) per character. Moving to run-length items in a tree is a contained change behind the `Rga` API when documents get large.
