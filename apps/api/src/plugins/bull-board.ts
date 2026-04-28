import fp from "fastify-plugin";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { FastifyAdapter } from "@bull-board/fastify";
import { createQueue, QUEUE_NAMES } from "@onchainme/shared";

export const bullBoardPlugin = fp(async (fastify) => {
  const adapter = new FastifyAdapter();
  adapter.setBasePath("/admin/queues");

  createBullBoard({
    queues: [
      new BullMQAdapter(createQueue(QUEUE_NAMES.scan)),
      new BullMQAdapter(createQueue(QUEUE_NAMES.checkBalance)),
      new BullMQAdapter(createQueue(QUEUE_NAMES.mintConfirm)),
      new BullMQAdapter(createQueue(QUEUE_NAMES.webhook)),
    ],
    serverAdapter: adapter,
  });

  await fastify.register(
    async (scoped) => {
      scoped.addHook("onRequest", scoped.basicAuth);
      await scoped.register(adapter.registerPlugin(), { prefix: "/admin/queues" });
    },
    { prefix: "/" },
  );
});
