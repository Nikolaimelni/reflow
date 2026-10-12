<script lang="ts">
  import BoxesView from './boxes/BoxesView.svelte';
  import LiveFrame from './compare/LiveFrame.svelte';
  import CodeEditor from './editor/CodeEditor.svelte';
  import { decode, encode, WIDTH } from './engine-run/permalink.js';
  import { Session } from './engine-run/session.svelte.js';
  import Inspector from './inspector/Inspector.svelte';
  import ReflowLab from './lab/ReflowLab.svelte';
  import LayersView from './layers/LayersView.svelte';
  import TracePlayer from './player/TracePlayer.svelte';

  const session = new Session();

  const VIEWS = [
    { id: 'boxes', label: 'boxes' },
    { id: 'layers', label: 'layers' },
    { id: 'lab', label: 'reflow lab' },
  ] as const;

  let copied = $state(false);
  let shareable = $state(true);
  let encoding = 0;

  /**
   * The whole example lives in the fragment, so a specific case can go in a chat message
   * rather than being described in one.
   */
  $effect(() => {
    void decode(window.location.hash.slice(1)).then((shared) => {
      if (shared === null) return;
      session.html = shared.html;
      session.css = shared.css;
      session.viewport = { ...session.viewport, width: shared.width };
      session.commit();
    });
  });

  $effect(() => {
    const shared = {
      html: session.source.html,
      css: session.source.css,
      width: session.viewport.width,
    };

    // A long source takes longer to squeeze than the short one typed after it, so only the
    // newest answer gets to write the URL.
    const ticket = ++encoding;
    void encode(shared).then((fragment) => {
      if (ticket !== encoding) return;
      shareable = fragment !== null;
      // Over the limit, the old fragment would share a source the page no longer shows.
      const target = fragment === null ? window.location.pathname : `#${fragment}`;
      window.history.replaceState(null, '', target);
    });
  });

  function copyLink(): void {
    void navigator.clipboard.writeText(window.location.href).then(() => {
      copied = true;
      window.setTimeout(() => {
        copied = false;
      }, 1200);
    });
  }

  /** Long enough that a run does not fire mid-word, short enough to feel immediate. */
  const DEBOUNCE = 250;

  let pending = 0;

  // A dpr change arrives as a resize, and it changes how wide a border is used, so the
  // layout has to be redone.
  $effect(() => {
    const watch = () => {
      session.devicePixelRatio = window.devicePixelRatio;
    };

    window.addEventListener('resize', watch);
    return () => {
      window.removeEventListener('resize', watch);
    };
  });

  function schedule(): void {
    clearTimeout(pending);
    pending = window.setTimeout(() => {
      session.commit();
    }, DEBOUNCE);
  }
</script>

<div class="shell">
  <header class="bar">
    <h1>reflow</h1>
    <p class="tagline">a CSS layout engine that shows its work</p>

    <label class="viewport">
      viewport
      <input
        type="number"
        min={WIDTH.min}
        max={WIDTH.max}
        value={session.viewport.width}
        oninput={(event) => {
          const width = Math.round(event.currentTarget.valueAsNumber);
          if (width >= WIDTH.min && width <= WIDTH.max) {
            session.viewport = { ...session.viewport, width };
          }
        }}
      />
      px
    </label>

    <label class="toggle">
      <input type="checkbox" bind:checked={session.comparing} />
      compare with the browser
    </label>

    <button type="button" class="share" onclick={copyLink} disabled={!shareable}>
      {#if !shareable}
        too long to share
      {:else}
        {copied ? 'copied' : 'copy link'}
      {/if}
    </button>
  </header>

  <main class="panes">
    <section class="source">
      <div class="pane">
        <span class="label">html</span>
        <CodeEditor
          value={session.html}
          language="html"
          onchange={(value) => {
            session.html = value;
            schedule();
          }}
        />
      </div>

      <div class="pane">
        <span class="label">css</span>
        <CodeEditor
          value={session.css}
          language="css"
          onchange={(value) => {
            session.css = value;
            schedule();
          }}
        />
      </div>
    </section>

    <section class="result">
      <nav class="tabs">
        {#each VIEWS as view (view.id)}
          <button
            type="button"
            class:on={session.view === view.id}
            onclick={() => {
              session.view = view.id;
            }}
          >
            {view.label}
          </button>
        {/each}
      </nav>

      {#if session.view === 'boxes'}
        <BoxesView {session} />
        <TracePlayer {session} />
        <Inspector {session} />
      {:else if session.view === 'layers'}
        <LayersView {session} />
      {:else}
        <ReflowLab {session} />
      {/if}
    </section>

    {#if session.comparing}
      <section class="browser">
        <LiveFrame {session} />
      </section>
    {/if}
  </main>
</div>

<style>
  .shell {
    display: flex;
    flex-direction: column;
    height: 100vh;
    min-height: 0;
  }

  .bar {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 11px 16px;
    border-bottom: 1px solid var(--rule);
    background: var(--surface);
  }

  h1 {
    margin: 0;
    font-size: 17px;
    font-weight: 600;
    letter-spacing: -0.01em;
  }

  .tagline {
    margin: 0;
    flex: 1;
    font-size: 13px;
    color: var(--ink-3);
  }

  .viewport,
  .toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--ink-2);
  }

  .share {
    font-family: var(--mono);
    font-size: 11.5px;
    padding: 2px 8px;
    border: 1px solid var(--rule-strong);
    background: var(--surface);
    color: var(--ink);
    cursor: pointer;
  }

  .share:hover:not(:disabled) {
    background: var(--surface-2);
  }

  .share:disabled {
    color: var(--ink-3);
    cursor: default;
  }

  .tabs {
    display: flex;
    gap: 1px;
    margin-bottom: -1px;
  }

  .tabs button {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    padding: 5px 10px;
    border: 1px solid var(--rule);
    border-bottom-color: transparent;
    background: var(--surface-2);
    color: var(--ink-3);
    cursor: pointer;
  }

  .tabs button.on {
    background: var(--surface);
    color: var(--ink);
    border-bottom-color: var(--surface);
  }

  .viewport input {
    width: 62px;
    font-family: var(--mono);
    font-size: 11.5px;
    padding: 2px 4px;
    border: 1px solid var(--rule-strong);
    background: var(--surface);
    color: var(--ink);
  }

  .panes {
    display: grid;
    grid-template-columns: minmax(260px, 0.85fr) minmax(360px, 1.25fr) minmax(0, 0.9fr);
    gap: 14px;
    padding: 14px 16px 16px;
    min-height: 0;
    flex: 1;
  }

  .panes:not(:has(.browser)) {
    grid-template-columns: minmax(280px, 1fr) minmax(320px, 1fr);
  }

  .source {
    display: grid;
    grid-template-rows: 1fr 1fr;
    gap: 14px;
    min-height: 0;
  }

  .pane {
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
    border: 1px solid var(--rule);
    background: var(--surface);
  }

  .label {
    padding: 7px 10px;
    border-bottom: 1px solid var(--rule);
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--ink-3);
  }

  .result,
  .browser {
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: auto;
  }

  @media (max-width: 1100px) {
    .shell {
      height: auto;
    }

    .panes,
    .panes:not(:has(.browser)) {
      grid-template-columns: 1fr;
    }

    .source {
      grid-template-rows: 320px 320px;
    }
  }
</style>
