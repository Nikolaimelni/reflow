import type { Rect } from '@reflow/engine';

// Half a CSS pixel, the same line the conformance harness draws.
const TOLERANCE = 0.5;

// No allowance for device pixel rounding: the engine snaps borders the way the browser does.
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
