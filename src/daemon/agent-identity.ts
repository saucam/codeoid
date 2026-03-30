/**
 * Agent Identity — registers Claude coding agents and sub-agents as ZeroID
 * identities with scoped, delegated tokens.
 *
 * Lifecycle:
 *   1. Session created → register agent identity in ZeroID, get token
 *   2. SubagentStart hook → register sub-agent, delegate token (attenuated)
 *   3. PreToolUse hook → audit tool call with agent's identity
 *   4. SubagentStop hook → deactivate sub-agent identity
 *   5. Session destroyed → deactivate agent identity, cascade revokes all tokens
 *
 * Delegation chain:
 *   human (owner) → codeoid session agent → sub-agent (explore, plan, etc.)
 *   Each level has scope intersection — sub-agent can only do what parent allows.
 */

import { ZeroIDClient } from "@highflame/sdk";
import type { AuthConfig } from "./auth.js";
import type { Store } from "./store.js";

export interface AgentIdentityConfig {
  auth: AuthConfig;
  /** Account + project for ZeroID tenant scoping */
  accountId: string;
  projectId: string;
}

interface RegisteredAgent {
  identityId: string;
  wimseUri: string;
  token: string;
  apiKey: string;
}

/** Tool scopes for the coding agent — maps to what actions the agent can take. */
const AGENT_TOOL_SCOPES = [
  "tools:read",     // Read, Grep, Glob
  "tools:write",    // Write, Edit
  "tools:execute",  // Bash
  "tools:agent",    // Spawn sub-agents
] as const;

/** Sub-agents get read-only by default unless explicitly promoted. */
const SUBAGENT_DEFAULT_SCOPES = ["tools:read"] as const;

/** Sub-agent scope overrides by agent type. */
const SUBAGENT_SCOPE_MAP: Record<string, readonly string[]> = {
  "general-purpose": ["tools:read", "tools:write", "tools:execute"],
  Explore: ["tools:read"],
  Plan: ["tools:read"],
};

export class AgentIdentityManager {
  #client: ZeroIDClient;
  #store: Store;
  #agents = new Map<string, RegisteredAgent>();

