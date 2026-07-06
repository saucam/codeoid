/**
 * Conductor identity integration test — P2 exit criteria, run against a LIVE
 * ZeroID (default http://localhost:8899, override with ZEROID_URL):
 *
 *   1. Durable identity: registerConductor persists {identityId, wimseUri,
 *      apiKey} to the Store; a fresh manager (simulated daemon restart)
 *      resumes the SAME identity — one stable WIMSE URI.
 *   2. Owner delegation: the owner's token delegates to the conductor via
 *      RFC 8693; the chain owner → conductor → child → sub-agent mints at
 *      delegation_depth 3 with a verifiable act chain at every hop.
 *   3. Attenuation: no hop can mint tools:write / tools:execute — the
 *      conductor's scope ceiling caps its whole subtree.
 *   4. Cascading revocation: deactivating the conductor kills the subtree
 *      (conductor/child/sub-agent tokens all introspect inactive) while the
 *      owner's own token stays live.
 *
 * NOT in the default `bun test` globs (CI has no ZeroID) — run with
 * `bun run test:integration`. Skips itself when ZeroID is unreachable or no
 * real (account_id, project_id) can be resolved. Every identity registered
 * here uses external_id `codeoid-conductor-test-*` and is deactivated in
 * afterAll.
 */

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { type RegisterAgentRequest, ZeroIDClient } from "@highflame/sdk";
import {
  generateAgentKeypair,
  signActorAssertion,
} from "../daemon/agent-assertion.js";
import {
  AgentIdentityManager,
  CONDUCTOR_SCOPES,
} from "../daemon/agent-identity.js";
import { Store } from "../daemon/store.js";
import { ALL_SCOPES_STRING } from "../protocol/scopes.js";

const BASE_URL = process.env.ZEROID_URL ?? "http://localhost:8899";
const TIMEOUT = 30_000;

