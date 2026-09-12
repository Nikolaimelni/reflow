import type { Rect } from '@reflow/engine';

/** Half a CSS pixel, the same line the conformance harness draws. */
const TOLERANCE = 0.5;

/**
 * One box, the engine's rectangle against the browser's. There is deliberately no allowance
 * for device pixel rounding here: the engine is told what screen it is on and snaps border
 * widths the same way a browser does, so anything left over is the engine's own fault and
 * should say so.
 */
export function compareRects(name: string, ours: Rect, theirs: Rect): string | null {
  const apart: string[] = [];

  for (const edge of ['x', 'y', 'width', 'height'] as const) {
    if (Math.abs(ours[edge] - theirs[edge]) <= TOLERANCE) continue;
    apart.push(`${edge} ${round(ours[edge])} against ${round(theirs[edge])}`);
  }

  return apart.length === 0 ? null : `${name} ${apart.join(', ')}`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
