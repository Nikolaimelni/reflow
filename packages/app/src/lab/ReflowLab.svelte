<script lang="ts">
  import {
    INVALIDATION,
    type Invalidation,
    type PropertyName,
    cssNameOf,
    dirtyBoxes,
  } from '@reflow/engine';
  import BoxesView from '../boxes/BoxesView.svelte';
  import type { Session } from '../engine-run/session.svelte.js';
  import { rings } from './rings.js';

  const { session }: { session: Session } = $props();

  /** How long the ripple takes to reach the far end, whatever the tree looks like. */
  const SPREAD = 700;

  const CLASSES: { name: Invalidation; blurb: string }[] = [
    { name: 'layout', blurb: 'geometry is thrown away and worked out again' },
    { name: 'paint', blurb: 'the boxes stay where they are, the pixels are redrawn' },
    { name: 'composite', blurb: 'the layer already exists, the compositor moves it' },
  ];

  const grouped = $derived.by(() => {
    const names = Object.keys(INVALIDATION) as PropertyName[];
    return CLASSES.map((group) => ({
      ...group,
      properties: names
        .filter((name) => INVALIDATION[name] === group.name)
        .sort((a, b) => cssNameOf(a).localeCompare(cssNameOf(b))),
    }));
  });

  const target = $derived(session.selected);

  const targetLabel = $derived(
    target === null || session.result.status !== 'ok'
      ? null
      : (session.result.labels.get(target) ?? null),
  );

  const summary = $derived.by(() => {
    const run = session.result;
    if (target === null || session.changed === null || run.status !== 'ok') return null;

    const result = dirtyBoxes(run.boxTree, target, session.changed);
    return {
      invalidation: result.invalidation,
      count: result.dirty.size,
      climbs: result.climbs.map((box) => run.labels.get(box) ?? '?'),
    };
  });

  function change(property: PropertyName): void {
    if (target === null || session.result.status !== 'ok') return;

    const result = dirtyBoxes(session.result.boxTree, target, property);
    const ripple = rings(session.result.boxTree, target, result.dirty);

    session.changed = property;
    session.dirty = ripple;
    session.wave = 0;

    const furthest = Math.max(0, ...ripple.values());
    const started = performance.now();

    const step = (now: number) => {
      const through = Math.min(1, (now - started) / SPREAD);
      session.wave = through * furthest;
      if (through < 1 && session.changed === property) requestAnimationFrame(step);
    };

    requestAnimationFrame(step);
  }
</script>

<div class="lab">
  <BoxesView {session} />

  <div class="panel">
    <div class="head">
      <span class="title">reflow lab</span>
      <span class="target">
        {#if targetLabel === null}
          click a box to pick a target
        {:else}
          {targetLabel}
        {/if}
      </span>
    </div>

    {#if summary !== null}
      <p class="verdict">
        <b class={summary.invalidation}>{summary.invalidation}</b>
        {summary.count} {summary.count === 1 ? 'box' : 'boxes'} to redo
        {#if summary.climbs.length > 0}
          &middot; climbs to {summary.climbs.join(', then ')}
        {/if}
      </p>
    {/if}

    {#each grouped as group (group.name)}
      <section>
        <h3 class={group.name}>{group.name}</h3>
        <p class="blurb">{group.blurb}</p>

        <div class="properties">
          {#each group.properties as property (property)}
            <button
              type="button"
              class:active={session.changed === property}
              disabled={target === null}
              onclick={() => change(property)}
            >
              {cssNameOf(property)}
            </button>
          {/each}
        </div>
      </section>
    {/each}
  </div>
</div>

<style>
  .lab {
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .panel {
    border: 1px solid var(--rule);
    border-top: none;
    background: var(--surface);
    padding: 0 10px 12px;
  }

  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 0;
  }

  .title {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--ink-3);
  }

  .target {
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--ink-2);
  }

  .verdict {
    margin: 0 0 10px;
    padding: 7px 9px;
    background: var(--surface-2);
    border-left: 2px solid var(--accent);
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--ink);
  }

  .verdict b {
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-right: 6px;
  }

  section {
    margin-bottom: 11px;
  }

  h3 {
    margin: 0;
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .layout {
    color: #b4431b;
  }

  .paint {
    color: #8a6a12;
  }

  .composite {
    color: #2f7a4d;
  }

  .blurb {
    margin: 2px 0 6px;
    font-size: 12px;
    color: var(--ink-3);
  }

  .properties {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  button {
    font-family: var(--mono);
    font-size: 11px;
    padding: 2px 6px;
    border: 1px solid var(--rule);
    background: var(--surface);
    color: var(--ink-2);
    cursor: pointer;
  }

  button:hover:not(:disabled) {
    border-color: var(--rule-strong);
    color: var(--ink);
  }

  button:disabled {
    opacity: 0.45;
    cursor: default;
  }

  button.active {
    border-color: var(--accent);
    color: var(--accent);
  }
</style>
