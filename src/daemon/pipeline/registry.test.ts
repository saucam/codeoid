import { describe, expect, test } from "bun:test";
import { registerBuiltins } from "./builtin";
import type { PhaseKind } from "./interface";
import { createRegistries, MapRegistry } from "./registry";

const kind = (id: string): PhaseKind => ({
  id,
  async run() {
    return { outcome: "passed" };
  },
});

describe("MapRegistry", () => {
  test("register / resolve / has / list", () => {
    const r = new MapRegistry<PhaseKind>("phase-kind");
    expect(r.has("a")).toBe(false);
    r.register(kind("a"));
    r.register(kind("b"));
    expect(r.has("a")).toBe(true);
    expect(r.resolve("a")?.id).toBe("a");
    expect(
      r
        .list()
        .map((x) => x.id)
        .sort(),
    ).toEqual(["a", "b"]);
    expect(r.resolve("missing")).toBeUndefined();
  });

  test("register is last-wins on a duplicate id", () => {
    const r = new MapRegistry<PhaseKind>("phase-kind");
    const first = kind("dup");
    const second = kind("dup");
    r.register(first);
    r.register(second);
    expect(r.resolve("dup")).toBe(second);
    expect(r.list()).toHaveLength(1);
  });

  test("unregister removes and tolerates unknown ids", () => {
    const r = new MapRegistry<PhaseKind>("phase-kind");
    r.register(kind("a"));
    r.unregister("a");
    expect(r.has("a")).toBe(false);
    r.unregister("nope"); // no throw
  });
});

describe("createRegistries + registerBuiltins", () => {
  test("exposes the four registries", () => {
    const r = createRegistries();
    expect(Object.keys(r).sort()).toEqual(["gates", "packs", "phases", "skills"]);
  });

  test("built-ins register the noop kind + always/manual gates", () => {
    const r = createRegistries();
    registerBuiltins(r);
    expect(r.phases.has("noop")).toBe(true);
    expect(r.gates.has("always")).toBe(true);
    expect(r.gates.has("manual")).toBe(true);
  });
});
