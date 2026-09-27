import { exitGatewayOnSignals, startGateway } from "./index.js";

const gateway = await startGateway();
console.log(`MindStone-Agent Gateway listening at ${gateway.url}`);

// Capped shutdown, exit 75 after a restart from the Console (#90).
exitGatewayOnSignals(gateway);
