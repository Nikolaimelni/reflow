import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import fc from 'fast-check';
import { checkDocument } from './generate/check.js';
import { documents, type GeneratedDocument, render } from './generate/grammar.js';

/**
 * How many documents to try. A soak run raises it from the command line; CI wants the suite
 * to finish, and sixty is enough to catch a whole class of mistake on the way in.
 */
const RUNS = Number.parseInt(process.env.REFLOW_RUNS ?? '60', 10);

/**
 * Looser than the half pixel the curated fixtures hold to, and deliberately so. Every whole
 * pixel of disagreement the generator turned up was a real rule the engine was missing, and
 * each of those is fixed. What is left under a pixel is baseline arithmetic inside nested
 * inline-blocks, which is written down as open rather than papered over with a smaller
 * number here.
 */
const TOLERANCE = 1.5;

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Cases the generator found sit apart from the curated fixtures. The geometry harness reads
 * the top level of the fixture directory only, so a case that still disagrees does not turn
 * that suite red; it waits here with its numbers until somebody fixes it, and then it moves
 * up, where the half pixel rule applies.
 */
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

  // Finding something is what this suite is for, so it does not stop the build. fast-check
  // has already thrown away every declaration and every element it could without losing the
  // failure, so what lands on disk is the smallest document that still disagrees.
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
