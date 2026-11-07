import { create } from "zustand";

/** The main composer's "Send on an event", for the command palette, which renders outside it. */
interface SendOnEventEntry {
  /** Why it cannot schedule this message yet, such as an attachment. */
  readonly disabledReason: string | null;
  readonly open: () => void;
}

/** Holds an entry only while that composer has a message it could schedule. */
export const useSendOnEventEntry = create<{ readonly entry: SendOnEventEntry | null }>(() => ({
  entry: null,
}));
