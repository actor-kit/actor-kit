/**
 * xxh64 — synchronous xxHash64 (seed 0) of a string's UTF-8 bytes, as 16 hex chars.
 *
 * Pure TypeScript so it runs the same in Workers, Node and the browser
 * (Workers' crypto.subtle is async). Used for state and view checksums, so on every transition.
 *
 * 64-bit words are two uint32 halves (hi, lo), multiplied with Math.imul (and 16-bit limbs for the high
 * word of lo × lo): far faster than BigInt arithmetic, with the same output (the reference values and
 * a property test against the BigInt version pin it).
 */

// The primes, as [hi, lo].
const P1H = 0x9e3779b1;
const P1L = 0x85ebca87;
const P2H = 0xc2b2ae3d;
const P2L = 0x27d4eb4f;
const P3H = 0x165667b1;
const P3L = 0x9e3779f9;
const P4H = 0x85ebca77;
const P4L = 0xc2b2ae63;
const P5H = 0x27d4eb2f;
const P5L = 0x165667c5;

/** A 64-bit word as two uint32 halves. Each helper writes its result here (no allocation per call). */
let rh = 0;
let rl = 0;

const TWO32 = 0x1_0000_0000;

function add(ah: number, al: number, bh: number, bl: number): void {
  const lo = al + bl;
  rl = lo >>> 0;
  // The carry, exactly 0 or 1: what the low half lost when it wrapped.
  rh = (ah + bh + (lo - rl) / TWO32) >>> 0;
}

/** The high 32 bits of the 64-bit product of two uint32s (16-bit limbs keep every step below 2^32). */
function mulHi(a: number, b: number): number {
  const a0 = a & 0xffff;
  const a1 = a >>> 16;
  const b0 = b & 0xffff;
  const b1 = b >>> 16;
  const m1 = a1 * b0;
  const m2 = a0 * b1;
  const w = ((a0 * b0) >>> 16) + (m1 & 0xffff) + (m2 & 0xffff);
  return (a1 * b1 + (m1 >>> 16) + (m2 >>> 16) + (w >>> 16)) >>> 0;
}

/** The low 64 bits of a × b: lo·lo in full, plus the cross terms' low halves in the high word. */
function mul(ah: number, al: number, bh: number, bl: number): void {
  rl = Math.imul(al, bl) >>> 0;
  rh = (mulHi(al, bl) + Math.imul(ah, bl) + Math.imul(al, bh)) >>> 0;
}

/** Rotate left by r (0 < r < 32: every rotation xxh64 uses). */
function rotl(h: number, l: number, r: number): void {
  rh = ((h << r) | (l >>> (32 - r))) >>> 0;
  rl = ((l << r) | (h >>> (32 - r))) >>> 0;
}

/** round(acc, lane) = rotl(acc + lane × P2, 31) × P1. */
function round(acch: number, accl: number, laneh: number, lanel: number): void {
  mul(laneh, lanel, P2H, P2L);
  add(acch, accl, rh, rl);
  rotl(rh, rl, 31);
  mul(rh, rl, P1H, P1L);
}

/** mergeRound(acc, val) = (acc ^ round(0, val)) × P1 + P4. */
function mergeRound(acch: number, accl: number, valh: number, vall: number): void {
  round(0, 0, valh, vall);
  mul((acch ^ rh) >>> 0, (accl ^ rl) >>> 0, P1H, P1L);
  add(rh, rl, P4H, P4L);
}

const encoder = new TextEncoder();
const hex8 = (n: number): string => n.toString(16).padStart(8, "0");

export function xxh64(input: string): string {
  const bytes = encoder.encode(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const len = bytes.byteLength;
  let offset = 0;
  let hh: number;
  let hl: number;

  if (len >= 32) {
    add(P1H, P1L, P2H, P2L);
    let v1h = rh;
    let v1l = rl;
    let v2h = P2H;
    let v2l = P2L;
    let v3h = 0;
    let v3l = 0;
    // -P1 mod 2^64: the two's complement.
    add(~P1H >>> 0, ~P1L >>> 0, 0, 1);
    let v4h = rh;
    let v4l = rl;
    for (; offset + 32 <= len; offset += 32) {
      round(v1h, v1l, view.getUint32(offset + 4, true), view.getUint32(offset, true));
      v1h = rh;
      v1l = rl;
      round(v2h, v2l, view.getUint32(offset + 12, true), view.getUint32(offset + 8, true));
      v2h = rh;
      v2l = rl;
      round(v3h, v3l, view.getUint32(offset + 20, true), view.getUint32(offset + 16, true));
      v3h = rh;
      v3l = rl;
      round(v4h, v4l, view.getUint32(offset + 28, true), view.getUint32(offset + 24, true));
      v4h = rh;
      v4l = rl;
    }
    rotl(v1h, v1l, 1);
    let sh = rh;
    let sl = rl;
    rotl(v2h, v2l, 7);
    add(sh, sl, rh, rl);
    sh = rh;
    sl = rl;
    rotl(v3h, v3l, 12);
    add(sh, sl, rh, rl);
    sh = rh;
    sl = rl;
    rotl(v4h, v4l, 18);
    add(sh, sl, rh, rl);
    mergeRound(rh, rl, v1h, v1l);
    mergeRound(rh, rl, v2h, v2l);
    mergeRound(rh, rl, v3h, v3l);
    mergeRound(rh, rl, v4h, v4l);
    hh = rh;
    hl = rl;
  } else {
    hh = P5H;
    hl = P5L;
  }

  // The length as a 64-bit word: its high half is 0 (no string reaches 2^32 UTF-8 bytes).
  add(hh, hl, 0, len);
  hh = rh;
  hl = rl;

  for (; offset + 8 <= len; offset += 8) {
    round(0, 0, view.getUint32(offset + 4, true), view.getUint32(offset, true));
    rotl((hh ^ rh) >>> 0, (hl ^ rl) >>> 0, 27);
    mul(rh, rl, P1H, P1L);
    add(rh, rl, P4H, P4L);
    hh = rh;
    hl = rl;
  }
  if (offset + 4 <= len) {
    mul(0, view.getUint32(offset, true), P1H, P1L);
    rotl((hh ^ rh) >>> 0, (hl ^ rl) >>> 0, 23);
    mul(rh, rl, P2H, P2L);
    add(rh, rl, P3H, P3L);
    hh = rh;
    hl = rl;
    offset += 4;
  }
  for (; offset < len; offset++) {
    mul(0, view.getUint8(offset), P5H, P5L);
    rotl((hh ^ rh) >>> 0, (hl ^ rl) >>> 0, 11);
    mul(rh, rl, P1H, P1L);
    hh = rh;
    hl = rl;
  }

  // Avalanche: h ^= h >> 33; h *= P2; h ^= h >> 29; h *= P3; h ^= h >> 32.
  hl = (hl ^ (hh >>> 1)) >>> 0;
  mul(hh, hl, P2H, P2L);
  hh = rh;
  hl = (rl ^ ((rl >>> 29) | (rh << 3))) >>> 0;
  hh = (hh ^ (hh >>> 29)) >>> 0;
  mul(hh, hl, P3H, P3L);
  hh = rh;
  hl = (rl ^ rh) >>> 0;

  return hex8(hh) + hex8(hl);
}
