/** The message of a thrown value: `Error#message`, else its string form. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
