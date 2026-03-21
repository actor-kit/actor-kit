import React from "react";
import { CounterContext } from "./counter.context";

export function Counter() {
  const count = CounterContext.useSelector((s) => s.count);
  const send = CounterContext.useSend();

  return (
    <div>
      <h1 data-testid="count">Count: {count}</h1>
      <button onClick={() => send({ type: "INCREMENT" })}>+</button>
      <button onClick={() => send({ type: "DECREMENT" })}>-</button>
      <button onClick={() => send({ type: "RESET" })}>Reset</button>
    </div>
  );
}
