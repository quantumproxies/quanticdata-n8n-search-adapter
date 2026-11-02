import test from 'node:test';
import assert from 'node:assert/strict';
import { selectNetwork } from '../setup.mjs';

test('setup chooses the n8n user-defined network, with an explicit choice for ambiguity', () => {
  assert.equal(selectNetwork({ app_default: {}, bridge: {} }), 'app_default');
  assert.equal(selectNetwork({ app_default: {}, other: {} }), 'app_default');
  assert.equal(selectNetwork({ app: {}, other: {} }, 'other'), 'other');
  assert.throws(() => selectNetwork({ bridge: {} }));
  assert.throws(() => selectNetwork({ app: {}, other: {} }));
  assert.throws(() => selectNetwork({ app: {} }, 'outside'));
});
