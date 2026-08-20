#!/usr/bin/env node
/**
 * Prints one version's section of CHANGELOG.md, for use as release notes.
 *
 *   node scripts/changelog.mjs v1.0.0-beta.2
 *   node scripts/changelog.mjs 1.0.0-beta.2   # leading "v" optional
 *
 * Exits 1 with a message on stderr when there is no section for that version,
 * which is what lets the release workflow refuse to publish an undocumented
 * release instead of shipping empty notes.
 */
import { readFileSync } from 'node:fs';

const HEADING = /^##\s+\[?v?([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)\]?/;
/** Link reference definitions live below the last section; they are not notes. */
const LINK_DEFINITION = /^\[[^\]]+\]:\s/;

const requested = (process.argv[2] ?? '').trim().replace(/^v/, '');
if (!requested) {
  console.error('Usage: node scripts/changelog.mjs <version>');
  process.exit(2);
}

const path = new URL('../CHANGELOG.md', import.meta.url);
const lines = readFileSync(path, 'utf8').split('\n');

const body = [];
let inSection = false;

for (const line of lines) {
  const heading = HEADING.exec(line);
  if (heading) {
    if (inSection) {
      break;
    }
    inSection = heading[1] === requested;
    continue;
  }
  if (inSection) {
    if (LINK_DEFINITION.test(line)) {
      break;
    }
    body.push(line);
  }
}

if (!inSection) {
  console.error(`CHANGELOG.md has no section for ${requested}. Add one before releasing.`);
  process.exit(1);
}

const notes = body.join('\n').trim();
if (notes.length === 0) {
  console.error(`The CHANGELOG.md section for ${requested} is empty. Fill it in before releasing.`);
  process.exit(1);
}

process.stdout.write(`${notes}\n`);
