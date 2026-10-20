import test from 'node:test';
import assert from 'node:assert/strict';
import { markNotificationAttempt, markNotificationPosted, notificationRetryReady } from '../src/notificationState.js';

test('notification attempts use a bounded retry cooldown and respect clock skew', () => {
  const start = new Date('2026-09-24T12:00:00.000Z');
  const attempted = markNotificationAttempt({}, 'opening', start);
  assert.equal(notificationRetryReady(attempted, 'opening', start.getTime() + 4 * 60_000), false);
  assert.equal(notificationRetryReady(attempted, 'opening', start.getTime() + 5 * 60_000), true);
  assert.equal(notificationRetryReady(attempted, 'opening', start.getTime() - 1), false);
});

test('a null delivery does not create a posted marker and can retry after cooldown', () => {
  const now = new Date('2026-09-24T12:00:00.000Z');
  const attempted = markNotificationAttempt({}, 'review', now);
  const failed = markNotificationPosted(attempted, 'review', null, now);
  assert.equal(failed.reviewPostedAt, undefined);
  assert.equal(notificationRetryReady(failed, 'review', now.getTime() + 5 * 60_000), true);
});

test('a confirmed delivery records its message id and prevents duplicate posting', () => {
  const now = new Date('2026-09-24T12:00:00.000Z');
  const delivered = markNotificationPosted({}, 'opening', { id: '123' }, now);
  assert.equal(delivered.openingPostedAt, now.toISOString());
  assert.equal(delivered.openingMessageId, '123');
  assert.equal(notificationRetryReady(delivered, 'opening', now.getTime() + 60 * 60_000), false);
});
