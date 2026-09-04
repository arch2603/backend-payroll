const test = require('node:test');
const assert = require('node:assert/strict');
const { passwordError, normalizeRole } = require('../service/passwordPolicy');

test('accepts a password that satisfies every rule', () => {
  assert.equal(passwordError('Correct-Horse7'), null);
});

test('rejects short or incomplete passwords', () => {
  assert.match(passwordError('Short1!'), /12 characters/);
  assert.match(passwordError('alllowercase7!'), /uppercase/);
  assert.match(passwordError('ALLUPPERCASE7!'), /lowercase/);
  assert.match(passwordError('NoNumberHere!'), /number/);
  assert.match(passwordError('NoSymbolHere7'), /symbol/);
});

test('normalizes only supported roles', () => {
  assert.equal(normalizeRole(' HR '), 'hr');
  assert.equal(normalizeRole('owner'), null);
});
