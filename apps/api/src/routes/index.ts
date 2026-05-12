import type { FastifyPluginAsync } from "fastify";
import { healthRoute } from "./health.js";
import { authRoute } from "./auth.js";
import { scanRoute } from "./scan.js";
import { landsRoute } from "./lands.js";
import { placementsRoute } from "./placements.js";
import { mintRoute } from "./mint.js";
import { webhooksRoute } from "./webhooks.js";
import { badgesRoute } from "./badges.js";
import { feedRoute } from "./feed.js";
import { statsRoute } from "./stats.js";
import { metadataRoute } from "./metadata.js";
import { devRoute } from "./dev.js";
import { importRoute } from "./import.js";
import { solanaRoute } from "./solana.js";
import { adminRoute } from "./admin.js";

export const registerRoutes: FastifyPluginAsync = async (fastify) => {
  await fastify.register(async (api) => {
    await api.register(healthRoute);
    await api.register(authRoute);
    await api.register(scanRoute);
    await api.register(landsRoute);
    await api.register(placementsRoute);
    await api.register(mintRoute);
    await api.register(webhooksRoute);
    await api.register(badgesRoute);
    await api.register(feedRoute);
    await api.register(statsRoute);
    await api.register(metadataRoute);
    await api.register(devRoute);
    await api.register(importRoute);
    await api.register(solanaRoute);
    await api.register(adminRoute);
  }, { prefix: "/api/v1" });
};
