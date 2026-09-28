import { MemoryStorage } from "../src/storage/memory.ts";
import { registerStorageConformance } from "./storage-conformance.ts";

registerStorageConformance("Pico MemoryStorage", () => new MemoryStorage());
