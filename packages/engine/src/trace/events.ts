import type { BoxId } from '../boxtree/box.js';
import type { Edges, Rect } from '../geometry.js';

export type Fragment = {
  box: BoxId;
  /** The border box, in document coordinates, which is what the browser reports too. */
  rect: Rect;
  margin: Edges;
  border: Edges;
  padding: Edges;
};

export type Constraint = {
  availableWidth: number;
  /** null when the containing block's height is itself unresolved. */
  availableHeight: number | null;
};

export type LayoutEvent =
  | { t: 'measure:start'; box: BoxId; constraint: Constraint }
  | { t: 'size:resolved'; box: BoxId; fragment: Fragment; reason: string }
  | { t: 'margin:collapsed'; boxes: BoxId[]; from: number[]; to: number }
  | { t: 'child:positioned'; box: BoxId; parent: BoxId; rect: Rect }
  | { t: 'line:broken'; box: BoxId; at: number; width: number };

export type Frame = ReadonlyMap<BoxId, Fragment>;

export const EMPTY_FRAME: Frame = new Map();

/** Pure, so the player can hold onto older frames. */
export function applyEvent(frame: Frame, event: LayoutEvent): Frame {
  if (event.t !== 'size:resolved') return frame;
  return new Map(frame).set(event.box, event.fragment);
}

export function replay(trace: readonly LayoutEvent[]): Map<BoxId, Fragment> {
  const frame = new Map<BoxId, Fragment>();
  for (const event of trace) {
    if (event.t === 'size:resolved') frame.set(event.box, event.fragment);
  }
  return frame;
}

/**
 * The frame after `cursor` events. `applyEvent` would give the same answer folded over a
 * prefix, but it copies the map every step, and a player scrubbing at sixty frames a second
 * cannot afford that.
 */
export function frameAt(trace: readonly LayoutEvent[], cursor: number): Frame {
  return replay(trace.slice(0, Math.max(0, cursor)));
}
