import * as durable from "@earendil-works/pi-durable";
import * as sqlite from "@earendil-works/pi-durable/storage/sqlite";

// Keep both runtime-neutral public entry points live so the browser smoke build
// catches accidental imports of Node-only adapters or built-ins.
console.log(Object.keys(durable), Object.keys(sqlite));
