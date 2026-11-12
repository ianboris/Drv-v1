import test from 'node:test';
import assert from 'node:assert/strict';
import { createDigitProposalRequest } from '../src/digit-contracts.mjs';

const common = { symbol: '1HZ100V', amount: 5, currency: 'USD', targetDigit: 7, reqId: 41 };

test('all four strategies map to their Deriv one-tick contract types', () => {
  const expected = {
    DIFFERS: 'DIGITDIFF',
    MATCHES: 'DIGITMATCH',
    EVEN: 'DIGITEVEN',
    ODD: 'DIGITODD',
  };
  for (const [strategy, contractType] of Object.entries(expected)) {
    const payload = createDigitProposalRequest({ ...common, strategy });
    assert.equal(payload.contract_type, contractType);
    assert.equal(payload.duration, 1);
    assert.equal(payload.duration_unit, 't');
    assert.equal(payload.underlying_symbol, common.symbol);
  }
});

test('parity proposals omit barrier while Matches and Differs include it', () => {
  for (const strategy of ['EVEN', 'ODD']) {
    assert.equal(Object.hasOwn(createDigitProposalRequest({ ...common, strategy }), 'barrier'), false);
  }
  for (const strategy of ['DIFFERS', 'MATCHES']) {
    assert.equal(createDigitProposalRequest({ ...common, strategy }).barrier, '7');
  }
});

test('Matches and Differs reject missing or invalid target digits', () => {
  for (const strategy of ['DIFFERS', 'MATCHES']) {
    assert.throws(() => createDigitProposalRequest({ ...common, strategy, targetDigit: -1 }), /target digit/);
  }
});

test('unsupported strategies and invalid stake/currency are rejected', () => {
  assert.throws(() => createDigitProposalRequest({ ...common, strategy: 'BOOM' }), /Unsupported/);
  assert.throws(() => createDigitProposalRequest({ ...common, strategy: 'EVEN', amount: 0 }), /Stake/);
  assert.throws(() => createDigitProposalRequest({ ...common, strategy: 'ODD', currency: '' }), /currency/);
});
