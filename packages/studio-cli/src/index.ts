// @actor-kit/studio-cli — read-only Studio access for people and agents (ADR-014)

export { runCli, USAGE } from "./cli";
export {
  authFromEnv,
  createStudioClient,
  type FetchFn,
  type StudioAuth,
  type StudioClient,
  StudioClientError,
  type TimelineEntry,
  type TimelinePage,
} from "./client";
export { createStudioMcpServer } from "./mcp";
export { changedPaths, type TimelineShapeEntry, timelineShape } from "./shape";
