'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isTransientRequestError,
  programSchedulesEquivalent,
  valuesEquivalent
} = require('../windhager-mycomfort-iobroker');

test('temperature comparison allows normal controller rounding', () => {
  assert.equal(valuesEquivalent('21.0', 21), true);
  assert.equal(valuesEquivalent(20.95, 21, 0.1), true);
  assert.equal(valuesEquivalent(20.8, 21, 0.1), false);
  assert.equal(valuesEquivalent(null, 0), false);
  assert.equal(valuesEquivalent(undefined, 0), false);
});

test('non-numeric values require an exact match', () => {
  assert.equal(valuesEquivalent('heating', 'heating'), true);
  assert.equal(valuesEquivalent('heating', 'setback'), false);
});

test('common transient HTTP and network errors are retryable', () => {
  for (const statusCode of [408, 425, 429, 500, 502, 503, 504]) {
    assert.equal(isTransientRequestError({ statusCode }), true, `HTTP ${statusCode}`);
  }
  for (const code of ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT']) {
    assert.equal(isTransientRequestError({ code }), true, code);
  }
  assert.equal(isTransientRequestError({ statusCode: 400 }), false);
  assert.equal(isTransientRequestError({ retryable: true }), true);
});

test('program verification compares times and temperatures', () => {
  const expected = {
    heatingStartTime: '06:00',
    heatingTargetTemperature: 21,
    setbackStartTime: '22:00',
    setbackTargetTemperature: 18
  };
  assert.equal(programSchedulesEquivalent({ ...expected, heatingTargetTemperature: '21.0' }, expected), true);
  assert.equal(programSchedulesEquivalent({ ...expected, setbackStartTime: '23:00' }, expected), false);
});
