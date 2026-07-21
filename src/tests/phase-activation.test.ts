/**
 * resolvePhaseActivation — the per-phase pack failure policy used by
 * SessionManager.runPhaseTurn. A declared capability role is a security
 * boundary: if it can't be applied we fail CLOSED (throw) so a phase never runs
 * with more privilege than declared; without a role we fail SOFT (the
 * constitution is only guidance). Pure, so tested without a live daemon.
 */

import { describe, expect, mock, test } from "bun:test";
import { type PackActivation, type PackActivator, resolvePhaseActivation } from "../daemon/pipeline/pack-service";

function throwingActivator(msg = "clone gone"): PackActivator {
  return {
    resolveActivation: () => {
      throw new Error(msg);
    },
  };
}

describe("resolvePhaseActivation", () => {
  test("no packId → undefined, never touches the activator", () => {
    const spy = mock(() => ({}) as PackActivation);
    expect(resolvePhaseActivation({ resolveActivation: spy }, undefined, "reviewer")).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  test("success returns the activation and forwards the role", () => {
    const spy = mock((_id: string, _role?: string) => ({ id: "p", subagents: [] }) as PackActivation);
    const act = resolvePhaseActivation({ resolveActivation: spy }, "aif-sdlc", "reviewer");
    expect(act?.id).toBe("p");
    expect(spy).toHaveBeenCalledWith("aif-sdlc", "reviewer");
  });

  test("role declared + resolution fails ⇒ fail CLOSED (throws, no silent escalation)", () => {
    expect(() => resolvePhaseActivation(throwingActivator(), "aif-sdlc", "reviewer")).toThrow(
      /activation failed for role "reviewer".*aif-sdlc.*clone gone/,
    );
  });

  test("no role + resolution fails ⇒ fail SOFT (undefined, run continues)", () => {
    expect(resolvePhaseActivation(throwingActivator(), "aif-sdlc", undefined)).toBeUndefined();
  });
});
