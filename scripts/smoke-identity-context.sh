#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "== Route identity context smoke test =="

npm run build:mindstone

node <<'NODE'
import { runMindStoneRoute } from '@mindstone-agent/core';

const seen = { messages: undefined };
const provider = {
  id: 'identity-smoke-provider',
  listModels() {
    return [{ id: 'identity-smoke-model', provider: 'identity-smoke-provider', contextWindowTokens: 4096 }];
  },
  async completeChat(request) {
    seen.messages = request.messages;
    return {
      role: 'assistant',
      text: 'identity context smoke response',
      model: request.model,
    };
  },
};

const result = await runMindStoneRoute({
  agentId: 'default',
  sessionKey: 'agent:default:main',
  entries: [{
    id: 'user-1',
    timestamp: new Date().toISOString(),
    sessionKey: 'agent:default:main',
    agentId: 'default',
    role: 'user',
    text: 'hello identity smoke',
  }],
  model: { id: 'identity-smoke-model', provider: 'identity-smoke-provider', contextWindowTokens: 4096 },
  provider,
  identityContext: {
    name: 'Sentinel Smoke Agent',
    identityMarkdown: '# Sentinel Smoke Agent\n\nIdentity sentinel: ORANGE-DIAMOND-IDENTITY.',
    userMarkdown: '# Sentinel User\n\nUser sentinel: BLUE-SLATE-USER.',
    identityPath: '/tmp/IDENTITY.md',
    userPath: '/tmp/USER.md',
  },
});

if (!Array.isArray(seen.messages)) throw new Error('Provider did not receive messages');
if (seen.messages[0]?.role !== 'system') throw new Error('First message was not identity system context');
if (!seen.messages[0].text.includes('ORANGE-DIAMOND-IDENTITY')) throw new Error('Identity sentinel missing from provider messages');
if (!seen.messages[0].text.includes('BLUE-SLATE-USER')) throw new Error('User sentinel missing from provider messages');
if (seen.messages.at(-1)?.text !== 'hello identity smoke') throw new Error('User transcript message missing from provider messages');
if (!result.identityContext?.injected) throw new Error('Route result did not report injected identity context');
if (result.identityContext.name !== 'Sentinel Smoke Agent') throw new Error('Identity context name missing');
if (!result.identityContext.tokenEstimate || result.identityContext.tokenEstimate <= 0) throw new Error('Identity token estimate missing');

console.log(JSON.stringify({
  ok: true,
  messages: seen.messages.length,
  identityContext: result.identityContext,
}, null, 2));
NODE

echo "Route identity context smoke test passed."
