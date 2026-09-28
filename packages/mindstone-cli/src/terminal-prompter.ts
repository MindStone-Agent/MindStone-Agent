import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { formatMindStoneConfigHeader, type MindStonePrompter, type MindStoneSelectOption } from "@mindstone-agent/core";

/**
 * The CLI's terminal prompter, in its own module so a smoke can drive it over
 * piped streams (#127): the default is the process's stdin and stdout.
 */
export type TerminalIo = {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
};

const gold = (text: string) => `\x1b[38;5;220m${text}\x1b[0m`;
const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
const bold = (text: string) => `\x1b[1m${text}\x1b[0m`;

function arrowOptionLines<T extends string>(
  options: Array<MindStoneSelectOption<T>>,
  selectedIndex: number,
): string[] {
  return options.map((option, index) => {
    const selected = index === selectedIndex;
    const pointer = selected ? gold("◆") : " ";
    const label = selected ? bold(gold(option.label)) : option.label;
    const hint = option.hint ? dim(` — ${option.hint}`) : "";
    return ` ${pointer} ${label}${hint}`;
  });
}

function selectWithArrows<T extends string>(io: TerminalIo, params: {
  message: string;
  options: Array<MindStoneSelectOption<T>>;
  initialValue?: T;
  prefixLines?: string[];
}): Promise<T> {
  const { input, output } = io;
  if (!input.isTTY || !output.isTTY) {
    return Promise.resolve(
      params.options.find((option) => option.value === params.initialValue)?.value ?? params.options[0].value,
    );
  }

  let selectedIndex = Math.max(
    0,
    params.initialValue ? params.options.findIndex((option) => option.value === params.initialValue) : 0,
  );
  if (selectedIndex < 0) selectedIndex = 0;
  let renderedLines = 0;

  const render = () => {
    if (renderedLines > 0) output.write(`\x1b[${renderedLines}A\x1b[0J`);
    const lines = [
      ...(params.prefixLines?.length ? [...params.prefixLines, ""] : []),
      bold(params.message),
      dim("Use ↑/↓ arrows, Enter to select, Ctrl+C to cancel."),
      ...arrowOptionLines(params.options, selectedIndex),
    ];
    renderedLines = lines.length;
    output.write(`${lines.join("\n")}\n`);
  };

  return new Promise<T>((resolve, reject) => {
    const wasRaw = input.isRaw;
    input.setRawMode(true);
    input.resume();
    output.write("\x1b[?25l");

    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode(wasRaw);
      output.write("\x1b[?25h");
    };

    const finish = (value: T) => {
      cleanup();
      output.write("\n");
      resolve(value);
    };

    const onData = (chunk: Buffer) => {
      const data = chunk.toString("utf8");
      if (data === "\u0003") {
        cleanup();
        output.write("\n");
        reject(new Error("Cancelled"));
        return;
      }
      if (data === "\r" || data === "\n") {
        finish(params.options[selectedIndex].value);
        return;
      }
      if (data === "\u001b[A" || data === "k" || data === "\u0010") {
        selectedIndex = (selectedIndex - 1 + params.options.length) % params.options.length;
        render();
        return;
      }
      if (data === "\u001b[B" || data === "j" || data === "\u000e") {
        selectedIndex = (selectedIndex + 1) % params.options.length;
        render();
      }
    };

    input.on("data", onData);
    render();
  });
}

function inputHidden(io: TerminalIo, message: string, placeholder?: string, signal?: AbortSignal): Promise<string> {
  const { input, output } = io;
  if (signal?.aborted) return Promise.reject(new Error("Cancelled"));
  if (!input.isTTY || !output.isTTY) return Promise.resolve("");
  output.write(`${message}${placeholder ? ` [${placeholder}]` : ""}: `);
  return new Promise<string>((resolve, reject) => {
    const wasRaw = input.isRaw;
    let value = "";
    input.setRawMode(true);
    input.resume();
    const onAbort = () => {
      cleanup();
      output.write("\n");
      reject(new Error("Cancelled"));
    };
    const cleanup = () => {
      input.off("data", onData);
      signal?.removeEventListener("abort", onAbort);
      input.setRawMode(wasRaw);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    // A chunk can hold several keys: a pasted key arrives with its newline in
    // one chunk. Enter or Ctrl-D ends the prompt, Ctrl-C cancels, backspace
    // deletes, other control keys are ignored, and a chunk that is an escape
    // sequence (an arrow key) is dropped (#131).
    const onData = (chunk: Buffer) => {
      const data = chunk.toString("utf8");
      if (data.startsWith("\u001b")) return;
      for (const ch of data) {
        if (ch === "\u0003") {
          cleanup();
          output.write("\n");
          reject(new Error("Cancelled"));
          return;
        }
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          cleanup();
          output.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          value = Array.from(value).slice(0, -1).join("");
          continue;
        }
        if (ch < " ") continue;
        value += ch;
      }
    };
    input.on("data", onData);
  });
}

