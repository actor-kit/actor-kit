/**
 * xxh64 — synchronous xxHash64 (seed 0) of a string's UTF-8 bytes, as 16 hex chars.
 *
 * Pure TypeScript so it runs the same in Workers, Node and the browser
 * (Workers' crypto.subtle is async). Used for state and view checksums.
 */

const P1 = 0x9e3779b185ebca87n;
const P2 = 0xc2b2ae3d27d4eb4fn;
const P3 = 0x165667b19e3779f9n;
const P4 = 0x85ebca77c2b2ae63n;
const P5 = 0x27d4eb2f165667c5n;

const u64 = (x: bigint): bigint => BigInt.asUintN(64, x);
const rotl = (x: bigint, r: bigint): bigint => u64((x << r) | (x >> (64n - r)));

function round(acc: bigint, lane: bigint): bigint {
  return u64(rotl(u64(acc + u64(lane * P2)), 31n) * P1);
}

function mergeRound(acc: bigint, val: bigint): bigint {
  return u64(u64((acc ^ round(0n, val)) * P1) + P4);
}

const encoder = new TextEncoder();

export function xxh64(input: string): string {
  const bytes = encoder.encode(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const len = bytes.byteLength;
  let offset = 0;
  let h: bigint;

  if (len >= 32) {
    let v1 = u64(P1 + P2);
    let v2 = P2;
    let v3 = 0n;
    let v4 = u64(-P1);
    for (; offset + 32 <= len; offset += 32) {
      v1 = round(v1, view.getBigUint64(offset, true));
      v2 = round(v2, view.getBigUint64(offset + 8, true));
      v3 = round(v3, view.getBigUint64(offset + 16, true));
      v4 = round(v4, view.getBigUint64(offset + 24, true));
    }
    h = u64(rotl(v1, 1n) + rotl(v2, 7n) + rotl(v3, 12n) + rotl(v4, 18n));
    h = mergeRound(h, v1);
    h = mergeRound(h, v2);
    h = mergeRound(h, v3);
    h = mergeRound(h, v4);
  } else {
    h = P5;
  }

  h = u64(h + BigInt(len));

  for (; offset + 8 <= len; offset += 8) {
    h ^= round(0n, view.getBigUint64(offset, true));
    h = u64(u64(rotl(h, 27n) * P1) + P4);
  }
  if (offset + 4 <= len) {
    h ^= u64(BigInt(view.getUint32(offset, true)) * P1);
    h = u64(u64(rotl(h, 23n) * P2) + P3);
    offset += 4;
  }
  for (; offset < len; offset++) {
    h ^= u64(BigInt(view.getUint8(offset)) * P5);
    h = u64(rotl(h, 11n) * P1);
  }

  h ^= h >> 33n;
  h = u64(h * P2);
  h ^= h >> 29n;
  h = u64(h * P3);
  h ^= h >> 32n;

  return h.toString(16).padStart(16, "0");
}
