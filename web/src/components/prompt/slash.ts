/**
 * Re-export shim — the slash-command parser/dispatcher lives in
 * `@codeoid/core` (SlashContext is dependency-injected, so the logic is
 * frontend-agnostic).
 */
export { dispatchSlash, parseSlash } from "@codeoid/core";
export type { SlashCommand, SlashContext } from "@codeoid/core";
