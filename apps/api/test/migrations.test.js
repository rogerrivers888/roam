/**
 * The migration ledger, and the one mistake it cannot recover from.
 *
 * Two files with the same number is how two branches quietly disagree about the
 * order the schema was built in. It has already happened five times here; the
 * guard exists so the sixth is caught while renaming is still free.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoNewDuplicateNumbers, numberOf } from '../src/migrate.js';

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');

test('reads the number a file leads with', () => {
  assert.equal(numberOf('017_scores_and_where.sql'), '017');
  assert.equal(numberOf('001_init.sql'), '001');
});

test('a new file taking a used number is refused', () => {
  assert.throws(
    () => assertNoNewDuplicateNumbers(['001_init.sql', '040_things.sql', '040_other_things.sql']),
    /two migrations share the number 040/,
  );
});

test('the collisions that already happened are history, by name', () => {
  assert.doesNotThrow(() => assertNoNewDuplicateNumbers(['009_favourites.sql', '009_timezone.sql']));
  assert.doesNotThrow(() => assertNoNewDuplicateNumbers(['030_group_cap.sql', '030_place_contents.sql']));
});

test('a new file wearing a grandfathered number is still refused', () => {
  // The hole in grandfathering by number rather than by name: `030_anything`
  // would have walked straight in and recreated the divergence (found by
  // review, 4 Sep 2026).
  assert.throws(
    () => assertNoNewDuplicateNumbers(['030_group_cap.sql', '030_place_contents.sql', '030_something_new.sql']),
    /two migrations share the number 030/,
  );
  assert.throws(
    () => assertNoNewDuplicateNumbers(['009_favourites.sql', '009_something_new.sql']),
    /two migrations share the number 009/,
  );
});

test('the repository builds from an empty database', async () => {
  // The guard must not read history out of "what this database has applied":
  // an empty one has applied nothing, and inferring from that would refuse to
  // build a database from scratch. This is the case that would have blocked a
  // deploy (found by review, 4 Sep 2026).
  const files = (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  assert.doesNotThrow(() => assertNoNewDuplicateNumbers(files));
});

test('and from a database part-way through', async () => {
  // The other failing case: a database applied through 029 sees both 030 files
  // as new.
  const files = (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  assert.doesNotThrow(() => assertNoNewDuplicateNumbers(files));
});

test('every migration is named number_words.sql', async () => {
  const files = (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql'));
  for (const f of files) {
    assert.match(f, /^\d{3}_[a-z0-9_]+\.sql$/, `${f} does not follow the naming the ordering depends on`);
  }
});

test('no migration creates schema outside a migration', async () => {
  // Rule 3 of the estate's engineering standard, checked rather than asserted:
  // schema is created by migrations, never at runtime by application code.
  const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
  const offenders = [];
  const walk = async (dir) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      // migrate.js creates the ledger it needs to know what has run; that is
      // the one place allowed to, and it is the bootstrap, not the schema.
      if (entry.name === 'migrate.js') continue;
      const body = await fs.readFile(full, 'utf8');
      if (/\b(create|alter|drop)\s+(table|index|type|function)\b/i.test(body)) offenders.push(full);
    }
  };
  await walk(srcDir);
  assert.deepEqual(offenders, [], 'schema created outside migrations/');
});
