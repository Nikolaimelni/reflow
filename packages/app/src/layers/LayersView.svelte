<script lang="ts">
  import { type BoxId, toCss } from '@reflow/engine';
  import type { Session } from '../engine-run/session.svelte.js';

  const { session }: { session: Session } = $props();

  /** Distance between planes, in the same pixels the page is measured in. */
  const GAP = 90;

  /** Room for the label chip hanging off the top left corner of each plane. */
  const LABEL = 26;

  /**
   * A thousand planes of CSS 3D will put the compositor on the floor, so the view stops and
   * says so rather than quietly getting slower.
   */
  const LIMIT = 350;

  type Placed = {
    box: BoxId;
    x: number;
    y: number;
    width: number;
    height: number;
    background: string;
    opacity: number;
    hidden: boolean;
    label: string;
  };

  type Plane = {
    context: BoxId;
    depth: number;
    zIndex: number | 'auto';
    label: string;
    boxes: Placed[];
  };

  let host: HTMLDivElement | undefined = $state();
  let width = $state(0);
  let height = $state(0);
  let pitch = $state(52);
  let spin = $state(-28);

  const flat = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const page = $derived.by(() => {
    const fallback = { width: session.viewport.width, height: session.viewport.height };
    if (session.result.status !== 'ok') return fallback;

    const root = session.result.layout.fragments.get(session.result.boxTree.id);
    return { width: session.viewport.width, height: Math.max(120, root?.rect.height ?? 0) };
  });

  const built = $derived.by(() => {
    if (session.result.status !== 'ok') return { planes: [] as Plane[], shown: 0, total: 0 };

    const result = session.result;
    const contexts = new Map<BoxId, Plane>();

    for (const context of result.display.contexts) {
      contexts.set(context.box, {
        context: context.box,
        depth: context.depth,
        zIndex: context.zIndex,
        label: result.labels.get(context.box) ?? '',
        boxes: [],
      });
    }

    let shown = 0;
    for (const item of result.display.items) {
      if (shown >= LIMIT) break;

      const fragment = result.layout.fragments.get(item.box);
      const box = result.boxes.get(item.box);
      const plane = contexts.get(item.context);
      if (fragment === undefined || box === undefined || plane === undefined) continue;
      if (fragment.rect.width <= 0 || fragment.rect.height <= 0) continue;

      plane.boxes.push({
        box: item.box,
        x: fragment.rect.x,
        y: fragment.rect.y,
        width: fragment.rect.width,
        height: fragment.rect.height,
        background: toCss(box.style.backgroundColor),
        opacity: box.style.opacity,
        hidden: !item.visible,
        label: result.labels.get(item.box) ?? '',
      });
      shown++;
    }

    return {
      planes: [...contexts.values()].sort((a, b) => a.depth - b.depth),
      shown,
      total: result.display.items.length,
    };
  });

  /**
   * The stack is rotated before it is scaled, so fitting it to the stage means projecting its
   * corners first. A fudge factor on the page width was wrong at every angle except the one I
   * happened to be looking at. Perspective is left out: it can only magnify by the depth over
   * the perspective distance, which the margin below covers.
   */
  const footprint = $derived.by(() => {
    const half = { x: page.width / 2 + LABEL, y: page.height / 2 + LABEL };
    const far = ((built.planes.length - 1) * GAP) / 2;
    const p = (pitch * Math.PI) / 180;
    const s = (spin * Math.PI) / 180;

    let across = 0;
    let down = 0;

    for (const x of [-half.x, half.x]) {
      for (const y of [-half.y, half.y]) {
        for (const z of [-far, far]) {
          across = Math.max(across, Math.abs(x * Math.cos(s) - y * Math.sin(s)));
          const turned = x * Math.sin(s) + y * Math.cos(s);
          down = Math.max(down, Math.abs(turned * Math.cos(p) + z * Math.sin(p)));
        }
      }
    }

    return { across: across * 2, down: down * 2 };
  });

  const scale = $derived.by(() => {
    if (width === 0 || footprint.across === 0) return 1;
    const margin = 28;
    const across = (width - margin) / footprint.across;
    const down = (height - margin) / footprint.down;
    return Math.max(0.1, Math.min(1.6, across, down));
  });

  $effect(() => {
    if (host === undefined) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry === undefined) return;
      width = entry.contentRect.width;
      height = entry.contentRect.height;
    });

    observer.observe(host);
    return () => {
      observer.disconnect();
    };
  });

  function orbit(event: PointerEvent): void {
    if (event.buttons === 0 || flat) return;
    pitch = Math.min(85, Math.max(0, pitch - event.movementY * 0.4));
    spin = spin + event.movementX * 0.4;
  }
