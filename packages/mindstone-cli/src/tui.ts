import {
  loadMindStoneConfig,
  resolveConfigPath,
  resolveConfiguredSessionKey,
  resolveMindStoneChatModel,
  runMindStoneChatTurn,
  runtimePathsFromEnv,
  type AgentRunner,
  type MindStoneModelInfo,
} from "@mindstone-agent/core";
import { MockMindStoneProvider, PiMindStoneProvider, PiSessionAgentRunner, PiSessionMindStoneProvider } from "@mindstone-agent/gateway";
import {
  CombinedAutocompleteProvider,
  Container,
  Editor,
  Key,
  Loader,
  Markdown,
  matchesKey,
  ProcessTerminal,
  Spacer,
  Text,
  TUI,
  truncateToWidth,
  type Component,
  type EditorTheme,
  type MarkdownTheme,
  type SelectListTheme,
} from "../../../vendor/pi/packages/tui/dist/index.js";

const reset = "\x1b[0m";
const ansi = (code: string) => (text: string) => `${code}${text}${reset}`;
const gold = ansi("\x1b[38;5;214m");
const amber = ansi("\x1b[38;5;222m");
const muted = ansi("\x1b[38;5;244m");
const dim = ansi("\x1b[2m");
const red = ansi("\x1b[38;5;203m");
const green = ansi("\x1b[38;5;114m");
const bold = ansi("\x1b[1m");

const selectListTheme: SelectListTheme = {
  selectedPrefix: gold,
  selectedText: (text) => bold(gold(text)),
  description: muted,
  scrollInfo: dim,
  noMatch: muted,
};

const editorTheme: EditorTheme = {
  borderColor: muted,
  selectList: selectListTheme,
};

const markdownTheme: MarkdownTheme = {
  heading: (text) => bold(gold(text)),
  link: green,
  linkUrl: dim,
  code: amber,
  codeBlock: amber,
  codeBlockBorder: muted,
  quote: muted,
  quoteBorder: muted,
  hr: muted,
  listBullet: gold,
  bold,
  italic: (text) => `\x1b[3m${text}${reset}`,
  strikethrough: (text) => `\x1b[9m${text}${reset}`,
  underline: (text) => `\x1b[4m${text}${reset}`,
  highlightCode: (code) => code.split("\n").map(amber),
};

type TuiCommandContext = {
  agentId: string;
  sessionKey: string;
  model: MindStoneModelInfo;
  routingMode: "mock" | "pi" | "pi-session";
};

class MindStoneHeader implements Component {
  constructor(private readonly ctx: TuiCommandContext) {}

  render(width: number): string[] {
    const title = `${gold("◆")} ${bold(gold("MindStone-Agent"))} ${muted("TUI")}`;
    const detail = muted(`agent ${this.ctx.agentId} • ${this.ctx.routingMode} • ${this.ctx.model.id}`);
    return [
      truncateToWidth(title, width),
      truncateToWidth(detail, width),
      truncateToWidth(muted("─".repeat(Math.max(0, width))), width),
    ];
  }

  invalidate(): void {}
}

class MindStoneFooter implements Component {
  private status = "idle";

  setStatus(status: string): void {
    this.status = status;
  }

  render(width: number): string[] {
    return [
      truncateToWidth(muted("─".repeat(Math.max(0, width))), width),
      truncateToWidth(`${gold("◆")} ${muted(this.status)} ${dim("• Enter send • /help • /clear • /exit")}`, width),
    ];
  }

  invalidate(): void {}
}

class MindStoneChatLog extends Container {
  private readonly maxComponents: number;

  constructor(maxComponents = 160) {
    super();
    this.maxComponents = maxComponents;
  }

  private append(component: Component): void {
    this.addChild(component);
    while (this.children.length > this.maxComponents) {
      const oldest = this.children[0];
      if (!oldest) return;
      this.removeChild(oldest);
    }
  }

  addSystem(text: string): void {
    this.append(new Text(muted(text), 1, 0));
  }

  addUser(text: string): void {
    this.append(new Spacer(1));
    this.append(new Text(`${gold("◆")} ${bold("you")}`, 1, 0));
    this.append(new Markdown(text, 2, 0, markdownTheme));
  }

  addAssistant(text: string): void {
    this.append(new Spacer(1));
    this.append(new Text(`${gold("◆")} ${bold(gold("mindstone"))}`, 1, 0));
    this.append(new Markdown(text || muted("(empty response)"), 2, 0, markdownTheme));
  }

