import type { MindStoneConfig } from "../config/types.js";
import type { MindStonePrompter } from "../wizard/prompter.js";

export type ChannelId = string;

export type ChannelCapabilities = {
  chatTypes?: Array<"direct" | "group" | "channel" | "thread">;
  media?: boolean;
  reactions?: boolean;
  threads?: boolean;
  polls?: boolean;
  nativeCommands?: boolean;
};

export type ChannelMeta = {
  id: ChannelId;
  label: string;
  blurb?: string;
  docsPath?: string;
  order?: number;
};

export type ChannelStatus = {
  channel: ChannelId;
  configured: boolean;
  running?: boolean;
  lastError?: string | null;
};

export type ChannelOnboardingAdapter = {
  configure(ctx: { cfg: MindStoneConfig; prompter: MindStonePrompter }): Promise<{ cfg: MindStoneConfig; accountId?: string }>;
  disable?(cfg: MindStoneConfig): MindStoneConfig;
};

export type ChannelPlugin<Account = unknown> = {
  id: ChannelId;
  meta: ChannelMeta;
  capabilities: ChannelCapabilities;
  onboarding?: ChannelOnboardingAdapter;
  resolveAccounts?(cfg: MindStoneConfig): Account[];
  status?(cfg: MindStoneConfig): Promise<ChannelStatus>;
};
