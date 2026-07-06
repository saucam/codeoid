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

import { type RegisterAgentRequest, ZeroIDClient } from "@highflame/sdk";
import { generateAgentKeypair, signActorAssertion } from "./agent-assertion.js";
import type { AuthConfig } from "./auth.js";
import { SCOPES } from "../protocol/scopes.js";
import type { Store } from "./store.js";

export interface AgentIdentityConfig {
  auth: AuthConfig;
  /** Account + project for ZeroID tenant scoping */
  accountId: string;
  projectId: string;
  /**
   * Prefix for the conductor's ZeroID external_id. Defaults to
   * "codeoid-conductor"; integration tests override it so their throwaway
   * identities are unmistakable (codeoid-conductor-test-*) and sweepable.
   */
  conductorExternalIdPrefix?: string;
}

interface RegisteredAgent {
  identityId: string;
  wimseUri: string;
  token: string;
  apiKey: string;
  /**
   * For session agents: a ZeroID client authed with THIS agent's api_key, so
   * it can act as the delegation *subject* (orchestrator) when minting
   * delegated tokens for its sub-agents via `tokens.delegate`. Undefined for
   * sub-agents (they are actors, not orchestrators).
   */
  client?: ZeroIDClient;
}

/** Tool scopes for the coding agent — maps to what actions the agent can take. */
const AGENT_TOOL_SCOPES = [
  "tools:read", // Read, Grep, Glob
  "tools:write", // Write, Edit
  "tools:execute", // Bash
  "tools:agent", // Spawn sub-agents
] as const;

/**
 * Conductor scope profile (design R1) — the conductor routes work, it never
 * does work in a target session. Fleet visibility + dispatch only; the
 * deliberate absence of `tools:write` / `tools:execute` means that even a
 * fully-delegated chain rooted at the conductor can never mint a token that
 * edits or runs anything in a target (ZeroID grants the *intersection* of the
 * subject's scopes on every hop, so what the conductor lacks its whole
 * subtree lacks — read-only-by-construction, made cryptographic).
 */
export const CONDUCTOR_SCOPES = [
  SCOPES.SESSION_READ, // list / find / summarize the fleet
  SCOPES.SESSION_DISPATCH, // direct, interrupt, or spawn sessions
] as const;

/** Sub-agents get read-only by default unless explicitly promoted. */
const SUBAGENT_DEFAULT_SCOPES = ["tools:read"] as const;

/** Sub-agent scope overrides by agent type. */
const SUBAGENT_SCOPE_MAP: Record<string, readonly string[]> = {
  "general-purpose": ["tools:read", "tools:write", "tools:execute"],
  Explore: ["tools:read"],
  Plan: ["tools:read"],
};

/**
 * The durable conductor identity (design R2). Unlike session agents — which
 * are disposable and die with their session — the conductor's identity is
 * persisted to the Store and reloaded on daemon restart, so it keeps ONE
 * stable WIMSE URI for its whole lifetime. Only the api_key rests on disk;
 * the actor keypair is regenerated per process and re-registered with ZeroID.
 */
interface RegisteredConductor {
  identityId: string;
  wimseUri: string;
  apiKey: string;
  /**
   * ZeroID client authed as the conductor — the delegation *subject* when
   * the conductor later delegates to disposable child workers (P4).
   */
  client: ZeroIDClient;
  /**
   * Signs the conductor's actor assertions so the *owner* can delegate
   * `session:read session:dispatch` to it via RFC 8693 token exchange.
   * Process-local: regenerated (and re-registered) on every boot.
   */
  privateKey: CryptoKey;
}

export interface ConductorIdentity {
  identityId: string;
  wimseUri: string;
}

export class AgentIdentityManager {
  #client: ZeroIDClient;
  #store: Store;
  #config: AgentIdentityConfig;
  #agents = new Map<string, RegisteredAgent>();
  #conductor?: RegisteredConductor;

