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

const actorDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/actors/$actorType/$actorId",
  component: ActorDetailPage,
});

export const routeTree = rootRoute.addChildren([dashboardRoute, actorDetailRoute]);
