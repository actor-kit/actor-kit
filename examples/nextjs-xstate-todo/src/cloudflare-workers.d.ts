declare module "cloudflare:workers" {
  export class WorkerEntrypoint<TEnv = unknown> {
    constructor(ctx: ExecutionContext, env: TEnv);
    env: TEnv;
    ctx: ExecutionContext;
    fetch(request: Request): Response | Promise<Response>;
  }
}
