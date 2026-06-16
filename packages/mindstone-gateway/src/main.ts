import { startGateway } from "./index.js";

const gateway = await startGateway();
console.log(`MindStone-Agent Gateway listening at ${gateway.url}`);

const shutdown = async () => {
  await gateway.close();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
