/**
 * Finding the StudioRegistry Durable Object namespace: in ctx.exports (marked
 * `__actorKitStudioRegistry`, production with enable_ctx_exports) or, failing that, the
 * env.STUDIO_REGISTRY binding (wrangler dev).
 */

/** Runtime check for a DurableObjectNamespace-like binding (idFromName + get). */
export function looksLikeDONamespace(value: unknown): boolean {
  return typeof value === "object" && value !== null && "idFromName" in value && "get" in value;
}

const isRegistryExport = (value: unknown): boolean =>
  typeof value === "object" && value !== null && "__actorKitStudioRegistry" in value;

/** The registry namespace, or undefined when this Worker has none. */
export function findStudioRegistry(
  exports: Record<string, unknown> | undefined,
  envBindings: Record<string, unknown>,
): unknown {
  const exported = Object.values(exports ?? {}).find(isRegistryExport);
  if (exported !== undefined) return exported;
  const binding = envBindings["STUDIO_REGISTRY"];
  return looksLikeDONamespace(binding) ? binding : undefined;
}