  constructor(config: AgentIdentityConfig, store: Store) {
    this.#client = new ZeroIDClient({
      baseUrl: config.auth.baseUrl,
      accountId: config.accountId,
      projectId: config.projectId,
    });
    this.#store = store;
  }

  /**
   * Register a coding agent identity when a session is created.
   * Returns the WIMSE URI for audit attribution.
   */
  async registerSessionAgent(
    sessionId: string,
    sessionName: string,
    ownerSub: string,
  ): Promise<{ wimseUri: string; token: string }> {
    const externalId = `codeoid-session-${sessionId.slice(0, 8)}`;

    try {
      const resp = await this.#client.agents.register({
        name: `codeoid/${sessionName}`,
        external_id: externalId,
        sub_type: "code_agent",
        trust_level: "first_party",
        framework: "claude-agent-sdk",
        publisher: "codeoid",
        created_by: ownerSub,
        metadata: JSON.stringify({ session_id: sessionId, session_name: sessionName }),
      });

      // Issue a scoped token for the agent via delegation
      const tokenResp = await this.#client.tokens.issue({
        grant_type: "api_key",
        api_key: resp.api_key,
        scope: AGENT_TOOL_SCOPES.join(" "),
      });

      const agent: RegisteredAgent = {
        identityId: resp.identity.id,
        wimseUri: resp.identity.wimse_uri,
        token: tokenResp.access_token,
        apiKey: resp.api_key,
      };

      this.#agents.set(sessionId, agent);

      this.#store.audit(
        agent.wimseUri,
        "agent.identity.registered",
        sessionId,
        `external_id=${externalId}`,
      );

      return { wimseUri: agent.wimseUri, token: agent.token };
    } catch (err) {
      // Non-fatal — identity registration is best-effort. Session still works.
      console.error(
        `[codeoid] failed to register agent identity for session ${sessionName}:`,
        err instanceof Error ? err.message : err,
      );
      return { wimseUri: `anonymous:session:${sessionId}`, token: "" };
    }
  }

  /**
   * Register a sub-agent identity when Claude spawns one (SubagentStart hook).
   * Token is delegated from the parent session agent with attenuated scopes.
   */
  async registerSubagent(
    sessionId: string,
    agentId: string,
    agentType: string,
  ): Promise<{ wimseUri: string }> {
    const parent = this.#agents.get(sessionId);
    if (!parent) {
      return { wimseUri: `anonymous:subagent:${agentId}` };
    }

    const externalId = `codeoid-subagent-${agentId.slice(0, 12)}`;
    const scopes = SUBAGENT_SCOPE_MAP[agentType] ?? SUBAGENT_DEFAULT_SCOPES;

    try {
      const resp = await this.#client.agents.register({
        name: `codeoid/${agentType}/${agentId.slice(0, 8)}`,
        external_id: externalId,
        sub_type: "tool_agent",
        trust_level: "first_party",
        framework: "claude-agent-sdk",
        publisher: "codeoid",
        created_by: parent.wimseUri,
        metadata: JSON.stringify({
          session_id: sessionId,
          parent_agent: parent.wimseUri,
          agent_type: agentType,
        }),
      });

      // Delegate token from parent — scope intersection enforced by ZeroID
      const tokenResp = await this.#client.tokens.issue({
        grant_type: "token_exchange",
        subject_token: parent.token,
        scope: scopes.join(" "),
      });

      this.#agents.set(`${sessionId}:${agentId}`, {
        identityId: resp.identity.id,
        wimseUri: resp.identity.wimse_uri,
        token: tokenResp.access_token,
        apiKey: resp.api_key,
      });

      this.#store.audit(
        resp.identity.wimse_uri,
        "subagent.identity.registered",
        sessionId,
        `type=${agentType} parent=${parent.wimseUri}`,
      );

      return { wimseUri: resp.identity.wimse_uri };
    } catch (err) {
      console.error(
        `[codeoid] failed to register subagent identity:`,
        err instanceof Error ? err.message : err,
      );
      return { wimseUri: `anonymous:subagent:${agentId}` };
    }
  }

  /**
   * Audit a tool call attributed to the session agent's identity.
   */
  auditToolCall(sessionId: string, toolName: string, _toolInput: string): void {
    const agent = this.#agents.get(sessionId);
    const sub = agent?.wimseUri ?? `anonymous:session:${sessionId}`;
    this.#store.audit(sub, "agent.tool_call", sessionId, `tool=${toolName}`);
  }

  /**
   * Deactivate a sub-agent identity (SubagentStop hook).
   */
  async deactivateSubagent(sessionId: string, agentId: string): Promise<void> {
    const key = `${sessionId}:${agentId}`;
    const agent = this.#agents.get(key);
    if (!agent) return;

    try {
      await this.#client.agents.deactivate(agent.identityId);
      this.#store.audit(agent.wimseUri, "subagent.identity.deactivated", sessionId);
    } catch {
      // Best-effort
    }
    this.#agents.delete(key);
  }

  /**
   * Deactivate a session agent identity — cascades to revoke all sub-agent tokens.
   */
  async deactivateSessionAgent(sessionId: string): Promise<void> {
    const agent = this.#agents.get(sessionId);
    if (!agent) return;

    // Deactivate all sub-agents for this session
    for (const [key, subagent] of this.#agents) {
      if (key.startsWith(`${sessionId}:`) && key !== sessionId) {
        try {
          await this.#client.agents.deactivate(subagent.identityId);
        } catch {
          // Best-effort
        }
        this.#agents.delete(key);
      }
    }

    // Deactivate the session agent itself
    try {
      await this.#client.agents.deactivate(agent.identityId);
      this.#store.audit(agent.wimseUri, "agent.identity.deactivated", sessionId);
    } catch {
      // Best-effort
    }
    this.#agents.delete(sessionId);
  }

  /**
   * Get the WIMSE URI for a session agent.
   */
  getAgentUri(sessionId: string): string | undefined {
    return this.#agents.get(sessionId)?.wimseUri;
  }
}
