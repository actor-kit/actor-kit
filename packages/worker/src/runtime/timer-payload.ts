/**
 * The payload a timer's handler receives. A timer's payload is stored as JSON (the timers table,
 * checkpoints, the journal), where an absent payload is null. Every runtime (the Durable Object,
 * simulate(), replayJournal()) fires through the step core, which parses the stored payload with
 * the timer's schema here: a null that the schema rejects but whose absence it accepts is read as
 * absent. A schema that accepts both gets null.
 */
import { ActorKitError, type ParseableSchema, parseSchema } from "@actor-kit/core";

type PayloadSchema = ParseableSchema;

export function timerPayload(name: string, schema: PayloadSchema, stored: unknown): unknown {
  const parsed = parseSchema(schema, stored);
  if (parsed.success) return parsed.data;
  const absent = stored === null ? parseSchema(schema, undefined) : parsed;
  if (absent.success) return absent.data;
  throw new ActorKitError("invalid_timer_payload", `Timer "${name}": invalid payload: ${parsed.message}`);
}
