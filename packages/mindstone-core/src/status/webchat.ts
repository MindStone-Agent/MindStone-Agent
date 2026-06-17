import type { MindStoneConfig } from "../config/index.js";
import { resolveDefaultSessionKey } from "../routing/session.js";

export type MindStoneWebChatStatus = {
  enabled: true;
  path: "/webchat";
  url: string;
  apiAuthApplies: boolean;
  defaultSessionKey: string;
  source: {
    substrate: "gateway-rest";
    channel: "webchat";
    chatType: "internal";
  };
};

export function getMindStoneWebChatStatus(config: MindStoneConfig | undefined): MindStoneWebChatStatus {
  const host = config?.gateway?.host ?? "127.0.0.1";
  const port = config?.gateway?.port ?? 19789;
  const defaultSessionKey = resolveDefaultSessionKey(config);
  return {
    enabled: true,
    path: "/webchat",
    url: `http://${host}:${port}/webchat`,
    apiAuthApplies: true,
    defaultSessionKey,
    source: {
      substrate: "gateway-rest",
      channel: "webchat",
      chatType: "internal",
    },
  };
}
