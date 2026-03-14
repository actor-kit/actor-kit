import { ActorKitEnv } from "actor-kit";

export type Env = ActorKitEnv & { EMAIL_SERVICE_API_KEY: string };
