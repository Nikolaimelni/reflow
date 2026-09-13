import type { BoxId, Fragment, Rect } from '@reflow/engine';
import { PALETTE } from './palette.js';

export type Scene = {
  /** Boxes in paint order, so overlaps land the way the engine says they should. */
  order: readonly BoxId[];
  frame: ReadonlyMap<BoxId, Fragment>;
  labels: ReadonlyMap<BoxId, string>;
  highlight: BoxId | null;
  selected: BoxId | null;
  diverging: ReadonlyMap<BoxId, string>;
  /** Each dirty box and its ring, from the reflow lab. */
  dirty: ReadonlyMap<BoxId, number>;
  /** Rings revealed so far, so the ripple can be animated by moving one number. */
  wave: number;
  viewport: { width: number; height: number };
};

export type View = {
  /** Device pixels per CSS pixel of the page being laid out. */
  scale: number;
  width: number;
  height: number;
};

export function draw(context: CanvasRenderingContext2D, scene: Scene, view: View): void {
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, view.width, view.height);
  context.fillStyle = PALETTE.page;
  context.fillRect(0, 0, view.width, view.height);

  context.setTransform(view.scale, 0, 0, view.scale, 0, 0);
  drawGrid(context, scene, view);

  for (const id of scene.order) {
    const fragment = scene.frame.get(id);
    if (fragment !== undefined) drawBox(context, fragment);
  }

  drawDirty(context, scene, view);

  if (scene.selected !== null) {
    const fragment = scene.frame.get(scene.selected);
    if (fragment !== undefined) outline(context, fragment.rect, PALETTE.selected, 2 / view.scale);
  }

  for (const id of scene.diverging.keys()) {
    const fragment = scene.frame.get(id);
    if (fragment !== undefined) outline(context, fragment.rect, PALETTE.divergence, 2 / view.scale);
  }

  if (scene.highlight !== null) {
    const fragment = scene.frame.get(scene.highlight);
    if (fragment !== undefined) {
      outline(context, fragment.rect, PALETTE.highlight, 1.5 / view.scale);
      label(context, fragment.rect, scene.labels.get(scene.highlight) ?? '', view.scale);
    }
  }
}

/**
 * The dirty set nests: html holds body holds everything the change touched. One wash per box
 * stacks fourteen of them into an opaque smear, so the wash goes on as a single union fill and
 * the ripple outwards is left to the outlines, a shade fainter each ring.
 */
function drawDirty(context: CanvasRenderingContext2D, scene: Scene, view: View): void {
  const revealed = [...scene.dirty]
    .filter(([, ring]) => ring <= scene.wave)
    .flatMap(([id, ring]) => {
      const fragment = scene.frame.get(id);
      return fragment === undefined ? [] : [{ rect: fragment.rect, ring }];
    });

  if (revealed.length === 0) return;

  const union = new Path2D();
  for (const { rect } of revealed) union.rect(rect.x, rect.y, rect.width, rect.height);

  context.globalAlpha = 0.2;
  context.fillStyle = PALETTE.dirty;
  context.fill(union);
  context.globalAlpha = 1;

  for (const { rect, ring } of revealed) {
    outline(context, rect, PALETTE.dirty, 1.5 / view.scale, Math.max(0.35, 1 - ring * 0.15));
  }
}

function drawGrid(context: CanvasRenderingContext2D, scene: Scene, view: View): void {
  const step = 32;
  const width = view.width / view.scale;
  const height = view.height / view.scale;

  context.strokeStyle = PALETTE.grid;
  context.lineWidth = 1 / view.scale;
  context.beginPath();

  for (let x = 0; x <= width; x += step) {
    context.moveTo(x, 0);
    context.lineTo(x, height);
  }
  for (let y = 0; y <= height; y += step) {
    context.moveTo(0, y);
    context.lineTo(width, y);
  }

  context.stroke();

  context.strokeStyle = PALETTE.margin;
  context.lineWidth = 1 / view.scale;
  context.beginPath();
  context.moveTo(scene.viewport.width, 0);
  context.lineTo(scene.viewport.width, height);
  context.stroke();
}

/**
 * Outside in: margin, border, padding, content. Each of the first three is drawn as a band
 * rather than a filled rectangle, because filling them stacks four alphas on top of each
 * other and every box comes out the same olive colour.
 */
function drawBox(context: CanvasRenderingContext2D, fragment: Fragment): void {
  const border = fragment.rect;
  const margin = grow(border, fragment.margin);
  const padding = shrink(border, fragment.border);
  const content = shrink(padding, fragment.padding);

  band(context, margin, border, PALETTE.margin, 0.28);
  band(context, border, padding, PALETTE.border, 0.5);
  band(context, padding, content, PALETTE.padding, 0.42);
  fill(context, content, PALETTE.content, 0.32);
}

/** The area between two rectangles, punched out with an even-odd fill. */
function band(
  context: CanvasRenderingContext2D,
  outer: Rect,
  inner: Rect,
  colour: string,
  alpha: number,
): void {
  if (outer.width <= 0 || outer.height <= 0) return;
  if (outer.width === inner.width && outer.height === inner.height) return;

  context.globalAlpha = alpha;
  context.fillStyle = colour;
  context.beginPath();
  context.rect(outer.x, outer.y, outer.width, outer.height);
  context.rect(inner.x, inner.y, inner.width, inner.height);
  context.fill('evenodd');
  context.globalAlpha = 1;
}

function fill(context: CanvasRenderingContext2D, rect: Rect, colour: string, alpha: number): void {
  if (rect.width <= 0 || rect.height <= 0) return;
  context.globalAlpha = alpha;
  context.fillStyle = colour;
  context.fillRect(rect.x, rect.y, rect.width, rect.height);
  context.globalAlpha = 1;
}

function outline(
  context: CanvasRenderingContext2D,
  rect: Rect,
  colour: string,
  width: number,
  alpha = 1,
): void {
  context.globalAlpha = alpha;
  context.strokeStyle = colour;
  context.lineWidth = width;
  context.strokeRect(rect.x, rect.y, rect.width, rect.height);
  context.globalAlpha = 1;
}

function label(context: CanvasRenderingContext2D, rect: Rect, text: string, scale: number): void {
  if (text === '') return;

  const size = 11 / scale;
  context.font = `${size}px ui-monospace, monospace`;
  const width = context.measureText(text).width + 8 / scale;
  const height = size + 6 / scale;
  const y = rect.y - height < 0 ? rect.y : rect.y - height;

  context.fillStyle = PALETTE.labelBackground;
  context.fillRect(rect.x, y, width, height);
  context.strokeStyle = PALETTE.highlight;
  context.lineWidth = 1 / scale;
  context.strokeRect(rect.x, y, width, height);

  context.fillStyle = PALETTE.label;
  context.textBaseline = 'middle';
  context.fillText(text, rect.x + 4 / scale, y + height / 2);
}

function grow(rect: Rect, edges: Fragment['margin']): Rect {
  return {
    x: rect.x - edges.left,
    y: rect.y - edges.top,
    width: rect.width + edges.left + edges.right,
    height: rect.height + edges.top + edges.bottom,
  };
}

function shrink(rect: Rect, edges: Fragment['margin']): Rect {
  return {
    x: rect.x + edges.left,
    y: rect.y + edges.top,
    width: Math.max(0, rect.width - edges.left - edges.right),
    height: Math.max(0, rect.height - edges.top - edges.bottom),
  };
}
