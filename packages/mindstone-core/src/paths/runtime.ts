export type MindStoneRuntimePaths = {
  root: string;
  runtimeDir: string;
  piAgentDir: string;
  piSessionDir: string;
  dataDir: string;
  tokenDir: string;
  vectorDir: string;
  transcriptDir: string;
  handoffDir: string;
  memoryDir: string;
  journalDir: string;
  logPath: string;
  memoryIndexPath: string;
};

export function runtimePathsFromEnv(env: NodeJS.ProcessEnv = process.env): MindStoneRuntimePaths {
  const root = env.MINDSTONE_AGENT_ROOT ?? process.cwd();
  const runtimeDir = env.MINDSTONE_AGENT_RUNTIME_DIR ?? `${root}/.runtime`;
  const dataDir = env.MINDSTONE_AGENT_DATA_DIR ?? `${runtimeDir}/mindstone`;
  return {
    root,
    runtimeDir,
    piAgentDir: env.PI_CODING_AGENT_DIR ?? `${runtimeDir}/pi-agent`,
    piSessionDir: env.PI_CODING_AGENT_SESSION_DIR ?? `${runtimeDir}/pi-sessions`,
    dataDir,
    tokenDir: env.MINDSTONE_AGENT_TOKEN_DIR ?? `${dataDir}/tokens`,
    vectorDir: env.MINDSTONE_AGENT_VECTOR_DIR ?? `${dataDir}/vectors`,
    transcriptDir: env.MINDSTONE_AGENT_TRANSCRIPT_DIR ?? `${dataDir}/transcripts`,
    handoffDir: env.MINDSTONE_AGENT_HANDOFF_DIR ?? `${dataDir}/handoffs`,
    memoryDir: env.MINDSTONE_AGENT_MEMORY_DIR ?? `${dataDir}/memory`,
    journalDir: env.MINDSTONE_AGENT_JOURNAL_DIR ?? `${dataDir}/journals`,
    logPath: env.MINDSTONE_AGENT_LOG_PATH ?? `${dataDir}/LOG.md`,
    memoryIndexPath: env.MINDSTONE_AGENT_MEMORY_INDEX_PATH ?? `${dataDir}/memory/MEMORY.md`,
  };
}
