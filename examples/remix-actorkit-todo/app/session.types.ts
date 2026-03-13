import type {
  ActorKitSystemEvent,
  BaseActorKitEvent,
  ActorKitEnv,
  WithActorKitEvent,
  WithActorKitInput,
} from "actor-kit";
import { z } from "zod";
import {
  SessionClientEventSchema,
  SessionInputPropsSchema,
  SessionServiceEventSchema,
} from "./session.schemas";

declare global {
  interface Env extends ActorKitEnv {
    REMIX: DurableObjectNamespace;
    TODO: DurableObjectNamespace;
    SESSION: DurableObjectNamespace;
  }
}

export type SessionClientEvent = z.infer<typeof SessionClientEventSchema>;
export type SessionServiceEvent = z.infer<typeof SessionServiceEventSchema>;
export type SessionInputProps = z.infer<typeof SessionInputPropsSchema>;
export type SessionInput = WithActorKitInput<SessionInputProps, Env>;

export type SessionEvent = (
  | WithActorKitEvent<SessionClientEvent, "client">
  | WithActorKitEvent<SessionServiceEvent, "service">
  | ActorKitSystemEvent
) &
  BaseActorKitEvent<Env>;

export type SessionPublicContext = {
  id: string;
  userId: string;
  listIds: string[];
};

export type SessionPrivateContext = {
  theme: "light" | "dark";
};

export type SessionServerContext = {
  public: SessionPublicContext;
  private: Record<string, SessionPrivateContext>;
  history: string[];
};

export const SessionInputPropsSchema = z.object({
  userId: z.string(),
});

export const SessionClientEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("PING") }),
]);
