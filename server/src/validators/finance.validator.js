'use strict';

const { z } = require('zod');
const { id } = require('./common.validator');

// Finance writes (audit #79). Each body names the fields its form actually sends; anything else is
// dropped before the service sees it. That matters most for refType/refId: they tie a ledger row to a
// sale, a purchase order, a supplier or a payout, so a hand-typed row carrying them could pass as
// sale money, pay down a supplier's bill or drop out of the balances. Only the server sets them.
//
// These check the SHAPE only. The rules about money — an amount above zero, an account chosen, enough
// in it, no more than is owed — stay in the services, which say them in plain words, so a missing
// amount or account is still answered the way it always was.

// Shillings have no cents in this business (audit fina12): 100.555 was kept as 100.56 while every screen showed
// 101, so the page and the books disagreed. A typed amount is a whole number of shillings.
const WHOLE = 'Use whole shillings — amounts here have no cents.';
const whole = (v) => v == null || Number.isInteger(v);
const amount = z.coerce.number().finite().refine(whole, WHOLE).optional().nullable();
// For a value that REPLACES a stored figure: null is refused rather than read as 0.
const figure = z.union([z.number(), z.string()]).pipe(z.coerce.number().finite()).optional();
const text = (max) => z.string().trim().max(max).optional().nullable();
const ref = z.string().max(64).optional().nullable();
// The forms send a day ("2026-11-11"); a cleared date field sends ''; a full timestamp is taken as given.
const when = z.union([z.string().date(), z.string().datetime({ offset: true }), z.literal('')]).optional().nullable();
const direction = z.enum(['IN', 'OUT']).optional();

const moneyFields = {
  accountId: ref,
  amount,
  brandId: ref,
  category: text(120),
  description: text(500),
  reference: text(120),
  notes: text(2000),
  receiptUrl: text(1000),
  occurredAt: when,
  // One per press of the form: a double tap or a retry records nothing more (15 Nov 2026).
  clientKey: z.string().trim().min(8).max(80).optional(),
};

// POST /finance/income and /finance/expenses
const financeMoney = { body: z.object(moneyFields) };
// POST /finance/owner-money
const financeOwnerMoney = { body: z.object({ ...moneyFields, direction }) };
// A balance the owner typed or saw: a real number when sent, never '' read as 0; null or left out = not sent.
const balance = z.union([z.number(), z.string().trim().min(1)]).pipe(z.coerce.number().finite()).optional().nullable();
// POST /finance/adjustments
const financeAdjustment = {
  body: z.object({
    accountId: ref,
    amount,
    direction,
    // "Correct balance" sends what the account really holds and the balance it showed; the server works
    // out the difference from the balance as it is when it writes (audit freshness-1). Both optional:
    // { direction, amount } alone is recorded as before.
    targetBalance: balance.refine(whole, WHOLE),
    expectedBalance: balance,
    brandId: ref,
    description: text(500),
    notes: text(2000),
    occurredAt: when,
  }),
};
// POST /finance/transfers
const financeTransfer = {
  body: z.object({
    fromAccountId: ref,
    toAccountId: ref,
    amount,
    notes: text(2000),
    occurredAt: when,
    reason: text(500),
    clientKey: z.string().trim().min(8).max(80).optional(),
  }),
};
// POST /finance/transactions/:id/reverse
const financeReverse = {
  params: z.object({ id }),
  body: z.object({ reason: z.string().trim().min(3, 'Say why this entry is being reversed').max(500) }),
};
// PUT /finance/transactions/:id
const financeTxnUpdate = {
  params: z.object({ id }),
  body: z.object({
    // Left out to keep the row where it is; never null, which would wipe the amount or the account.
    accountId: z.string().min(1).max(64).optional(),
    brandId: ref,
    amount: figure,
    category: text(120),
    description: text(500),
    reference: text(120),
    notes: text(2000),
    occurredAt: when,
    reason: text(500),
  }),
};
// POST /finance/supplier-payments
const financeSupplierPayment = {
  body: z.object({
    purchaseOrderId: id,
    accountId: ref,
    amount,
    notes: text(2000),
    occurredAt: when,
    // One per press of the Pay window, like the other money forms (audit fina00): a double tap pays once.
    clientKey: z.string().trim().min(8).max(80).optional(),
  }),
};
// POST /finance/suppliers/:id/pay
const financeSupplierBalancePayment = {
  params: z.object({ id }),
  body: z.object({
    accountId: ref,
    amount,
    notes: text(2000),
    occurredAt: when,
    clientKey: z.string().trim().min(8).max(80).optional(),
  }),
};
// POST /finance/suppliers/:id/credits
const financeSupplierCredit = {
  params: z.object({ id }),
  body: z.object({
    amount,
    reason: text(300),
    occurredAt: when,
  }),
};
const accountType = z.enum(['CASH', 'BANK', 'MOBILE_MONEY', 'OTHER', 'COMMISSION']);
// POST /finance/accounts
const financeAccountCreate = {
  body: z.object({
    name: text(80),
    type: accountType.optional(),
    brandId: ref,
    openingBalance: amount,
    notes: text(1000),
  }),
};
// PUT /finance/accounts/:id
const financeAccountUpdate = {
  params: z.object({ id }),
  body: z.object({
    name: z.string().trim().min(1).max(80).optional(),
    type: accountType.optional(),
    brandId: ref,
    openingBalance: figure.refine(whole, WHOLE),
    notes: text(1000),
    isActive: z.boolean().optional(),
  }),
};
// POST /finance/categories
const financeCategoryCreate = { body: z.object({ name: text(80) }) };