async function zeroidUp(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * A real (account_id, project_id) — env override first, else the most-used
 * tenant in the local ~/.codeoid/codeoid.db sessions table.
 */
function resolveTenant(): { accountId: string; projectId: string } | null {
  const envAccount = process.env.ZEROID_TEST_ACCOUNT;
  const envProject = process.env.ZEROID_TEST_PROJECT;
  if (envAccount && envProject) {
    return { accountId: envAccount, projectId: envProject };
  }
  const dbPath = join(homedir(), ".codeoid", "codeoid.db");
  if (!existsSync(dbPath)) return null;
  try {
    const db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare(
        `SELECT account_id AS accountId, project_id AS projectId
         FROM sessions GROUP BY account_id, project_id
         ORDER BY COUNT(*) DESC LIMIT 1`,
      )
      .get() as { accountId: string; projectId: string } | null;
    db.close();
    return row ?? null;
  } catch {
    return null;
  }
}

const up = await zeroidUp();
const tenant = up ? resolveTenant() : null;
const ready = up && tenant !== null;
if (!up) {
  console.warn(
    `[conductor-integration] skipping — ZeroID not reachable at ${BASE_URL}`,
  );
} else if (!tenant) {
  console.warn(
    "[conductor-integration] skipping — no tenant in ~/.codeoid/codeoid.db and no ZEROID_TEST_ACCOUNT/ZEROID_TEST_PROJECT",
  );
}

const d = ready ? describe : describe.skip;

d("conductor identity against live ZeroID (P2)", () => {
  const { accountId, projectId } = tenant!;
  const run = crypto.randomUUID().slice(0, 8);
  const client = new ZeroIDClient({ baseUrl: BASE_URL, accountId, projectId });

  const tmpDir = mkdtempSync(join(tmpdir(), "codeoid-conductor-it-"));
  const store = new Store(join(tmpDir, "store.db"));
  const managerConfig = {
    auth: { baseUrl: BASE_URL },
    accountId,
    projectId,
    conductorExternalIdPrefix: "codeoid-conductor-test",
  };

  /** Identity ids to deactivate in afterAll, whatever state the run died in. */
  const cleanupIds: string[] = [];

  let owner: { identityId: string; wimseUri: string; apiKey: string };
  let manager2: AgentIdentityManager;
  let conductor: { identityId: string; wimseUri: string };
  let ownerToken = "";
  let conductorToken = "";
  let childToken = "";
  let subagentToken = "";

  afterAll(async () => {
    for (const id of cleanupIds) {
      try {
        await client.agents.deactivate(id);
      } catch {
        // Best-effort — already deactivated by the test itself is the norm.
      }
    }
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Register a throwaway `codeoid-conductor-test-*` actor identity with a
   * fresh keypair, so it can appear as an RFC 8693 actor in the chain.
   */
  async function registerActor(
    role: string,
    allowedScopes: string[],
    createdBy: string,
  ) {
    const keypair = await generateAgentKeypair();
    const registerReq = {
      name: `codeoid-test/${role}`,
      external_id: `codeoid-conductor-test-${role}-${run}`,
      sub_type: "tool_agent" as const,
      trust_level: "first_party" as const,
      framework: "claude-agent-sdk",
      publisher: "codeoid",
      created_by: createdBy,
      allowed_scopes: allowedScopes,
      public_key_pem: keypair.publicKeyPem,
    };
    const resp = await client.agents.register(
      registerReq as RegisterAgentRequest,
    );
    cleanupIds.push(resp.identity.id);
    return {
      identityId: resp.identity.id,
      wimseUri: resp.identity.wimse_uri,
      apiKey: resp.api_key,
      keypair,
    };
  }

  test(
    "registerConductor persists a durable identity to the Store",
    async () => {
      // The delegation root: a stand-in for the human owner, holding the
      // full codeoid scope set the way a real owner token does.
      const ownerReq = {
        name: "codeoid-test/owner",
        external_id: `codeoid-conductor-test-owner-${run}`,
        sub_type: "human_proxy" as const,
        trust_level: "first_party" as const,
        framework: "claude-agent-sdk",
        publisher: "codeoid",
        // created_by becomes the identity's required owner_user_id.
        created_by: `codeoid-conductor-test-user-${run}`,
        allowed_scopes: ALL_SCOPES_STRING.split(" "),
      };
      const ownerResp = await client.agents.register(
        ownerReq as RegisterAgentRequest,
      );
      cleanupIds.push(ownerResp.identity.id);
      owner = {
        identityId: ownerResp.identity.id,
        wimseUri: ownerResp.identity.wimse_uri,
        apiKey: ownerResp.api_key,
      };

      const manager1 = new AgentIdentityManager(managerConfig, store);
      const registered = await manager1.registerConductor(owner.wimseUri);
      expect(registered).not.toBeNull();
      conductor = registered!;
      cleanupIds.push(conductor.identityId);

      const row = store.getConductorIdentity(accountId, projectId);
      expect(row).not.toBeNull();
      expect(row!.identityId).toBe(conductor.identityId);
      expect(row!.wimseUri).toBe(conductor.wimseUri);
      expect(row!.apiKey).toStartWith("zid_sk_");
    },
    TIMEOUT,
  );

  test(
    "a fresh manager resumes the SAME identity — stable WIMSE URI across restarts",
    async () => {
      // New manager over the same store = daemon restart. resumeConductor is
      // what SessionManager.resumeSessions calls on boot.
      manager2 = new AgentIdentityManager(managerConfig, store);
      const resumed = await manager2.resumeConductor();
      expect(resumed).not.toBeNull();
      expect(resumed!.identityId).toBe(conductor.identityId);
      expect(resumed!.wimseUri).toBe(conductor.wimseUri);

      // registerConductor must also reload, never mint a second identity.
      const again = await manager2.registerConductor(owner.wimseUri);
      expect(again!.wimseUri).toBe(conductor.wimseUri);
    },
    TIMEOUT,
  );

  test(
    "owner → conductor delegation mints depth 1 with the owner in the act chain",
    async () => {
      ownerToken = (
        await client.tokens.issueApiKey(owner.apiKey, {
          scope: ALL_SCOPES_STRING,
        })
      ).access_token;

      const minted = await manager2.mintConductorToken(ownerToken);
      expect(minted).not.toBeNull();
      conductorToken = minted!;

      const intro = await client.tokens.introspect(conductorToken);
      expect(intro.active).toBe(true);
      expect(intro.delegation_depth).toBe(1);
      expect(intro.sub).toBe(conductor.wimseUri);
      expect(intro.act?.sub).toBe(owner.wimseUri);

      // Scope ceiling: exactly the conductor profile, nothing tool-shaped.
      const scopes = (intro.scope ?? "").split(" ").sort();
      expect(scopes).toEqual([...CONDUCTOR_SCOPES].sort());
      expect(scopes).not.toContain("tools:write");
      expect(scopes).not.toContain("tools:execute");
    },
    TIMEOUT,
  );

  test(
    "conductor → child → sub-agent extends the chain to delegation_depth 3",
    async () => {
      const child = await registerActor(
        "child",
        ["session:read", "session:dispatch"],
        conductor.wimseUri,
      );
      const childAssertion = await signActorAssertion(
        child.keypair.privateKey,
        child.wimseUri,
        BASE_URL,
      );
      childToken = (
        await client.tokens.issueTokenExchange(conductorToken, childAssertion, {
          scope: "session:read session:dispatch",
        })
      ).access_token;

      const childIntro = await client.tokens.introspect(childToken);
      expect(childIntro.active).toBe(true);
      expect(childIntro.delegation_depth).toBe(2);
      expect(childIntro.sub).toBe(child.wimseUri);
      expect(childIntro.act?.sub).toBe(conductor.wimseUri);

      const subagent = await registerActor(
        "subagent",
        ["session:read"],
        child.wimseUri,
      );
      const subAssertion = await signActorAssertion(
        subagent.keypair.privateKey,
        subagent.wimseUri,
        BASE_URL,
      );
      subagentToken = (
        await client.tokens.issueTokenExchange(childToken, subAssertion, {
          scope: "session:read",
        })
      ).access_token;

      const subIntro = await client.tokens.introspect(subagentToken);
      expect(subIntro.active).toBe(true);
      expect(subIntro.delegation_depth).toBe(3);
      expect(subIntro.sub).toBe(subagent.wimseUri);
      expect(subIntro.act?.sub).toBe(child.wimseUri);
      expect((subIntro.scope ?? "").split(" ")).toEqual(["session:read"]);
    },
    TIMEOUT,
  );

  test(
    "no hop below the conductor can mint tools:write — attenuation holds",
    async () => {
      // Ask for tools:write mid-chain: the subject (conductor) never held it,
      // so the three-way intersection must strip it (or reject outright).
      const child = await registerActor(
        "grabby-child",
        ["session:read", "tools:write"],
        conductor.wimseUri,
      );
      const assertion = await signActorAssertion(
        child.keypair.privateKey,
        child.wimseUri,
        BASE_URL,
      );
      let granted: string[] = [];
      try {
        const resp = await client.tokens.issueTokenExchange(
          conductorToken,
          assertion,
          { scope: "session:read tools:write" },
        );
        granted = (resp.scope ?? "").split(" ");
      } catch {
        // invalid_scope rejection is an equally acceptable outcome.
      }
      expect(granted).not.toContain("tools:write");
      expect(granted).not.toContain("tools:execute");
    },
    TIMEOUT,
  );

  test(
    "deactivating the conductor cascade-revokes the whole subtree",
    async () => {
      await manager2.deactivateConductor();

      // Every credential under the conductor dies with it, walked via the
      // parent_jti chain: its own owner-delegated token, the child's, the
      // sub-agent's. Introspection is the revocation-aware path.
      for (const token of [conductorToken, childToken, subagentToken]) {
        const intro = await client.tokens.introspect(token);
        expect(intro.active).toBe(false);
      }

      // Revocation must not climb UP the chain — the owner keeps working.
      const ownerIntro = await client.tokens.introspect(ownerToken);
      expect(ownerIntro.active).toBe(true);

      // The persisted row is gone; the next registerConductor starts fresh.
      expect(store.getConductorIdentity(accountId, projectId)).toBeNull();
    },
    TIMEOUT,
  );
});
