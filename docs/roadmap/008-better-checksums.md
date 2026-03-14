# 008: Collision-Resistant Checksums

**Priority**: P2
**Status**: Proposal
**Affects**: `createMachineServer.ts` (hashString function)

## Problem

The current checksum uses a simple 32-bit string hash:

```typescript
// Current implementation in createMachineServer.ts
function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0; // Convert to 32bit integer
  }
  return hash.toString(16);
}
```

32-bit hash space = ~4 billion values. By the birthday paradox, collision probability exceeds 50% after ~77,000 unique states. In a collaborative app with frequent state changes, this is reachable.

A collision means the server thinks the client already has the latest state and skips sending the patch. The client silently desyncs.

## Proposed Change

Replace with SHA-256 using the Web Crypto API (available in Cloudflare Workers):

```typescript
async function hashSnapshot(snapshot: unknown): Promise<string> {
  const str = JSON.stringify(snapshot);
  const buffer = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  const array = new Uint8Array(hash);
  return Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");
}
```

### Performance consideration

SHA-256 is ~10x slower than the current hash, but the input (JSON-stringified snapshot) is typically <10KB. The cost is negligible compared to WebSocket I/O and DO storage writes.

If performance is a concern, use a fast non-cryptographic hash with a larger output space:

```typescript
// FNV-1a 64-bit (via BigInt) — fast, low collision
function fnv1a64(str: string): string {
  let hash = 14695981039346656037n;
  for (let i = 0; i < str.length; i++) {
    hash ^= BigInt(str.charCodeAt(i));
    hash = (hash * 1099511628211n) & 0xffffffffffffffffn;
  }
  return hash.toString(16);
}
```

64-bit reduces collision probability to ~50% after ~5 billion unique states.

### Recommendation

Use SHA-256. It's available natively, collision-resistant, and the performance cost is negligible for this use case.

## Breaking change consideration

The checksum format changes from short hex (e.g., `"a3f2b1"`) to 64-char hex. This affects:

1. **Client reconnection**: Old clients with old-format checksums won't match. The server already handles this — mismatched checksum triggers a full state send.
2. **Persisted snapshots**: Checksums stored in snapshot cache use the old format. Clear cache on upgrade (it's ephemeral anyway).

No migration needed. The worst case is one extra full-state send per client on upgrade.

## Test Plan

1. **New checksum is SHA-256 hex string**
   - Assert: Checksum is 64 characters, all hex

2. **Same state produces same checksum**
   - Act: Hash same snapshot twice
   - Assert: Identical checksums

3. **Different states produce different checksums**
   - Act: Hash two different snapshots
   - Assert: Different checksums

4. **Client with old checksum gets full state**
   - Setup: Client connects with short-format checksum
   - Assert: Server sends full snapshot (not patch)

5. **Performance**: Checksum computation under 1ms for 10KB snapshot
