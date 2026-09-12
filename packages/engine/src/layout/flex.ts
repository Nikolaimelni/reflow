import type { AlignItems, JustifyContent } from '../cascade/properties.js';

export type FlexItemInput = {
  grow: number;
  shrink: number;
  /** Flex base size: the content main size the item starts from. */
  basis: number;
  minMain: number;
  maxMain: number | null;
  /** Margin, border and padding along the main axis. */
  mainSurround: number;
  /** Margin, border and padding along the cross axis. */
  crossSurround: number;
  marginMainStart: number;
  marginCrossStart: number;
  /** Cross content size when the style pins it, null when it is auto. */
  crossSize: number | null;
};

export type FlexLineInput = {
  /** null when the container's main size is indefinite, which leaves no free space to share. */
  mainSize: number | null;
  justify: JustifyContent;
  align: AlignItems;
  /** Cross content size the container pins, null when it comes from the items. */
  crossSize: number | null;
  items: readonly FlexItemInput[];
  /** Cross content size of an item once its main size is settled. */
  crossOf: (index: number, main: number) => number;
  /** Offset from an item's cross start to its baseline, or null if it has none. */
  baselineOf: (index: number, main: number) => number | null;
};

export type FlexPlacement = {
  /** Border-box offset from the content box start, along each axis. */
  mainStart: number;
  crossStart: number;
  /** Content sizes. */
  mainSize: number;
  crossSize: number;
};

export type FlexLineResult = {
  placements: FlexPlacement[];
  mainSize: number;
  crossSize: number;
};

/**
 * One flex line. Sizes resolve first, because nothing can be positioned until the free space
 * is known, and the cross axis resolves last, because stretching depends on the line height
 * which depends on the items that are not stretching.
 */
export function solveFlexLine(input: FlexLineInput): FlexLineResult {
  const mains = resolveMainSizes(input);
  const outerMain = input.items.map((item, i) => (mains[i] ?? 0) + item.mainSurround);
  const contentMain = outerMain.reduce((sum, one) => sum + one, 0);
  const mainSize = input.mainSize ?? contentMain;

  const spacing = distribute(input.justify, input.items.length, mainSize - contentMain);
  const mainStarts: number[] = [];
  let cursor = spacing.leading;

  input.items.forEach((item, i) => {
    mainStarts.push(cursor + item.marginMainStart);
    cursor += (outerMain[i] ?? 0) + spacing.between;
  });

  const cross = resolveCross(input, mains);

  return {
    placements: input.items.map((_, i) => ({
      mainStart: mainStarts[i] ?? 0,
      mainSize: mains[i] ?? 0,
      crossStart: cross.starts[i] ?? 0,
      crossSize: cross.sizes[i] ?? 0,
    })),
    mainSize,
    crossSize: cross.lineSize,
  };
}

function resolveMainSizes(input: FlexLineInput): number[] {
  const hypothetical = input.items.map((item) => clamp(item.basis, item.minMain, item.maxMain));

  if (input.mainSize === null) return hypothetical;

  const outer = hypothetical.reduce(
    (sum, size, i) => sum + size + (input.items[i]?.mainSurround ?? 0),
    0,
  );
  const free = input.mainSize - outer;

  if (free === 0) return hypothetical;
  return free > 0 ? grow(input, hypothetical, free) : shrink(input, hypothetical, free);
}

function grow(input: FlexLineInput, hypothetical: readonly number[], free: number): number[] {
  const total = input.items.reduce((sum, item) => sum + item.grow, 0);
  if (total === 0) return [...hypothetical];

  return input.items.map((item, i) =>
    clamp((hypothetical[i] ?? 0) + (free * item.grow) / total, item.minMain, item.maxMain),
  );
}

/** Shrinking is weighted by the base size as well as the factor, unlike growing. */
function shrink(input: FlexLineInput, hypothetical: readonly number[], free: number): number[] {
  const weights = input.items.map((item, i) => item.shrink * (hypothetical[i] ?? 0));
  const total = weights.reduce((sum, one) => sum + one, 0);
  if (total === 0) return [...hypothetical];

  return input.items.map((item, i) =>
    clamp((hypothetical[i] ?? 0) + (free * (weights[i] ?? 0)) / total, item.minMain, item.maxMain),
  );
}

function resolveCross(
  input: FlexLineInput,
  mains: readonly number[],
): { starts: number[]; sizes: number[]; lineSize: number } {
  const sizes = input.items.map((item, i) => item.crossSize ?? input.crossOf(i, mains[i] ?? 0));

  if (input.align === 'baseline') return alignBaselines(input, mains, sizes);

  const natural = Math.max(
    0,
    ...input.items.map((item, i) => (sizes[i] ?? 0) + item.crossSurround),
  );
  const lineSize = input.crossSize ?? natural;

  const starts = input.items.map((item, i) => {
    const stretched =
      input.align === 'stretch' && item.crossSize === null
        ? Math.max(0, lineSize - item.crossSurround)
        : (sizes[i] ?? 0);
    sizes[i] = stretched;

    const free = lineSize - (stretched + item.crossSurround);

    switch (input.align) {
      case 'flex-end':
        return free + item.marginCrossStart;
      case 'center':
        return free / 2 + item.marginCrossStart;
      default:
        return item.marginCrossStart;
    }
  });

  return { starts, sizes, lineSize };
}

function alignBaselines(
  input: FlexLineInput,
  mains: readonly number[],
  sizes: readonly number[],
): { starts: number[]; sizes: number[]; lineSize: number } {
  const baselines = input.items.map((_, i) => input.baselineOf(i, mains[i] ?? 0) ?? sizes[i] ?? 0);
  const above = Math.max(
    0,
    ...input.items.map((item, i) => item.marginCrossStart + (baselines[i] ?? 0)),
  );

  const starts = input.items.map((_, i) => above - (baselines[i] ?? 0));
  const lineSize =
    input.crossSize ??
    Math.max(
      0,
      ...input.items.map((item, i) => (starts[i] ?? 0) + (sizes[i] ?? 0) + item.crossSurround),
    );

  return { starts, sizes: [...sizes], lineSize };
}

function distribute(
  justify: JustifyContent,
  count: number,
  free: number,
): { leading: number; between: number } {
  if (free <= 0 || count === 0) return { leading: 0, between: 0 };

  switch (justify) {
    case 'flex-end':
      return { leading: free, between: 0 };
    case 'center':
      return { leading: free / 2, between: 0 };
    case 'space-between':
      return count === 1 ? { leading: 0, between: 0 } : { leading: 0, between: free / (count - 1) };
    case 'space-around':
      return { leading: free / count / 2, between: free / count };
    case 'space-evenly':
      return { leading: free / (count + 1), between: free / (count + 1) };
    default:
      return { leading: 0, between: 0 };
  }
}

function clamp(value: number, min: number, max: number | null): number {
  const capped = max === null ? value : Math.min(value, max);
  return Math.max(capped, min);
}