  constructor(config: AgentIdentityConfig, store: Store) {
    this.#config = config;
    this.#client = new ZeroIDClient({
      baseUrl: config.auth.baseUrl,
      accountId: config.accountId,
      projectId: config.projectId,
    });
    this.#store = store;
  }

  /**
   * A ZeroID client authed as a specific agent (by its api_key) — used as the
   * delegation *subject* (orchestrator) when minting delegated sub-agent
   * tokens. The api_key grant makes this client speak for that identity.
   */
  #clientForAgent(apiKey: string): ZeroIDClient {
    return new ZeroIDClient({
      baseUrl: this.#config.auth.baseUrl,
      accountId: this.#config.accountId,
      projectId: this.#config.projectId,
      apiKey,
    });
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
      // The session agent is the delegation *subject*: it can only grant a
      // sub-agent scopes it holds itself, so it must be registered with the
      // full tool-scope ceiling. (`allowed_scopes`, like `public_key_pem`, is
      // server-accepted but missing from the SDK's RegisterAgentRequest type
      // through 0.3.17 — widen the literal to attach it.)
      const registerReq = {
        name: `codeoid/${sessionName}`,
        external_id: externalId,
        sub_type: "autonomous" as const,
        trust_level: "first_party" as const,
        framework: "claude-agent-sdk",
        publisher: "codeoid",
        created_by: ownerSub,
        allowed_scopes: [...AGENT_TOOL_SCOPES],
        metadata: JSON.stringify({
          session_id: sessionId,
          session_name: sessionName,
        }),
      };
      const resp = await this.#client.agents.register(
        registerReq as RegisterAgentRequest,
      );

      // Issue a scoped token for the agent via delegation
      const tokenResp = await this.#client.tokens.issueApiKey(resp.api_key, {
        scope: AGENT_TOOL_SCOPES.join(" "),
      });

      const agent: RegisteredAgent = {
        identityId: resp.identity.id,
        wimseUri: resp.identity.wimse_uri,
        token: tokenResp.access_token,
        apiKey: resp.api_key,
        // Orchestrator client — lets this session agent grant delegated
        // authority to its sub-agents (it is the delegation subject).
        client: this.#clientForAgent(resp.api_key),
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
      // The sub-agent is the delegation *actor*, so it must self-sign an actor
      // assertion — generate its EC keypair up front and register the public
      // key, which ZeroID validates the assertion against.
      const keypair = await generateAgentKeypair();
      // `public_key_pem` is accepted by ZeroID's register endpoint but is
      // absent from the SDK's RegisterAgentRequest type (through 0.3.17), so
      // widen the literal to attach it without an excess-property error.
      const registerReq = {
        name: `codeoid/${agentType}/${agentId.slice(0, 8)}`,
        external_id: externalId,
        sub_type: "tool_agent" as const,
        trust_level: "first_party" as const,
        framework: "claude-agent-sdk",
        publisher: "codeoid",
        created_by: parent.wimseUri,
        allowed_scopes: [...scopes],
        public_key_pem: keypair.publicKeyPem,
        metadata: JSON.stringify({
          session_id: sessionId,
          parent_agent: parent.wimseUri,
          agent_type: agentType,
        }),
      };
      const resp = await this.#client.agents.register(
        registerReq as RegisterAgentRequest,
      );

      // Real RFC 8693 delegation: the sub-agent self-signs an actor assertion
      // (iss = its WIMSE URI); the parent session agent (orchestrator) is the
      // *subject* and grants delegated authority via `tokens.delegate`. The
      // result carries a verifiable `act` chain (session-agent ← sub-agent)
      // and an incremented `delegation_depth`, and ZeroID enforces scope as the
      // intersection of the subject's grant and the requested `scope` — true
      // attenuation, not a cosmetic map. Deactivating the parent then
      // invalidates this token by construction (revocation-aware).
      let token = "";
      let delegated = false;
      if (parent.client) {
        try {
          const assertion = await signActorAssertion(
            keypair.privateKey,
            resp.identity.wimse_uri,
            this.#config.auth.baseUrl,
          );
          const delegatedResp = await parent.client.tokens.delegate({
            actor_token: assertion,
            scope: scopes.join(" "),
          });
          token = delegatedResp.access_token;
          delegated = true;
        } catch (err) {
          // Delegation failed — fall back to the sub-agent's own (non-
          // delegated) token so the session keeps working. The chain degrades
          // to metadata-only attribution for this sub-agent.
          console.error(
            `[codeoid] delegation failed for subagent ${agentType}, using direct token:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
      if (!delegated) {
        token = (await this.#client.tokens.issueApiKey(resp.api_key))
          .access_token;
      }

      this.#agents.set(`${sessionId}:${agentId}`, {
        identityId: resp.identity.id,
        wimseUri: resp.identity.wimse_uri,
        token,
        apiKey: resp.api_key,
      });

      this.#store.audit(
        resp.identity.wimse_uri,
        "subagent.identity.registered",
        sessionId,
        `type=${agentType} parent=${parent.wimseUri} ${
          delegated ? "delegated" : "(undelegated)"
        }`,
      );

      return { wimseUri: resp.identity.wimse_uri };
    } catch (err) {
      console.error(
        "[codeoid] failed to register subagent identity:",
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
      this.#store.audit(
        agent.wimseUri,
        "subagent.identity.deactivated",
        sessionId,
      );
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
      this.#store.audit(
        agent.wimseUri,
        "agent.identity.deactivated",
        sessionId,
      );
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

  // ── Conductor identity (durable, owner-delegated — design R1/R2) ──────

  /** The conductor's stable WIMSE URI, when one is registered/resumed. */
  get conductorUri(): string | undefined {
    return this.#conductor?.wimseUri;
  }

  /**
   * Ensure the durable conductor identity exists: reuse the in-memory one,
   * else reload the persisted one from the Store, else register a fresh
   * identity in ZeroID (scope ceiling = CONDUCTOR_SCOPES) and persist it.
   * Best-effort like the rest of the identity layer — returns null on
   * failure so the daemon keeps working without a conductor identity.
   */
  async registerConductor(ownerSub: string): Promise<ConductorIdentity | null> {
    const resumed = await this.resumeConductor();
    if (resumed) return resumed;

    const prefix = this.#config.conductorExternalIdPrefix ?? "codeoid-conductor";
    // Unique per registration — durability comes from the Store row, not from
    // external_id reuse (a deactivated identity keeps its external_id, so a
    // stable one would collide on legitimate re-registration).
    const externalId = `${prefix}-${crypto.randomUUID().slice(0, 8)}`;

    try {
      // The conductor is both a delegation *actor* (the owner delegates
      // session:read/session:dispatch TO it) and a future *subject* (it
      // delegates onward to disposable child workers) — so it registers a
      // public key for actor assertions AND gets an api_key for the
      // orchestrator client. (`allowed_scopes` / `public_key_pem` are
      // server-accepted but missing from the SDK type through 0.3.17.)
      const keypair = await generateAgentKeypair();
      const registerReq = {
        name: "codeoid/conductor",
        external_id: externalId,
        sub_type: "orchestrator" as const,
        trust_level: "first_party" as const,
        framework: "claude-agent-sdk",
        publisher: "codeoid",
        created_by: ownerSub,
        allowed_scopes: [...CONDUCTOR_SCOPES],
        public_key_pem: keypair.publicKeyPem,
        metadata: JSON.stringify({ role: "conductor", owner: ownerSub }),
      };
      const resp = await this.#client.agents.register(
        registerReq as RegisterAgentRequest,
      );

      this.#conductor = {
        identityId: resp.identity.id,
        wimseUri: resp.identity.wimse_uri,
        apiKey: resp.api_key,
        client: this.#clientForAgent(resp.api_key),
        privateKey: keypair.privateKey,
      };
      this.#store.saveConductorIdentity({
        accountId: this.#config.accountId,
        projectId: this.#config.projectId,
        identityId: resp.identity.id,
        wimseUri: resp.identity.wimse_uri,
        apiKey: resp.api_key,
      });

      this.#store.audit(
        resp.identity.wimse_uri,
        "conductor.identity.registered",
        undefined,
        `external_id=${externalId} owner=${ownerSub}`,
      );

      return { identityId: resp.identity.id, wimseUri: resp.identity.wimse_uri };
    } catch (err) {
      console.error(
        "[codeoid] failed to register conductor identity:",
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  /**
   * Reload the persisted conductor identity on daemon restart (called from
   * SessionManager.resumeSessions). Reuses the stored identity — same
   * identityId, same WIMSE URI — instead of re-registering, and rotates the
   * process-local actor keypair with ZeroID so owner→conductor delegation
   * keeps working. Returns null when nothing is persisted or the stored
   * identity is no longer usable (deactivated / api_key revoked), in which
   * case the stale row is dropped so the next registerConductor starts clean.
   */
  async resumeConductor(): Promise<ConductorIdentity | null> {
    if (this.#conductor) {
      return {
        identityId: this.#conductor.identityId,
        wimseUri: this.#conductor.wimseUri,
      };
    }

    const row = this.#store.getConductorIdentity(
      this.#config.accountId,
      this.#config.projectId,
    );
    if (!row) return null;

    try {
      // Liveness probe: minting from the api_key fails iff the identity was
      // deactivated or the key revoked — exactly the cases where the stored
      // row is dead and a fresh registration is the right call.
      await this.#client.tokens.issueApiKey(row.apiKey);
    } catch (err) {
      console.error(
        "[codeoid] persisted conductor identity is no longer usable, dropping:",
        err instanceof Error ? err.message : err,
      );
      this.#store.deleteConductorIdentity(
        this.#config.accountId,
        this.#config.projectId,
      );
      this.#store.audit(
        row.wimseUri,
        "conductor.identity.dropped_stale",
        undefined,
        `identity_id=${row.identityId}`,
      );
      return null;
    }

    // The previous process's actor private key died with it — register a
    // fresh public key under the SAME identity so assertions keep verifying.
    // Durable identity, ephemeral keys.
    const keypair = await generateAgentKeypair();
    try {
      await this.#client.identities.update(row.identityId, {
        public_key_pem: keypair.publicKeyPem,
      });
    } catch (err) {
      // Keep the resumed identity (URI stability wins) — delegation will
      // surface a clear assertion-verification error if this mattered.
      console.error(
        "[codeoid] failed to rotate conductor actor key (delegation may fail):",
        err instanceof Error ? err.message : err,
      );
    }

    this.#conductor = {
      identityId: row.identityId,
      wimseUri: row.wimseUri,
      apiKey: row.apiKey,
      client: this.#clientForAgent(row.apiKey),
      privateKey: keypair.privateKey,
    };

    this.#store.audit(
      row.wimseUri,
      "conductor.identity.resumed",
      undefined,
      `identity_id=${row.identityId}`,
    );

    return { identityId: row.identityId, wimseUri: row.wimseUri };
  }

  /**
   * Mint the conductor's working token by OWNER delegation (RFC 8693): the
   * owner's subject token grants, the conductor's self-signed assertion
   * acts. The result carries `delegation_depth: 1`, an `act` chain rooted at
   * the owner, and at most CONDUCTOR_SCOPES (three-way scope intersection) —
   * so the conductor acts on the owner's behalf, never on its own authority,
   * and deactivating either end kills the token.
   */
  async mintConductorToken(ownerSubjectToken: string): Promise<string | null> {
    const conductor = this.#conductor;
    if (!conductor) return null;

    try {
      const assertion = await signActorAssertion(
        conductor.privateKey,
        conductor.wimseUri,
        this.#config.auth.baseUrl,
      );
      const resp = await this.#client.tokens.issueTokenExchange(
        ownerSubjectToken,
        assertion,
        { scope: CONDUCTOR_SCOPES.join(" ") },
      );
      this.#store.audit(
        conductor.wimseUri,
        "conductor.token.delegated",
        undefined,
        `scope=${resp.scope ?? ""}`,
      );
      return resp.access_token;
    } catch (err) {
      console.error(
        "[codeoid] owner->conductor delegation failed:",
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  /**
   * Deactivate the conductor identity. ZeroID cascade-revokes every active
   * credential in its delegation subtree (owner-delegated conductor token,
   * child-worker tokens, their sub-agent tokens) via the parent_jti chain —
   * one call kills the whole tree. Clears the persisted row so the next
   * registerConductor starts a fresh identity.
   */
  async deactivateConductor(): Promise<void> {
    const conductor = this.#conductor;
    const row =
      conductor ??
      this.#store.getConductorIdentity(
        this.#config.accountId,
        this.#config.projectId,
      );
    if (!row) return;

    try {
      await this.#client.agents.deactivate(row.identityId);
      this.#store.audit(
        row.wimseUri,
        "conductor.identity.deactivated",
        undefined,
        `identity_id=${row.identityId}`,
      );
    } catch (err) {
      console.error(
        "[codeoid] failed to deactivate conductor identity:",
        err instanceof Error ? err.message : err,
      );
    }
    this.#store.deleteConductorIdentity(
      this.#config.accountId,
      this.#config.projectId,
    );
    this.#conductor = undefined;
  }
}
