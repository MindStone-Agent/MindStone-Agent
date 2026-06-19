#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function findRepoRoot() {
  if (process.env.MINDSTONE_AGENT_ROOT) return resolve(process.env.MINDSTONE_AGENT_ROOT);
  let current = here;
  for (let i = 0; i < 8; i += 1) {
    const packageJson = resolve(current, "package.json");
    if (existsSync(packageJson)) {
      try {
        const parsed = JSON.parse(readFileSync(packageJson, "utf-8"));
        if (parsed?.name === "mindstone-agent") return current;
      } catch {
        // Keep walking.
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return process.cwd();
}

function setDefault(name, value) {
  if (!process.env[name]) process.env[name] = value;
}

function loadEnvLocal(path) {
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf-8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    let value = rawValue.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function bootstrapMindStoneEnv() {
  const root = findRepoRoot();
  setDefault("MINDSTONE_AGENT_ROOT", root);

  const runtimeDir = process.env.MINDSTONE_AGENT_RUNTIME_DIR || resolve(root, ".runtime");
  setDefault("MINDSTONE_AGENT_RUNTIME_DIR", runtimeDir);

  setDefault("PI_CODING_AGENT_DIR", resolve(runtimeDir, "pi-agent"));
  setDefault("PI_CODING_AGENT_SESSION_DIR", resolve(runtimeDir, "pi-sessions"));
  setDefault("PI_PACKAGE_DIR", resolve(root, "vendor/pi/packages/coding-agent"));
  setDefault("PI_SKIP_VERSION_CHECK", "1");
  setDefault("PI_OFFLINE", "1");

  const dataDir = process.env.MINDSTONE_AGENT_DATA_DIR || resolve(runtimeDir, "mindstone");
  setDefault("MINDSTONE_AGENT_DATA_DIR", dataDir);
  setDefault("MINDSTONE_AGENT_TOKEN_DIR", resolve(dataDir, "tokens"));
  setDefault("MINDSTONE_AGENT_VECTOR_DIR", resolve(dataDir, "vectors"));
  setDefault("MINDSTONE_AGENT_TRANSCRIPT_DIR", resolve(dataDir, "transcripts"));
  setDefault("MINDSTONE_AGENT_MEMORY_DIR", resolve(dataDir, "memory"));
  setDefault("MINDSTONE_AGENT_JOURNAL_DIR", resolve(dataDir, "journals"));
  setDefault("MINDSTONE_AGENT_LOG_PATH", resolve(dataDir, "LOG.md"));
  setDefault("MINDSTONE_AGENT_MEMORY_INDEX_PATH", resolve(dataDir, "memory/MEMORY.md"));
  setDefault("MINDSTONE_AGENT_GATEWAY_HOST", "127.0.0.1");
  setDefault("MINDSTONE_AGENT_GATEWAY_PORT", "19789");

  for (const dir of [
    process.env.PI_CODING_AGENT_DIR,
    process.env.PI_CODING_AGENT_SESSION_DIR,
    process.env.MINDSTONE_AGENT_TOKEN_DIR,
    process.env.MINDSTONE_AGENT_VECTOR_DIR,
    process.env.MINDSTONE_AGENT_TRANSCRIPT_DIR,
    process.env.MINDSTONE_AGENT_MEMORY_DIR,
    process.env.MINDSTONE_AGENT_JOURNAL_DIR,
    dirname(process.env.MINDSTONE_AGENT_LOG_PATH),
    dirname(process.env.MINDSTONE_AGENT_MEMORY_INDEX_PATH),
  ]) {
    if (dir) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  if (process.env.MSA_ALLOW_HOST_PROVIDER_ENV !== "1") {
    for (const name of [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "AZURE_OPENAI_API_KEY",
      "AZURE_OPENAI_BASE_URL",
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
      "OPENROUTER_API_KEY",
      "GROQ_API_KEY",
      "XAI_API_KEY",
      "TOGETHER_API_KEY",
      "FIREWORKS_API_KEY",
      "MISTRAL_API_KEY",
      "CEREBRAS_API_KEY",
      "DEEPSEEK_API_KEY",
      "NVIDIA_API_KEY",
      "AWS_PROFILE",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_BEARER_TOKEN_BEDROCK",
    ]) {
      delete process.env[name];
    }
  }

  loadEnvLocal(resolve(runtimeDir, "env.local"));
}

bootstrapMindStoneEnv();

const cli = resolve(here, "../dist/index.js");
if (!existsSync(cli)) {
  console.error("MindStone-Agent CLI is not built yet.");
  console.error("Run: npm run build:mindstone");
  process.exit(1);
}

await import(pathToFileURL(cli).href);
