import { StateValueFrom } from "./stateMachine";
import { z } from "zod";
import { AnyActorKitStateMachine, CallerSnapshotFrom, ClientEventFrom } from "./types";

const ResponseSchema = z.object({
  snapshot: z.record(z.any()),
  checksum: z.string(),
});

export function createActorFetch<TMachine extends AnyActorKitStateMachine>({
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
      waitForEvent?: ClientEventFrom<TMachine>;
      waitForState?: StateValueFrom<TMachine>;
      timeout?: number;
      errorOnWaitTimeout?: boolean;
    },
    options?: RequestInit
  ): Promise<{
    snapshot: CallerSnapshotFrom<TMachine>;
    checksum: string;
  }> {
    const input = props.input ?? {};

    if (!host) throw new Error("Actor Kit host is not defined");

    const route = getActorRoute(actorType, props.actorId);
    const protocol = getHttpProtocol(host);
    const url = new URL(`${protocol}://${host}${route}`);

    // Add input to URL parameters
    url.searchParams.append("input", JSON.stringify(input));

    // Add waitForEvent or waitForState to URL parameters
    if (props.waitForEvent) {
      url.searchParams.append(
        "waitForEvent",
        JSON.stringify(props.waitForEvent)
      );
    }
    if (props.waitForState) {
      url.searchParams.append(
        "waitForState",
        JSON.stringify(props.waitForState)
      );
    }

    // Add timeout to URL parameters if specified
    if (props.timeout) {
      url.searchParams.append("timeout", props.timeout.toString());
    }

    // Add errorOnWaitTimeout to URL parameters if specified
    if (props.errorOnWaitTimeout !== undefined) {
      url.searchParams.append(
        "errorOnWaitTimeout",
        props.errorOnWaitTimeout.toString()
      );
    }

    const response = await fetch(url.toString(), {
      ...options,
      headers: {
        ...options?.headers,
        Authorization: `Bearer ${props.accessToken}`,
      },
    });

    if (!response.ok) {
      if (response.status === 408 && props.errorOnWaitTimeout !== false) {
        throw new Error(
          `Timeout waiting for actor response: ${response.statusText}`
        );
      }
      throw new Error(`Failed to fetch actor: ${response.statusText}`);
    }

    const data = await response.json();
    const { checksum, snapshot } = ResponseSchema.parse(data);

    return {
      snapshot: snapshot as CallerSnapshotFrom<TMachine>,
      checksum,
    };
  };
}

function getActorRoute(actorType: string, actorId: string) {
  return `/api/${actorType}/${actorId}`;
}

function getHttpProtocol(host: string): "http" | "https" {
  return isLocal(host) ? "http" : "https";
}

function isLocal(host: string): boolean {
  return (
    host.startsWith("localhost") ||
    host.startsWith("127.0.0.1") ||
    host.startsWith("0.0.0.0")
  );
}
