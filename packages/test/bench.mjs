// simulate() on a peekaboo-sized state (an album of 300 cards), 3000 small messages: `node packages/test/bench.mjs [--no-journal]` after `pnpm build`.
import { simulate } from "@actor-kit/test";
import { defineActor, message } from "@actor-kit/worker/testing";
import { schema, uint32, view } from "@actor-kit/core";
import { z } from "zod";

const album = Array.from({ length: 300 }, (_, i) => ({ id: `card_${i}`, critter: `meadow.fox.${i % 7}`, shiny: i % 10 === 0, hat: null, day: "2026-10-18" }));
const journalOff = process.argv.includes("--no-journal");
const Room = defineActor("bench", {
  input: z.object({}),
  ...(journalOff ? { journal: false } : {}),
  init: () => ({ n: 0, glass: { x: 0.5, y: 0.5 }, album, players: ["a", "b", "c"] }),
  roles: { anyone: () => true },
  messages: {
    MOVE: message(z.object({ x: z.number(), y: z.number() }), (s, { x, y }) => ({ ...s, n: s.n + 1, glass: { x, y } })),
  },
  views: { anyone: view.shared(schema({ n: uint32 }), (s) => ({ n: s.n })) },
});
const sim = simulate({ contracts: [Room] });
const actor = sim.spawnSync(Room, "r", {});
const N = 3000;
const t0 = performance.now();
for (let i = 0; i < N; i++) actor.send("a", { type: "MOVE", x: i / N, y: 0.5 });
const ms = performance.now() - t0;
console.log(`${journalOff ? "journal off" : "journal on "}: ${N} sends in ${ms.toFixed(0)} ms (${((ms / N) * 1000).toFixed(0)} µs/send)`);
