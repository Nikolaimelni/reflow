<script lang="ts">
  import { type BoxId, type ElementNode, reportedRect } from '@reflow/engine';
  import { compareRects } from './divergence.js';
  import type { Session } from '../engine-run/session.svelte.js';
  import { SKIP } from '../host/parse-html.js';

  const { session }: { session: Session } = $props();

  let frame: HTMLIFrameElement | undefined = $state();

  // The iframe's own scrollbar narrows its viewport, so the frame is widened by that much.
  let gutter = $state(0);

  const document_ = $derived(
    `<!doctype html><html><head><meta charset="utf-8"><style>${session.source.css}</style></head><body>${session.source.html}</body></html>`,
  );

  function compare(): void {
    // Between one srcdoc and the next the frame can hold a document with no element in it yet.
    // The load event runs this again once there is one.
    const root = frame?.contentDocument?.documentElement;
    if (root === undefined || root === null || session.result.status !== 'ok') return;

    const measured = (frame?.clientWidth ?? 0) - root.clientWidth;
    if (measured >= 0 && measured < 40 && measured !== gutter) {
      gutter = measured;
      return;
    }

    const run = session.result;
    const theirs = collectElements(root);
    const ours = collectNodes(run.root);
    const diverging = new Map<BoxId, string>();

    for (let i = 0; i < Math.min(theirs.length, ours.length); i++) {
      const element = theirs[i];
      const node = ours[i];
      if (element === undefined || node === undefined) continue;

      // A block cuts the inline around it in two, so one element can be several boxes, and
      // what the browser reports for it is the union of them.
      const boxes = run.boxOf.get(node);
      const rect = boxes === undefined ? null : reportedRect(boxes, run.layout.fragments, run.layout.lines);
      if (boxes === undefined || rect === null) continue;

      const divergence = compareRects(
        `<${element.tagName.toLowerCase()}>`,
        rect,
        element.getBoundingClientRect(),
      );

      if (divergence !== null) for (const one of boxes) diverging.set(one, divergence);
    }

    session.diverging = diverging;
  }

  function collectElements(root: Element): Element[] {
    const found: Element[] = [];

    const walk = (node: Element) => {
      if (SKIP.has(node.tagName.toLowerCase())) return;
      found.push(node);
      for (const child of Array.from(node.children)) walk(child);
    };

    walk(root);
    return found;
  }

  function collectNodes(root: ElementNode): ElementNode[] {
    const found: ElementNode[] = [];

    const walk = (node: ElementNode) => {
      found.push(node);
      for (const child of node.children) {
        if (child.kind === 'element') walk(child);
      }
    };

    walk(root);
    return found;
  }

  $effect(() => {
    // The gutter too: the first pass runs in a frame narrower than the engine's viewport.
    void document_;
    void gutter;

    const handle = requestAnimationFrame(compare);
    return () => {
      cancelAnimationFrame(handle);
    };
  });
</script>

<div class="live">
  <div class="head">
    <span class="title">the browser, same source</span>
    <span class="verdict" class:apart={session.diverging.size > 0}>
      {#if session.diverging.size === 0}
        every box agrees
      {:else}
        {session.diverging.size}
        {session.diverging.size === 1 ? 'box disagrees' : 'boxes disagree'}
      {/if}
    </span>
  </div>

  {#if session.diverging.size > 0}
    <ul class="apart-list">
      {#each [...session.diverging] as [id, detail] (id)}
        <li>{detail}</li>
      {/each}
    </ul>
  {/if}

  <!-- The source may have come in on someone else's link, so it gets no scripts. It keeps
       the same origin because compare() reads the layout out of it. -->
  <iframe
    bind:this={frame}
    title="the same source laid out by the browser"
    sandbox="allow-same-origin"
    srcdoc={document_}
    width={session.viewport.width + gutter}
    height={session.viewport.height}
    onload={compare}
  ></iframe>
</div>

<style>
  .live {
    display: flex;
    flex-direction: column;
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
    font-family: var(--mono);
    font-size: 11px;
  }

  .title {
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--ink-3);
  }

  .verdict {
    color: var(--ok);
  }

  .verdict.apart {
    color: var(--accent);
  }

  .apart-list {
    margin: 0;
    padding: 7px 10px;
    list-style: none;
    border-bottom: 1px solid var(--rule);
    font-family: var(--mono);
    font-size: 11px;
    line-height: 1.6;
    color: var(--accent);
    max-height: 130px;
    overflow: auto;
  }

  iframe {
    border: none;
    background: #fff;
  }
</style>
