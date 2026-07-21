import { describe, expect, test } from "bun:test";
import {
  isPhaseComplete,
  PHASE_COMPLETE_MARKER,
  stripPhaseCompleteMarker,
} from "./phase-completion";

describe("phase-completion", () => {
  test("isPhaseComplete matches the marker only at the END of the message", () => {
    expect(isPhaseComplete(`all done\n${PHASE_COMPLETE_MARKER}`)).toBe(true);
    // trailing whitespace after the marker is tolerated
    expect(isPhaseComplete(`done\n${PHASE_COMPLETE_MARKER}\n  `)).toBe(true);
    // a bare rest with no marker is NOT complete
    expect(isPhaseComplete("Here's my plan, starting now.")).toBe(false);
    // merely MENTIONING the marker mid-prose does not count (must end with it)
    expect(isPhaseComplete(`I will emit ${PHASE_COMPLETE_MARKER} when done. Working…`)).toBe(false);
    expect(isPhaseComplete("")).toBe(false);
  });

  test("stripPhaseCompleteMarker removes only a trailing marker", () => {
    expect(stripPhaseCompleteMarker(`the spec\n${PHASE_COMPLETE_MARKER}`)).toBe("the spec");
    expect(stripPhaseCompleteMarker(`the spec\n${PHASE_COMPLETE_MARKER}\n`)).toBe("the spec");
    // no marker → unchanged
    expect(stripPhaseCompleteMarker("just some text")).toBe("just some text");
  });
});
