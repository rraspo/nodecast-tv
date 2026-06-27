'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { parseConnectionInfo } = require('./xtreamApi');

test('parseConnectionInfo: parses string counts to numbers', () => {
  const data = { user_info: { active_cons: '1', max_connections: '3' } };
  assert.deepStrictEqual(parseConnectionInfo(data), { active: 1, max: 3 });
});

test('parseConnectionInfo: accepts numeric counts', () => {
  const data = { user_info: { active_cons: 2, max_connections: 5 } };
  assert.deepStrictEqual(parseConnectionInfo(data), { active: 2, max: 5 });
});

test('parseConnectionInfo: zero active is preserved, not nulled', () => {
  const data = { user_info: { active_cons: '0', max_connections: '3' } };
  assert.deepStrictEqual(parseConnectionInfo(data), { active: 0, max: 3 });
});

test('parseConnectionInfo: empty strings become null', () => {
  const data = { user_info: { active_cons: '', max_connections: '' } };
  assert.deepStrictEqual(parseConnectionInfo(data), { active: null, max: null });
});

test('parseConnectionInfo: missing user_info yields nulls', () => {
  assert.deepStrictEqual(parseConnectionInfo({}), { active: null, max: null });
  assert.deepStrictEqual(parseConnectionInfo(null), { active: null, max: null });
});

test('parseConnectionInfo: non-numeric junk becomes null', () => {
  const data = { user_info: { active_cons: 'unlimited', max_connections: 'n/a' } };
  assert.deepStrictEqual(parseConnectionInfo(data), { active: null, max: null });
});
