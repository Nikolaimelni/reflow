import type { Box } from '../boxtree/box.js';
import { isBlock } from '../boxtree/box.js';
import { fontOf, segmentText, symbolMarkerAdvance, type TextMeasurer, wraps } from './text.js';
import {
  clampSize,
  toContentBox,
  usedBorderWidths,
  usedMargin,
  usedMaxSize,
  usedPadding,
  usedSize,
} from './used.js';

export type Intrinsic = { min: number; max: number };

/**
 * The spec's preferred minimum and preferred widths. The minimum is the widest thing that
 * cannot be broken any further, usually the longest word. The maximum is what the content
 * would take if it never broke at all. Shrink-to-fit picks a point between them.
 *
 * Percentages resolve to zero here, because the whole point of this pass is that no width is
 * known yet.
 */
export function intrinsicWidths(box: Box, measurer: TextMeasurer): Intrinsic {
  if (box.kind === 'text' || (box.kind === 'inline' && !box.atomic)) {
    return inlineIntrinsic([box], measurer, true);
  }
  return outerIntrinsic(box, measurer);
}

/** Without the box's own margins, border and padding, for a caller that adds them itself. */
export function intrinsicContentWidths(box: Box, measurer: TextMeasurer): Intrinsic {
  return contentIntrinsic(box, measurer);
}

export function shrinkToFit(intrinsic: Intrinsic, available: number): number {
  return Math.min(Math.max(intrinsic.min, available), intrinsic.max);
}

function outerIntrinsic(box: Box, measurer: TextMeasurer): Intrinsic {
  if (box.kind === 'text') return inlineIntrinsic([box], measurer, true);

  const style = box.style;
  const border = usedBorderWidths(style);
  const padding = usedPadding(style, 0);
  const surround = border.left + border.right + padding.left + padding.right;
  const margins = (usedMargin(style.marginLeft, 0) ?? 0) + (usedMargin(style.marginRight, 0) ?? 0);

  const definite = usedSize(style.width, null);
  const inner =
    definite === null ? contentIntrinsic(box, measurer) : { min: definite, max: definite };

  const min = toContentBox(style.boxSizing, usedSize(style.minWidth, null), surround);
  const max = toContentBox(style.boxSizing, usedMaxSize(style.maxWidth, null), surround);
  const extra = margins + (definite !== null && style.boxSizing === 'border-box' ? 0 : surround);

  return {
    min: clampSize(inner.min, min, max) + extra,
    max: clampSize(inner.max, min, max) + extra,
  };
}

function contentIntrinsic(box: Box, measurer: TextMeasurer): Intrinsic {
  if (box.kind === 'text') return inlineIntrinsic([box], measurer, true);

  // An absolutely positioned child is out of the flow, so it takes no part in how wide its
  // parent wants to be.
  const children = box.children.filter(
    (child) => child.kind === 'text' || child.style.position !== 'absolute',
  );
  const blocks = children.filter(isBlock);

  if (blocks.length > 0) {
    let min = 0;
    let max = 0;
    for (const child of blocks) {
      const outer = outerIntrinsic(child, measurer);
      min = Math.max(min, outer.min);
      max = Math.max(max, outer.max);
    }
    return { min, max };
  }

  return inlineIntrinsic(children, measurer, wraps(box.style.whiteSpace));
}

function inlineIntrinsic(
  children: readonly Box[],
  measurer: TextMeasurer,
  canWrap: boolean,
): Intrinsic {
  /**
   * The same rules the line breaker follows, or the two disagree about what a line costs.
   * A space only counts once it has a word after it, a run with no space in it cannot be
   * broken however wide it gets, and an inline box's own padding travels with its content.
   */
  let min = 0;
  let max = 0;
  let line = 0;
  let run = 0;
  /** A space that could be broken at: it belongs to the line but not to the run. */
  let gap = 0;
  /** A space that could not: it belongs to both, because nothing may split it off. */
  let glue = 0;
  let content = false;

  const endRun = () => {
    min = Math.max(min, run);
    run = 0;
  };

  const endLine = () => {
    endRun();
    max = Math.max(max, line);
    line = 0;
    gap = 0;
    glue = 0;
    content = false;
  };

  const add = (width: number) => {
    line += gap + glue + width;
    run += glue + width;
    gap = 0;
    glue = 0;
    content = true;
  };

  /** An inline box's own padding cannot be broken away from its content, or counted twice. */
  const addEdge = (width: number) => {
    line += width;
    run += width;
  };

  const visit = (boxes: readonly Box[]): void => {
    for (const child of boxes) {
      if (child.kind === 'text') {
        const preserve = child.style.whiteSpace === 'pre';

        for (const segment of segmentText(child.text, child.style.whiteSpace)) {
          if (segment.kind === 'newline') {
            endLine();
            continue;
          }

          const font = fontOf(child.style);
          const width = child.symbol
            ? symbolMarkerAdvance(measurer.metrics(font), font.size)
            : measurer.advance(segment.text, font);

          if (segment.kind === 'space') {
            if (preserve) add(width);
            else if (!content) continue;
            else if (gap > 0 || glue > 0) {
              // A run of spaces counts once, and it is the first that counts, the same as on
              // the line. One that may break still makes the run somewhere to break.
              if (glue > 0 && wraps(child.style.whiteSpace)) {
                endRun();
                gap = glue;
                glue = 0;
              }
            } else if (wraps(child.style.whiteSpace)) {
              endRun();
              gap = width;
            } else {
              glue = width;
            }
            continue;
          }

          add(width);
        }
        continue;
      }

      if (child.kind === 'inline' && !child.atomic) {
        const border = usedBorderWidths(child.style);
        const padding = usedPadding(child.style, 0);
        const margin =
          (usedMargin(child.style.marginLeft, 0) ?? 0) +
          (usedMargin(child.style.marginRight, 0) ?? 0);

        addEdge(border.left + padding.left);
        visit(child.children);
        addEdge(border.right + padding.right + margin);
        continue;
      }

      const outer = outerIntrinsic(child, measurer);
      add(outer.max);
      min = Math.max(min, outer.min);
    }
  };

  visit(children);
  endLine();

  // Nothing can break, so the narrowest the content goes is also the widest it gets. Blink
  // keeps these in sixty-fourths of a pixel, rounded up, so text measured a hair under a
  // sixty-fourth still asks for the whole of it.
  const up = (value: number) => Math.ceil(value * 64 - 1e-6) / 64;
  return canWrap ? { min: up(min), max: up(max) } : { min: up(max), max: up(max) };
}
