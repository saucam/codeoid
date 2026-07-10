import { describe, it, expect } from "vitest";

import { DEFAULT_SESSION_MODE, effectiveMode } from "./session-mode";
import type { SessionInfo } from "../protocol/types";

describe("effectiveMode", () => {
  it("defaults to guarded — the daemon's boot mode — not interactive", () => {
    expect(DEFAULT_SESSION_MODE).toBe("guarded");
    expect(effectiveMode(undefined)).toBe("guarded");
    expect(effectiveMode(null)).toBe("guarded");
    // Legacy daemons omit `mode` from SessionInfo entirely.
    expect(effectiveMode({ id: "s" } as SessionInfo)).toBe("guarded");
  });

  it("passes an explicit mode through untouched", () => {
    expect(effectiveMode({ id: "s", mode: "interactive" } as SessionInfo)).toBe("interactive");
    expect(effectiveMode({ id: "s", mode: "autonomous" } as SessionInfo)).toBe("autonomous");
    expect(effectiveMode({ id: "s", mode: "guarded" } as SessionInfo)).toBe("guarded");
  });
});
