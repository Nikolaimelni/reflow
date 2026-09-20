import { describe, expect, it } from 'vitest';
import type { AlignItems, JustifyContent } from '../cascade/properties.js';
import { type FlexItemInput, type FlexLineInput, solveFlex } from './flex.js';

function item(overrides: Partial<FlexItemInput> = {}): FlexItemInput {
  return {
    grow: 0,
    shrink: 1,
    basis: 100,
    minMain: 0,
    maxMain: null,
    mainSurround: 0,
    crossSurround: 0,
    marginMainStart: 0,
    marginMainEnd: 0,
    marginCrossStart: 0,
    marginCrossEnd: 0,
    autoMainStart: false,
    autoMainEnd: false,
    autoCrossStart: false,
    autoCrossEnd: false,
    crossSize: 20,
    align: null,
    ...overrides,
  };
}

function line(overrides: Partial<FlexLineInput> = {}) {
  const input: FlexLineInput = {
    mainSize: 300,
    crossSize: null,
    justify: 'flex-start',
    align: 'stretch',
    alignContent: 'normal',
    reverse: false,
    wrap: 'nowrap',
    mainGap: 0,
    crossGap: 0,
    items: [item(), item()],
    crossOf: () => 0,
    baselineOf: () => null,
    ...overrides,
  };
  return solveFlex(input);
}

const mains = (result: ReturnType<typeof line>) => result.placements.map((one) => one.mainSize);
const starts = (result: ReturnType<typeof line>) => result.placements.map((one) => one.mainStart);

describe('main axis sizing', () => {
  it('leaves items at their base size when nothing grows', () => {
    expect(mains(line({ items: [item({ basis: 60 }), item({ basis: 90 })] }))).toEqual([60, 90]);
  });

  it('shares free space by the grow factor', () => {
    const result = line({
      items: [item({ basis: 50, grow: 1 }), item({ basis: 50, grow: 2 })],
    });
    // 200 left over, split one to two
    expect(mains(result)).toEqual([50 + 200 / 3, 50 + 400 / 3]);
  });

  it('weighs shrinking by the base size as well as the factor', () => {
    const result = line({
      mainSize: 200,
      items: [item({ basis: 100, shrink: 1 }), item({ basis: 300, shrink: 1 })],
    });
    // 200 to give back, weighted 100 to 300
    expect(mains(result)).toEqual([100 - 50, 300 - 150]);
  });

  it('refuses to shrink past the minimum', () => {
    const result = line({
      mainSize: 100,
      items: [item({ basis: 200, minMain: 150 }), item({ basis: 200, minMain: 0 })],
    });
    expect(mains(result)[0]).toBe(150);
  });

  it('refuses to grow past the maximum', () => {
    const result = line({
      items: [item({ basis: 50, grow: 1, maxMain: 70 }), item({ basis: 50 })],
    });
    expect(mains(result)[0]).toBe(70);
  });

  it("counts an item's own padding and margin against the free space", () => {
    const result = line({
      items: [item({ basis: 50, grow: 1, mainSurround: 20, marginMainStart: 10 })],
    });
    expect(mains(result)[0]).toBe(280);
    expect(starts(result)[0]).toBe(10);
  });

  it('hands out nothing when the container has no definite main size', () => {
    const result = line({ mainSize: null, items: [item({ basis: 40, grow: 1 })] });
    expect(mains(result)).toEqual([40]);
    expect(result.mainSize).toBe(40);
  });
});

describe('justify-content', () => {
  const run = (justify: JustifyContent, count = 2) =>
    starts(line({ justify, items: Array.from({ length: count }, () => item({ basis: 50 })) }));

  it('packs to the start by default', () => {
    expect(run('flex-start')).toEqual([0, 50]);
  });

  it('packs to the end', () => {
    expect(run('flex-end')).toEqual([200, 250]);
  });

  it('centres the group', () => {
    expect(run('center')).toEqual([100, 150]);
  });

  it('pushes the gap between them', () => {
    expect(run('space-between')).toEqual([0, 250]);
  });

  it('gives each item half a gap on each side', () => {
    expect(run('space-around')).toEqual([50, 200]);
  });

  it('gives every gap the same width', () => {
    expect(run('space-evenly')).toEqual([200 / 3, 50 + (200 / 3) * 2]);
  });
});

