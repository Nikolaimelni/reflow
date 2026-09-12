import { type BoxId, frameAt, type PropertyName } from '@reflow/engine';
import { run, type Viewport } from './run.js';
import { SAMPLE_CSS, SAMPLE_HTML } from './sample.js';

/**
 * Everything the app knows, in one place. The editors write to `html` and `css`; `source` is
 * the debounced copy the engine actually runs, so typing does not relayout on every keypress.
 * The player owns `cursor` and nothing else, which is what keeps the canvas a pure function
 * of the frame.
 */
export class Session {
  html = $state(SAMPLE_HTML);
  css = $state(SAMPLE_CSS);
  source = $state({ html: SAMPLE_HTML, css: SAMPLE_CSS });

  viewport = $state<Viewport>({ width: 420, height: 720 });
  devicePixelRatio = $state(window.devicePixelRatio);
  cursor = $state(0);
  playing = $state(false);
  hovered = $state<BoxId | null>(null);
  selected = $state<BoxId | null>(null);
  view = $state<'boxes' | 'layers' | 'lab'>('boxes');

  /** Each dirty box and how far it sits from the change, for the lab's ripple. */
  dirty = $state<ReadonlyMap<BoxId, number>>(new Map());
  /** How far the ripple has spread, in rings. */
  wave = $state(0);
  changed = $state<PropertyName | null>(null);
  comparing = $state(true);
  diverging = $state<ReadonlyMap<BoxId, string>>(new Map());

  result = $derived(run(this.source.html, this.source.css, this.viewport, this.devicePixelRatio));
  trace = $derived(this.result.status === 'ok' ? this.result.layout.trace : []);
  frame = $derived(frameAt(this.trace, this.cursor));

  /** Paint order, filtered to the boxes the current frame actually has geometry for. */
  order = $derived(
    this.result.status === 'ok' ? this.result.display.items.map((item) => item.box) : [],
  );

  constructor() {
    // Start at the end of the trace: the finished layout first, then scrub back into it.
    this.cursor = this.trace.length;
  }

  commit(): void {
    this.source = { html: this.html, css: this.css };
    this.cursor = this.trace.length;
    this.playing = false;
    this.clearDirt();
  }

  clearDirt(): void {
    this.dirty = new Map();
    this.wave = 0;
    this.changed = null;
  }

  seek(cursor: number): void {
    this.cursor = Math.min(Math.max(0, cursor), this.trace.length);
  }
}
