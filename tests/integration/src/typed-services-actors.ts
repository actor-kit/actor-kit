/**
 * Typed services (ADR-016), for tests/integration/typed-services.test.ts.
 *
 * - Teller runs services and forwards. ECHO returns what the runtime passed as its third argument
 *   (minus the signal). FORWARD sends DELIVER to a Till through the `till` link.
 * - Till records `ctx.delivery` for every DELIVER it accepts and ignores a delivery it has already seen.
 */

import type { DeliveryInfo } from "@actor-kit/core";
import { schema, uint32, view } from "@actor-kit/core";
import { createActorClass, defineActor, type EffectInfo, link, message } from "@actor-kit/worker";
import { z } from "zod";

type TillState = { received: Array<{ text: string; delivery: DeliveryInfo | null }> };

const TillContract = defineActor("till", {
  input: z.object({}),
  init: (): TillState => ({ received: [] }),
  roles: { any: () => true },
  messages: {
    DELIVER: message(z.object({ text: z.string() }), (s: TillState, { text }, ctx) => {
      const key = ctx.delivery?.idempotencyKey;
      if (key !== undefined && s.received.some((r) => r.delivery?.idempotencyKey === key)) return s;
      return { received: [...s.received, { text, delivery: ctx.delivery ?? null }] };
    }),
  },
  views: { any: view.shared(schema({ n: uint32 }), (s: TillState) => ({ n: s.received.length })) },
});

export type TellerState = { echoes: unknown[]; errors: unknown[] };

const echo = (effect: EffectInfo) => ({
  actorType: effect.actorType,
  actorId: effect.actorId,
  effectId: effect.effectId,
  idempotencyKey: effect.idempotencyKey,
  attempt: effect.attempt,
  signalAborted: effect.signal.aborted,
});

const TellerContract = defineActor("teller", {
  input: z.object({}),
  init: (): TellerState => ({ echoes: [], errors: [] }),
  roles: { any: () => true },
  links: { till: link(TillContract, { onUpdate: <S>(s: S) => s }) },
  services: {
    ECHO: {
      fn: async (_input: unknown, _env: unknown, effect: EffectInfo) => echo(effect),
      onDone: (s: TellerState, result: unknown) => ({ ...s, echoes: [...s.echoes, result] }),
    },
  },
  messages: {
    RUN: message(z.object({ service: z.string() }), (s: TellerState, { service }, ctx) => {
      ctx.execute(service, {});
      return s;
    }),
    FORWARD: message(z.object({ to: z.string(), text: z.string() }), (s: TellerState, { to, text }, ctx) => {
      ctx.forward("till", to, { type: "DELIVER", text });
      return s;
    }),
  },
  views: { any: view.shared(schema({ n: uint32 }), (s: TellerState) => ({ n: s.echoes.length })) },
  studio: { enabled: true },
});

export const Teller = createActorClass(TellerContract);
export const Till = createActorClass(TillContract);
