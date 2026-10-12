import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import fc from 'fast-check';
import { env } from './env.js';
import { checkDocument } from './generate/check.js';
import { documents, type GeneratedDocument, render } from './generate/grammar.js';

// Sixty by default; CI runs twice that.
const RUNS = env.REFLOW_RUNS;

// Looser than the fixtures' half pixel: what is left under a pixel is baseline arithmetic in
// nested inline-blocks. Of 600 documents that agreed at 1.5px, none disagreed at 1.
const TOLERANCE = 1;

const here = dirname(fileURLToPath(import.meta.url));

// Below the level the geometry suite reads, so an open find does not turn it red.
const foundDir = join(here, '..', 'fixtures', 'found');
const reportDir = join(here, '..', 'report');

test.describe.configure({ mode: 'serial' });

test('generated documents agree with Chromium', async ({ page }) => {
  // Every document is a page load and two round trips into it, and shrinking runs dozens
  // more, so the budget has to follow the run count rather than the default thirty seconds.
  test.setTimeout(30_000 + RUNS * 1_500);

  let documentsTried = 0;
  let edgesCompared = 0;
  let pointsCompared = 0;

  const result = await fc.check(
    fc.asyncProperty(documents, async (generated: GeneratedDocument) => {
      const { html, css } = render(generated);
      const check = await checkDocument(page, html, css, TOLERANCE);

      documentsTried++;
      edgesCompared += check.compared;
      pointsCompared += check.points;

      return check.misses.length === 0;
    }),
    { numRuns: RUNS },
  );

  expect(documentsTried, 'nothing was generated').toBeGreaterThan(0);
  expect(edgesCompared, 'nothing was compared').toBeGreaterThan(0);

  // A find does not fail the build. fast-check has already shrunk it as far as it goes.
  const shrunk = result.failed ? result.counterexample?.[0] : undefined;
  let found: string | null = null;

  if (shrunk !== undefined) {
    const rendered = render(shrunk);
    const again = await checkDocument(page, rendered.html, rendered.css, TOLERANCE);

    mkdirSync(foundDir, { recursive: true });

    // Only the newest find is kept. The ones with names were triaged by hand and stay; a
    // `gen-` file is this run's lead, and yesterday's is either fixed or already a fixture.
    for (const name of readdirSync(foundDir)) {
      if (name.startsWith('gen-')) rmSync(join(foundDir, name));
    }
    const path = join(foundDir, `gen-${String(result.seed)}.html`);

    writeFileSync(path, rendered.document);
    writeFileSync(
      `${path}.txt`,
      [
        `seed ${String(result.seed)}`,
        `shrinks ${String(result.numShrinks)}`,
        ...again.misses,
        '',
      ].join('\n'),
    );

    found = relative(process.cwd(), path);
  }

  mkdirSync(reportDir, { recursive: true });
  writeFileSync(
    join(reportDir, 'generated.json'),
    `${JSON.stringify(
      {
        runs: RUNS,
        tolerance: TOLERANCE,
        // Includes the documents fast-check laid out while shrinking a counterexample.
        documents: documentsTried,
        compared: edgesCompared,
        points: pointsCompared,
        found,
        seed: result.seed,
      },
      null,
      2,
    )}\n`,
  );
});
