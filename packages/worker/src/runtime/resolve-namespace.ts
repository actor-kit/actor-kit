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
  const exported = exportedNamespace(contractName, exports);
  if (exported !== undefined) return exported;

  // Fall back to env binding
  const bindingName = contractName.toUpperCase().replace(/-/g, "_");
  const binding: unknown = env[bindingName];
  if (binding) return binding;

  throw new Error(`Actor "${contractName}" not found in ctx.exports or env.${bindingName}`);
}

/** The ctx.exports entry marked with this contract name. */
function exportedNamespace(contractName: string, exports: Record<string, unknown> | undefined): unknown {
  return Object.values(exports ?? {}).find(
    (value) =>
      typeof value === "object" &&
      value !== null &&
      "__actorKitContractName" in value &&
      value.__actorKitContractName === contractName,
  );
}
