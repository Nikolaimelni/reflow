export const SAMPLE_HTML = `<header>
  <h1>reflow</h1>
  <span class="tag">a layout engine that shows its work</span>
</header>

<article>
  This sentence sits next to a paragraph, so it gets a box nobody wrote. Point at it.
  <p>An inline box is drawn line by line: <span class="mark">this one has padding and a
  border, and it wraps, so it is two pieces</span> rather than one rectangle.</p>
</article>

<section class="cards">
  <div class="card">flex: 1</div>
  <div class="card">flex: 1</div>
  <div class="card wide">too wide for the row, so it wraps and grows</div>
</section>

<div class="stack">
  <div class="low">
    z-index: 1
    <div class="top">z-index: 999</div>
  </div>
  <div class="high">z-index: 2, still on top</div>
</div>

<p class="note">
  My 32px top margin meets the 24px under the stack and only the larger one is kept.
  Press play and watch them collapse.
</p>
`;

export const SAMPLE_CSS = `body {
  font-family: system-ui, sans-serif;
  color: #1d2430;
}

header {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 0 12px;
  border-bottom: 2px solid;
  background-color: #eef2f7;
}

h1 {
  margin: 8px 0;
  font-size: 26px;
}

.tag {
  padding: 2px 8px;
  border: 1px solid;
  font-size: 12px;
}

article {
  margin: 20px 0;
  line-height: 1.5;
}

p {
  margin: 12px 0 0;
}

.mark {
  padding: 2px 4px;
  border: 1px solid #c74e23;
  background-color: #fae6dc;
}

.cards {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.card {
  flex: 1 1 100px;
  padding: 10px;
  background-color: #dfe7f1;
}

.wide {
  flex-basis: 260px;
}

/* The 999 is inside the context z-index: 1 makes, so it can only win against its siblings. */
.stack {
  position: relative;
  height: 90px;
  margin-top: 24px;
  margin-bottom: 24px;
}

.low {
  position: absolute;
  z-index: 1;
  left: 0;
  top: 0;
  width: 55%;
  height: 54px;
  padding: 8px;
  background-color: #1b3f5c;
  color: white;
}

.top {
  position: absolute;
  z-index: 999;
  right: -64px;
  bottom: -14px;
  padding: 6px 8px;
  background-color: #c74e23;
}

.high {
  position: absolute;
  z-index: 2;
  right: 0;
  top: 20px;
  width: 45%;
  height: 54px;
  padding: 8px;
  background-color: teal;
  color: white;
  opacity: 0.9;
}

.note {
  margin-top: 32px;
}
`;
