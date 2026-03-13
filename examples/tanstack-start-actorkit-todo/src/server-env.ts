import { z } from "zod";

export const ServerEnvSchema = z.object({
  ACTOR_KIT_HOST: z.string().min(1),
  ACTOR_KIT_SECRET: z.string().min(1),
});
