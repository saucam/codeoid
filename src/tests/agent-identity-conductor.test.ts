/**
 * Conductor identity unit tests — the durable, owner-delegated conductor
 * lifecycle (P2) against a fetch-stubbed ZeroID, so the register / resume /
 * mint / deactivate flows and their Store persistence are exercised without a
 * live server. The live-server counterpart (depth-3 chain, real cascade
 * revocation) is src/integration/conductor-zeroid.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentIdentityManager,
  CONDUCTOR_SCOPES,
} from "../daemon/agent-identity.js";
import { Store } from "../daemon/store.js";

const BASE_URL = "http://zeroid.test";
const ACCOUNT = "acct_t";
const PROJECT = "proj_t";

/** Decode a JWS payload (the actor assertion) without verifying. */
function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const b64 = jwt.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}

/**
 * In-memory fake of the ZeroID endpoints the conductor lifecycle touches.
 * Tracks calls so tests can assert on the wire contract, and simulates
 * api-key revocation on deactivation (the liveness probe's failure mode).
 */
class FakeZeroID {
  registerCalls: Array<Record<string, unknown>> = [];
  tokenCalls: Array<Record<string, unknown>> = [];
  keyRotations: Array<{ identityId: string; publicKeyPem: unknown }> = [];
  deactivateCalls: string[] = [];
  /** When true, POST /api/v1/agents/register returns 422. */
  failRegister = false;

  #nextId = 0;
  #identities = new Map<string, { wimseUri: string; active: boolean }>();
  #apiKeys = new Map<string, string>(); // api_key -> identity id

  /** Directly mark an identity dead (out-of-band deactivation). */
  killIdentity(identityId: string): void {
    const identity = this.#identities.get(identityId);
    if (identity) identity.active = false;
  }

  install(): void {
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = String(input);
      const path = url.replace(BASE_URL, "");
      const body = init?.body ? JSON.parse(String(init.body)) : {};

      if (path === "/api/v1/agents/register") {
        this.registerCalls.push(body);
        if (this.failRegister) {
          return Response.json({ detail: "validation failed" }, { status: 422 });
        }
        const id = `ident-${++this.#nextId}`;
        const wimseUri = `wimse://zeroid.test/agent/${id}`;
        const apiKey = `zid_sk_${id}`;
        this.#identities.set(id, { wimseUri, active: true });
        this.#apiKeys.set(apiKey, id);
        return Response.json({
          identity: { id, wimse_uri: wimseUri, external_id: body.external_id },
          api_key: apiKey,
        });
      }

      if (path === "/oauth2/token") {
        this.tokenCalls.push(body);
        if (body.grant_type === "api_key") {
          const identityId = this.#apiKeys.get(body.api_key);
          const identity = identityId
            ? this.#identities.get(identityId)
            : undefined;
          if (!identity?.active) {
            return Response.json(
              { detail: "invalid or revoked api key" },
              { status: 401 },
            );
          }
          return Response.json({
            access_token: `tok-${identityId}`,
            token_type: "Bearer",
            expires_in: 3600,
            jti: crypto.randomUUID(),
            iat: 0,
            scope: body.scope ?? "",
          });
        }
        // RFC 8693 token exchange (owner -> conductor)
        return Response.json({
          access_token: "delegated-conductor-token",
          token_type: "Bearer",
          expires_in: 3600,
          jti: crypto.randomUUID(),
          iat: 0,
          scope: body.scope ?? "",
        });
      }

      const patchMatch = path.match(/^\/api\/v1\/identities\/([^/]+)$/);
      if (patchMatch && init?.method === "PATCH") {
        this.keyRotations.push({
          identityId: patchMatch[1]!,
          publicKeyPem: body.public_key_pem,
        });
        return Response.json({ id: patchMatch[1] });
      }

      const deactivateMatch = path.match(
        /^\/api\/v1\/agents\/registry\/([^/]+)\/deactivate$/,
      );
      if (deactivateMatch) {
        const id = deactivateMatch[1]!;
        this.deactivateCalls.push(id);
        this.killIdentity(id);
        return Response.json({ id, status: "deactivated" });
      }

      return Response.json(
        { detail: `unexpected route: ${init?.method ?? "GET"} ${path}` },
        { status: 404 },
      );
    }) as typeof fetch;
  }
}

const realFetch = globalThis.fetch;

