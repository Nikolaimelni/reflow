export const SAMPLE_HTML = `<header>reflow</header>

<main>
  <p>Every element is four rectangles: content, padding, border, margin.</p>

  <section class="cards">
    <div class="card">grow 1</div>
    <div class="card wide">grow 2</div>
  </section>

  <p class="note">This paragraph collapses its top margin with the section above it.</p>

  <aside class="badge">z-index 2</aside>
  <div class="wash">opacity 0.55, so the compositor gets a layer of its own</div>
</main>
`;

export const SAMPLE_CSS = `body {
  font-family: system-ui, sans-serif;
  width: 420px;
  color: #1d2430;
}

header {
  padding: 8px 12px;
  border: 2px solid;
  margin-bottom: 24px;
  background-color: #eef2f7;
}

main {
  position: relative;
}

p {
  margin: 16px 0;
}

.cards {
  display: flex;
  border: 1px solid;
  padding: 6px;
}

.card {
  flex-grow: 1;
  padding: 10px;
  margin: 4px;
  border: 1px solid;
  background-color: #dfe7f1;
}

.wide {
  flex-grow: 2;
}

.note {
  margin-top: 32px;
}

.badge {
  position: absolute;
  top: 4px;
  right: 0;
  z-index: 2;
  padding: 4px 8px;
  background-color: #1b3f5c;
  color: white;
}

.wash {
  position: relative;
  z-index: 1;
  margin-top: 20px;
  padding: 10px;
  background-color: teal;
  color: white;
  opacity: 0.55;
}
`;
