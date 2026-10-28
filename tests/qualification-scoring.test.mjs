import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createQualificationScoringManager, scoreQualificationSignals } from '../pipeline/qualification-scoring.js';

test('qualification scoring uses validated immutable profiles and deterministic saved-signal derivation', () => {
  const db = new Database(':memory:');
  try {
    const manager = createQualificationScoringManager(db);
    const versionOne = manager.getProfile();
    assert.equal(versionOne.version, 1);
    assert.match(versionOne.configHash, /^[a-f0-9]{64}$/);
    assert.deepEqual(manager.getProfile(1).config, versionOne.config);

    const versionTwoConfig = {
      ...versionOne.config,
      thresholds: { outdated_max: 40, modern_min: 70 },
      signal_weights: Object.fromEntries(Object.keys(versionOne.config.signal_weights).map(key => [key, 1])),
      confidence_penalties: {
        ...versionOne.config.confidence_penalties,
        unresolved_signal: 7,
        near_threshold: 25,
        threshold_proximity: 5,
      },
    };
    const versionTwo = manager.createVersion({
      actor: { id: 7, role: 'owner' },
      config: versionTwoConfig,
      changeNote: 'Calibrate review boundary',
    });
    assert.equal(versionTwo.version, 2);
    assert.notEqual(versionTwo.configHash, versionOne.configHash);
    assert.equal(manager.getProfile(1).configHash, versionOne.configHash, 'older profiles remain immutable');
    assert.deepEqual(manager.listProfiles(10).map(profile => profile.version), [2, 1]);

    const signals = Object.fromEntries(Object.keys(versionTwoConfig.signal_weights).map(key => [key, false]));
    Object.keys(signals).slice(0, 8).forEach(key => { signals[key] = true; });
    const evaluation = scoreQualificationSignals(signals, versionTwo);
    assert.deepEqual(evaluation, scoreQualificationSignals(signals, versionTwo), 'same evidence/profile yields an identical derivation');
    assert.equal(evaluation.site_score, 67);
    assert.equal(evaluation.site_status, 'OUTDATED');
    assert.equal(evaluation.confidence, 75, 'near-threshold penalty is applied from the versioned profile');
    assert.equal(evaluation.scoring.version, 2);
    assert.equal(evaluation.scoring.configHash, versionTwo.configHash);
    assert.deepEqual(evaluation.scoring.unresolvedSignals, []);

    const errorEvidence = { ...signals, ssl_check_failed: true, html_truncated: true };
    const penalized = scoreQualificationSignals(errorEvidence, versionTwo);
    assert.equal(penalized.confidence, 40, 'configured transport and truncation penalties participate in confidence');
    assert.deepEqual(penalized.scoring.appliedPenalties, {
      ssl_check_failed: versionTwoConfig.confidence_penalties.ssl_check_failed,
      html_truncated: versionTwoConfig.confidence_penalties.html_truncated,
      near_threshold: 25,
    });

    assert.throws(() => manager.createVersion({
      actor: { id: 8, role: 'operator' }, config: versionTwoConfig,
    }), /Only workspace owners and admins/);
    assert.throws(() => manager.createVersion({
      actor: { id: 7, role: 'owner' },
      config: { ...versionTwoConfig, thresholds: { outdated_max: 80, modern_min: 70 } },
    }), /must be lower/);
    assert.throws(() => manager.createVersion({
      actor: { id: 7, role: 'owner' }, config: versionTwoConfig,
    }), /already match/);
    assert.equal(manager.getProfile().version, 2, 'rejected updates do not create a partial version');
  } finally {
    db.close();
  }
});
