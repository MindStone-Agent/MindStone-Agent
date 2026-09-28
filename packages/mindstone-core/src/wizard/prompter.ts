export type MindStoneSelectOption<T extends string> = {
  value: T;
  label: string;
  hint?: string;
};

export type MindStoneProgress = {
  update(message: string): void;
  stop(message?: string): void;
};

export type MindStonePrompter = {
  intro?(title: string): Promise<void> | void;
  outro?(message: string): Promise<void> | void;
  note(message: string, title?: string): Promise<void>;
  confirm(options: { message: string; initialValue?: boolean }): Promise<boolean>;
  select<T extends string>(options: {
    message: string;
    options: Array<MindStoneSelectOption<T>>;
    initialValue?: T;
  }): Promise<T>;
  text(options: {
    message: string;
    placeholder?: string;
    initialValue?: string;
    sensitive?: boolean;
    validate?: (value: string) => string | undefined;
    /** Ends the question early (rejecting), e.g. when a login finishes in the browser first. */
    signal?: AbortSignal;
  }): Promise<string>;
  progress?(label: string): MindStoneProgress;
};
