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

/** Appended to a phase prompt so the model knows the completion protocol. */
export const PHASE_COMPLETION_CONTRACT = [
  "",
  "---",
  "## Completing this phase",
  "Do the whole task now, using tools as needed. Every message you send must end",
  "with exactly ONE of these markers, alone on the last line:",
  "",
  `- ${PHASE_COMPLETE_MARKER} — the deliverable is fully complete.`,
  `- ${PHASE_NEEDS_INPUT_MARKER} — you need a decision or information from the`,
  "  user to proceed. Ask your question in the message, then end with this",
  "  marker. The user's answer comes back as your next turn and you continue.",
  "",
  "Rules:",
  `- Never emit ${PHASE_COMPLETE_MARKER} while work remains.`,
  `- Prefer ${PHASE_NEEDS_INPUT_MARKER} over guessing on anything that`,
  "  materially changes the outcome; otherwise make a reasonable assumption,",
  "  state it, and keep going.",
  "- Put a marker ONLY on that final line — never mention them elsewhere.",
].join("\n");

/** Sent to nudge the model to continue when a turn rests without any marker. */
export const PHASE_CONTINUE_NUDGE = [
  "Your last message ended without a marker. End every message with exactly one",
  `of: ${PHASE_COMPLETE_MARKER} (deliverable fully done) or ${PHASE_NEEDS_INPUT_MARKER}`,
  "(you need the user to answer something). Keep working and finish the phase.",
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

/** A phase turn can rest WITHOUT the model producing any new assistant text —
 *  e.g. the Claude provider rebuilds its query loop on a phase-activation
 *  systemPromptAppend change, which surfaces as a transient `idle` before the
 *  real turn runs. Such a rest is NOT a place to nudge (the model hasn't spoken
 *  yet); the driver waits for the real turn instead. This bounds how many
 *  content-free rests it will skip before giving up (so it can't wait forever). */
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
