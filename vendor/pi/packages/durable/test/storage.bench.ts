import { strictEqual } from "node:assert/strict";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterAll, bench, describe } from "vitest";
import { MemoryStorage } from "../src/storage/memory.ts";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import type { Storage } from "../src/types.ts";
import {
	STORAGE_BENCHMARK_BACKENDS,
	STORAGE_READ_BENCHMARKS,
	STORAGE_WRITE_BENCHMARKS,
	type StorageBenchmarkBackend,
	seedStorageBenchmark,
} from "./storage-benchmark.ts";

const READ_OPTIONS = { time: 300, iterations: 10, warmupTime: 75, warmupIterations: 3 } as const;
const WRITE_OPTIONS = { time: 0, iterations: 20, warmupTime: 0, warmupIterations: 5 } as const;
const REOPEN_OPTIONS = { time: 0, iterations: 20, warmupTime: 0, warmupIterations: 3 } as const;

type Fixture = {
	readonly backend: StorageBenchmarkBackend;
	readonly storage: Storage;
	readonly path?: string;
};

const fixtures: Fixture[] = [];
const directories: string[] = [];

async function createFixture(backend: StorageBenchmarkBackend): Promise<Fixture> {
	if (backend === "memory") {
		const fixture = { backend, storage: new MemoryStorage() } satisfies Fixture;
		fixtures.push(fixture);
		return fixture;
	}
	const directory = await mkdtemp(join(tmpdir(), "pi-durable-benchmark-"));
	directories.push(directory);
	const path = join(directory, "storage.sqlite");
	const fixture = { backend, storage: await openNodeSqliteStorage(path), path } satisfies Fixture;
	fixtures.push(fixture);
	return fixture;
}

const readFixtures = await Promise.all(STORAGE_BENCHMARK_BACKENDS.map(createFixture));
const readDatasets = await Promise.all(readFixtures.map(({ storage }) => seedStorageBenchmark(storage)));
for (let index = 0; index < readFixtures.length; index++) {
	for (const scenario of STORAGE_READ_BENCHMARKS) {
		strictEqual(
			await scenario.run(readFixtures[index].storage, readDatasets[index]),
			scenario.expected(readDatasets[index]),
		);
	}
}

for (const scenario of STORAGE_READ_BENCHMARKS) {
	describe(scenario.name, () => {
		for (let index = 0; index < readFixtures.length; index++) {
			const fixture = readFixtures[index];
			const dataset = readDatasets[index];
			bench(
				fixture.backend,
				async () => {
					await scenario.run(fixture.storage, dataset);
				},
				READ_OPTIONS,
			);
		}
	});
}

async function createWriteFixture(backend: StorageBenchmarkBackend): Promise<Fixture> {
	const fixture = await createFixture(backend);
	await fixture.storage.commit([{ type: "conversation", value: { id: 1 } }], BACKGROUND_CONTEXT);
	await fixture.storage.commit(
		await Promise.all(
			Array.from({ length: 100 }, async (_, index) => ({
				type: "entry" as const,
				value: {
					id: await fixture.storage.mintId(),
					conversationId: 1,
					kind: "benchmark.baseline",
					data: { index },
				},
			})),
		),
		BACKGROUND_CONTEXT,
	);
	return fixture;
}

const writePools = new Map<string, Fixture[]>();
for (const scenario of STORAGE_WRITE_BENCHMARKS) {
	for (const backend of STORAGE_BENCHMARK_BACKENDS) {
		const validation = await createWriteFixture(backend);
		strictEqual(await scenario.run(validation.storage), scenario.expected);
		const pool = await Promise.all(
			Array.from({ length: WRITE_OPTIONS.iterations + WRITE_OPTIONS.warmupIterations }, () =>
				createWriteFixture(backend),
			),
		);
		writePools.set(`${scenario.name}:${backend}`, pool);
	}
	describe(scenario.name, () => {
		for (const backend of STORAGE_BENCHMARK_BACKENDS) {
			const pool = writePools.get(`${scenario.name}:${backend}`)!;
			bench(
				backend,
				async () => {
					const fixture = pool.shift();
					if (fixture === undefined) throw new Error("Write benchmark fixture pool was exhausted");
					await scenario.run(fixture.storage);
				},
				WRITE_OPTIONS,
			);
		}
	});
}

const reopenDirectory = await mkdtemp(join(tmpdir(), "pi-durable-reopen-benchmark-"));
directories.push(reopenDirectory);
const reopenPath = join(reopenDirectory, "storage.sqlite");
const reopenSeed = await openNodeSqliteStorage(reopenPath);
const reopenDataset = await seedStorageBenchmark(reopenSeed);
await reopenSeed.close(BACKGROUND_CONTEXT);
const reopenPaths = await Promise.all(
	Array.from({ length: REOPEN_OPTIONS.iterations + REOPEN_OPTIONS.warmupIterations }, async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-durable-reopen-sample-"));
		directories.push(directory);
		const path = join(directory, "storage.sqlite");
		await copyFile(reopenPath, path);
		return path;
	}),
);
const reopenedStorages: Storage[] = [];
async function reopenAndRead(path: string): Promise<{ readonly id: number; readonly storage: Storage }> {
	const storage = await openNodeSqliteStorage(path);
	const id = (await storage.entry(reopenDataset.firstEntryId, BACKGROUND_CONTEXT))?.entry.id ?? -1;
	return { id, storage };
}
const reopenValidation = await reopenAndRead(reopenPath);
strictEqual(reopenValidation.id, reopenDataset.firstEntryId);
await reopenValidation.storage.close(BACKGROUND_CONTEXT);
describe("SQLite reopen and first exact read", () => {
	bench(
		"sqlite",
		async () => {
			const path = reopenPaths.shift();
			if (path === undefined) throw new Error("Reopen benchmark fixture pool was exhausted");
			const result = await reopenAndRead(path);
			reopenedStorages.push(result.storage);
		},
		REOPEN_OPTIONS,
	);
});

afterAll(async () => {
	for (const storage of reopenedStorages) await storage.close(BACKGROUND_CONTEXT);
	for (const fixture of fixtures) await fixture.storage.close(BACKGROUND_CONTEXT);
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});
