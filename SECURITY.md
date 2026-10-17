# Security

## Reporting

Report vulnerabilities privately through GitHub's "Report a vulnerability" button on this repository (Security tab). I aim to reply within 72 hours. Please do not open public issues for exploitable bugs.

## Threat model

- **Assets:** room contents; availability of the sync server.
- **Actors:** any client that can open a WebSocket to the server; other websites trying to open sockets from a visitor's browser.
- **Entry points:** `/ws` (WebSocket protocol), `/api/rooms`, static file serving, `/healthz`.
- **Top risks and mitigations:**
  - Malformed or hostile messages: every message is validated against the protocol shape (room and client id patterns, op structure); invalid input closes the connection with 1007.
  - Flooding: per-connection token bucket, 1 MiB frame limit, one room per connection, `MAX_ROOMS` cap on room creation.
  - Cross-site WebSocket hijacking: `ALLOWED_ORIGINS` allow-list for the upgrade's `Origin` header. Set it in production.
  - Path traversal in static serving and snapshot files: room names are restricted by pattern before they become file names.
  - Container: unprivileged `node` user, Node 24 LTS.

## Not provided

There is no authentication or authorization. Anyone who knows a room name can read and edit it. Do not put sensitive data in rooms without adding auth in front of the server.
