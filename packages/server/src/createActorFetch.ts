import { z } from "zod";

const ResponseSchema = z.object({
  snapshot: z.record(z.unknown()),
  checksum: z.string(),
});

/**
 * Creates a typed HTTP fetcher for an actor's snapshot.
 *
 * Used in SSR loaders (Next.js, TanStack Start) to fetch the initial
 * state before rendering and upgrading to WebSocket.
 */
export function createActorFetch<TView>({
  actorType,
  host,
}: {
  actorType: string;
  host: string;
}) {
  return async function fetchActor(
    props: {
      actorId: string;
      accessToken: string;
      input?: Record<string, unknown>;
    },
    options?: RequestInit
  ): Promise<{
    snapshot: TView;
    checksum: string;
  }> {
    const input = props.input ?? {};

    if (!host) throw new Error("Actor Kit host is not defined");

    const route = `/api/${actorType}/${props.actorId}`;
    const protocol = isLocal(host) ? "http" : "https";
    const url = new URL(`${protocol}://${host}${route}`);

    url.searchParams.append("input", JSON.stringify(input));

    const response = await fetch(url.toString(), {
      ...options,
      headers: {
        ...options?.headers,
        Authorization: `Bearer ${props.accessToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch actor: ${response.statusText}`);
    }

    const data = await response.json();
    const { checksum, snapshot } = ResponseSchema.parse(data);

    return {
      snapshot: snapshot as TView,
      checksum,
    };
  };
}

function isLocal(host: string): boolean {
  return (
    host.startsWith("localhost") ||
    host.startsWith("127.0.0.1") ||
    host.startsWith("0.0.0.0")
  );
}
