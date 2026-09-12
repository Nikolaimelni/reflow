<script lang="ts">
  import type { BoxId, Constraint, Edges, Fragment, LayoutEvent } from '@reflow/engine';
  import type { Session } from '../engine-run/session.svelte.js';

  const { session }: { session: Session } = $props();

  type Details = {
    label: string;
    constraint: Constraint | null;
    reason: string | null;
    fragment: Fragment | null;
  };

  /**
   * Walks the trace up to the cursor, so the panel says what the engine knew at this point
   * rather than what it ended up with. The constraint it was handed sits next to the size it
   * came back with, which is the pair worth seeing together.
   */
  function detailsFor(
    trace: readonly LayoutEvent[],
    cursor: number,
    box: BoxId,
    label: string,
  ): Details {
    const details: Details = { label, constraint: null, reason: null, fragment: null };

    for (let i = 0; i < cursor; i++) {
      const event = trace[i];
      if (event === undefined || !('box' in event) || event.box !== box) continue;

      if (event.t === 'measure:start') details.constraint = event.constraint;
      if (event.t === 'size:resolved') {
        details.reason = event.reason;
        details.fragment = event.fragment;
      }
    }

    return details;
  }

  const details = $derived.by(() => {
    const box = session.hovered;
    if (box === null || session.result.status !== 'ok') return null;
    return detailsFor(session.trace, session.cursor, box, session.result.labels.get(box) ?? '');
  });

  const round = (value: number) => Math.round(value * 100) / 100;

  const edgeList = (edges: Edges) =>
    [edges.top, edges.right, edges.bottom, edges.left].map(round).join(' ');
</script>

<div class="inspector">
  <span class="title">inspector</span>

  {#if details === null}
    <p class="hint">Point at a box.</p>
  {:else}
    <p class="what">{details.label}</p>

    <dl>
      <dt>given</dt>
      <dd>
        {#if details.constraint === null}
          not measured yet
        {:else}
          {round(details.constraint.availableWidth)}px wide,
          {details.constraint.availableHeight === null
            ? 'height unresolved'
            : `${round(details.constraint.availableHeight)}px tall`}
        {/if}
      </dd>

      <dt>came out</dt>
      <dd>
        {#if details.fragment === null}
          no size yet
        {:else}
          {round(details.fragment.rect.width)} &times; {round(details.fragment.rect.height)}
          at {round(details.fragment.rect.x)}, {round(details.fragment.rect.y)}
        {/if}
      </dd>

      <dt>because</dt>
      <dd>{details.reason ?? 'the engine has not got here yet'}</dd>

      {#if details.fragment !== null}
        <dt>edges</dt>
        <dd class="edges">
          <span class="margin">margin {edgeList(details.fragment.margin)}</span>
          <span class="border">border {edgeList(details.fragment.border)}</span>
          <span class="padding">padding {edgeList(details.fragment.padding)}</span>
        </dd>
      {/if}
    </dl>
  {/if}
</div>

<style>
  .inspector {
    border: 1px solid var(--rule);
    border-top: none;
    background: var(--surface);
    padding: 9px 10px 11px;
  }

  .title {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--ink-3);
  }

  .hint,
  .what {
    margin: 6px 0 0;
    font-size: 13px;
    color: var(--ink-2);
  }

  .what {
    font-family: var(--mono);
    font-size: 12.5px;
    color: var(--ink);
  }

  dl {
    display: grid;
    grid-template-columns: 74px 1fr;
    gap: 3px 10px;
    margin: 9px 0 0;
    font-size: 12.5px;
  }

  dt {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--ink-3);
    padding-top: 1px;
  }

  dd {
    margin: 0;
    color: var(--ink);
  }

  .edges {
    display: flex;
    flex-direction: column;
    gap: 1px;
    font-family: var(--mono);
    font-size: 11.5px;
  }

  .margin {
    color: #a23d19;
  }

  .border {
    color: #8a7420;
  }

  .padding {
    color: #4f6a37;
  }
</style>
