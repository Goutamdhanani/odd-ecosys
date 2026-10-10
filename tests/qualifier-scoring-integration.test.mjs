import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-qualifier-scoring-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
const database = await import('../pipeline/database.js');
const db = database.initDb();
const { getQualificationScoringManager, scoreQualificationSignals } = await import('../pipeline/qualification-scoring.js');
const { qualifyLead } = await import('../pipeline/qualifier.js');
const manager = getQualificationScoringManager(db);

after(() => {
  database.closeDb();
  rmSync(directory, { recursive: true, force: true });
});

test('qualification uses the selected version and does not reuse another version’s cached domain score', async () => {
  const versionOne = manager.getProfile();
  const versionTwoConfig = structuredClone(versionOne.config);
  versionTwoConfig.signal_weights.ssl_valid = 20;
  versionTwoConfig.signal_weights.has_analytics = 1;
  const versionTwo = manager.createVersion({
    actor: { id: 1, role: 'owner' },
    config: versionTwoConfig,
    changeNote: 'Synthetic integration fixture',
  });

  const year = new Date().getFullYear();
  const html = `<!doctype html><html><head>
    <meta name="viewport" content="width=device-width">
    <script src="https://www.googletagmanager.com/gtag.js"></script>
    <script type="application/ld+json">{"@type":"Organization"}</script>
    <meta name="copyright" content="${year}">
    </head><body><p>© ${year} This synthetic fixture includes enough visible page content for the static site audit to score its saved signals without starting JavaScript rendering. ${'Representative content. '.repeat(20)}</p>
    <img src="image.jpg" srcset="image-small.jpg 480w, image-large.jpg 1200w">
    <a href="mailto:hello@fixture-scoring.test">Email</a>
    <a href="https://facebook.com/fixture">Social one</a><a href="https://instagram.com/fixture">Social two</a>
    </body></html>`;
  let requests = 0;
  const fetchPage = async url => {
    requests += 1;
    assert.match(url, /^https:\/\/fixture-scoring\.test\//);
    return {
      url: 'https://fixture-scoring.test/',
      ok: true,
      status: 200,
      headers: { get: name => name.toLowerCase() === 'content-length' ? String(Buffer.byteLength(html)) : null },
      text: async () => html,
    };
  };
  const lead = { id: 9001, business_name: 'Synthetic site', website_url: 'https://fixture-scoring.test/' };
  const fixtureOptions = { fetchPage, checkFacebook: async () => null, takeScreenshot: async () => null };

  const resultV1 = await qualifyLead(lead, { ...fixtureOptions, scoringProfile: versionOne });
  assert.equal(resultV1.scoring.version, 1);
  assert.equal(resultV1.scoring.configHash, versionOne.configHash);
  assert.equal(resultV1.scoring.applicable, true);
  assert.equal(resultV1.site_score, scoreQualificationSignals(resultV1.signals, versionOne).site_score);
  assert.equal(resultV1.signals.ssl_valid, true);
  assert.equal(resultV1.signals.last_modified_recent, null, 'missing Last-Modified remains unresolved in saved evidence');
  assert.equal(resultV1.confidence, 90);

  const repeatedV1 = await qualifyLead(lead, { ...fixtureOptions, scoringProfile: versionOne });
  assert.equal(repeatedV1._cached, true, 'same-domain checks are still cached within one scoring version');
  assert.equal(requests, 1);

  const resultV2 = await qualifyLead(lead, { ...fixtureOptions, scoringProfile: versionTwo });
  assert.equal(resultV2._cached, undefined, 'a new scoring version cannot reuse a stale domain score');
  assert.equal(resultV2.scoring.version, 2);
  assert.equal(resultV2.scoring.configHash, versionTwo.configHash);
  assert.equal(resultV2.site_score, scoreQualificationSignals(resultV2.signals, versionTwo).site_score);
  assert.notEqual(resultV2.site_score, resultV1.site_score, 'changed signal weights change the derived score');
  assert.equal(requests, 2, 'new scoring profile triggers fresh site evidence before scoring');

  const fallbackCalls = [];
  const fallbackResult = await qualifyLead({
    id: 9002, business_name: 'Synthetic HTTP fallback', website_url: 'https://fallback-scoring.test/',
  }, {
    scoringProfile: versionTwo,
    checkFacebook: async () => null,
    takeScreenshot: async () => null,
    fetchPage: async url => {
      fallbackCalls.push(url);
      if (url.startsWith('https://')) throw new Error('Synthetic certificate validation failure');
      return {
        url,
        ok: true,
        status: 200,
        headers: { get: name => name.toLowerCase() === 'content-length' ? String(Buffer.byteLength(html)) : null },
        text: async () => html,
      };
    },
  });
  assert.equal(fallbackCalls.length, 2, 'the normal secure-first and HTTP fallback path was exercised');
  assert.equal(fallbackResult.signals.ssl_valid, false);
  assert.equal(fallbackResult.signals.ssl_check_failed, true);
  assert.equal(fallbackResult.scoring.appliedPenalties.ssl_check_failed, versionTwo.config.confidence_penalties.ssl_check_failed,
    'the configured TLS failure penalty is applied from the recorded evidence');
});
