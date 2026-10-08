---
title: Studio
description: Introspect and debug your actors in real-time with Actor Kit Studio.
---

Actor Kit Studio is a built-in debugging tool for actor-kit. Connect to any running actor and see its state, timeline, connections, outbox, and views — all updating in real-time.

## What you can see

- **Current state** — live-updating JSON view of the actor's state
- **Timeline** — chronological log of every state mutation with its cause (message, service completion, link update, lifecycle event)
- **Connections** — active WebSocket clients with caller identity and role
- **Outbox** — service executions by effect id, with status (pending, running, retrying, done, failed), tries, next try and last error. Admins can redrive a failed row.
- **Links** — actor-to-actor subscriptions (who this actor links to and who subscribes to it)
- **Views** — computed view projections per role

## How it works

Every actor automatically records a timeline of state mutations to its SQLite storage. The timeline captures:

| Cause | When |
|-------|------|
| `init` | Actor initialized for the first time |
| `message` | Client sent a message (includes payload, caller, role) |
| `lifecycle.connect` | Client WebSocket connected |
| `lifecycle.disconnect` | Client WebSocket disconnected |
| `service.onDone` | Service completed successfully |
| `service.onError` | Service failed |
| `link.onUpdate` | Linked actor pushed new state |
| `link.onError` | Link subscription failed |
| `link.onUnlink` | Link was removed |

Each entry stores the full state snapshot after the mutation, so you can scrub through the timeline and see the exact state at any point.

## Architecture

```
Studio UI  <-->  actorKitStudio() middleware  <-->  Actor DOs
                        |                              |
                        v                              v
                 StudioRegistry DO              Timeline table
                 (actor index)                  (per-actor SQLite)
```

- **StudioRegistry** — a Durable Object that tracks all known actor instances. Actors register themselves automatically.
- **Timeline table** — each actor stores its mutation history in a ring buffer (default 500 entries) in its own SQLite.
- **Studio WebSocket** — the studio connects to actors with a special `__studio` identity that bypasses role evaluation and receives live updates.

## Quick start

See the [setup guide](/studio/setup/) for installation and configuration.
