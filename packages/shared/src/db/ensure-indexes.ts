import { allModels } from "./models.js";
import { connectDb, closeDb } from "./connect.js";

async function main(): Promise<void> {
  console.warn("Connecting to MongoDB...");
  await connectDb();

  for (const model of allModels) {
    console.warn(`syncing indexes for ${model.modelName} ...`);
    await model.syncIndexes();
  }

  console.warn("All indexes synced.");
  await closeDb();
}

main().catch(async (err) => {
  console.error("ensure-indexes failed:", err);
  await closeDb().catch(() => {});
  process.exit(1);
});
