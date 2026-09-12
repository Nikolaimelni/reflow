<script lang="ts">
  import type { Session } from '../engine-run/session.svelte.js';

  const { session }: { session: Session } = $props();

  /** A whole trace plays in about this long, whatever its length. */
  const DURATION = 4000;

  const total = $derived(session.trace.length);
  const current = $derived(session.trace[session.cursor - 1]);

  $effect(() => {
    if (!session.playing || total === 0) return;

    let last = performance.now();
    let handle = 0;

    const tick = (now: number) => {
      const events = ((now - last) / DURATION) * total;
      last = now;

      if (session.cursor >= total) {
        session.playing = false;
        return;
      }

      session.seek(session.cursor + Math.max(1, Math.round(events)));
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
