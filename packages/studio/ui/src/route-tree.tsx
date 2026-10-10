import { createRootRoute, createRoute } from "@tanstack/react-router";
import { Layout } from "./components/layout";
import { ActorDetailPage } from "./routes/actor-detail";
import { DashboardPage } from "./routes/dashboard";

const rootRoute = createRootRoute({
  component: Layout,
});

const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: DashboardPage,
});

/** `?entry=N` opens the timeline at that entry (cause links, ADR-017 §4). Anything else is ignored. */
export function parseActorSearch(search: Record<string, unknown>): { entry?: number | undefined } {
  const entry = Number(search["entry"]);
  // Always set: the router keeps raw search keys the result leaves out.
  return { entry: Number.isInteger(entry) && entry > 0 ? entry : undefined };
}

const actorDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/actors/$actorType/$actorId",
  validateSearch: parseActorSearch,
  component: ActorDetailPage,
});

export const routeTree = rootRoute.addChildren([dashboardRoute, actorDetailRoute]);
