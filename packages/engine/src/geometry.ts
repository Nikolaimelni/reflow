export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Edges {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const zeroEdges: Edges = { top: 0, right: 0, bottom: 0, left: 0 };

export function edges(top: number, right: number, bottom: number, left: number): Edges {
  return { top, right, bottom, left };
}

export function horizontal(e: Edges): number {
  return e.left + e.right;
}

export function vertical(e: Edges): number {
  return e.top + e.bottom;
}

/** Padding wider than the box leaves a zero content box, never a negative one. */
export function deflate(rect: Rect, e: Edges): Rect {
  return {
    x: rect.x + e.left,
    y: rect.y + e.top,
    width: Math.max(0, rect.width - horizontal(e)),
    height: Math.max(0, rect.height - vertical(e)),
  };
}

export function inflate(rect: Rect, e: Edges): Rect {
  return {
    x: rect.x - e.left,
    y: rect.y - e.top,
    width: rect.width + horizontal(e),
    height: rect.height + vertical(e),
  };
}
