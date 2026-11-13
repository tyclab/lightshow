// The ruleset on main requires one check, `gate` (.github/workflows/ci.yml).
// A job that `gate` does not wait for still runs, but a red one no longer
// holds a merge back, and nothing else would say so.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const WORKFLOW = path.join(import.meta.dirname, '..', '..', '.github', 'workflows', 'ci.yml');

/** The `jobs:` section as { id: text of that job }. Job ids sit at two spaces. */
function readJobs() {
  const text = fs.readFileSync(WORKFLOW, 'utf8');
  const section = text.slice(text.indexOf('\njobs:\n') + '\njobs:\n'.length);
  const jobs = {};
  let id = null;
  for (const line of section.split('\n')) {
    const head = /^ {2}([\w-]+):\s*$/.exec(line);
    if (head) {
      id = head[1];
      jobs[id] = '';
    } else if (id) {
      jobs[id] += `${line}\n`;
    }
  }
  return jobs;
}

test('gate waits for every other job', () => {
  const jobs = readJobs();
  assert.ok(jobs.gate, 'ci.yml has a job named gate');
  const needs = /^ {4}needs: \[([^\]]*)\]$/m.exec(jobs.gate);
  assert.ok(needs, 'gate lists its needs on one line');
  const waited = needs[1].split(',').map((s) => s.trim()).sort();
  const others = Object.keys(jobs).filter((id) => id !== 'gate').sort();
  assert.ok(others.length > 0);
  assert.deepEqual(waited, others);
});

test('gate runs when a job it waits for failed', () => {
  // Skipped is what a failed `needs` gives a job without this, and GitHub
  // counts a skipped required check as passed.
  assert.match(readJobs().gate, /^ {4}if: always\(\)$/m);
});
