/**
 * Output helpers shared by commands: the --json escape hatch and definitive
 * empty states (AXI principles 1 and 5).
 */

/** Mirrors axi-sdk-js's renderable contract: TOON object or passthrough string. */
export type AxiRenderable = string | Record<string, unknown>;

export function renderResult(output: Record<string, unknown>, json: boolean): AxiRenderable {
  if (json) {
    return JSON.stringify(output, null, 2);
  }
  return output;
}

/** Build the definitive empty-state marker for a list command. */
export function emptyState(emptyMessage: string): { result: string } {
  return { result: emptyMessage };
}

export function pageCountLine(shown: number, total: number | undefined, flag: string): string | undefined {
  if (total === undefined || shown >= total) return undefined;
  return `showing ${shown} of ${total} \u2014 pass --${flag} or a larger --limit to see more`;
}
