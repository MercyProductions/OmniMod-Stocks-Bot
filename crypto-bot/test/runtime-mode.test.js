import test from 'node:test';
import assert from 'node:assert/strict';
import { isWorkerOnlyMode } from '../src/runtimeMode.js';

test('Windows runs Discord workers in-process instead of spawning the Linux shell supervisor', () => {
  assert.equal(isWorkerOnlyMode('win32', ''), true);
  assert.equal(isWorkerOnlyMode('win32', 'false'), true);
});

test('Linux keeps Passenger supervisor mode unless the persistent worker flag is set', () => {
  assert.equal(isWorkerOnlyMode('linux', ''), false);
  assert.equal(isWorkerOnlyMode('linux', 'false'), false);
  assert.equal(isWorkerOnlyMode('linux', '1'), true);
  assert.equal(isWorkerOnlyMode('linux', 'TRUE'), true);
});