describe('cross axis', () => {
  const crosses = (align: AlignItems, crossSize: number | null) => {
    const result = line({
      align,
      crossSize,
      items: [item({ crossSize: 20 }), item({ crossSize: 40 })],
    });
    return result.placements.map((one) => [one.crossStart, one.crossSize]);
  };

  it('takes the line height from the tallest item', () => {
    const result = line({
      align: 'flex-start',
      items: [item({ crossSize: 20 }), item({ crossSize: 40 })],
    });
    expect(result.crossSize).toBe(40);
  });

  it('stretches only the items whose cross size is auto', () => {
    const result = line({
      align: 'stretch',
      crossSize: 60,
      items: [item({ crossSize: null }), item({ crossSize: 25 })],
    });
    expect(result.placements.map((one) => one.crossSize)).toEqual([60, 25]);
  });

  it('leaves a short item at the start, the end or the middle', () => {
    expect(crosses('flex-start', 100)).toEqual([
      [0, 20],
      [0, 40],
    ]);
    expect(crosses('flex-end', 100)).toEqual([
      [80, 20],
      [60, 40],
    ]);
    expect(crosses('center', 100)).toEqual([
      [40, 20],
      [30, 40],
    ]);
  });

  it('lines baselines up and lets the line grow to fit', () => {
    const result = line({
      align: 'baseline',
      items: [item({ crossSize: 20 }), item({ crossSize: 40 })],
      baselineOf: (index) => (index === 0 ? 15 : 32),
    });

    expect(result.placements.map((one) => one.crossStart)).toEqual([17, 0]);
    expect(result.crossSize).toBe(40);
  });
});

describe('the other way round', () => {
  it('packs a reversed line against the end it starts at', () => {
    const items = [item({ basis: 60 }), item({ basis: 90 })];

    expect(starts(line({ items, reverse: true }))).toEqual([240, 150]);
  });

  it('turns the whole arrangement around, spacing and all', () => {
    const items = [item({ basis: 60 }), item({ basis: 90 })];
    const spread = line({ items, reverse: true, justify: 'space-between' });

    expect(starts(spread)).toEqual([240, 0]);
  });

  it('keeps a margin on the side it was written on', () => {
    const items = [item({ basis: 60, mainSurround: 10, marginMainStart: 4, marginMainEnd: 6 })];

    expect(starts(line({ items, reverse: true }))).toEqual([236]);
  });
});

describe('align-self', () => {
  it('lets one item leave the line it is in', () => {
    const items = [item({ crossSize: 20 }), item({ crossSize: 10, align: 'flex-end' })];
    const result = line({ items, align: 'flex-start', crossSize: 40 });

    expect(result.placements.map((one) => one.crossStart)).toEqual([0, 30]);
  });

  it('stretches only the items that asked to', () => {
    const items = [item({ crossSize: null, align: 'stretch' }), item({ crossSize: null })];
    const result = line({ items, align: 'flex-start', crossSize: 40, crossOf: () => 10 });

    expect(result.placements.map((one) => one.crossSize)).toEqual([40, 10]);
  });
});

