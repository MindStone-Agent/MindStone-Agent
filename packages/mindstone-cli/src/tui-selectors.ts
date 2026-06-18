import {
  listTranscriptSessions,
  loadMindStoneConfig,
  runtimePathsFromEnv,
} from "@mindstone-agent/core";
import { type TuiCommandContext } from "./tui-panels.js";
import {
  Input,
  Key,
  matchesKey,
  SelectList,
  truncateToWidth,
  type Component,
  type SelectItem,
  type SelectListTheme,
} from "../../../vendor/pi/packages/tui/dist/index.js";

const reset = "\x1b[0m";
const ansi = (code: string) => (text: string) => `${code}${text}${reset}`;
const gold = ansi("\x1b[38;5;214m");
const muted = ansi("\x1b[38;5;244m");
const dim = ansi("\x1b[2m");
const bold = ansi("\x1b[1m");

export const selectListTheme: SelectListTheme = {
  selectedPrefix: gold,
  selectedText: (text) => bold(gold(text)),
  description: muted,
  scrollInfo: dim,
  noMatch: muted,
};

export type TuiCommandLike = {
  name: string;
  description: string;
  usage?: string;
};

export class MindStoneSelectOverlay implements Component {
  private readonly allItems: SelectItem[];
  private readonly input = new Input();
  private selectList: SelectList;
  private selectHandler: ((item: SelectItem) => void) | undefined;
  private cancelHandler: (() => void) | undefined;

  constructor(private readonly title: string, items: SelectItem[], private readonly hint: string) {
    this.allItems = items;
    this.selectList = this.createSelectList(items);
  }

  set onSelect(handler: ((item: SelectItem) => void) | undefined) {
    this.selectHandler = handler;
    this.selectList.onSelect = handler;
  }

  set onCancel(handler: (() => void) | undefined) {
    this.cancelHandler = handler;
    this.selectList.onCancel = handler;
  }

  private createSelectList(items: SelectItem[]): SelectList {
    const list = new SelectList(items, 9, selectListTheme, { maxPrimaryColumnWidth: 34 });
    list.onSelect = this.selectHandler;
    list.onCancel = this.cancelHandler;
    return list;
  }

  private applyFilter(): void {
    const query = this.input.getValue().trim().toLowerCase();
    if (!query) {
      this.selectList = this.createSelectList(this.allItems);
      return;
    }
    const terms = query.split(/\s+/).filter(Boolean);
    const filtered = this.allItems.filter((item) => {
      const haystack = [item.value, item.label, item.description].filter(Boolean).join(" ").toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
    this.selectList = this.createSelectList(filtered);
  }

  render(width: number): string[] {
    const filterLabel = muted("filter: ");
    const inputLines = this.input.render(Math.max(1, width - 8));
    return [
      truncateToWidth(`${gold("◆")} ${bold(gold(this.title))}`, width),
      truncateToWidth(muted(this.hint), width),
      `${filterLabel}${inputLines[0] ?? ""}`,
      truncateToWidth(muted("─".repeat(Math.max(0, width))), width),
      ...this.selectList.render(width),
    ];
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.up) || matchesKey(data, Key.ctrl("p")) || (!this.input.getValue().trim() && data === "k")) {
      this.selectList.handleInput("\x1b[A");
      return;
    }
    if (matchesKey(data, Key.down) || matchesKey(data, Key.ctrl("n")) || (!this.input.getValue().trim() && data === "j")) {
      this.selectList.handleInput("\x1b[B");
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const selected = this.selectList.getSelectedItem();
      if (selected) this.selectHandler?.(selected);
      return;
    }
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      if (this.input.getValue()) {
        this.input.setValue("");
        this.applyFilter();
      } else {
        this.cancelHandler?.();
      }
      return;
    }
    const before = this.input.getValue();
    this.input.handleInput(data);
    if (this.input.getValue() !== before) this.applyFilter();
  }

  invalidate(): void {
    this.input.invalidate();
    this.selectList.invalidate();
  }
}

function uniqueTuiValues(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))));
}

export function tuiCommandSelectItems(commands: TuiCommandLike[]): SelectItem[] {
  return commands.map((command) => ({
    value: `/${command.name}`,
    label: `/${command.name}${command.usage ? ` ${command.usage}` : ""}`,
    description: command.description,
  }));
}

export function tuiAgentSelectItems(config: ReturnType<typeof loadMindStoneConfig>["config"], ctx: TuiCommandContext): SelectItem[] {
  return uniqueTuiValues([
    ctx.agentId,
    config?.routing?.defaultAgentId,
    ...Object.keys(config?.agents ?? {}),
  ]).sort((a, b) => a.localeCompare(b)).map((id) => {
    const agent = config?.agents?.[id];
    const detail = [
      id === ctx.agentId ? "current" : undefined,
      id === config?.routing?.defaultAgentId ? "default" : undefined,
      agent?.profileId ? `profile ${agent.profileId}` : undefined,
      agent?.defaultModel ? `model ${agent.defaultModel}` : undefined,
    ].filter(Boolean).join("; ");
    return { value: id, label: id, description: detail };
  });
}

export function tuiModelSelectItems(config: ReturnType<typeof loadMindStoneConfig>["config"], ctx: TuiCommandContext): SelectItem[] {
  const agent = config?.agents?.[ctx.agentId];
  const agentDefaults = Object.values(config?.agents ?? {}).map((configuredAgent) => configuredAgent.defaultModel);
  return uniqueTuiValues([
    ctx.model.id,
    agent?.defaultModel,
    config?.routing?.defaultModel,
    ...agentDefaults,
    ctx.routingMode === "mock" ? "mindstone/mock" : undefined,
  ]).sort((a, b) => a.localeCompare(b)).map((id) => ({
    value: id,
    label: id,
    description: [
      id === ctx.model.id ? "current" : undefined,
      id === config?.routing?.defaultModel ? "routing default" : undefined,
      id === agent?.defaultModel ? "agent default" : undefined,
    ].filter(Boolean).join("; "),
  }));
}

export function tuiSessionSelectItems(params: {
  config: ReturnType<typeof loadMindStoneConfig>["config"];
  ctx: TuiCommandContext;
  paths: ReturnType<typeof runtimePathsFromEnv>;
}): SelectItem[] {
  const defaultSession = params.config?.session?.defaultSessionKey;
  const mode = params.config?.session?.mode ?? "single";
  const byKey = new Map<string, SelectItem>();
  for (const key of uniqueTuiValues([params.ctx.sessionKey, defaultSession])) {
    byKey.set(key, {
      value: key,
      label: key,
      description: [key === params.ctx.sessionKey ? "current" : undefined, key === defaultSession ? "default" : undefined, `mode ${mode}`].filter(Boolean).join("; "),
    });
  }
  for (const session of listTranscriptSessions({ paths: params.paths }).slice(0, 30)) {
    const existing = byKey.get(session.sessionKey);
    const detail = `${session.entries} entr${session.entries === 1 ? "y" : "ies"}${session.updatedAt ? `; updated ${session.updatedAt}` : ""}`;
    byKey.set(session.sessionKey, {
      value: session.sessionKey,
      label: session.sessionKey,
      description: existing?.description ? `${existing.description}; ${detail}` : detail,
    });
  }
  return Array.from(byKey.values()).sort((a, b) => Number(a.value !== params.ctx.sessionKey) - Number(b.value !== params.ctx.sessionKey) || a.value.localeCompare(b.value));
}