describe("AgentIdentityManager conductor lifecycle", () => {
  let tmpDir: string;
  let store: Store;
  let zeroid: FakeZeroID;

  const config = {
    auth: { baseUrl: BASE_URL },
    accountId: ACCOUNT,
    projectId: PROJECT,
  };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "codeoid-conductor-unit-"));
    store = new Store(join(tmpDir, "store.db"));
    zeroid = new FakeZeroID();
    zeroid.install();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("registerConductor registers an orchestrator with the conductor scope ceiling and persists it", async () => {
    const manager = new AgentIdentityManager(config, store);
    const conductor = await manager.registerConductor("user:owner@test");

    expect(conductor).not.toBeNull();
    expect(manager.conductorUri).toBe(conductor!.wimseUri);

    expect(zeroid.registerCalls).toHaveLength(1);
    const req = zeroid.registerCalls[0]!;
    expect(req.sub_type).toBe("orchestrator");
    expect(req.created_by).toBe("user:owner@test");
    expect(req.allowed_scopes).toEqual([...CONDUCTOR_SCOPES]);
    expect(req.allowed_scopes).not.toContain("tools:write");
    expect(req.allowed_scopes).not.toContain("tools:execute");
    expect(String(req.external_id)).toStartWith("codeoid-conductor-");
    expect(String(req.public_key_pem)).toContain("BEGIN PUBLIC KEY");

    const row = store.getConductorIdentity(ACCOUNT, PROJECT);
    expect(row).toEqual({
      identityId: conductor!.identityId,
      wimseUri: conductor!.wimseUri,
      apiKey: expect.stringMatching(/^zid_sk_/) as unknown as string,
    });
  });

  test("registerConductor honors conductorExternalIdPrefix", async () => {
    const manager = new AgentIdentityManager(
      { ...config, conductorExternalIdPrefix: "codeoid-conductor-test" },
      store,
    );
    await manager.registerConductor("user:owner@test");
    expect(String(zeroid.registerCalls[0]!.external_id)).toStartWith(
      "codeoid-conductor-test-",
    );
  });

  test("second registerConductor reuses the in-memory identity — no re-registration", async () => {
    const manager = new AgentIdentityManager(config, store);
    const first = await manager.registerConductor("user:owner@test");
    const second = await manager.registerConductor("user:owner@test");

    expect(second).toEqual(first!);
    expect(zeroid.registerCalls).toHaveLength(1);
  });

  test("a fresh manager resumes the persisted identity — same WIMSE URI, key rotated, no re-registration", async () => {
    const manager1 = new AgentIdentityManager(config, store);
    const registered = await manager1.registerConductor("user:owner@test");

    // Simulated daemon restart: new manager over the same store.
    const manager2 = new AgentIdentityManager(config, store);
    const resumed = await manager2.resumeConductor();

    expect(resumed).toEqual(registered!);
    expect(zeroid.registerCalls).toHaveLength(1);

    // Liveness probe minted from the persisted api key…
    const probe = zeroid.tokenCalls.find((c) => c.grant_type === "api_key");
    expect(probe?.api_key).toBe(
      store.getConductorIdentity(ACCOUNT, PROJECT)!.apiKey,
    );
    // …and the process-local actor keypair was re-registered.
    expect(zeroid.keyRotations).toHaveLength(1);
    expect(zeroid.keyRotations[0]!.identityId).toBe(registered!.identityId);
    expect(String(zeroid.keyRotations[0]!.publicKeyPem)).toContain(
      "BEGIN PUBLIC KEY",
    );
  });

  test("resumeConductor without a persisted row is a no-op", async () => {
    const manager = new AgentIdentityManager(config, store);
    expect(await manager.resumeConductor()).toBeNull();
    expect(manager.conductorUri).toBeUndefined();
    expect(zeroid.tokenCalls).toHaveLength(0);
  });

  test("a stale persisted identity is dropped and the next register starts fresh", async () => {
    const manager1 = new AgentIdentityManager(config, store);
    const first = await manager1.registerConductor("user:owner@test");

    // The identity dies out-of-band (revoked on the server); the persisted
    // api key stops minting.
    zeroid.killIdentity(first!.identityId);

    const manager2 = new AgentIdentityManager(config, store);
    expect(await manager2.resumeConductor()).toBeNull();
    expect(store.getConductorIdentity(ACCOUNT, PROJECT)).toBeNull();

    // registerConductor now mints a NEW identity and persists it.
    const second = await manager2.registerConductor("user:owner@test");
    expect(second).not.toBeNull();
    expect(second!.identityId).not.toBe(first!.identityId);
    expect(store.getConductorIdentity(ACCOUNT, PROJECT)!.identityId).toBe(
      second!.identityId,
    );
  });

  test("registerConductor returns null when ZeroID rejects registration", async () => {
    zeroid.failRegister = true;
    const manager = new AgentIdentityManager(config, store);
    expect(await manager.registerConductor("user:owner@test")).toBeNull();
    expect(store.getConductorIdentity(ACCOUNT, PROJECT)).toBeNull();
  });

  test("mintConductorToken exchanges the owner's token with a self-signed actor assertion", async () => {
    const manager = new AgentIdentityManager(config, store);
    const conductor = await manager.registerConductor("user:owner@test");

    const token = await manager.mintConductorToken("owner-subject-token");
    expect(token).toBe("delegated-conductor-token");

    const exchange = zeroid.tokenCalls.find(
      (c) => c.grant_type !== "api_key",
    )!;
    expect(exchange.subject_token).toBe("owner-subject-token");
    expect(exchange.scope).toBe(CONDUCTOR_SCOPES.join(" "));

    // The actor assertion is self-signed by the conductor: iss = sub = its
    // WIMSE URI, aud = the ZeroID base URL.
    const assertion = decodeJwtPayload(String(exchange.actor_token));
    expect(assertion.iss).toBe(conductor!.wimseUri);
    expect(assertion.sub).toBe(conductor!.wimseUri);
    expect(assertion.aud).toBe(BASE_URL);
  });

  test("mintConductorToken without a conductor returns null", async () => {
    const manager = new AgentIdentityManager(config, store);
    expect(await manager.mintConductorToken("owner-subject-token")).toBeNull();
    expect(zeroid.tokenCalls).toHaveLength(0);
  });

  test("deactivateConductor deactivates in ZeroID and clears the persisted row", async () => {
    const manager = new AgentIdentityManager(config, store);
    const conductor = await manager.registerConductor("user:owner@test");

    await manager.deactivateConductor();

    expect(zeroid.deactivateCalls).toEqual([conductor!.identityId]);
    expect(store.getConductorIdentity(ACCOUNT, PROJECT)).toBeNull();
    expect(manager.conductorUri).toBeUndefined();
    expect(await manager.resumeConductor()).toBeNull();
  });

  test("deactivateConductor works from the persisted row alone (no in-memory conductor)", async () => {
    const manager1 = new AgentIdentityManager(config, store);
    const conductor = await manager1.registerConductor("user:owner@test");

    // Fresh manager that never registered nor resumed.
    const manager2 = new AgentIdentityManager(config, store);
    await manager2.deactivateConductor();

    expect(zeroid.deactivateCalls).toEqual([conductor!.identityId]);
    expect(store.getConductorIdentity(ACCOUNT, PROJECT)).toBeNull();
  });

  test("deactivateConductor with nothing registered is a no-op", async () => {
    const manager = new AgentIdentityManager(config, store);
    await manager.deactivateConductor();
    expect(zeroid.deactivateCalls).toHaveLength(0);
  });
});

