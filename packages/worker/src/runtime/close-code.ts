/**
 * The close code a server may send back when answering a client's close (RFC 6455 §7.4).
 * 1005/1006 are reserved (never sent) and anything outside 1000-1014 / 3000-4999 cannot be sent,
 * so those are answered with 1000.
 */
export function closeCodeToSend(code: number | undefined): number {
  return code !== undefined && isSendable(code) ? code : 1000;
}

function isSendable(code: number): boolean {
  if (code === 1000) return true;
  if (code >= 3000 && code <= 4999) return true;
  return code >= 1001 && code <= 1014 && !isReserved(code);
}

const isReserved = (code: number): boolean => code === 1005 || code === 1006;
