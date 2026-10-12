<script lang="ts">
  import { type BoxId, hitTest } from '@reflow/engine';
  import type { Session } from '../engine-run/session.svelte.js';
  import { draw } from './draw.js';
  import { BOX_MODEL_LEGEND } from './palette.js';

  const { session }: { session: Session } = $props();

  let canvas: HTMLCanvasElement | undefined = $state();
  let host: HTMLDivElement | undefined = $state();
  let width = $state(0);

  const scale = $derived(width === 0 ? 1 : width / session.viewport.width);

  /**
   * Tall enough for the finished page, not for the whole viewport, and taken from the final
   * layout rather than the current frame so the canvas does not jump while scrubbing.
   */
  const pageHeight = $derived.by(() => {
    if (session.result.status !== 'ok') return session.viewport.height;
    const root = session.result.layout.fragments.get(session.result.boxTree.id);
    return Math.max(240, Math.min(session.viewport.height, (root?.rect.height ?? 0) + 24));
  });

  $effect(() => {
    if (host === undefined) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry !== undefined) width = entry.contentRect.width;
    });

    observer.observe(host);
    return () => {
      observer.disconnect();
    };
  });

  // One frame per change, never one per event. The player can move the cursor as fast as it
  // likes; the canvas still redraws once.
  $effect(() => {
    const scene = {
      order: session.order,
      frame: session.frame,
      lines: session.result.status === 'ok' ? session.result.layout.lines : new Map(),
      labels: session.result.status === 'ok' ? session.result.labels : new Map(),
      highlight: session.hovered ?? session.active,
      selected: session.selected,
      diverging: session.diverging,
      dirty: session.dirty,
      wave: session.wave,
      viewport: session.viewport,
    };
    const ratio = window.devicePixelRatio;
    const target = canvas;
    const factor = scale;
    const pixels = width;
    const page = pageHeight;

    if (target === undefined || pixels === 0) return;

    const handle = requestAnimationFrame(() => {
      const context = target.getContext('2d');
      if (context === null) return;

      const height = Math.round(page * factor);
      target.width = Math.round(pixels * ratio);
      target.height = Math.round(height * ratio);
      target.style.height = `${height}px`;

      draw(context, scene, {
        scale: factor * ratio,
        width: target.width,
        height: target.height,
      });
    });

    return () => {
      cancelAnimationFrame(handle);
    };
  });

  function at(event: PointerEvent): BoxId | null {
    if (canvas === undefined || session.result.status !== 'ok') return null;

    const bounds = canvas.getBoundingClientRect();
    return hitTest(
      session.result.display,
      {
        fragments: session.frame,
        pieces: session.result.layout.pieces,
        lineBoxes: session.result.layout.lineBoxes,
        lineOf: session.result.layout.lineOf,
      },
      (event.clientX - bounds.left) / scale,
      (event.clientY - bounds.top) / scale,
    );
  }

  function pick(event: PointerEvent): void {
    session.hovered = at(event);
  }

  function choose(event: PointerEvent): void {
    session.selected = at(event);
    session.clearDirt();
  }
</script>

<div class="boxes">
  <div class="head">
    <span class="title">boxes</span>
    <ul class="legend">
      {#each BOX_MODEL_LEGEND as entry (entry.name)}
        <li><i style:background={entry.colour}></i>{entry.name}</li>
      {/each}
    </ul>
  </div>

  <div class="surface" bind:this={host}>
    {#if session.result.status === 'failed'}
      <p class="failed">{session.result.message}</p>
    {:else}
      <canvas
        bind:this={canvas}
        onpointerdown={choose}
        onpointermove={pick}
        onpointerleave={() => {
          session.hovered = null;
        }}
      ></canvas>
    {/if}
  </div>
</div>

<style>
  .boxes {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border: 1px solid var(--rule);
    background: var(--surface);
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 7px 10px;
    border-bottom: 1px solid var(--rule);
  }

  .title {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--ink-3);
  }

  .legend {
    display: flex;
    gap: 12px;
    margin: 0;
    padding: 0;
    list-style: none;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--ink-2);
  }

  .legend li {
    display: flex;
    align-items: center;
    gap: 5px;
  }

  .legend i {
    width: 9px;
    height: 9px;
    opacity: 0.55;
  }

  /* The gutter is kept even with nothing to scroll. Without it a scrollbar narrows the canvas,
     the canvas gets shorter, the scrollbar goes, and round it goes under a still pointer. */
  .surface {
    overflow: auto;
    scrollbar-gutter: stable;
    padding: 0;
  }

  canvas {
    display: block;
    width: 100%;
  }

  .failed {
    margin: 0;
    padding: 14px;
    font-family: var(--mono);
    font-size: 12px;
    color: var(--accent);
  }
</style>
