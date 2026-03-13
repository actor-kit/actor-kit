import { produce } from "immer";
import { assign, setup } from "xstate";
import {
  SessionEvent,
  SessionInput,
  SessionServerContext,
} from "./session.types";

export const sessionMachine = setup({
  types: {
    context: {} as SessionServerContext,
    events: {} as SessionEvent,
    input: {} as SessionInput,
  },
  actions: {
    sendEmail: ({ event }) => {
      if (event.type === "REGISTER") {
        console.log(
          "Sending email to",
          event.email,
          "using API key",
          event.env.EMAIL_SERVICE_API_KEY
        );
      }
    },
    addListId: assign({
      public: ({ context, event }) => {
        if (event.type === "NEW_LIST") {
          return produce(context.public, (draft) => {
            draft.listIds.push(event.listId);
          });
        }
        return context.public;
      },
    }),
  },
  guards: {
    isOwner: ({ context, event }) => {
      return context.public.userId === event.caller.id;
    },
  },
}).createMachine({
  id: "session",
  initial: "idle",
  context: ({ input }: { input: SessionInput }) => {
    return {
      public: {
        id: input.id,
        userId: input.caller.id,
        listIds: [],
      },
      private: {},
      history: [],
    };
  },
  states: {
    idle: {
      on: {
        NEW_LIST: {
          actions: "addListId",
          guard: "isOwner",
        },
        REGISTER: {
          actions: "sendEmail",
        },
      },
    },
  },
});

export type SessionMachine = typeof sessionMachine;