  addError(text: string): void {
    this.append(new Spacer(1));
    this.append(new Text(`${red("✗")} ${bold("error")}`, 1, 0));
    this.append(new Text(red(text), 2, 0));
  }
}

function optionValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function hasOption(argv: string[], name: string): boolean {
  return argv.includes(name);
}

function resolveTuiProvider(config: ReturnType<typeof loadMindStoneConfig>["config"]): MockMindStoneProvider | PiMindStoneProvider | PiSessionMindStoneProvider {
  const mode = config?.routing?.mode ?? "placeholder";
  const paths = runtimePathsFromEnv();
  if (mode === "mock") return new MockMindStoneProvider(config?.routing?.mock);
  if (mode === "pi-session") {
    return new PiSessionMindStoneProvider({
      projectRoot: paths.root,
      agentDir: config?.routing?.pi?.agentDir ?? paths.piAgentDir,
      sessionDir: paths.piSessionDir,
      cwd: config?.workspace?.root,
      defaultModel: config?.routing?.defaultModel,
    });
  }
  if (mode === "pi") {
    return new PiMindStoneProvider({
      agentDir: config?.routing?.pi?.agentDir,
      defaultModel: config?.routing?.defaultModel,
    });
  }
  throw new Error("MindStone TUI requires routing.mode to be mock, pi-session, or pi. Current mode is placeholder; run `mindstone config` first.");
}

function resolveTuiRunner(config: ReturnType<typeof loadMindStoneConfig>["config"], provider: MockMindStoneProvider | PiMindStoneProvider | PiSessionMindStoneProvider): AgentRunner | undefined {
  return config?.routing?.mode === "pi-session" ? new PiSessionAgentRunner({ provider }) : undefined;
}

async function sendTuiTurn(params: {
  argv: string[];
  loaded: ReturnType<typeof loadMindStoneConfig>;
  ctx: TuiCommandContext;
  message: string;
}): Promise<Awaited<ReturnType<typeof runMindStoneChatTurn>>> {
  const config = params.loaded.config;
  if (!config) throw new Error(`Config not found. Run ./scripts/init-runtime.sh or mindstone onboard first. Expected: ${params.loaded.path}`);
  const provider = resolveTuiProvider(config);
  const runner = resolveTuiRunner(config, provider);
  const metadata: Record<string, unknown> = {
    source: "mindstone-tui",
    method: "tui",
  };
  const modelOverride = optionValue(params.argv, "--model");
  if (modelOverride) metadata.model = modelOverride;
  return runMindStoneChatTurn({
    agentId: params.ctx.agentId,
    sessionKey: params.ctx.sessionKey,
    message: params.message,
    config,
    configPath: params.loaded.path,
    provider,
    model: params.ctx.model,
    runner,
    source: {
      substrate: "mindstone-tui",
      channel: "terminal",
      chatType: "direct",
      senderId: "local",
    },
    metadata,
  });
}

function resolveTuiContext(argv: string[], loaded: ReturnType<typeof loadMindStoneConfig>): TuiCommandContext {
  const config = loaded.config;
  if (!config) throw new Error(`Config not found. Run ./scripts/init-runtime.sh or mindstone onboard first. Expected: ${loaded.path}`);
  const routingMode = config.routing?.mode ?? "placeholder";
  if (routingMode !== "mock" && routingMode !== "pi-session" && routingMode !== "pi") {
    throw new Error("MindStone TUI requires routing.mode to be mock, pi-session, or pi. Current mode is placeholder; run `mindstone config` first.");
  }
  const agentId = optionValue(argv, "--agent") ?? config.routing?.defaultAgentId ?? "default";
  const sessionKey = resolveConfiguredSessionKey(config, {
    agentId,
    substrate: "mindstone-tui",
    channel: "terminal",
    chatType: "direct",
    senderId: "local",
    explicitSessionKey: optionValue(argv, "--session"),
  });
  const metadata: Record<string, unknown> = {};
  const modelOverride = optionValue(argv, "--model");
  if (modelOverride) metadata.model = modelOverride;
  return {
    agentId,
    sessionKey,
    routingMode,
    model: resolveMindStoneChatModel({ config, agentId, routingMode, metadata }),
  };
}