</script>

<div class="layers">
  <div class="head">
    <span class="title">layers</span>
    <span class="count">
      {built.planes.length} stacking {built.planes.length === 1 ? 'context' : 'contexts'}
      {#if built.shown < built.total}
        &middot; showing the first {built.shown} of {built.total} boxes
      {/if}
    </span>
  </div>

  <div
    class="stage"
    class:flat
    bind:this={host}
    onpointermove={orbit}
    role="presentation"
    title={flat ? '' : 'drag to turn'}
  >
    <div
      class="world"
      style:width="{page.width}px"
      style:height="{page.height}px"
      style:transform={flat
        ? 'none'
        : `translate(-50%, -50%) scale(${scale}) rotateX(-${pitch}deg) rotateZ(${spin}deg)` +
          ` translateZ(${-((built.planes.length - 1) * GAP) / 2}px)`}
    >
      {#each built.planes as plane (plane.context)}
        <div class="plane" style:transform={flat ? 'none' : `translateZ(${plane.depth * GAP}px)`}>
          <span class="plane-label" style:left={flat ? '0' : `${plane.depth * 18}px`}>
            {plane.label}
            {plane.zIndex === 'auto' ? '' : `z-index ${plane.zIndex}`}
          </span>

          {#each plane.boxes as placed (placed.box)}
            <div
              class="box"
              class:hidden={placed.hidden}
              class:lit={session.hovered === placed.box}
              style:left="{placed.x}px"
              style:top="{placed.y}px"
              style:width="{placed.width}px"
              style:height="{placed.height}px"
              style:background={placed.background}
              style:opacity={placed.opacity}
              title={placed.label}
            ></div>
          {/each}
        </div>
      {/each}
    </div>
  </div>
</div>

<style>
  .layers {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
    border: 1px solid var(--rule);
    background: var(--surface);
  }

  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    padding: 7px 10px;
    border-bottom: 1px solid var(--rule);
    font-family: var(--mono);
    font-size: 11px;
  }

  .title {
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--ink-3);
  }

  .count {
    color: var(--ink-2);
  }

  .stage {
    position: relative;
    flex: 1;
    min-height: 420px;
    overflow: hidden;
    perspective: 1400px;
    background:
      radial-gradient(circle at 50% 30%, #f7f9fc, var(--surface-2));
    cursor: grab;
  }

  .stage.flat {
    perspective: none;
    overflow: auto;
    cursor: default;
  }

  .stage:active {
    cursor: grabbing;
  }

  .world {
    position: absolute;
    left: 50%;
    top: 50%;
    transform-style: preserve-3d;
    transform-origin: 50% 50%;
  }

  .plane {
    position: absolute;
    inset: 0;
    transform-style: preserve-3d;
    background: rgb(255 255 255 / 0.55);
    outline: 1px solid var(--rule-strong);
    outline-offset: 0;
  }

  .stage.flat .world {
    position: relative;
    left: 0;
    top: 0;
    width: auto !important;
    height: auto !important;
    padding: 16px;
    transform: none !important;
  }

  .stage.flat .plane {
    position: relative;
    inset: auto;
    height: 240px;
    margin-bottom: 26px;
    border: 1px dashed var(--rule-strong);
  }

  .plane-label {
    position: absolute;
    top: -19px;
    left: 0;
    padding: 1px 5px;
    background: rgb(255 255 255 / 0.9);
    outline: 1px solid var(--rule);
    white-space: nowrap;
    font-family: var(--mono);
    font-size: 10px;
    color: var(--ink-2);
  }

  .box {
    position: absolute;
    outline: 1px solid rgb(18 22 32 / 0.35);
    outline-offset: -1px;
  }

  .box.hidden {
    outline-style: dashed;
    opacity: 0.2 !important;
  }

  .box.lit {
    outline: 2px solid var(--accent);
    outline-offset: 0;
  }
</style>
