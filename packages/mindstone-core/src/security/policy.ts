export type DmPolicy = "pairing" | "allowlist" | "open" | "disabled";

export type SenderPolicyDecision = {
  allowed: boolean;
  reason: string;
};

export function decideSenderPolicy(input: {
  policy: DmPolicy;
  senderId: string;
  allowFrom?: string[];
}): SenderPolicyDecision {
  if (input.policy === "disabled") return { allowed: false, reason: "dm disabled" };
  if (input.policy === "open") return { allowed: true, reason: "open policy" };
  const allowFrom = input.allowFrom ?? [];
  if (allowFrom.includes("*") || allowFrom.includes(input.senderId)) {
    return { allowed: true, reason: "sender allowlisted" };
  }
  if (input.policy === "pairing") return { allowed: false, reason: "pairing required" };
  return { allowed: false, reason: "sender not allowlisted" };
}
