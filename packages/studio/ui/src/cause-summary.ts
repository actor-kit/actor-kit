/** One-line, human-readable summaries of timeline causes. */

function field(cause: Record<string, unknown>, key: string): string {
  const value = cause[key];
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "unknown";
}

type Field = (key: string) => string;

const SUMMARIES = new Map<string, (f: Field) => string>([
  ["message", (f) => `${f("caller")} sent ${f("messageType")}`],
  ["lifecycle.connect", (f) => `${f("caller")} connected (${f("role")})`],
  ["lifecycle.disconnect", (f) => `${f("caller")} disconnected`],
  ["service.onDone", (f) => `${f("service")} completed`],
  ["service.onError", (f) => `${f("service")} failed: ${f("error")}`],
  ["service.stale", (f) => `${f("service")} answered after its state was left`],
  ["link.onUpdate", (f) => `${f("sourceType")}:${f("sourceId")} updated`],
  ["link.onError", (f) => `${f("sourceType")}:${f("sourceId")} failed: ${f("error")}`],
  ["link.onUnlink", (f) => `${f("sourceType")}:${f("sourceId")} unlinked`],
  ["init", () => "Actor initialized"],
  ["migrate", (f) => `Migrated from v${f("fromVersion")} to v${f("toVersion")}`],
]);

/** Unknown cause types are shown by name. */
export function formatCauseSummary(causeType: string, cause: Record<string, unknown>): string {
  const summary = SUMMARIES.get(causeType);
  return summary === undefined ? causeType : summary((key) => field(cause, key));
}
