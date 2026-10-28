import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { validateAstraQaFixture } from './astra-r18-fixture.mjs';
import { validateAstraR20Fixture } from './astra-r20-fixture.mjs';

const R20_FIXTURE_RELATIVE_PATH = 'r20-source-rights/pg.json';

/**
 * Bridge released platform tests to the separately pinned R20 fixture. Existing
 * labels and validator options continue through the original strict31/32
 * validator unchanged; only an explicit opt-in and the one canonical named R20
 * fixture select the strict33 validator.
 */
export async function validateAstraPlatformFixture(options) {
  const { root, fixturePath, allowR20 = false } = options || {};
  if (allowR20 !== undefined && typeof allowR20 !== 'boolean') {
    throw new TypeError('allowR20 must be an explicit boolean.');
  }
  const repo = await realpath(root);
  const qaRoot = await realpath(path.join(repo, '.runner', 'astra-qa'));
  const canonicalFixture = await realpath(fixturePath);
  const relative = path.relative(qaRoot, canonicalFixture);
  const isContained = !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
  const parts = isContained ? relative.split(path.sep) : [];
  const canonicalRelative = relative.split(path.sep).join('/');
  if (parts[0] === 'r20-source-rights') {
    if (canonicalRelative !== R20_FIXTURE_RELATIVE_PATH) {
      throw new Error('Only the canonical named R20 source-rights fixture is accepted.');
    }
    if (allowR20 !== true) throw new Error('The R20 source-rights fixture requires explicit allowR20 opt-in.');
    return validateAstraR20Fixture({ root: repo, fixturePath: canonicalFixture });
  }
  const legacyMigrations = options?.migrations;
  if (legacyMigrations !== undefined && ![31, 32, 'legacy31-or-r18'].includes(legacyMigrations)) {
    throw new Error('Historical platform fixtures are limited to strict migration31/32 validation.');
  }
  const { allowR20: _allowR20, ...legacyOptions } = options;
  return validateAstraQaFixture(legacyOptions);
}
