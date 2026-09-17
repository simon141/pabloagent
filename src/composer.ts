import type { EnterBehavior } from "./types";

export interface ComposerDraft {
  text: string;
  multiline: boolean;
}

export function composerDraft(
  text: string,
  previous?: ComposerDraft,
): ComposerDraft {
  return {
    text,
    multiline: !!text && (!!previous?.multiline || /[\r\n]/.test(text)),
  };
}

export function enterSends(
  behavior: EnterBehavior,
  multiline: boolean,
): boolean {
  return behavior === "send" || (behavior === "auto" && !multiline);
}
