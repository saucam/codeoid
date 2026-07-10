/**
 * Codex app-server client — the shared stdio JSON-RPC transport with the
 * `app-server` subcommand baked in. Wire shape verified live against
 * @openai/codex@0.144.1; see jsonrpc-stdio.ts for framing semantics.
 */

import {
  StdioJsonRpcProcess,
  type StdioJsonRpcSpawnOptions,
} from "../jsonrpc-stdio.js";

export type { JsonRpcFrame as CodexFrame } from "../jsonrpc-stdio.js";

export interface CodexSpawnOptions
  extends Omit<StdioJsonRpcSpawnOptions, "args" | "name"> {
  /** argv before `app-server` (bundled runtime entry, if any). */
  argsPrefix?: string[];
  /** Extra args after `app-server`. */
  args?: string[];
}

export class CodexRpcProcess extends StdioJsonRpcProcess {
  constructor(opts: CodexSpawnOptions) {
    const { argsPrefix, args, ...rest } = opts;
    super({
      ...rest,
      name: "codex",
      args: [...(argsPrefix ?? []), "app-server", ...(args ?? [])],
    });
  }
}
