import type { Box } from '../boxtree/box.js';
import { isBlock } from '../boxtree/box.js';
import { fontOf, segmentText, type TextMeasurer, wraps } from './text.js';
import {
  clampSize,
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

  const min = usedSize(style.minWidth, null);
  const max = usedMaxSize(style.maxWidth, null);
  const extra = margins + (definite !== null && style.boxSizing === 'border-box' ? 0 : surround);

  return {
    min: clampSize(inner.min, min, max) + extra,
    max: clampSize(inner.max, min, max) + extra,
  };
}

function contentIntrinsic(box: Box, measurer: TextMeasurer): Intrinsic {
  if (box.kind === 'text') return inlineIntrinsic([box], measurer, true);

  const blocks = box.children.filter(isBlock);

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

  return inlineIntrinsic(box.children, measurer, wraps(box.style.whiteSpace));
}

function inlineIntrinsic(
  children: readonly Box[],
  measurer: TextMeasurer,
  canWrap: boolean,
): Intrinsic {
  let min = 0;
  let max = 0;
  let line = 0;

  const visit = (boxes: readonly Box[]): void => {
    for (const child of boxes) {
      if (child.kind === 'text') {
        for (const segment of segmentText(child.text, child.style.whiteSpace)) {
          if (segment.kind === 'newline') {
            max = Math.max(max, line);
            line = 0;
            continue;
          }
          const width = measurer.advance(segment.text, fontOf(child.style));
          line += width;
          if (segment.kind === 'word') min = Math.max(min, width);
        }
        continue;
      }

      if (child.kind === 'inline' && !child.atomic) {
        visit(child.children);
        continue;
      }

      const outer = outerIntrinsic(child, measurer);
      line += outer.max;
      min = Math.max(min, outer.min);
    }
  };

  visit(children);
  max = Math.max(max, line);

  // Nothing can break, so the narrowest the content goes is also the widest it gets.
  return canWrap ? { min, max } : { min: max, max };
}
