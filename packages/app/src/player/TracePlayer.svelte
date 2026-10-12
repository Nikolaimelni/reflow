<script lang="ts">
  import type { Session } from '../engine-run/session.svelte.js';

  const { session }: { session: Session } = $props();

  // Events a second. A fixed rate rather than a fixed length, so a long trace is no faster to
  // watch than a short one.
  const RATES = [3, 8, 30];
  let rate = $state(8);

  const total = $derived(session.trace.length);
  const current = $derived(session.trace[session.cursor - 1]);

  $effect(() => {
    if (!session.playing || total === 0) return;

    const perSecond = rate;
    let last = performance.now();
    let owed = 0;
    let handle = 0;

    const tick = (now: number) => {
      owed += ((now - last) / 1000) * perSecond;
      last = now;

      const steps = Math.floor(owed);
      owed -= steps;
      if (steps > 0) session.seek(session.cursor + steps);

      if (session.cursor >= total) {
        session.playing = false;
        return;
      }
      handle = requestAnimationFrame(tick);
    };

    handle = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(handle);
    };
  });

  function toggle(): void {
    if (session.cursor >= total) session.seek(0);
    session.playing = !session.playing;
  }
</script>

<div class="player">
  <div class="controls">
    <button type="button" onclick={() => session.seek(session.cursor - 1)} title="step back">
      &lsaquo;
    </button>
    <button type="button" class="play" onclick={toggle}>
      {session.playing ? 'pause' : 'play'}
    </button>
    <button type="button" onclick={() => session.seek(session.cursor + 1)} title="step forward">
      &rsaquo;
    </button>

    <input
      type="range"
      min="0"
      max={total}
      value={session.cursor}
      oninput={(event) => {
        session.playing = false;
        session.seek(event.currentTarget.valueAsNumber);
      }}
    />

    <span class="count">{session.cursor} / {total}</span>

    <select bind:value={rate} title="events a second">
      {#each RATES as option (option)}
        <option value={option}>{option}/s</option>
      {/each}
    </select>
  </div>

  <p class="event">
    {#if current === undefined}
      nothing measured yet
    {:else if current.t === 'size:resolved'}
      <b>size resolved</b> {current.reason}
    {:else if current.t === 'measure:start'}
      <b>measuring</b> against {Math.round(current.constraint.availableWidth)}px
    {:else if current.t === 'margin:collapsed'}
      <b>margins collapsed</b> {current.from.join(' and ')} became {current.to}
    {:else if current.t === 'line:broken'}
      <b>line {current.at + 1}</b> came out {Math.round(current.width)}px wide
    {:else}
      <b>child positioned</b> at {Math.round(current.rect.x)}, {Math.round(current.rect.y)}
    {/if}
  </p>
</div>

<style>
  .player {
    border: 1px solid var(--rule);
    border-top: none;
    background: var(--surface);
  }

  .controls {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
  }

  button {
    font-family: var(--mono);
    font-size: 12px;
    padding: 3px 9px;
    border: 1px solid var(--rule-strong);
    background: var(--surface);
    color: var(--ink);
    cursor: pointer;
  }

  button:hover {
    background: var(--surface-2);
  }

  .play {
    min-width: 56px;
  }

  input[type='range'] {
    flex: 1;
    min-width: 80px;
    accent-color: var(--accent);
  }

  select {
    font-family: var(--mono);
    font-size: 11px;
    padding: 2px 4px;
    border: 1px solid var(--rule-strong);
    background: var(--surface);
    color: var(--ink);
  }

  .count {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--ink-3);
    min-width: 74px;
    text-align: right;
  }

  .event {
    margin: 0;
    padding: 7px 10px;
    border-top: 1px dashed var(--rule);
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--ink-2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .event b {
    color: var(--accent);
    font-weight: 500;
  }
</style>
