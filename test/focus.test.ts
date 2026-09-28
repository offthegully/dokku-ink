// Unit tests for terminal focus tracking and the header freshness buckets.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

const { stripFocus, isFocused, onFocusChange, focusAwareStdin } = await import('../src/focus.js');
const { fmtFreshness, nextFreshnessChange } = await import('../src/ui.js');

test('focus sequences are stripped and flip the focus state', () => {
  const seen: boolean[] = [];
  const off = onFocusChange((f) => seen.push(f));
  assert.equal(stripFocus('\u001B[O'), '');
  assert.equal(isFocused(), false);
  assert.equal(stripFocus('a\u001B[Ib'), 'ab'); // keys either side survive
  assert.equal(isFocused(), true);
  assert.equal(stripFocus('\u001B[O\u001B[I'), ''); // last one wins: no net change, no event
  assert.equal(isFocused(), true);
  assert.equal(stripFocus('\u001B[A'), '\u001B[A'); // arrow keys untouched
  off();
  assert.deepEqual(seen, [false, true]);
});

test('wrapped stdin skips chunks that were only a focus event', () => {
  const chunks = ['\u001B[O', 'q', '\u001B[I'];
  const fake = Object.assign(new EventEmitter(), {
    read: () => chunks.shift() ?? null,
    isTTY: true,
  }) as unknown as NodeJS.ReadStream;
  const stdin = focusAwareStdin(fake);
  assert.equal(stdin.read(), 'q'); // the leading focus-out never reaches Ink
  assert.equal(isFocused(), false);
  assert.equal(stdin.read(), null); // trailing focus-in consumed, then drained
  assert.equal(isFocused(), true);
  assert.equal(stdin.isTTY, true); // everything else passes through
});

test('freshness readout is bucketed and knows when it next changes', () => {
  assert.equal(fmtFreshness(0), 'now');
  assert.equal(fmtFreshness(14.9), 'now');
  assert.equal(fmtFreshness(15), '15s');
  assert.equal(fmtFreshness(44), '30s');
  assert.equal(fmtFreshness(61), '1m');
  assert.equal(fmtFreshness(7300), '2h');
  assert.equal(nextFreshnessChange(0), 15);
  assert.equal(nextFreshnessChange(20), 10);
  assert.equal(nextFreshnessChange(90), 30);
  assert.equal(nextFreshnessChange(3700), 3500);
});
