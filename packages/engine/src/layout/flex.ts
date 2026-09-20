import type { AlignContent, AlignItems, FlexWrap, JustifyContent } from '../cascade/properties.js';

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
  marginMainEnd: number;
  marginCrossStart: number;
  marginCrossEnd: number;
  /** An `auto` margin takes the free space for itself, and stops the item stretching. */
  autoMainStart: boolean;
  autoMainEnd: boolean;
  autoCrossStart: boolean;
  autoCrossEnd: boolean;
  /** Cross content size when the style pins it, null when it is auto. */
  crossSize: number | null;
  /** What `align-self` says, or null to follow the container. */
  align: AlignItems | null;
};

export type FlexLineInput = {
  /** null when the container's main size is indefinite, which leaves no free space to share. */
  mainSize: number | null;
  justify: JustifyContent;
  align: AlignItems;
  alignContent: AlignContent;
  /** The main axis runs the other way, so the first item is laid out at the far end. */
  reverse: boolean;
  wrap: FlexWrap;
  /** Space kept between items along a line, and between the lines themselves. */
  mainGap: number;
  crossGap: number;
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
 * Items are cut into lines, each line is solved on its own, and the lines are then stacked
 * across. A container that will not wrap is the same thing with one line in it, and it hands
 * that line its own cross size rather than letting `align-content` near it.
 */
export function solveFlex(input: FlexLineInput): FlexLineResult {
  const runs = cutIntoLines(input);
  const wraps = input.wrap !== 'nowrap';
  const gaps = input.crossGap * Math.max(0, runs.length - 1);

  const solve = (run: readonly number[], crossSize: number | null) =>
    solveFlexLine({
      ...input,
      crossSize,
      items: run.map((index) => input.items[index]).filter(present),
      crossOf: (index, main) => input.crossOf(run[index] ?? 0, main),
      baselineOf: (index, main) => input.baselineOf(run[index] ?? 0, main),
    });

  // A line in a container that wraps is as big across as the items in it, even when that is
  // more than the container has: it is the container that overflows, not the items that
  // shrink. A container that does not wrap hands its own size down instead.
  const natural = runs.map((run) => solve(run, wraps ? null : input.crossSize));
  const content = natural.reduce((sum, line) => sum + line.crossSize, gaps);

  // `align-content` shares out the cross space the lines left over. Its initial value is
  // `normal`, which in a flex container stretches them to fill it.
  const packing = input.alignContent === 'normal' ? 'stretch' : input.alignContent;
  const free = wraps && input.crossSize !== null ? input.crossSize - content : 0;
  const spare = packing === 'stretch' && free > 0 ? free / runs.length : 0;

  const lines =
    spare === 0
      ? natural
      : runs.map((run, index) => solve(run, (natural[index]?.crossSize ?? 0) + spare));
  const spacing = distribute(packing, runs.length, spare === 0 ? free : 0);

  const placements: FlexPlacement[] = [];
  let mainSize = 0;
  let across = spacing.leading;
  let extent = 0;

  lines.forEach((line, index) => {
    const run = runs[index] ?? [];
    const start = across;

    run.forEach((item, at) => {
      const placement = line.placements[at];
      if (placement !== undefined) {
        placements[item] = { ...placement, crossStart: placement.crossStart + start };
      }
    });

    mainSize = Math.max(mainSize, line.mainSize);
    extent = start + line.crossSize;
    across = extent + input.crossGap + spacing.between;
  });

  return {
    placements:
      input.wrap === 'wrap-reverse'
        ? turnOver(placements, input, input.crossSize ?? extent)
        : placements,
    mainSize: input.mainSize ?? mainSize,
    crossSize: extent,
  };
}

function present<T>(value: T | undefined): value is T {
  return value !== undefined;
}

/** The greedy cut the spec asks for: an item goes on the line unless it no longer fits. */
function cutIntoLines(input: FlexLineInput): number[][] {
  if (input.wrap === 'nowrap' || input.mainSize === null) {
    return [input.items.map((_, index) => index)];
  }

  const lines: number[][] = [];
  let current: number[] = [];
  let used = 0;

  input.items.forEach((item, index) => {
    const outer = clamp(item.basis, item.minMain, item.maxMain) + item.mainSurround;
    const gap = current.length > 0 ? input.mainGap : 0;

    if (current.length > 0 && used + gap + outer > (input.mainSize ?? 0)) {
      lines.push(current);
      current = [index];
      used = outer;
      return;
    }

    current.push(index);
    used += gap + outer;
  });

  if (current.length > 0) lines.push(current);
  return lines;
}

/**
 * `wrap-reverse` turns the cross axis around: the first line is the one furthest across, and
 * so is the start of every item on it. The lines were solved in that turned around axis, with
 * the margins already swapped to match, so all that is left is to reflect the answer.
 */
function turnOver(
  placements: readonly FlexPlacement[],
  input: FlexLineInput,
  crossSize: number,
): FlexPlacement[] {
  return placements.map((placement, index) => {
    const item = input.items[index];
    if (item === undefined) return placement;

    const border =
      placement.crossSize + item.crossSurround - item.marginCrossStart - item.marginCrossEnd;

    return { ...placement, crossStart: crossSize - (placement.crossStart + border) };
  });
}

/**
 * One flex line. Sizes resolve first, because nothing can be positioned until the free space
 * is known, and the cross axis resolves last, because stretching depends on the line height
 * which depends on the items that are not stretching.
 */
export function solveFlexLine(input: FlexLineInput): FlexLineResult {
  const mains = resolveMainSizes(input);
  const outerMain = input.items.map((item, i) => (mains[i] ?? 0) + item.mainSurround);
  const contentMain = outerMain.reduce(
    (sum, one) => sum + one,
    input.mainGap * Math.max(0, input.items.length - 1),
  );
  const mainSize = input.mainSize ?? contentMain;

  // An auto margin on the main axis eats the free space before `justify-content` sees any,
  // which is how `margin-left: auto` pushes one item to the far end of a row.
  const hungry = input.items.reduce(
    (count, item) => count + (item.autoMainStart ? 1 : 0) + (item.autoMainEnd ? 1 : 0),
    0,
  );
  const free = mainSize - contentMain;
  const share = hungry > 0 && free > 0 ? free / hungry : 0;

  const spacing = distribute(input.justify, input.items.length, hungry > 0 ? 0 : free);
  const mainStarts: number[] = [];
  let cursor = spacing.leading;

  input.items.forEach((item, i) => {
    const eaten = (item.autoMainStart ? share : 0) + (item.autoMainEnd ? share : 0);
    const outer = (outerMain[i] ?? 0) + eaten;

    // Solved from the start of the main axis whichever way it runs, then turned around, so
    // that `justify-content: flex-start` packs against the end a reversed line begins at.
    const start = input.reverse
      ? mainSize - cursor - outer + item.marginMainEnd + (item.autoMainEnd ? share : 0)
      : cursor + item.marginMainStart + (item.autoMainStart ? share : 0);

    mainStarts.push(start);
    cursor += outer + input.mainGap + spacing.between;
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
    input.mainGap * Math.max(0, input.items.length - 1),
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

/**
 * Every item is placed by its own `align-self`, falling back to the container's `align-items`.
 * The ones asking for a baseline share one: the line makes room for the tallest ascent among
 * them and they all hang from it, while the rest are placed against the line they sit in.
 */
function resolveCross(
  input: FlexLineInput,
  mains: readonly number[],
): { starts: number[]; sizes: number[]; lineSize: number } {
  const sizes = input.items.map((item, i) => item.crossSize ?? input.crossOf(i, mains[i] ?? 0));
  // `normal` is what a browser reports when nothing asked for anything, and in a flex
  // container it means stretch.
  const aligns = input.items.map((item) => {
    const asked = item.align ?? input.align;
    return asked === 'normal' ? 'stretch' : asked;
  });
  const ascents = input.items.map((_, i) =>
    aligns[i] === 'baseline' ? (input.baselineOf(i, mains[i] ?? 0) ?? sizes[i] ?? 0) : 0,
  );

  let above = 0;
  input.items.forEach((item, i) => {
    if (aligns[i] === 'baseline') {
      above = Math.max(above, item.marginCrossStart + (ascents[i] ?? 0));
    }
  });

  const hangs = (i: number) => (aligns[i] === 'baseline' ? above - (ascents[i] ?? 0) : 0);
  const natural = Math.max(
    0,
    ...input.items.map((item, i) => hangs(i) + (sizes[i] ?? 0) + item.crossSurround),
  );
  const lineSize = input.crossSize ?? natural;

  const starts = input.items.map((item, i) => {
    if (aligns[i] === 'baseline') return hangs(i);

    // An item with an auto margin across the line does not stretch: the margin is what takes
    // the room, and it takes all of it.
    const hungry = (item.autoCrossStart ? 1 : 0) + (item.autoCrossEnd ? 1 : 0);
    const stretched =
      aligns[i] === 'stretch' && item.crossSize === null && hungry === 0
        ? Math.max(0, lineSize - item.crossSurround)
        : (sizes[i] ?? 0);
    sizes[i] = stretched;

    const free = lineSize - (stretched + item.crossSurround);

    if (hungry > 0) {
      const share = free > 0 ? free / hungry : 0;
      return item.marginCrossStart + (item.autoCrossStart ? share : 0);
    }

    switch (aligns[i]) {
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

function distribute(
  packing: AlignContent,
  count: number,
  free: number,
): { leading: number; between: number } {
  if (free <= 0 || count === 0) return { leading: 0, between: 0 };

  switch (packing) {
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
