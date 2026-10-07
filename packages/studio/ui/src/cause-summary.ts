/** One-line, human-readable summaries of timeline causes. */

function field(cause: Record<string, unknown>, key: string): string {
  const value = cause[key];
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "unknown";
}

export function formatCauseSummary(causeType: string, cause: Record<string, unknown>): string {
  const f = (key: string) => field(cause, key);
  switch (causeType) {
    case "message":
      return `${f("caller")} sent ${f("messageType")}`;
    case "lifecycle.connect":
      return `${f("caller")} connected (${f("role")})`;
    case "lifecycle.disconnect":
      return `${f("caller")} disconnected`;
    case "service.onDone":
      return `${f("service")} completed`;
    case "service.onError":
      return `${f("service")} failed: ${f("error")}`;
    case "link.onUpdate":
      return `${f("sourceType")}:${f("sourceId")} updated`;
    case "link.onError":
      return `${f("sourceType")}:${f("sourceId")} failed: ${f("error")}`;
    case "link.onUnlink":
      return `${f("sourceType")}:${f("sourceId")} unlinked`;
    case "init":
      return "Actor initialized";
    case "migrate":
      return `Migrated from v${f("fromVersion")} to v${f("toVersion")}`;
    default:
      return causeType;
  }
}
