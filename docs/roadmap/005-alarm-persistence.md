# 005: DO Alarm-Based Persistence Heartbeat

**Priority**: P1
**Status**: Proposal
**Affects**: `createMachineServer.ts`

## Problem

Cloudflare Durable Objects can be evicted at any time (memory pressure, inactivity). If the DO is evicted between a state transition and the next automatic persistence, state is lost.

In Piqolo, this manifests as manual heap monitoring:

```typescript
if ('memory' in performance && performance.memory) {
  if (used > 100) {
    console.warn('⚠️ High memory usage detected - risk of DO eviction');
    performBackup('high_memory');
  }
}
```

Cloudflare's `alarm()` API is designed exactly for this — a scheduled callback that ensures work completes before eviction.

## Proposed Change

Use `alarm()` as a persistence heartbeat. Every N seconds (default: 10), the alarm fires and persists the current snapshot if it has changed since last persist.

### Developer-facing config

```typescript
export const Todo = createMachineServer({
  machine: todoMachine,
  schemas: { /* ... */ },
  options: {
    persisted: true,
    alarmIntervalMs: 10_000,  // Heartbeat interval (default: 10s, 0 = disabled)
  },
});
```

No other API changes. The heartbeat is opt-in via `persisted: true` (which is already required for persistence).

## Implementation

### How DO alarms work

```typescript
class MyDurableObject {
  async alarm() {
    // Called by Cloudflare runtime at the scheduled time
    // Guaranteed to run even if no other requests are pending
    // If the DO is about to be evicted, alarm() runs first
  }
}
```

### Code changes in `createMachineServer.ts`

```typescript
// In the DurableObject class returned by createMachineServer:

private lastPersistedChecksum: string | null = null;

async alarm() {
  if (!this.actor) return;

  const snapshot = this.actor.getSnapshot();
  const checksum = this.calculateChecksum(snapshot);

  // Only persist if state changed since last persist
  if (checksum !== this.lastPersistedChecksum) {
    const serialized = this.serializeSnapshot(snapshot);
    await this.ctx.storage.put(PERSISTED_SNAPSHOT_KEY, serialized);
    this.lastPersistedChecksum = checksum;
  }

  // Schedule next alarm
  await this.ctx.storage.setAlarm(Date.now() + this.alarmIntervalMs);
}

// On actor initialization:
async initializeActor() {
  // ... existing init logic

  if (this.options.persisted && this.alarmIntervalMs > 0) {
    await this.ctx.storage.setAlarm(Date.now() + this.alarmIntervalMs);
  }
}

// On each state transition (existing persist logic):
private async persistSnapshot(snapshot: any) {
  const checksum = this.calculateChecksum(snapshot);
  if (checksum === this.lastPersistedChecksum) return;

  const serialized = this.serializeSnapshot(snapshot);
  await this.ctx.storage.put(PERSISTED_SNAPSHOT_KEY, serialized);
  this.lastPersistedChecksum = checksum;
}
```

### Key behaviors

1. **Alarm starts on first event** (actor initialization)
2. **Alarm re-schedules itself** every `alarmIntervalMs`
3. **Alarm is deduplicated** — Cloudflare only allows one alarm per DO; setting a new one overwrites the old
4. **Checksum prevents redundant writes** — if nothing changed, no storage call
5. **Works with `flush` (001)** — flush writes immediately, alarm provides safety net

## Test Plan

### Unit tests

1. **Alarm schedules on actor init**
   - Setup: Create machine server with `persisted: true`
   - Act: Initialize actor
   - Assert: `storage.setAlarm()` called with expected time

2. **Alarm persists changed state**
   - Setup: Initialize actor, send event (state changes)
   - Act: Trigger `alarm()`
   - Assert: `storage.put(PERSISTED_SNAPSHOT_KEY)` called

3. **Alarm skips persistence when state unchanged**
   - Setup: Initialize actor, persist, no new events
   - Act: Trigger `alarm()`
   - Assert: `storage.put` NOT called

4. **Alarm re-schedules itself**
   - Act: Trigger `alarm()`
   - Assert: `storage.setAlarm()` called for next interval

5. **Alarm disabled when `alarmIntervalMs: 0`**
   - Setup: Create with `alarmIntervalMs: 0`
   - Assert: `storage.setAlarm()` never called

6. **Alarm handles no-actor state**
   - Act: Trigger `alarm()` before actor is initialized
   - Assert: No error, no persistence, no re-schedule

### Mutation testing targets

- Checksum comparison (skip-if-unchanged)
- Alarm scheduling (must re-schedule)
- Alarm interval configuration
