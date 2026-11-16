import test from 'node:test';
import assert from 'node:assert/strict';
import {PASSWORD_MINIMUM, passwordStrength} from '../web/password-field.js';

test('the meter is empty, then short until the server minimum, then fair and good', () => {
  assert.deepEqual(passwordStrength(0), {level: '', fill: 0});
  assert.equal(passwordStrength(PASSWORD_MINIMUM - 1).level, 'short');
  assert.equal(passwordStrength(PASSWORD_MINIMUM).level, 'fair');
  assert.equal(passwordStrength(16).level, 'good');
  // It fills on past the minimum, towards twenty, and stops there.
  assert.equal(passwordStrength(10).fill, 50);
  assert.equal(passwordStrength(40).fill, 100);
});
