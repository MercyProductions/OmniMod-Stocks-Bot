import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { getPaperLedgerWorkspaceRoot, paperLedgerFingerprint, resolvePaperLedgerPath } from '../paperStatePath.js';

test('default ledger is one absolute workspace path independent of process working directory', () => {
  assert.equal(resolvePaperLedgerPath(''), resolve(getPaperLedgerWorkspaceRoot(), 'shared/data/shared-paper-risk.json'));
  assert.equal(resolvePaperLedgerPath('../shared/data/shared-paper-risk.json'),
    resolve(getPaperLedgerWorkspaceRoot(), '../shared/data/shared-paper-risk.json'));
});

test('absolute operator-configured ledger paths are preserved', () => {
  const configured = resolve(getPaperLedgerWorkspaceRoot(), 'test-data', 'paper.json');
  assert.equal(resolvePaperLedgerPath(configured), configured);
});

test('ledger fingerprints are stable and do not contain filesystem paths', () => {
  const fingerprint = paperLedgerFingerprint('custom/ledger.json');
  assert.equal(fingerprint, paperLedgerFingerprint('custom/ledger.json'));
  assert.match(fingerprint, /^[a-f0-9]{16}$/);
  assert.notEqual(fingerprint, paperLedgerFingerprint('custom/other.json'));
  assert.equal(fingerprint.includes(getPaperLedgerWorkspaceRoot()), false);
});

test('four Discord app starter configurations all use the same shared ledger', () => {
  for (const bot of ['forex', 'futures', 'options', 'etfs-etps']) {
    const source = readFileSync(resolve(getPaperLedgerWorkspaceRoot(), bot, '.env.example'), 'utf8');
    const configured = source.match(/^TRADING_RISK_STATE_PATH=(.*)$/m)?.[1].trim() || '';
    assert.equal(resolvePaperLedgerPath(configured), resolvePaperLedgerPath(''), `${bot} starter ledger must align`);
  }
});
