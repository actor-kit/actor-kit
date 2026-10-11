/**
 * Run Set Jimmy feedback 18: a Worker types its Durable Object binding from the actor class
 * (`DurableObjectNamespace<InstanceType<typeof RoomActor>>`) and never hand-types the stub. Cloudflare's RPC
 * types map `unknown` to `never`, so every RPC result must be typed: `getSnapshot` resolves to the
 * contract's views, one member per role (`role` narrows `snapshot`), `__getView` likewise, and `__inspect`'s
 * `state` to the contract's persisted state. Checked by `pnpm typecheck:types`.
 */
import { boolean, type JsonValue, nullable, schema, string, uint32, view } from "@actor-kit/core";
import type { ContractSnapshot, TypedActorClass } from "@actor-kit/worker";
import { setup } from "@actor-kit/worker/testing";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

type Shared = { players: string[]; host: string | null; secret: string };

const HostView = schema({ players: uint32, secret: string, host: nullable(string) });
const GuestView = schema({ players: uint32, seated: boolean });

const room = setup({ states: { lobby: {}, playing: { local: z.object({ round: z.number() }) } } });

const RoomContract = room.actor("room", {
  input: z.object({ host: z.string() }),
  init: (): Shared => ({ players: [], host: null, secret: "s" }),
  roles: { host: (st: { shared: Shared }, caller: string) => st.shared.host === caller, guest: () => true },
  initial: "lobby",
  states: {
    lobby: room.in("lobby").state({
      messages: { JOIN: room.in("lobby").message(z.object({ name: z.string() }), (s: Shared) => s) },
    }),
    playing: room.in("playing").state({}),
  },
  views: {
    host: view.shared(HostView, (st: { shared: Shared }) => ({
      players: st.shared.players.length,
      secret: st.shared.secret,
      host: st.shared.host,
    })),
    guest: view.perCaller(GuestView, (st: { shared: Shared }, caller: string) => ({
      players: st.shared.players.length,
      seated: st.shared.players.includes(caller),
    })),
  },
});

type RoomActor = InstanceType<TypedActorClass<typeof RoomContract>>;
type HostData = { players: number; secret: string; host: string | null };
type GuestData = { players: number; seated: boolean };

describe("a binding typed from the actor class", () => {
  it("getSnapshot resolves to one member per role; role narrows the view", () => {
    const page = async (ns: DurableObjectNamespace<RoomActor>) => {
      const stub = ns.get(ns.idFromName("r1"));
      const snap = await stub.getSnapshot("ann", "user");
      expectTypeOf(snap.role).toEqualTypeOf<"host" | "guest">();
      expectTypeOf(snap.checksum).toEqualTypeOf<string>();
      if (snap.role === "host") expectTypeOf(snap.snapshot).toEqualTypeOf<HostData>();
      else expectTypeOf(snap.snapshot).toEqualTypeOf<GuestData>();
      // @ts-expect-error a guest's view has no secret
      if (snap.role === "guest") void snap.snapshot.secret;
      return snap.snapshot.players;
    };
    expect(page).toBeDefined();
  });

  it("ContractSnapshot is the same union, for code that names it", () => {
    expectTypeOf<ContractSnapshot<typeof RoomContract>>().toEqualTypeOf<
      { checksum: string; role: "host"; snapshot: HostData } | { checksum: string; role: "guest"; snapshot: GuestData }
    >();
  });

  it("a contract without view schemas gets JSON, not never", () => {
    type Bare = { name: "bare"; def: { views: Record<never, never> } };
    expectTypeOf<ContractSnapshot<Bare>>().toEqualTypeOf<{ checksum: string; role: string; snapshot: JsonValue }>();
    const page = async (ns: DurableObjectNamespace<InstanceType<TypedActorClass<Bare>>>) => {
      const snap = await ns.get(ns.idFromName("b")).getSnapshot("u", "user");
      expectTypeOf(snap.snapshot).not.toBeNever();
      expectTypeOf((await ns.get(ns.idFromName("b")).__inspect()).state).not.toBeNever();
      return snap.role;
    };
    expect(page).toBeDefined();
  });

  it("no public RPC resolves to never", () => {
    const worker = async (ns: DurableObjectNamespace<RoomActor>) => {
      const stub = ns.get(ns.idFromName("r1"));
      await stub.spawn({ caller: "ann", callerType: "user", input: { host: "ann" } });
      const sent = await stub.send("ann", "user", { type: "JOIN", name: "Ann" });
      expectTypeOf(sent).not.toBeNever();
      if (!sent.ok) expectTypeOf(sent.code).toBeString();
      // @ts-expect-error not a message of the contract
      await stub.send("ann", "user", { type: "NOPE" });
      const inspect = await stub.__inspect();
      expectTypeOf(inspect.state).not.toBeNever();
      // The persisted state; Cloudflare's RPC types turn its tuples into arrays.
      expectTypeOf(inspect.state).toEqualTypeOf<
        | { shared: Shared; phase: readonly "lobby"[]; locals: null[]; stateTimers: string[][] }
        | { shared: Shared; phase: readonly "playing"[]; locals: { round: number }[]; stateTimers: string[][] }
      >();
      const viewed = await stub.__getView({ role: "host" });
      if ("data" in viewed && viewed.role === "host") expectTypeOf(viewed.data).toEqualTypeOf<HostData>();
      expectTypeOf(await stub.__getTimeline()).not.toBeNever();
      expectTypeOf((await stub.__journal()).entries).not.toBeNever();
      expectTypeOf(await stub.__redrive({ effectId: "1:0" })).not.toBeNever();
      expectTypeOf(await stub.__fireTimer({ key: "k" })).not.toBeNever();
      expectTypeOf(await stub.__restore({ toSeq: 1 })).not.toBeNever();
      expectTypeOf(await stub.fetch(new Request("https://x"))).toEqualTypeOf<Response>();
    };
    expect(worker).toBeDefined();
  });
});