describe('wrapping', () => {
  const box = (basis: number) => item({ basis, crossSize: 10, shrink: 0 });

  it('puts what will not fit on the next line', () => {
    const items = [box(200), box(200), box(200)];
    const result = line({ items, mainSize: 450, wrap: 'wrap' });

    expect(starts(result)).toEqual([0, 200, 0]);
    expect(result.placements.map((one) => one.crossStart)).toEqual([0, 0, 10]);
    expect(result.crossSize).toBe(20);
  });

  it('shares the free space within a line and not across them', () => {
    const items = [item({ basis: 200, crossSize: 10, grow: 1 }), box(200), box(200)];
    const result = line({ items, mainSize: 450, wrap: 'wrap' });

    // The first line has fifty to give and one taker; the second line is on its own.
    expect(mains(result)).toEqual([250, 200, 200]);
  });

  it('stacks the lines the other way round when asked', () => {
    const items = [box(200), box(200), box(200)];
    const result = line({ items, mainSize: 450, wrap: 'wrap-reverse' });

    expect(result.placements.map((one) => one.crossStart)).toEqual([10, 10, 0]);
  });

  it('measures a turned around line from the far side', () => {
    // The caller hands the margins over already swapped, so the start margin here is the one
    // that ends up at the bottom.
    const items = [
      item({ crossSize: 10, crossSurround: 8, marginCrossStart: 6, marginCrossEnd: 2 }),
    ];
    const result = line({ items, mainSize: 450, wrap: 'wrap-reverse' });

    expect(result.crossSize).toBe(18);
    expect(result.placements.map((one) => one.crossStart)).toEqual([2]);
  });

  it('keeps everything on one line when it must not wrap', () => {
    const items = [box(200), box(200), box(200)];
    const result = line({ items, mainSize: 450, wrap: 'nowrap' });

    expect(result.placements.map((one) => one.crossStart)).toEqual([0, 0, 0]);
  });
});

describe('gaps', () => {
  const box = (basis: number) => item({ basis, crossSize: 10, shrink: 0 });
  const across = (result: ReturnType<typeof line>) =>
    result.placements.map((one) => one.crossStart);

  it('takes its room before the items get theirs', () => {
    const items = [item({ basis: 100, grow: 1 }), item({ basis: 100, grow: 1 })];
    const result = line({ items, mainGap: 20 });

    expect(mains(result)).toEqual([140, 140]);
    expect(starts(result)).toEqual([0, 160]);
  });

  it('counts towards what fits on a line', () => {
    const items = [box(200), box(200)];

    expect(across(line({ items, mainSize: 420, wrap: 'wrap', mainGap: 30 }))).toEqual([0, 10]);
    expect(across(line({ items, mainSize: 420, wrap: 'wrap', mainGap: 10 }))).toEqual([0, 0]);
  });

  it('keeps the lines apart', () => {
    const items = [box(200), box(200), box(200)];
    const result = line({ items, mainSize: 450, wrap: 'wrap', crossGap: 6 });

    expect(across(result)).toEqual([0, 0, 16]);
    expect(result.crossSize).toBe(26);
  });
});

describe('align-content', () => {
  const box = (basis: number) => item({ basis, crossSize: 10, shrink: 0 });
  const wrapped = (overrides: Partial<FlexLineInput>) =>
    line({
      items: [box(200), box(200), box(200)],
      mainSize: 450,
      crossSize: 100,
      wrap: 'wrap',
      ...overrides,
    }).placements.map((one) => one.crossStart);

  it('stretches the lines to fill the container', () => {
    expect(wrapped({})).toEqual([0, 0, 50]);
  });

  it('packs them against the end', () => {
    expect(wrapped({ alignContent: 'flex-end' })).toEqual([80, 80, 90]);
  });

  it('puts the free space between them', () => {
    expect(wrapped({ alignContent: 'space-between' })).toEqual([0, 0, 90]);
  });

  it('leaves a container that will not wrap alone', () => {
    expect(wrapped({ wrap: 'nowrap', alignContent: 'flex-end' })).toEqual([0, 0, 0]);
  });
});

describe('auto margins', () => {
  it('pushes an item to the far end with one of them', () => {
    const items = [item({ basis: 60 }), item({ basis: 60, autoMainStart: true })];

    expect(starts(line({ items }))).toEqual([0, 240]);
  });

  it('shares the room between them', () => {
    const items = [item({ basis: 100, autoMainStart: true, autoMainEnd: true })];

    expect(starts(line({ items }))).toEqual([100]);
  });

  it('leaves justify-content nothing to distribute', () => {
    const items = [item({ basis: 60, autoMainEnd: true }), item({ basis: 60 })];

    expect(starts(line({ items, justify: 'center' }))).toEqual([0, 240]);
  });

  it('stops an item stretching across the line', () => {
    const items = [item({ crossSize: null, autoCrossStart: true })];
    const result = line({ items, crossSize: 40, crossOf: () => 10 });

    expect(result.placements.map((one) => one.crossSize)).toEqual([10]);
    expect(result.placements.map((one) => one.crossStart)).toEqual([30]);
  });
});
