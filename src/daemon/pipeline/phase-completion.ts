/**
 * Phase-completion contract.
 *
 * A pipeline phase runs the model AUTONOMOUSLY on the bound session. The session
 * going `idle` only means the model ENDED A TURN — which happens whenever it
 * stops calling tools: when it's genuinely done, but ALSO when it pauses to plan,
 * report progress, or ask a question. Treating that first `idle` as "phase
 * complete" halted phases for Approve/Reject mid-work.
 *
 * Instead, the model marks completion EXPLICITLY, and the turn host
 * (SessionManager#runPhaseOnSession) treats a phase as done ONLY when it sees the
 * marker at the end of the model's final message — nudging it to continue on a
 * bare rest rather than ending the phase.
 */

/** Distinctive end-of-message marker the model emits when a phase is complete.
 *  Matched only at the END of the final message so prose that merely *mentions*
 *  completion can't false-positive. */
export const PHASE_COMPLETE_MARKER = "⟦PHASE-COMPLETE⟧";

/** Appended to a phase prompt so the model knows the completion protocol. */
export const PHASE_COMPLETION_CONTRACT = [
  "",
  "---",
  "## Completing this phase",
  "Do the whole task now, using tools as needed. When — and ONLY when — the",
  "deliverable is fully complete, end your FINAL message with this exact marker",
  "alone on the last line:",
  "",
  PHASE_COMPLETE_MARKER,
  "",
  "Rules:",
  `- Never emit ${PHASE_COMPLETE_MARKER} while work remains.`,
  "- You are running autonomously — do not stop early to ask permission.",
  "- If you genuinely need a decision, make the most reasonable assumption,",
  "  state it, and keep going (a human reviews the whole phase afterward).",
  "- Do not mention the marker anywhere except that final line.",
].join("\n");

/** Sent to nudge the model to continue when a turn rests without the marker. */
export const PHASE_CONTINUE_NUDGE = [
  "You have not marked this phase complete yet (no completion marker in your",
  "last message). Keep working until the deliverable is fully done, then end your",
  `final message with the marker alone on the last line: ${PHASE_COMPLETE_MARKER}.`,
  "If you were waiting on a decision, make the most reasonable assumption, note",
  "it, and continue.",
].join("\n");

/** How many times to nudge a resting-but-incomplete phase before handing what
 *  the model has produced to the human review boundary — so a model that never
 *  emits the marker still reaches Approve/Reject instead of looping forever. */
export const MAX_PHASE_NUDGES = 3;

/** True when the model's final message signals phase completion. */
export function isPhaseComplete(text: string): boolean {
  return text.trimEnd().endsWith(PHASE_COMPLETE_MARKER);
}

/** Strip a trailing completion marker so it never leaks into the phase summary. */
export function stripPhaseCompleteMarker(text: string): string {
  const trimmed = text.trimEnd();
  if (!trimmed.endsWith(PHASE_COMPLETE_MARKER)) return text;
  return trimmed.slice(0, trimmed.length - PHASE_COMPLETE_MARKER.length).trimEnd();
}