export function createMindStoneTuiSmokeSnapshot(width = 80): string {
  const ctx: TuiCommandContext = {
    agentId: "default",
    sessionKey: "agent:default:main",
    routingMode: "mock",
    model: { id: "mindstone/mock", provider: "mock" },
  };
  const header = new MindStoneHeader(ctx);
  const chat = new MindStoneChatLog();
  const footer = new MindStoneFooter();
  chat.addSystem("Welcome back. This is the styled MindStone-Agent TUI shell.");
  chat.addUser("hello tui");
  chat.addAssistant("TUI smoke response with **markdown** and `code`.");
  footer.setStatus(`session ${ctx.sessionKey}`);
  return [...header.render(width), ...chat.render(width), ...footer.render(width)].join("\n");
}

export async function runTuiCommand(argv: string[]): Promise<void> {
  if (hasOption(argv, "--smoke")) {
    process.stdout.write(`${createMindStoneTuiSmokeSnapshot(Number(optionValue(argv, "--width") ?? 80))}\n`);
    return;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("MindStone TUI requires a TTY. Use `mindstone tui --smoke` for non-interactive validation or `mindstone chat --once` for one-shot chat.");
  }

  const paths = runtimePathsFromEnv();
  const loaded = loadMindStoneConfig(resolveConfigPath(process.env, paths));
  if (loaded.error) throw new Error(`Config error: ${loaded.error}`);
  const ctx = resolveTuiContext(argv, loaded);

  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);
  const header = new MindStoneHeader(ctx);
  const chat = new MindStoneChatLog();
  const footer = new MindStoneFooter();
  const editor = new Editor(tui, editorTheme, { paddingX: 1, autocompleteMaxVisible: 8 });
  editor.setAutocompleteProvider(new CombinedAutocompleteProvider([
    { name: "help", description: "Show TUI commands" },
    { name: "clear", description: "Clear the visible chat log" },
    { name: "status", description: "Show current TUI/session status" },
    { name: "exit", description: "Exit the TUI" },
    { name: "quit", description: "Exit the TUI" },
  ], process.cwd()));

  chat.addSystem("Welcome back. Type a message, /help, /clear, or /exit.");
  footer.setStatus(`session ${ctx.sessionKey}`);

  tui.addChild(header);
  tui.addChild(chat);
  tui.addChild(footer);
  tui.addChild(editor);
  tui.setFocus(editor);

  let responding = false;
  let stopped = false;

  await new Promise<void>((resolve) => {
    const stop = () => {
      if (stopped) return;
      stopped = true;
      tui.stop();
      resolve();
    };

    tui.addInputListener((data) => {
      if (matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.ctrl("d"))) {
        stop();
        return { consume: true };
      }
      return undefined;
    });

    editor.onSubmit = (raw: string) => {
      const message = raw.trim();
      editor.setText("");
      if (!message || responding) return;
      editor.addToHistory(message);

      if (message === "/exit" || message === "/quit") {
        stop();
        return;
      }
      if (message === "/help") {
        chat.addSystem("Commands: /help, /clear, /status, /exit. Regular text sends a MindStone turn.");
        tui.requestRender();
        return;
      }
      if (message === "/status") {
        chat.addSystem(`agent=${ctx.agentId} session=${ctx.sessionKey} route=${ctx.routingMode} model=${ctx.model.id}`);
        tui.requestRender();
        return;
      }
      if (message === "/clear") {
        chat.clear();
        chat.addSystem("Visible chat log cleared. Transcript history is preserved.");
        tui.requestRender(true);
        return;
      }

      responding = true;
      editor.disableSubmit = true;
      footer.setStatus("thinking…");
      chat.addUser(message);
      const loader = new Loader(tui, gold, muted, "MindStone is thinking…");
      chat.addChild(loader);
      tui.requestRender();

      void sendTuiTurn({ argv, loaded, ctx, message })
        .then((result) => {
          chat.removeChild(loader);
          chat.addAssistant(result.assistantEntry.text ?? "");
          footer.setStatus(`idle • ${ctx.sessionKey}`);
        })
        .catch((error) => {
          chat.removeChild(loader);
          chat.addError(error instanceof Error ? error.message : String(error));
          footer.setStatus("error");
        })
        .finally(() => {
          responding = false;
          editor.disableSubmit = false;
          tui.requestRender();
        });
    };

    tui.start();
  });
}
