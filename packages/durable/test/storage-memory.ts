import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MemoryStorage } from "../src/storage/memory.ts";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import type { Storage } from "../src/types.ts";
import {
	STORAGE_BENCHMARK_BACKENDS,
	STORAGE_MEMORY_SCALES,
	STORAGE_READ_BENCHMARKS,
	type StorageBenchmarkBackend,
	type StorageBenchmarkScale,
	seedStorageBenchmark,
	storageBenchmarkPrimaryRecordCount,
} from "./storage-benchmark.ts";

type MemorySnapshot = {
	readonly heapUsed: number;
	readonly rss: number;
	readonly external: number;
};

type SqliteFootprint = {
	readonly mainBytes: number;
	readonly walBytes: number;
	readonly pageCount: number;
	readonly freelistCount: number;
};

type StorageMemoryResult = {
	readonly backend: StorageBenchmarkBackend;
	readonly scale: string;
	readonly recordCount: number;
	readonly baseline: MemorySnapshot;
	readonly postSeed: MemorySnapshot;
	readonly postRead: MemorySnapshot;
	readonly sqlite?: SqliteFootprint;
};

const execFileAsync = promisify(execFile);

function collectGarbage(): void {
	if (globalThis.gc === undefined) throw new Error("Storage memory measurement requires Node.js --expose-gc");
	for (let index = 0; index < 3; index++) globalThis.gc();
}

function snapshot(): MemorySnapshot {
	const usage = process.memoryUsage();
	return { heapUsed: usage.heapUsed, rss: usage.rss, external: usage.external };
}

async function fileSize(path: string): Promise<number> {
	try {
		return (await stat(path)).size;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
		throw error;
	}
}

function sqliteMetrics(path: string): SqliteFootprint {
	const database = new DatabaseSync(path, { readOnly: true });
	try {
		const pageCount = database.prepare("SELECT page_count AS value FROM pragma_page_count()").get() as {
			readonly value: number;
		};
		const freelistCount = database.prepare("SELECT freelist_count AS value FROM pragma_freelist_count()").get() as {
			readonly value: number;
		};
		return { mainBytes: 0, walBytes: 0, pageCount: pageCount.value, freelistCount: freelistCount.value };
	} finally {
		database.close();
	}
}

async function runWorker(backend: StorageBenchmarkBackend, scale: StorageBenchmarkScale): Promise<void> {
	let storage: Storage;
	let directory: string | undefined;
	let path: string | undefined;
	if (backend === "memory") {
		storage = new MemoryStorage();
	} else {
		directory = await mkdtemp(join(tmpdir(), "pi-durable-memory-"));
		path = join(directory, "storage.sqlite");
		storage = await openNodeSqliteStorage(path);
	}

	try {
		collectGarbage();
		const baseline = snapshot();
		const dataset = await seedStorageBenchmark(storage, scale);
		collectGarbage();
		const postSeed = snapshot();
		let checksum = 0;
		for (const scenario of STORAGE_READ_BENCHMARKS) {
			const result = await scenario.run(storage, dataset);
			if (result !== scenario.expected(dataset)) throw new Error(`Invalid benchmark result: ${scenario.name}`);
			checksum += result;
		}
		for (let round = 1; round < 10; round++) {
			for (const scenario of STORAGE_READ_BENCHMARKS) checksum += await scenario.run(storage, dataset);
		}
		if (!Number.isFinite(checksum)) throw new Error("Storage memory read checksum is invalid");
		collectGarbage();
		const postRead = snapshot();
		let sqlite: SqliteFootprint | undefined;
		if (path !== undefined) {
			sqlite = sqliteMetrics(path);
			sqlite = {
				...sqlite,
				mainBytes: await fileSize(path),
				walBytes: await fileSize(`${path}-wal`),
			};
		}
		const recordCount = storageBenchmarkPrimaryRecordCount(scale);
		console.log(JSON.stringify({ backend, scale: scale.name, recordCount, baseline, postSeed, postRead, sqlite }));
	} finally {
		await storage.close(BACKGROUND_CONTEXT);
		if (directory !== undefined) await rm(directory, { recursive: true, force: true });
	}
}

function delta(after: MemorySnapshot, before: MemorySnapshot, field: keyof MemorySnapshot): number {
	return after[field] - before[field];
}

function mebibytes(bytes: number): string {
	return (bytes / 1024 / 1024).toFixed(2);
}

async function runDriver(): Promise<void> {
	const workerPath = fileURLToPath(import.meta.url);
	const results: StorageMemoryResult[] = [];
	for (const backend of STORAGE_BENCHMARK_BACKENDS) {
		for (const scale of STORAGE_MEMORY_SCALES) {
			const { stdout } = await execFileAsync(
				process.execPath,
				[
					"--conditions=source",
					"--expose-gc",
					"--experimental-strip-types",
					workerPath,
					"--worker",
					backend,
					scale.name,
				],
				{ cwd: fileURLToPath(new URL("..", import.meta.url)), maxBuffer: 1024 * 1024 },
			);
			results.push(JSON.parse(stdout) as StorageMemoryResult);
		}
	}

	console.log("Storage footprint after deterministic synthetic workloads; values are process deltas, not limits.");
	console.table(
		results.map((result) => ({
			backend: result.backend,
			scale: result.scale,
			"heap after seed MiB": mebibytes(delta(result.postSeed, result.baseline, "heapUsed")),
			"RSS after seed MiB": mebibytes(delta(result.postSeed, result.baseline, "rss")),
			"external after seed MiB": mebibytes(delta(result.postSeed, result.baseline, "external")),
			"heap after reads MiB": mebibytes(delta(result.postRead, result.postSeed, "heapUsed")),
			"JS heap bytes/primary record": Math.round(
				delta(result.postSeed, result.baseline, "heapUsed") / result.recordCount,
			),
			"live SQLite main MiB": result.sqlite === undefined ? "-" : mebibytes(result.sqlite.mainBytes),
			"live SQLite WAL MiB": result.sqlite === undefined ? "-" : mebibytes(result.sqlite.walBytes),
			"SQLite pages/free":
				result.sqlite === undefined ? "-" : `${result.sqlite.pageCount}/${result.sqlite.freelistCount}`,
		})),
	);
}

const [mode, backendName, scaleName] = process.argv.slice(2);
if (mode === "--worker") {
	const backend = STORAGE_BENCHMARK_BACKENDS.find((candidate) => candidate === backendName);
	if (backend === undefined) throw new Error(`Unknown storage benchmark backend: ${backendName}`);
	const scale = STORAGE_MEMORY_SCALES.find((candidate) => candidate.name === scaleName);
	if (scale === undefined) throw new Error(`Unknown storage benchmark scale: ${scaleName}`);
	await runWorker(backend, scale);
} else {
	await runDriver();
}
