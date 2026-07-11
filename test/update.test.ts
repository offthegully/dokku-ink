// Unit tests for the release-tag comparison behind the header's update chip.

import test from 'node:test';
import assert from 'node:assert/strict';

const { isNewer } = await import('../src/update.js');

test('detects a newer release across each version segment', () => {
  assert.equal(isNewer('0.1.4', '0.1.3'), true); // patch
  assert.equal(isNewer('0.2.0', '0.1.9'), true); // minor beats higher patch
  assert.equal(isNewer('1.0.0', '0.9.9'), true); // major beats all
});

test('same or older release is not newer', () => {
  assert.equal(isNewer('0.1.3', '0.1.3'), false);
  assert.equal(isNewer('0.1.2', '0.1.3'), false);
  assert.equal(isNewer('0.0.9', '0.1.0'), false);
});

test('tolerates a leading v and prerelease/build suffixes', () => {
  assert.equal(isNewer('v0.1.4', '0.1.3'), true);
  assert.equal(isNewer('v0.1.4', 'v0.1.4'), false);
  assert.equal(isNewer('0.2.0-rc.1', '0.1.9'), true);
  assert.equal(isNewer('0.1.4+build.7', '0.1.3'), true);
});

test('missing segments and garbage degrade to zero rather than throwing', () => {
  assert.equal(isNewer('1', '0.9.9'), true); // "1" -> 1.0.0
  assert.equal(isNewer('0.1', '0.1.0'), false); // "0.1" -> 0.1.0
  assert.equal(isNewer('not-a-version', '0.0.1'), false);
});
