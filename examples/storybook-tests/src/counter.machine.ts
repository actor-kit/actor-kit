// Simple types for the storybook counter example.
// No XState, no @actor-kit/types — just plain TypeScript.

export type CounterClientEvent =
  | { type: "INCREMENT" }
  | { type: "DECREMENT" }
  | { type: "RESET" };

export type CounterView = {
  count: number;
};
