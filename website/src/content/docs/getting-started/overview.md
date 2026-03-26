---
title: Overview
description: When to use Actor Kit and how it compares to alternatives.
---

## When to use Actor Kit

Actor Kit is for applications where **multiple users interact with shared, real-time state**. Each piece of shared state is an actor — a Durable Object that processes messages one at a time and pushes updates to connected clients.

Good fits:
- Collaborative apps (shared documents, whiteboards, project boards)
- Multiplayer games (zones, lobbies, match state)
- Real-time dashboards (live metrics, monitoring)
- Chat and messaging (rooms, threads, presence)
- Auction/bidding systems (competitive real-time updates)

Not a good fit:
- Static sites or CRUD apps without real-time requirements
- Batch processing or data pipelines
- Applications that don't need WebSocket connections

## Key terms

- **Actor** — a Durable Object instance with state, roles, messages, and views
- **Message** — a named action defined on the actor (server-side). Example: `INCREMENT`, `ADD_TODO`
- **Event** — the object sent from the client to trigger a message. Example: `{ type: "INCREMENT", amount: 5 }`
- **View** — a role-scoped projection of the actor's state, sent to connected clients
- **Role** — a predicate that determines what a caller can see and do
- **Lifecycle** — `connect` and `disconnect` handlers that fire on WebSocket open/close
- **Callback** — a typed handler for async request results (`onDone`/`onError`)

## How it works

```
Browser → WebSocket → CF Worker → Durable Object (Actor)
                                    ├── State (SQLite)
                                    ├── Roles (who can do what)
                                    ├── Messages (what changes state)
                                    └── Views (what each role sees)
```

1. A Worker routes the WebSocket connection to the right Durable Object
2. The DO validates the JWT and resolves the caller's role
3. Messages from the client are validated (Zod) and routed to the role's handler
4. State changes are persisted to SQLite and broadcast as view updates
5. Each connected client gets a role-specific projection of the state

## How it compares

| | Actor Kit | PartyKit | Liveblocks | Socket.IO |
|---|---|---|---|---|
| Runtime | CF Durable Objects | CF Durable Objects | Managed cloud | Self-hosted |
| State model | Actor per entity | Room per party | Document per room | No built-in state |
| Authorization | Role-based, derived from state | Custom middleware | Custom middleware | Custom middleware |
| Sync protocol | Binary delta or JSON | JSON | CRDT | JSON |
| Persistence | Automatic (DO SQLite) | Manual | Managed | Manual |
| TypeScript | Full inference from definition | Partial | SDK types | Partial |

## Architecture

Actor Kit embraces Cloudflare's infrastructure:

| CF Feature | How Actor Kit uses it |
|------------|----------------------|
| Durable Objects | Each actor is a DO — single-threaded, globally addressable |
| DO SQLite | State persistence, transactional outbox |
| DO Alarms | Durable timers (`after`) that survive hibernation |
| DO WebSocket Hibernation | Caller metadata stored as tags, survives restarts |
| Workers | Route requests, serve UI, issue JWT tokens |

## Next steps

- [Installation](/getting-started/installation/) — set up your project
- [Quick Start](/getting-started/quick-start/) — build a counter in 5 minutes
- [Counter Guide](/examples/counter/) — full walkthrough with UI
