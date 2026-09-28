import type { MindStonePrompter } from "@mindstone-agent/core";

/** Pi 0.87 login (#127): one prompt/notify interaction for api-key and OAuth flows. */
export type PiAuthPrompt = { signal?: AbortSignal } & (
  | { type: "text" | "secret" | "manual_code"; message: string; placeholder?: string }
  | { type: "select"; message: string; options: readonly { id: string; label: string; description?: string }[] }
);

export type PiAuthEvent =
  | { type: "info"; message: string; links?: readonly { url: string; label?: string }[] }
  | { type: "auth_url"; url: string; instructions?: string }
  | { type: "device_code"; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }
  | { type: "progress"; message: string };

export type PiLoginInteraction = {
  prompt(prompt: PiAuthPrompt): Promise<string>;
  notify(event: PiAuthEvent): void;
};

const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
const bold = (text: string) => `\x1b[1m${text}\x1b[0m`;

/**
 * The CLI's side of a Pi login: events are printed, prompts go to the
 * prompter. Each prompt's signal is passed on, because Pi aborts a manual-code
 * prompt when the browser callback wins; a question left pending would take
 * the wizard's next answer (#128 review). A manual code may be left empty (the
 * browser may still finish), and secrets aren't echoed.
 */
export function piLoginInteraction(
  prompter: MindStonePrompter,
  io: { write(text: string): void; openUrl(url: string): boolean },
): PiLoginInteraction {
  return {
    notify: (event) => {
      if (event.type === "auth_url") {
        const opened = io.openUrl(event.url);
        io.write(`${bold("OAuth browser login")}\n`);
        if (opened) io.write("Opened the login URL in your browser.\n");
        io.write(`${event.instructions ? `${event.instructions}\n` : ""}`);
        io.write(`${event.url}\n\n`);
      } else if (event.type === "device_code") {
        const opened = io.openUrl(event.verificationUri);
        io.write(`${bold("OAuth device login")}\n`);
        if (opened) io.write("Opened the verification URL in your browser.\n");
        io.write(`Verification URL: ${event.verificationUri}\n`);
        io.write(`Code: ${bold(event.userCode)}\n`);
        if (event.expiresInSeconds) io.write(`Expires in: ${event.expiresInSeconds}s\n`);
        io.write("\n");
      } else {
        io.write(`${dim(event.message)}\n`);
        for (const link of event.type === "info" ? event.links ?? [] : []) io.write(`${link.label ? `${link.label}: ` : ""}${link.url}\n`);
      }
    },
    prompt: async (prompt) => {
      if (prompt.type === "select") {
        if (prompt.options.length === 0) throw new Error("Login offered no options to choose from.");
        return prompter.select({
          message: prompt.message,
          options: prompt.options.map((option) => ({ value: option.id, label: option.label })),
          initialValue: prompt.options[0]?.id,
        });
      }
      return prompter.text({
        message: prompt.message,
        placeholder: prompt.placeholder,
        sensitive: prompt.type === "secret",
        signal: prompt.signal,
        validate: prompt.type === "manual_code" ? undefined : (value) => value.trim() ? undefined : "Required",
      });
    },
  };
}
