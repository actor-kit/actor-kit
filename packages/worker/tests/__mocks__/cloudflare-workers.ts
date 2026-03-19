/**
 * Minimal mock of cloudflare:workers for Node-based unit tests.
 * Real Workers runtime tests use @cloudflare/vitest-pool-workers.
 */
export class DurableObject {
  constructor(
    public state: unknown,
    public env: unknown
  ) {}
}
