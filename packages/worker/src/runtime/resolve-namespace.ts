/**
 * Resolve a DO namespace from ctx.exports by contract name.
 * Falls back to env binding if not found in exports.
 */
export function resolveNamespace(
  contractName: string,
  exports: Record<string, unknown> | undefined,
  env: Record<string, unknown>,
): unknown {
  // Try ctx.exports first
  if (exports) {
    for (const [_key, value] of Object.entries(exports)) {
      if (typeof value === "object" && value !== null && "__actorKitContractName" in value) {
        // After `in` check, TS knows __actorKitContractName exists on value
        const marker: unknown = value.__actorKitContractName;
        if (marker === contractName) {
          return value;
        }
      }
    }
  }

  // Fall back to env binding
  const bindingName = contractName.toUpperCase().replace(/-/g, "_");
  const binding: unknown = env[bindingName];
  if (binding) return binding;

  throw new Error(`Actor "${contractName}" not found in ctx.exports or env.${bindingName}`);
}