// GET /finance/transactions (audit fina13): a type, direction or amount the database cannot read answered
// "Invalid database query", and a day that does not exist (2026-13-45) silently listed nothing. Each filter is
// checked here and refused in plain words. REP_COMMISSION is the Ledger's "Rep commissions" choice.
const TXN_TYPES = [
  'SETTLEMENT', 'WAREHOUSE_SALE', 'INCOME', 'EXPENSE', 'STOCK_PURCHASE', 'COMMISSION_PAYMENT', 'TRANSFER', 'ADJUSTMENT',
  'OWNER_CONTRIBUTION', 'OWNER_DRAWING', 'REP_COMMISSION',
];
const blankToUndefined = (v) => (v === '' || v === null ? undefined : v);
const filterAmount = z.preprocess(blankToUndefined, z.coerce.number({ invalid_type_error: 'Use a number for the amount' }).finite().min(0).optional());
const filterDay = z.preprocess(
  blankToUndefined,
  z.union([z.string().date(), z.string().datetime({ offset: true })], { errorMap: () => ({ message: 'Use a real date like 2026-11-15' }) }).optional(),
);
const financeTxnQuery = {
  query: z.object({
    page: z.coerce.number().int().min(1).optional(),
    // A bigger page is cut to the most a page holds (parsePagination), as it always was.
    limit: z.coerce.number().int().min(1).optional(),
    sortBy: z.string().max(40).optional(),
    sortDir: z.enum(['asc', 'desc']).optional(),
    search: z.string().trim().max(200).optional(),
    accountId: z.preprocess(blankToUndefined, z.string().max(64).optional()),
    brandId: z.preprocess(blankToUndefined, z.string().max(64).optional()),
    category: z.preprocess(blankToUndefined, z.string().max(120).optional()),
    type: z.preprocess(blankToUndefined, z.enum(TXN_TYPES, { errorMap: () => ({ message: 'Unknown entry type' }) }).optional()),
    direction: z.preprocess(blankToUndefined, z.enum(['IN', 'OUT'], { errorMap: () => ({ message: 'Direction is IN or OUT' }) }).optional()),
    from: filterDay,
    to: filterDay,
    minAmount: filterAmount,
    maxAmount: filterAmount,
  }),
};

module.exports = {
  financeMoney,
  financeOwnerMoney,
  financeAdjustment,
  financeTransfer,
  financeTxnUpdate,
  financeReverse,
  financeSupplierPayment,
  financeSupplierBalancePayment,
  financeSupplierCredit,
  financeAccountCreate,
  financeAccountUpdate,
  financeCategoryCreate,
  financeTxnQuery,
};