describe("Store conductor_identity persistence", () => {
  let tmpDir: string;
  let store: Store;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "codeoid-conductor-store-"));
    store = new Store(join(tmpDir, "store.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const row = {
    accountId: "acct_a",
    projectId: "proj_a",
    identityId: "ident-1",
    wimseUri: "wimse://zeroid.test/agent/ident-1",
    apiKey: "zid_sk_1",
  };

  test("save + get round-trips", () => {
    store.saveConductorIdentity(row);
    expect(store.getConductorIdentity("acct_a", "proj_a")).toEqual({
      identityId: row.identityId,
      wimseUri: row.wimseUri,
      apiKey: row.apiKey,
    });
  });

  test("get returns null for an unknown tenant", () => {
    store.saveConductorIdentity(row);
    expect(store.getConductorIdentity("acct_b", "proj_a")).toBeNull();
    expect(store.getConductorIdentity("acct_a", "proj_b")).toBeNull();
  });

  test("save upserts — one row per tenant, latest wins", () => {
    store.saveConductorIdentity(row);
    store.saveConductorIdentity({
      ...row,
      identityId: "ident-2",
      wimseUri: "wimse://zeroid.test/agent/ident-2",
      apiKey: "zid_sk_2",
    });
    expect(store.getConductorIdentity("acct_a", "proj_a")!.identityId).toBe(
      "ident-2",
    );
  });

  test("tenants are isolated", () => {
    store.saveConductorIdentity(row);
    store.saveConductorIdentity({
      ...row,
      accountId: "acct_b",
      identityId: "ident-b",
    });
    expect(store.getConductorIdentity("acct_a", "proj_a")!.identityId).toBe(
      "ident-1",
    );
    expect(store.getConductorIdentity("acct_b", "proj_a")!.identityId).toBe(
      "ident-b",
    );
  });

  test("delete removes only the addressed tenant's row", () => {
    store.saveConductorIdentity(row);
    store.saveConductorIdentity({
      ...row,
      accountId: "acct_b",
      identityId: "ident-b",
    });
    store.deleteConductorIdentity("acct_a", "proj_a");
    expect(store.getConductorIdentity("acct_a", "proj_a")).toBeNull();
    expect(store.getConductorIdentity("acct_b", "proj_a")).not.toBeNull();
  });
});
