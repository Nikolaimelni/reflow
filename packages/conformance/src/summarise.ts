import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const reportDir = join(here, '..', 'report');
const fixturesDir = join(here, '..', 'fixtures');

type Counted = { compared?: number; matched?: number; percent?: number };

// A default export because that is the shape Playwright's globalTeardown wants.
export default function summarise(): void {
  const read = (name: string): Counted | null => {
    const path = join(reportDir, name);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8')) as Counted;
  };

  const fixtures = readdirSync(fixturesDir).filter((name) => name.endsWith('.html'));
  const found = existsSync(join(fixturesDir, 'found'))
    ? readdirSync(join(fixturesDir, 'found')).filter((name) => name.endsWith('.html'))
    : [];

  const computedStyle = read('computed-style.json');
  const geometry = read('geometry.json');
  const hitTest = read('hit-test.json');
  const generated = read('generated.json');

  const compared =
    (computedStyle?.compared ?? 0) + (geometry?.compared ?? 0) + (hitTest?.compared ?? 0);
  const matched =
    (computedStyle?.matched ?? 0) + (geometry?.matched ?? 0) + (hitTest?.matched ?? 0);

  mkdirSync(reportDir, { recursive: true });
  writeFileSync(
    join(reportDir, 'conformance.json'),
    `${JSON.stringify(
      {
        fixtures: fixtures.length,
        open: found,
        compared,
        matched,
        percent: compared === 0 ? 0 : Math.round((matched / compared) * 1000) / 10,
        suites: { computedStyle, geometry, hitTest, generated },
      },
      null,
      2,
    )}\n`,
  );
}
