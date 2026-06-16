export type AgentId = string;

export type MindStoneIdentity = {
  agentId: AgentId;
  name: string;
  pronouns?: string;
  identityMarkdown: string;
  userMarkdown?: string;
  createdAt?: string;
  updatedAt?: string;
};
