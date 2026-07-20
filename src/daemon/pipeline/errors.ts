/** Shared error helpers for the pipeline package. */

/** Best-effort human-readable message from an unknown thrown value. */
export const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
