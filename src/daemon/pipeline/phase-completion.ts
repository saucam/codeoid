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

/** End-of-message marker the model emits when it needs a decision or information
 *  from the user to proceed. The turn host surfaces the message (minus the
 *  marker) as an input dialog and feeds the user's answer back as the next turn.
 */
export const PHASE_NEEDS_INPUT_MARKER = "⟦NEED-INPUT⟧";

/** Appended to a phase prompt so the model knows the completion protocol.
 *  CRITICAL: a phase is SCOPED — it runs one step of a larger pipeline (e.g. a
 *  spec phase, then a separate implement phase) and stops at a human review
 *  boundary between each. The contract must NOT tell the model to "do the whole
 *  task": that made a scoped phase (like /spec) blow past its own deliverable and
 *  start implementing, so it never rested at the phase's end and never emitted
 *  the marker — the phase looked like it "never ended". Keep the model inside
 *  THIS phase's scope. */
export const PHASE_COMPLETION_CONTRACT = [
  "",
  "---",
  "## Completing this phase",
  "Do THIS phase's work as described above — and only that. Follow the phase's own",
  "instructions: a spec/design/planning phase produces its document or plan and",
  "STOPS; it does NOT write the implementation. Do not run ahead into work that",
  "belongs to a later phase — each phase ends at a human review boundary, and the",
  "next phase continues from your output.",
  "",
  "Every message you send must end with exactly ONE of these markers, alone on the",
  "last line:",
  "",
  `- ${PHASE_COMPLETE_MARKER} — THIS phase's deliverable is complete (NOT the whole`,
  "  feature). Emit it as soon as this phase's work is done.",
  `- ${PHASE_NEEDS_INPUT_MARKER} — you need a decision or information from the`,
  "  user to proceed. Ask your question in the message, then end with this",
  "  marker. The user's answer comes back as your next turn and you continue.",
  "",
  "Rules:",
  `- Never emit ${PHASE_COMPLETE_MARKER} while THIS phase's own work remains — but`,
  "  don't keep going into the next phase's work either; stop and emit it.",
  `- Prefer ${PHASE_NEEDS_INPUT_MARKER} over guessing on anything that`,
  "  materially changes the outcome; otherwise make a reasonable assumption,",
  "  state it, and keep going.",
  "- Put a marker ONLY on that final line — never mention them elsewhere.",
].join("\n");

/** Sent to nudge the model to continue when a turn rests without any marker.
 *  Steers a model that has finished its phase deliverable to CLOSE the phase
 *  (emit the marker) rather than to keep working — the old "keep working" nudge
 *  pushed an already-done spec phase onward into implementation. */
export const PHASE_CONTINUE_NUDGE = [
  "Your last message ended without a marker. If THIS phase's deliverable is done,",
  `end with ${PHASE_COMPLETE_MARKER} now — do NOT start the next phase's work`,
  `(e.g. don't implement during a spec/design phase). If you need the user, end`,
  `with ${PHASE_NEEDS_INPUT_MARKER}. Otherwise finish only this phase's remaining`,
  "work, then emit the marker.",
].join("\n");

/** Sent when the model asked for input but the user dismissed / didn't answer —
 *  so the phase proceeds on a best-effort assumption rather than stalling. */
export const PHASE_NO_INPUT_NUDGE = [
  "No answer was provided. Make the most reasonable assumption, state it",
  `explicitly, and continue. End with ${PHASE_COMPLETE_MARKER} when done or`,
  `${PHASE_NEEDS_INPUT_MARKER} if you still truly need the user.`,
].join("\n");

/** How many times to nudge a resting-but-incomplete phase before handing what
 *  the model has produced to the human review boundary — so a model that never
 *  emits the marker still reaches Approve/Reject instead of looping forever. */
export const MAX_PHASE_NUDGES = 3;

/** A phase turn can rest WITHOUT committing any new turn to the history — e.g.
 *  the Claude provider rebuilds its query loop on a phase-activation
 *  systemPromptAppend change, which surfaces as a transient `idle` before the
 *  real turn runs. Such a rest is NOT a place to nudge (the model hasn't done
 *  anything yet); the driver waits for the real turn instead. This bounds how
 *  many content-free rests it will skip before handing off to the human
 *  boundary — a backstop so a backend that somehow never commits a turn can't
 *  wedge the phase loop. */
export const MAX_SPURIOUS_RESTS = 5;

/** True when the model's final message signals phase completion. */
export function isPhaseComplete(text: string): boolean {
  return text.trimEnd().endsWith(PHASE_COMPLETE_MARKER);
}

/** True when the model's final message asks the user for input to proceed. */
export function isNeedInput(text: string): boolean {
  return text.trimEnd().endsWith(PHASE_NEEDS_INPUT_MARKER);
}

function stripTrailingMarker(text: string, marker: string): string {
  const trimmed = text.trimEnd();
  if (!trimmed.endsWith(marker)) return text;
  return trimmed.slice(0, trimmed.length - marker.length).trimEnd();
}

/** Strip a trailing completion marker so it never leaks into the phase summary. */
export function stripPhaseCompleteMarker(text: string): string {
  return stripTrailingMarker(text, PHASE_COMPLETE_MARKER);
}

/** Strip a trailing need-input marker so only the question is shown to the user. */
export function stripNeedInputMarker(text: string): string {
  return stripTrailingMarker(text, PHASE_NEEDS_INPUT_MARKER);
}
