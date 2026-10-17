# 0003. The sync server keeps a full replica
Status: accepted
Date: 2026-10-17

## Context
Clients connect through a WebSocket server. A late joiner needs the document even when nobody else is online, and rooms should survive restarts.

## Options
1. Pure relay. The server forwards messages and stores nothing. Simplest. A client joining an empty room sees nothing until a peer with the history connects.
2. Server keeps a replica per room, merges every operation (never transforms), answers delta-sync requests, and snapshots rooms to disk.

## Decision
Option 2. Catch-up without a peer online is a basic expectation for a collaborative editor.

## Consequences
- Server memory grows with the number and size of rooms, hence the `MAX_ROOMS` cap and per-connection rate limits.
- The server uses the same CRDT code as clients, so there is one implementation to test.
- Snapshots are atomic JSON files per room. Horizontal scaling would need shared storage or room-affinity routing; not implemented.
