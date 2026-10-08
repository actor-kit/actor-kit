/**
 * routeToActor — HTTP routing helper for forwarding requests to the correct DO.
 *
 * Parses /api/:actorType/:actorId from the URL path.
 * Handles WebSocket upgrade, GET (snapshot), POST (send message).
 */

export interface ActorRoute {
  actorType: string;
  actorId: string;
}

export function parseActorRoute(pathname: string): ActorRoute | null {
  const parts = pathname.split("/").filter(Boolean);
  // Expect: ["api", actorType, actorId, ...]
  if (parts[0] !== "api") {
    return null;
  }

  const actorType = parts[1];
  const actorId = parts[2];

  if (actorType === undefined || actorId === undefined) {
    return null;
  }

  return {
    actorType,
    actorId: decodeURIComponent(actorId),
  };
}
