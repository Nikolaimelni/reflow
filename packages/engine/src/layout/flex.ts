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
  /** The min and max on the cross axis, which a stretch has to respect like anything else. */
  minCross: number;
  maxCross: number | null;
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
  // which is how `margin-left: auto` pushes one item to the far end of a row. When the line
  // overflows the margins come to nothing, and the overflow is aligned like any other.
  const hungry = input.items.reduce(
    (count, item) => count + (item.autoMainStart ? 1 : 0) + (item.autoMainEnd ? 1 : 0),
    0,
  );
  const free = mainSize - contentMain;
  const share = hungry > 0 && free > 0 ? free / hungry : 0;

  const spacing = distribute(input.justify, input.items.length, share > 0 ? 0 : free);
  const mainStarts: number[] = [];
  let cursor = spacing.leading;

  input.items.forEach((item, i) => {
    const eaten = (item.autoMainStart ? share : 0) + (item.autoMainEnd ? share : 0);
    const outer = (outerMain[i] ?? 0) + eaten;

    // Solved from the start of the main axis whichever way it runs, then turned around, so
    // that `justify-content: flex-start` packs against the end a reversed line begins at. The
    // margins are physical and do not turn with it: whichever way the line runs, the border
    // box starts past the margin on its left or top.
    const outerStart = input.reverse ? mainSize - cursor - outer : cursor;
    const start = outerStart + item.marginMainStart + (item.autoMainStart ? share : 0);

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

/**
 * The loop the spec calls resolving flexible lengths. Space is shared out from the flex base
 * sizes, anything the share pushes past its min or max is clamped and frozen, and what it
 * would not take goes round again to the items still free to move. A single pass gets the
 * sizes wrong the moment one item hits its floor: the room it refuses to give up has to come
 * out of somebody else.
 */
function resolveMainSizes(input: FlexLineInput): number[] {
  const items = input.items;
  const hypothetical = items.map((item) => clamp(item.basis, item.minMain, item.maxMain));

  if (input.mainSize === null) return hypothetical;

  const room = input.mainSize - input.mainGap * Math.max(0, items.length - 1);
  const wanted = hypothetical.reduce(
    (sum, size, i) => sum + size + (items[i]?.mainSurround ?? 0),
    0,
  );
  const growing = wanted < room;
  const factor = (item: FlexItemInput) => (growing ? item.grow : item.shrink);

  // An item that cannot flex, or that its min or max has already moved the way the line is
  // going, sits at its hypothetical size from the start.
  const target = [...hypothetical];
  const frozen = items.map(
    (item, i) =>
      factor(item) === 0 ||
      (growing && item.basis > (hypothetical[i] ?? 0)) ||
      (!growing && item.basis < (hypothetical[i] ?? 0)),
  );

  const spare = () =>
    items.reduce(
      (left, item, i) => left - (frozen[i] ? (target[i] ?? 0) : item.basis) - item.mainSurround,
      room,
    );
  const initial = spare();

  while (frozen.includes(false)) {
    const flexing = items.filter((_, i) => !frozen[i]);
    const factors = flexing.reduce((sum, item) => sum + factor(item), 0);

    // Factors that add up to less than one only take that fraction of the space.
    let free = spare();
    if (factors < 1 && Math.abs(initial * factors) < Math.abs(free)) free = initial * factors;

    // Shrinking is weighted by the base size as well as the factor, unlike growing.
    const weight = (item: FlexItemInput) => (growing ? item.grow : item.shrink * item.basis);
    const weights = flexing.reduce((sum, item) => sum + weight(item), 0);

    let violation = 0;
    const moved = items.map((item, i) => {
      if (frozen[i]) return { want: target[i] ?? 0, got: target[i] ?? 0 };

      const share = weights === 0 ? 0 : (free * weight(item)) / weights;
      const want = item.basis + toLayoutUnit(share);
      const got = Math.max(0, clamp(want, item.minMain, item.maxMain));
      violation += got - want;
      return { want, got };
    });

    moved.forEach(({ want, got }, i) => {
      if (frozen[i]) return;
      target[i] = got;
      if (violation === 0 || (violation > 0 && got > want) || (violation < 0 && got < want)) {
        frozen[i] = true;
      }
    });
  }

  return target;
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
    const resolved = asked === 'normal' ? 'stretch' : asked;
    // An item with an auto margin across the line is placed by the margin, so it never joins
    // the others on a shared baseline.
    const margined = item.autoCrossStart || item.autoCrossEnd;
    return resolved === 'baseline' && margined ? 'flex-start' : resolved;
  });
  // Border and padding across the line, which is the surround without its margins.
  const inner = (item: FlexItemInput) =>
    item.crossSurround - item.marginCrossStart - item.marginCrossEnd;

  // An item with no line of text in it has its baseline made up at the bottom of its border
  // box, which is where the ascent is measured to.
  const ascents = input.items.map((item, i) =>
    aligns[i] === 'baseline'
      ? (input.baselineOf(i, mains[i] ?? 0) ?? (sizes[i] ?? 0) + inner(item))
      : 0,
  );

  let above = 0;
  input.items.forEach((item, i) => {
    if (aligns[i] === 'baseline') {
      above = Math.max(above, item.marginCrossStart + (ascents[i] ?? 0));
    }
  });

  // Where each item starts across the line. For one hanging from the baseline that is its
  // border box, with its start margin already above it, so the margin is not counted twice.
  const hangs = (i: number) => (aligns[i] === 'baseline' ? above - (ascents[i] ?? 0) : 0);
  const natural = Math.max(
    0,
    ...input.items.map((item, i) =>
      aligns[i] === 'baseline'
        ? hangs(i) + (sizes[i] ?? 0) + item.crossSurround - item.marginCrossStart
        : (sizes[i] ?? 0) + item.crossSurround,
    ),
  );
  const lineSize = input.crossSize ?? natural;

  const starts = input.items.map((item, i) => {
    if (aligns[i] === 'baseline') return hangs(i);

    // An item with an auto margin across the line does not stretch: the margin is what takes
    // the room, and it takes all of it.
    const hungry = (item.autoCrossStart ? 1 : 0) + (item.autoCrossEnd ? 1 : 0);
    const stretched =
      aligns[i] === 'stretch' && item.crossSize === null && hungry === 0
        ? clamp(Math.max(0, lineSize - item.crossSurround), item.minCross, item.maxCross)
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
  if (count === 0 || free === 0) return { leading: 0, between: 0 };

  // Out of room, the end and the centre still hold and the items overflow the start, but the
  // values that share space out have nothing to share and start where the line starts.
  if (free < 0) {
    if (packing === 'flex-end') return { leading: free, between: 0 };
    if (packing === 'center') return { leading: free / 2, between: 0 };
    return { leading: 0, between: 0 };
  }

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

/**
 * Blink adds each item's share of the space as a whole number of sixty-fourths, rounded to the
 * nearest and away from zero at the half. It is a fraction of a pixel, and it decides whether
 * the last word of a line still fits in an item that was only just squeezed.
 */
function toLayoutUnit(value: number): number {
  return (Math.sign(value) * Math.round(Math.abs(value) * 64)) / 64;
}

function clamp(value: number, min: number, max: number | null): number {
  const capped = max === null ? value : Math.min(value, max);
  return Math.max(capped, min);
}