export function makeTerminalPrompter(io: TerminalIo = { input: stdin, output: stdout }): MindStonePrompter & { close(): void } {
  const { input, output } = io;
  let rl = createInterface({ input, output });
  const pageMode = input.isTTY && output.isTTY && process.env.MINDSTONE_AGENT_SCROLL_ONBOARDING !== "1";
  let pendingPageLines: string[] = [];

  const clearPage = () => {
    if (pageMode) output.write("\x1b[2J\x1b[H");
  };
  const consumePagePrefix = (): string[] => {
    const lines = pendingPageLines;
    pendingPageLines = [];
    if (pageMode) clearPage();
    return lines;
  };
  const pushPageNote = (message: string, title?: string) => {
    if (title) pendingPageLines.push(bold(title));
    pendingPageLines.push(message);
  };
  // A cancelled prompt (Pi aborts a manual-code prompt when the browser login
  // wins) must end its pending question, or it takes the next answer (#127).
  const ask = async (question: string, signal?: AbortSignal): Promise<string> =>
    (await (signal ? rl.question(question, { signal }) : rl.question(question))).trim();
  // On a real terminal the readline echoes whatever is typed, even paused, so
  // it is closed while a secret is read and a fresh one is made after (#129).
  const hidden = async (message: string, placeholder?: string, signal?: AbortSignal): Promise<string> => {
    rl.close();
    try {
      return await inputHidden(io, message, placeholder, signal);
    } finally {
      rl = createInterface({ input, output });
    }
  };

  return {
    close: () => rl.close(),
    intro: async (title) => {
      if (pageMode) clearPage();
      output.write(`${gold(formatMindStoneConfigHeader())}\n`);
      output.write(`${bold(title)}\n\n`);
    },
    outro: async (message) => {
      const prefix = consumePagePrefix();
      if (prefix.length) output.write(`${prefix.join("\n")}\n\n`);
      output.write(`${gold("🔶")} ${message}\n`);
    },
    note: async (message, title) => {
      if (pageMode) {
        pushPageNote(message, title);
        return;
      }
      if (title) output.write(`${bold(title)}\n`);
      output.write(`${message}\n\n`);
    },
    confirm: async ({ message, initialValue }) => {
      rl.pause();
      try {
        return (
          (await selectWithArrows(io, {
            message,
            options: [
              { value: "yes", label: "Yes" },
              { value: "no", label: "No" },
            ],
            initialValue: initialValue ? "yes" : "no",
            prefixLines: consumePagePrefix(),
          })) === "yes"
        );
      } finally {
        rl.resume();
      }
    },
    select: async <T extends string>({ message, options, initialValue }: {
      message: string;
      options: Array<MindStoneSelectOption<T>>;
      initialValue?: T;
    }): Promise<T> => {
      rl.pause();
      try {
        return await selectWithArrows(io, { message, options, initialValue, prefixLines: consumePagePrefix() });
      } finally {
        rl.resume();
      }
    },
    text: async ({ message, placeholder, initialValue, sensitive, validate, signal }) => {
      const fallback = initialValue ?? "";
      const prefix = consumePagePrefix();
      if (prefix.length) output.write(`${prefix.join("\n")}\n\n`);
      const value = sensitive ? await hidden(message, placeholder, signal) : await ask(`${message}${fallback || placeholder ? ` [${fallback || placeholder}]` : ""}: `, signal);
      const resolved = value || fallback;
      const issue = validate?.(resolved);
      if (issue) throw new Error(issue);
      return resolved;
    },
  };
}

