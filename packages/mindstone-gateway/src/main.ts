import { gatewayExitCode, startGateway } from "./index.js";

/** How long shutdown may take to let in-flight work finish before the process exits anyway (#90). */
const SHUTDOWN_CAP_MS = 10_000;

const gateway = await startGateway();
console.log(`MindStone-Agent Gateway listening at ${gateway.url}`);

const shutdown = async () => {
  await Promise.race([gateway.close().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, SHUTDOWN_CAP_MS).unref())]);
  process.exit(gatewayExitCode());
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
