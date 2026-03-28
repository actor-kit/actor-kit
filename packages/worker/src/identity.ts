// Worker-trust identity helper.
// The Worker authenticates the caller. The DO trusts the Worker.
// withCallerIdentity scrubs any inbound identity headers, then stamps verified identity.

interface CallerIdentity {
  callerId: string;
  callerType: "user" | "service";
}

const CALLER_ID_HEADER = "X-Actor-Kit-Caller-Id";
const CALLER_TYPE_HEADER = "X-Actor-Kit-Caller-Type";

/**
 * Stamps a verified caller identity onto a request.
 * Scrubs any existing X-Actor-Kit-Caller-* headers first (prevents spoofing).
 * Returns a new Request with the body stream transferred from the original.
 * The original request's body becomes unusable (standard fetch spec behavior).
 * Designed for the Worker→DO forwarding pattern where the original is not reused.
 */
export function withCallerIdentity(request: Request, identity: CallerIdentity): Request {
  // Clone via Request copy constructor — handles body/duplex internally
  const clone = new Request(request);

  // Scrub — remove any inbound identity headers (case-insensitive by Headers spec)
  clone.headers.delete(CALLER_ID_HEADER);
  clone.headers.delete(CALLER_TYPE_HEADER);

  // Stamp verified identity
  clone.headers.set(CALLER_ID_HEADER, identity.callerId);
  clone.headers.set(CALLER_TYPE_HEADER, identity.callerType);

  return clone;
}
