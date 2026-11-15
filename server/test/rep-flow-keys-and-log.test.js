'use strict';

// Rep flow audit (15 Nov 2026), the parts that need no database. Run with: npm test
//
//  - one press = one record: the window key becomes a fixed row id (ui-r00 / ui-r01)
//  - CallMeBot keys leave every answer to staff and reps; the owner (ADMIN) keeps them (ui-r02 / perm02)
//  - keys, passwords and tokens are kept as [hidden] in the audit log (perm07)
//  - a fresh fine count only after an extension, never after a return's paused hours (reps04)
//  - a return that closes the order says so (reps07)
//
// The flows themselves run against a real database in rep-flow.db.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost/unused';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only';

const { keyedId, isUniqueClash } = require('../src/utils/clientKey');
const { forRole } = require('../src/utils/repView');
const { redactEntry } = require('../src/services/audit.service');
const { fineCountFrom } = require('../src/services/penalty.service');
const { repTexts } = require('../src/services/whatsappText');

test('the same window key from the same person gives the same id; anything else gives another', () => {
  const a = keyedId('settle', 'user1', 'window-key-1', 0);
  assert.match(a, /^k[0-9a-f]{24}$/);
  assert.equal(keyedId('settle', 'user1', 'window-key-1', 0), a, 'a repeat finds the first row');
  assert.notEqual(keyedId('settle', 'user2', 'window-key-1', 0), a, 'another person can never reach this row');
  assert.notEqual(keyedId('settle', 'user1', 'window-key-2', 0), a);
  assert.notEqual(keyedId('settle', 'user1', 'window-key-1', 1), a, 'each product of one press has its own row');
  assert.notEqual(keyedId('return', 'user1', 'window-key-1', 0), a);
  assert.equal(keyedId('settle', 'user1', undefined, 0), null, 'no key: an ordinary new row');
  assert.equal(keyedId('settle', null, 'window-key-1', 0), null);
});

test('a unique clash (id or document number) is the only error read as "the first press saved first"', () => {
  assert.equal(isUniqueClash({ code: 'P2002', meta: { target: ['id'] } }), true);
  assert.equal(isUniqueClash({ code: 'P2002', meta: { target: ['returnNumber'] } }), true);
  assert.equal(isUniqueClash({ code: 'P2025' }), false);
  assert.equal(isUniqueClash(new Error('boom')), false);
  assert.equal(isUniqueClash(null), false);
});

const answer = () => ({
  data: [{
    id: 's1',
    cost: 1000,
    salesRep: { id: 'r1', code: 'REP-003', phone: '0700', whatsappPhone: '255700', whatsappApiKey: 'SECRET-1', user: { name: 'Paul' } },
  }],
  rep: { id: 'r1', whatsappApiKey: 'SECRET-2' },
  outbox: [{ toPhone: '255700', toApiKey: 'SECRET-3' }],
});
const has = (v, word) => JSON.stringify(v).includes(word);

test('warehouse staff never receive a rep\'s CallMeBot key, in any nesting; everything else stays', () => {
  const out = forRole({ user: { role: 'WAREHOUSE_STAFF' } }, answer());
  assert.equal(has(out, 'SECRET'), false);
  assert.equal(out.data[0].salesRep.whatsappPhone, '255700');
  assert.equal(out.data[0].salesRep.user.name, 'Paul');
  assert.equal(out.data[0].cost, 1000, 'staff still see costs');
});

test('a rep receives neither keys (not even his own) nor costs', () => {
  const out = forRole({ user: { role: 'SALES_REP' } }, answer());
  assert.equal(has(out, 'SECRET'), false);
  assert.equal(out.data[0].cost, undefined);
  assert.equal(out.data[0].salesRep.code, 'REP-003');
});

test('the owner (ADMIN) keeps them: he sets them on the rep profile and in Settings', () => {
  const out = forRole({ user: { role: 'ADMIN' } }, answer());
  assert.equal(out.data[0].salesRep.whatsappApiKey, 'SECRET-1');
  assert.equal(out.rep.whatsappApiKey, 'SECRET-2');
});

test('the audit log keeps that a key or password was set, never its value', () => {
  const rep = redactEntry({
    entityType: 'SalesRepresentative',
    oldValues: { whatsappPhone: '255700', whatsappApiKey: 'OLD-KEY', user: { password: 'pw' } },
    newValues: { whatsappPhone: '255711', whatsappApiKey: 'NEW-KEY', notes: 'x' },
  });
  assert.equal(rep.oldValues.whatsappApiKey, '[hidden]');
  assert.equal(rep.oldValues.user.password, '[hidden]');
  assert.equal(rep.newValues.whatsappApiKey, '[hidden]');
  assert.equal(rep.newValues.whatsappPhone, '255711', 'the number is not a secret');
  assert.equal(rep.newValues.notes, 'x');

  const cleared = redactEntry({ entityType: 'SalesRepresentative', newValues: { whatsappApiKey: null } });
  assert.equal(cleared.newValues.whatsappApiKey, null, 'a removed key stays visibly removed');

  const setting = redactEntry({ entityType: 'Setting', entityId: 'whatsapp.apikey', newValues: { value: '1234567' } });
  assert.equal(setting.newValues.value, '[hidden]');
  const plain = redactEntry({ entityType: 'Setting', entityId: 'whatsapp.phone', newValues: { value: '255700' } });
  assert.equal(plain.newValues.value, '255700');
});

test('fines are counted afresh only from an extension (rep\'s 96 hours or ZELab\'s), never from a return\'s pause', () => {
  const at = new Date('2026-11-15T10:22:00Z');
  assert.deepEqual(fineCountFrom({ deadlineChangedAt: at, deadlineChangeKind: 'ADMIN_EXTENSION' }), at);
  assert.deepEqual(fineCountFrom({ deadlineChangedAt: at, deadlineChangeKind: 'SELF_EXTENSION' }), at);
  assert.equal(fineCountFrom({ deadlineChangedAt: null, deadlineChangeKind: null }), null, 'never extended: every fine counts');
  assert.equal(fineCountFrom({}), null);
});

test('RETURN APPROVED says the order is closed only when this return closed it', () => {
  const closing = repTexts.RETURN_APPROVED({ number: 'RET-20261115-0005', boxes: 21, closed: true, order: 'STL-20261115-0002' });
  assert.match(closing, /Order STL-20261115-0002 is now fully closed\./);
  const open = repTexts.RETURN_APPROVED({ number: 'RET-20261115-0006', boxes: 1, closed: false, order: 'STL-20261115-0002' });
  assert.doesNotMatch(open, /closed/);
});
