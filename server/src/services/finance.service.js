'use strict';

// ===========================================================================
// BUSINESS FINANCE
//
// One ledger (FinanceTransaction) is the single source of truth. An account's
// balance = openingBalance + Σ(IN) − Σ(OUT). Auto-income posts when a settlement
// or a warehouse cash sale completes; expenses post OUT. Net business profit =
// gross profit − expenses.
// ===========================================================================

const { Prisma } = require('@prisma/client');
const prisma = require('../config/prisma');
const ApiError = require('../utils/ApiError');
const reports = require('./reports.service');
const profitMath = require('../utils/profitMath');
const inventory = require('./inventory.service');
const commission = require('./commission.service');
const { nextDocNumber, withDocNumberRetry } = require('../utils/numbering');
const { toNumber, round2, DB_MAX_AMOUNT, formatCurrency } = require('../utils/money');
const { dayjs, resolveRange, eatDayBounds, EAT_OFFSET_H } = require('../utils/dates');

// ── Money that never touches a business account ─────────────────────────────
// The owner pays every rep in physical cash out of his own hand: "no business
// account is involved at any point". The ledger still carries a
// COMMISSION_PAYMENT row for each payout, because the record of what each rep
// was paid is exactly what he asked to keep — but that row is a RECORD, not a
// movement. It may not change an account balance and it may not count as the
// business spending money.
//
// Both legs of such a payout are off-account:
//   • the COMMISSION_PAYMENT OUT — the cash he handed the rep;
//   • an OWNER_CONTRIBUTION IN carrying refType 'CommissionWithdrawal' — a
//     legacy row posted to "fund" a payout. Nothing creates these any more,
//     but migration 20260830000007 stamped surviving ones and production may
//     still hold them. Excluding the OUT while leaving the IN would inflate
//     cash by exactly the amount this fix removes.
//
// Written as positive equalities only. A compound `NOT`/`{ not: … }` over a
// nullable column (refType is NULL on every ordinary contribution) leans on
// Prisma's NULL handling, and this figure is too important to rest on that.
const COMMISSION_TYPE = 'COMMISSION';

const OFF_ACCOUNT_WHERE = {
  OR: [
    { type: 'COMMISSION_PAYMENT' },
    { AND: [{ type: 'OWNER_CONTRIBUTION' }, { refType: 'CommissionWithdrawal' }] },
    // Anything at all filed on the commission account. That account is a
    // record, not a wallet — "no money is held here" has to be true of every
    // row on it, not just the payouts. It also holds the cash receipts that
    // were handed straight back out as commission: real income, but income no
    // wallet ever kept, so counting it as a balance invents money.
    { account: { is: { type: COMMISSION_TYPE } } },
  ],
};

// Movements that are NOT the business trading: internal transfers, the owner's
// own money going in or coming out, and rep commission paid from his pocket.
// Excluded from money in/out. COMMISSION_PAYMENT belongs here for the same
// reason OWNER_DRAWING does — it is the owner's money, not the business's.
const NON_TRADE_TYPES = ['TRANSFER', 'OWNER_CONTRIBUTION', 'OWNER_DRAWING', 'COMMISSION_PAYMENT'];

// ── The commission account ──────────────────────────────────────────────────
// Rep commission comes out of the owner's own pocket, in cash, for both brands.
// It may not add to or subtract from M-Pesa or Airtel Money — but the RECORD of
// what each rep was paid is exactly what he asked to keep, "held in one place,
// clearly labelled". That place is an account of type COMMISSION.
//
// It is recognised by TYPE, never by name: a name is something a user can
// change, and a rule that breaks when someone renames a card is not a rule.
// Because every row filed against it is off-account (OFF_ACCOUNT_WHERE), its
// BALANCE is zero by design; what it reports instead is the TOTAL RECORDED.
const COMMISSION_ACCOUNT_NAME = 'Commission';
const COMMISSION_ACCOUNT_NOTES =
  "Rep commission, paid by the owner in cash from his own pocket. A record only — no money is held here, so the balance is always zero.";
// Not a wallet the business trades through. Nothing may target one of these by
// default, offer one to a rep, or move money in or out of one.
const MONEY_ACCOUNT_WHERE = { type: { notIn: [COMMISSION_TYPE, 'CASH'] } };

// Generic payment accounts — WHERE money sits. The brand a transaction belongs
// to is a separate dimension (FinanceTransaction.brandId), but a WALLET is now
// bound to its brand: OHIS settles to M-Pesa, Civlily to Airtel Money, so a rep
// settling sees exactly one option instead of a choice they can get wrong.
//
// There is no Cash account. The business does not accept cash payments and
// holds no money in cash; the only cash in the story is the commission the
// owner hands reps himself, and that is a record, not a wallet.
const DEFAULT_ACCOUNTS = [
  { name: 'M-Pesa', type: 'MOBILE_MONEY', sortOrder: 1, brand: /^ohis/i, notes: '0766 790 794 · CASMIRY CHUWA · OHIS payments' },
  { name: 'Airtel Money', type: 'MOBILE_MONEY', sortOrder: 2, brand: /^civ/i, notes: '0788 734 003 · CASMIRY CHUWA · Civlily payments' },
  { name: COMMISSION_ACCOUNT_NAME, type: COMMISSION_TYPE, sortOrder: 90, notes: COMMISSION_ACCOUNT_NOTES },
];
const DEFAULT_CATEGORIES = [
  'Stock Purchase', 'Shipping', 'Freight', 'Customs', 'Warehouse', 'Transport',
  'Fuel', 'Marketing', 'Packaging', 'Salaries', 'Commission Payments', 'Internet',
  'Office Expenses', 'Utilities', 'Miscellaneous',
];

let ensured = false;
// Seed the default accounts + expense categories once (idempotent).
async function ensureDefaults() {
  if (ensured) return;
  if ((await prisma.businessAccount.count()) === 0) {
    const brands = await prisma.brand.findMany({ select: { id: true, name: true } });
    for (const a of DEFAULT_ACCOUNTS) {
      const brand = a.brand ? brands.find((b) => a.brand.test(b.name)) : null;
      await prisma.businessAccount.create({
        data: {
          name: a.name, type: a.type, brandId: brand ? brand.id : null,
          isDefault: false, sortOrder: a.sortOrder, notes: a.notes || null,
        },
      });
    }
  }
  if ((await prisma.expenseCategory.count()) === 0) {
    await prisma.expenseCategory.createMany({ data: DEFAULT_CATEGORIES.map((name) => ({ name, isDefault: true })), skipDuplicates: true });
  }
  ensured = true;
}

// Delegates to resolveRange so every window is the BUSINESS's day (EAT), not
// the server's. This function used dayjs() directly, which on Vercel (UTC)
// shifted every boundary three hours — the first sales of each Tanzanian
// morning were landing in the previous day, week and month.
function periodRange(period) {
  if (!period || period === 'all') return null; // all time
  return resolveRange({ period });
}

// --- Accounts --------------------------------------------------------------

// `client` and `accountId` let a balance correction read ONE account's balance inside its own transaction,
// by the very same formula every screen shows (recordBalanceCorrection). Called bare, it lists them all.
// `asOf` (a Date) gives what each account held at that moment, by the same formula with only the movements
// up to then: a report PDF states the balances at the END of its period, not when it was built (audit
// repo07, 15 Nov 2026). Without it nothing changes.
async function accountBalances({ client = prisma, accountId = null, asOf = null } = {}) {
  await ensureDefaults();
  // Balances = opening + post-epoch movements. Pre-epoch ledger rows are audit
  // history only; the accounts' openingBalance IS the truth at the epoch.
  const epoch = await reports.financeEpoch();
  const window = epoch || asOf ? { occurredAt: { ...(epoch ? { gte: epoch } : {}), ...(asOf ? { lte: asOf } : {}) } } : {};
  const one = accountId ? { accountId } : {};
  const [accounts, grouped, offAccount] = await Promise.all([
    client.businessAccount.findMany({
      where: { isActive: true, ...(accountId ? { id: accountId } : {}) },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    }),
    client.financeTransaction.groupBy({
      by: ['accountId', 'direction'],
      where: { ...window, ...one },
      _sum: { amount: true },
    }),
    // The same rows again, narrowed to the ones that never touched an account
    // (see OFF_ACCOUNT_WHERE). Taken back off below, so a rep payout leaves the
    // record in the ledger and the balance where it was. Subtracting a second
    // whole population beats filtering the first: no NULL semantics involved.
    client.financeTransaction.groupBy({
      by: ['accountId', 'direction'],
      where: { ...window, ...one, ...OFF_ACCOUNT_WHERE },
      _sum: { amount: true },
    }),
  ]);
  const inMap = new Map();
  const outMap = new Map();
  grouped.forEach((g) => (g.direction === 'IN' ? inMap : outMap).set(g.accountId, toNumber(g._sum.amount)));
  const offInMap = new Map();
  const offOutMap = new Map();
  offAccount.forEach((g) => (g.direction === 'IN' ? offInMap : offOutMap).set(g.accountId, toNumber(g._sum.amount)));
  return accounts.map((a) => {
    const moneyIn = round2((inMap.get(a.id) || 0) - (offInMap.get(a.id) || 0));
    const moneyOut = round2((outMap.get(a.id) || 0) - (offOutMap.get(a.id) || 0));
    const opening = toNumber(a.openingBalance);
    return {
      id: a.id, name: a.name, type: a.type, currency: a.currency, isDefault: a.isDefault, notes: a.notes,
      brandId: a.brandId || null,
      openingBalance: opening, moneyIn, moneyOut, balance: round2(opening + moneyIn - moneyOut),
      // A commission account holds nothing — every row filed against it is one
      // the owner paid out of his own hand, and those are subtracted back out
      // above. The number that matters on it is what has been RECORDED there,
      // which is the same population, taken from the other side. Reported as
      // its own field so no screen can print it under the word "balance".
      isCommissionRecord: a.type === COMMISSION_TYPE,
      recorded: round2(offOutMap.get(a.id) || 0),
    };
  });
}

// The last-resort wallet for money that arrives with no brand on it. It can
// never be the commission account (that would put a payout back into a figure
// the owner wants kept apart) and it can never be a cash account (there is no
// cash) — retiring Cash without this guard would have silently re-targeted
// every commission payout at M-Pesa or Airtel.
async function defaultAccount() {
  await ensureDefaults();
  return (
    (await prisma.businessAccount.findFirst({ where: { ...MONEY_ACCOUNT_WHERE, isDefault: true, isActive: true }, orderBy: { createdAt: 'asc' } })) ||
    (await prisma.businessAccount.findFirst({ where: { ...MONEY_ACCOUNT_WHERE, isActive: true }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }))
  );
}

// The one place the record of commission is held. Self-healing: if the account
// is missing it is created, and if someone deactivated it, it comes back —
// because the alternative is a payout falling back onto a wallet, which is the
// one outcome the owner asked to make impossible.
async function commissionAccount() {
  const existing = await prisma.businessAccount.findFirst({
    where: { type: COMMISSION_TYPE },
    orderBy: { createdAt: 'asc' },
  });
  if (existing) {
    if (existing.isActive) return existing;
    return prisma.businessAccount.update({ where: { id: existing.id }, data: { isActive: true } });
  }
  // `name` is unique, so an unrelated account already called "Commission"
  // would collide. Suffix rather than fail: the type is what identifies it.
  for (const name of [COMMISSION_ACCOUNT_NAME, 'Commission record', 'Commission (record)']) {
    const clash = await prisma.businessAccount.findUnique({ where: { name } });
    if (clash) continue;
    return prisma.businessAccount.create({
      data: { name, type: COMMISSION_TYPE, isDefault: false, sortOrder: 90, notes: COMMISSION_ACCOUNT_NOTES },
    });
  }
  return null;
}

// The accounts a rep may settle into for a given brand — and the accounts the
// owner picks from when money moves. One brand, one wallet: an account bound to
// a brand serves only that brand, and an unbound wallet is offered only when
// the brand has none of its own. Cash and the commission account are never in
// the list. This is THE filter behind GET /settlements/payment-accounts; the
// client renders what it returns rather than re-deciding it on its own.
// Whether an account reserved for one brand takes money of `brandId`: its own brand, or a brand that pays into it
// (Pepa pays into Civlily's account, 15 Nov 2026). A general account, or money with no brand, always fits.
async function accountServesBrand(client, accountBrandId, brandId) {
  if (!accountBrandId || !brandId || accountBrandId === brandId) return true;
  const b = await client.brand.findUnique({ where: { id: brandId }, select: { settlesWithBrandId: true } });
  return !!b && b.settlesWithBrandId === accountBrandId;
}

async function paymentAccountsForBrand(brandId) {
  await ensureDefaults();
  // A brand that pays into another brand's account settles there (Pepa → Civlily's Airtel Money).
  if (brandId) {
    const b = await prisma.brand.findUnique({ where: { id: brandId }, select: { settlesWithBrandId: true } });
    if (b?.settlesWithBrandId) brandId = b.settlesWithBrandId;
  }
  const accounts = await prisma.businessAccount.findMany({
    where: { ...MONEY_ACCOUNT_WHERE, isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    select: { id: true, name: true, type: true, notes: true, isDefault: true, brandId: true },
  });
  // No brand named (a mixed-brand counter sale, or a product with no brand):
  // every wallet, because the money has to go somewhere and there is no
  // general wallet any more. Never an empty list — that would leave the till
  // with nowhere to bank.
  if (!brandId) return accounts;
  const own = accounts.filter((a) => a.brandId === brandId);
  return own.length ? own : accounts.filter((a) => !a.brandId);
}

// Where a brand's money lands when nobody chose an account.
// Where a brand's money goes. Falling through to the default for a KNOWN brand
// is how a third brand's takings would quietly land in OHIS's wallet: the
// default is a real money account, so nothing would look wrong until the
// figures were read. A brand with no account of its own returns null, and the
// caller has to say so out loud instead.
async function settlementAccountFor(brandId) {
  const [first] = await paymentAccountsForBrand(brandId);
  if (first) return first;
  return brandId ? null : defaultAccount();
}

const NO_NEGATIVE_OPENING = 'An account cannot hold less than zero. Type what it really holds today.';

async function createAccount(data) {
  const name = (data.name || '').trim();
  if (!name) throw ApiError.badRequest('Account name is required');
  // One commission account, or the record stops being "held in one place".
  if (data.type === COMMISSION_TYPE) {
    throw ApiError.badRequest('There is already one Commission account, and the record of every payout is held there.');
  }
  if (data.type === 'CASH') {
    throw ApiError.badRequest('The business does not hold money in cash. Add the bank or mobile-money account the money actually sits in.');
  }
  // No account holds less than nothing (audit fina04), the rule Correct balance keeps.
  const opening = round2(toNumber(data.openingBalance));
  if (opening < 0) throw ApiError.badRequest(NO_NEGATIVE_OPENING);
  if (data.brandId) {
    const taken = await prisma.businessAccount.findFirst({ where: { brandId: data.brandId, isActive: true } });
    if (taken) throw ApiError.badRequest(`${taken.name} is already this brand's settlement account. A brand settles to one account, so reps see one option.`);
  }
  const max = await prisma.businessAccount.aggregate({ _max: { sortOrder: true } });
  return prisma.businessAccount.create({
    data: {
      name,
      type: data.type || 'OTHER',
      brandId: data.brandId || null,
      openingBalance: opening,
      notes: data.notes || null,
      sortOrder: (max._max.sortOrder || 0) + 1,
    },
  });
}

async function updateAccount(id, data) {
  const existing = await prisma.businessAccount.findUnique({ where: { id } });
  if (!existing) throw ApiError.notFound('Account not found');
  if (data.openingBalance !== undefined && round2(toNumber(data.openingBalance)) < 0) throw ApiError.badRequest(NO_NEGATIVE_OPENING);
  // Changing the opening of an account that has moved money rewrites its whole history without a trace
  // (15 Nov 2026). A real difference is recorded with Correct balance, which says why and who.
  if (data.openingBalance !== undefined && round2(toNumber(data.openingBalance)) !== round2(toNumber(existing.openingBalance))
    && (await prisma.financeTransaction.count({ where: { accountId: id } }))) {
    throw ApiError.badRequest(`${existing.name} already has money recorded through it, so its opening balance is fixed. Use Correct balance — it records the difference and why.`);
  }
  if (existing.type === COMMISSION_TYPE) {
    if (data.type !== undefined && data.type !== COMMISSION_TYPE) {
      throw ApiError.badRequest('This is the Commission account. Changing its type would put rep payouts back onto a wallet.');
    }
    if (data.isActive === false) {
      throw ApiError.badRequest('The Commission account cannot be closed — it is where the record of every payout is kept.');
    }
  } else if (data.type === COMMISSION_TYPE) {
    throw ApiError.badRequest('Only the Commission account can be of that type.');
  }
  // A brand settles to one active account, the rule createAccount keeps (audit money-flows-9): tagging a
  // second account to a brand, or switching a second one back on, gave reps a choice of where to pay.
  const brandAfter = data.brandId !== undefined ? (data.brandId || null) : existing.brandId;
  const activeAfter = data.isActive !== undefined ? Boolean(data.isActive) : existing.isActive;
  if (brandAfter && activeAfter && (brandAfter !== existing.brandId || !existing.isActive)) {
    const taken = await prisma.businessAccount.findFirst({ where: { brandId: brandAfter, isActive: true, id: { not: id } } });
    if (taken) throw ApiError.badRequest(`${taken.name} is already this brand's settlement account. A brand settles to one account, so reps see one option.`);
  }
  const patch = {};
  ['name', 'type', 'notes'].forEach((k) => { if (data[k] !== undefined) patch[k] = data[k]; });
  if (data.brandId !== undefined) patch.brandId = data.brandId || null;
  if (data.openingBalance !== undefined) patch.openingBalance = round2(toNumber(data.openingBalance));
  if (data.isActive !== undefined) patch.isActive = data.isActive;
  // Switching off an account that still holds money took that money out of every total with no ledger row
  // (audit fina05 / perm04). It is switched off only once it holds nothing: the account row is locked, so a
  // payment out of it cannot land between the check and the switch.
  if (data.isActive === false && existing.isActive) {
    return prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "business_accounts" WHERE id = ${id} FOR UPDATE`;
      const [acc] = await accountBalances({ client: tx, accountId: id });
      if (acc && Math.abs(acc.balance) >= 0.01) {
        throw ApiError.badRequest(
          `${existing.name} still holds ${formatCurrency(acc.balance)}. Move the money out with a transfer first (or Correct balance if the figure is wrong), then switch it off.`,
        );
      }
      return { updated: await tx.businessAccount.update({ where: { id }, data: patch }), previous: existing };
    });
  }
  return { updated: await prisma.businessAccount.update({ where: { id }, data: patch }), previous: existing };
}

// --- Historical backfill -----------------------------------------------------
// Rebuild the finance ledger from the REAL business records that already exist:
// every settled sale and direct warehouse CASH sale becomes an IN transaction
// (dated when the money actually arrived), every PAID commission withdrawal an
// OUT. Idempotent — keyed by refId — so it never double-counts and self-heals
// if an auto-post hook was ever missed. No fake data: only derived records.
async function backfillFromHistory() {
  await ensureDefaults();
  const acc = await defaultAccount();
  if (!acc) return { incomeCreated: 0, paymentsCreated: 0 };
  // Sale money goes to the wallet its brand settles to; only a sale whose brand
  // cannot be determined falls back. Rebuilding every row into "the default"
  // is how 501,000 of settlement money ended up filed under Cash.
  const accountForBrand = new Map();
  const walletFor = async (brandId) => {
    if (!brandId) return acc;
    if (!accountForBrand.has(brandId)) accountForBrand.set(brandId, (await settlementAccountFor(brandId)) || acc);
    return accountForBrand.get(brandId);
  };
  // Only sales from the finance epoch onward create ledger money — pre-epoch
  // activity is history, already represented by the accounts' opening balances.
  const epoch = await reports.financeEpoch();

  // Money in: settlement-linked sales (settled boxes = cash received) and
  // direct warehouse CASH sales (no rep).
  const [sales, existingSaleTxns] = await Promise.all([
    prisma.sale.findMany({
      where: {
        status: { not: 'CANCELLED' },
        type: 'CASH',
        OR: [{ settlementId: { not: null } }, { salesRepId: null }],
        ...(epoch ? { soldAt: { gte: epoch } } : {}),
      },
      select: {
        id: true, saleNumber: true, total: true, amountPaid: true, soldAt: true, settlementId: true,
        salesRep: { select: { user: { select: { name: true } } } },
      },
      orderBy: { soldAt: 'asc' },
    }),
    // A sale with any money row — its takings, a payment collected later, money handed back — is covered: its
    // money is already in the ledger and is never booked again from the sale (15 Nov 2026).
    prisma.financeTransaction.findMany({ where: { refType: { in: ['Sale', 'SalePayment', 'SaleRefund'] } }, select: { refId: true } }),
  ]);
  const have = new Set(existingSaleTxns.map((t) => t.refId));

  // Which brand each sale belongs to (single-brand sales only; mixed = null).
  const saleIds = sales.map((s) => s.id);
  const saleItems = saleIds.length
    ? await prisma.saleItem.findMany({
        where: { saleId: { in: saleIds } },
        select: { saleId: true, product: { select: { brandId: true } } },
      })
    : [];
  const brandsBySale = new Map();
  for (const it of saleItems) {
    const set = brandsBySale.get(it.saleId) || new Set();
    if (it.product?.brandId) set.add(it.product.brandId);
    brandsBySale.set(it.saleId, set);
  }
  const saleBrand = (saleId) => {
    const set = brandsBySale.get(saleId);
    return set && set.size === 1 ? [...set][0] : null;
  };

  let incomeCreated = 0;
  for (const s of sales) {
    if (have.has(s.id)) continue;
    const fromSettlement = !!s.settlementId;
    // A settled order's sale is money the rep handed over (its total). A counter sale banks what reached
    // the till, the same figure recordSaleIncome posts when it is made: the total used to be backfilled
    // here, so an unpaid counter sale showed money in that nobody handed over (12 Nov 2026).
    const amount = round2(toNumber(fromSettlement ? s.total : s.amountPaid));
    if (!(amount > 0)) continue;
    const txnNumber = await nextDocNumber(prisma.financeTransaction, 'txnNumber', 'FTX');
    const wallet = await walletFor(saleBrand(s.id));
    await prisma.financeTransaction.create({
      data: {
        txnNumber,
        accountId: wallet.id,
        direction: 'IN',
        type: fromSettlement ? 'SETTLEMENT' : 'WAREHOUSE_SALE',
        amount,
        brandId: saleBrand(s.id),
        category: fromSettlement ? 'Settlement received' : 'Warehouse sale',
        description: fromSettlement
          ? `Settlement received${s.salesRep?.user?.name ? ` — ${s.salesRep.user.name}` : ''}`
          : 'Direct warehouse sale',
        reference: s.saleNumber,
        refType: 'Sale',
        refId: s.id,
        occurredAt: s.soldAt,
      },
    });
    incomeCreated++;
  }

  // Retro-tag brand on sale-income rows created before the brand dimension
  // existed (idempotent — only touches rows still missing a brand).
  const untagged = await prisma.financeTransaction.findMany({
    where: { refType: 'Sale', brandId: null, refId: { in: saleIds } },
    select: { id: true, refId: true },
  });
  let brandTagged = 0;
  for (const t of untagged) {
    const b = saleBrand(t.refId);
    if (!b) continue;
    await prisma.financeTransaction.update({ where: { id: t.id }, data: { brandId: b } });
    brandTagged++;
  }

  // Money out: commission withdrawals PAID from the epoch onward.
  const [paidWithdrawals, existingWTxns] = await Promise.all([
    prisma.commissionWithdrawal.findMany({
      where: { status: 'PAID', ...(epoch ? { OR: [{ paidAt: { gte: epoch } }, { paidAt: null, decidedAt: { gte: epoch } }] } : {}) },
      include: { salesRep: { include: { user: { select: { name: true } } } } },
    }),
    prisma.financeTransaction.findMany({ where: { refType: 'CommissionWithdrawal' }, select: { refId: true } }),
  ]);
  const haveW = new Set(existingWTxns.map((t) => t.refId));
  let paymentsCreated = 0;
  // The record of every payout is held in one place — never rebuilt onto a
  // wallet, which is what the owner asked to make impossible.
  const commAcc = paidWithdrawals.length ? await commissionAccount() : null;
  for (const w of paidWithdrawals) {
    if (haveW.has(w.id)) continue;
    if (!commAcc) break;
    // Checked again under the withdrawal's lock: the admin's own write (or another rebuild) may have
    // landed since `haveW` was read (audit backend-integrity-1).
    const { created } = await writePayoutRowOnce(w.id, async (tx) => {
      const txnNumber = await nextDocNumber(tx.financeTransaction, 'txnNumber', 'FTX');
      return tx.financeTransaction.create({
        data: {
          txnNumber,
          accountId: commAcc.id,
          direction: 'OUT',
          type: 'COMMISSION_PAYMENT',
          amount: round2(toNumber(w.amount)),
          ...payoutWords(w.source, w.salesRep?.user?.name),
          refType: 'CommissionWithdrawal',
          refId: w.id,
          occurredAt: w.paidAt || w.decidedAt || w.createdAt,
        },
      });
    }).catch(() => ({ created: false }));
    if (created) paymentsCreated++;
  }

  return { incomeCreated, paymentsCreated, brandTagged };
}

// The self-heal the Finance screens run before they read. The Finance page asks for the overview and the
// cash flow at the same moment, and each used to start its own pass over the whole sales history at the
// same time (twice the work, and two passes could both see the same missing row and both add it). Callers
// that arrive while a pass is running now wait for that pass; the next request after it ends starts a new
// one, so a missed row is still picked up on the very next read. The explicit rebuild endpoint keeps
// calling backfillFromHistory() itself.
let backfillInFlight = null;
function backfillShared() {
  if (!backfillInFlight) {
    backfillInFlight = backfillFromHistory().finally(() => { backfillInFlight = null; });
  }
  return backfillInFlight;
}

// Does the self-heal have anything to do? One statement, answered inside the database (15 Nov 2026).
// The pass above reads the whole sales history into the server (every CASH sale since the epoch, every
// sale ledger row, those sales' items, every paid withdrawal) before Finance and Home can answer, and on
// almost every read it finds nothing. This asks the same three questions the pass acts on, with the same
// conditions, without moving the rows:
//   missingIncome  — a settled-order or counter sale since the epoch with money in and no ledger row;
//   untaggedIncome — a sale ledger row with no brand whose sale is all one brand (the pass tags those);
//   missingPayout  — a PAID withdrawal since the epoch with no ledger row.
// The epoch is compared as UTC wall time, the way Prisma stores DateTime, whatever the session time zone.
// `db` lets a test ask inside a transaction it rolls back.
async function ledgerGaps(db = prisma) {
  const epoch = await reports.financeEpoch();
  const at = epoch ? epoch.toISOString() : null;
  const saleSince = at ? Prisma.sql`AND s."soldAt" >= (${at}::timestamptz AT TIME ZONE 'UTC')` : Prisma.empty;
  const paidSince = at
    ? Prisma.sql`AND (w."paidAt" >= (${at}::timestamptz AT TIME ZONE 'UTC') OR (w."paidAt" IS NULL AND w."decidedAt" >= (${at}::timestamptz AT TIME ZONE 'UTC')))`
    : Prisma.empty;
  const rows = await db.$queryRaw`
    SELECT
      EXISTS (
        SELECT 1 FROM "sales" s
        WHERE s."status" <> 'CANCELLED' AND s."type" = 'CASH'
          AND (s."settlementId" IS NOT NULL OR s."salesRepId" IS NULL) ${saleSince}
          AND ROUND(CASE WHEN s."settlementId" IS NOT NULL THEN s."total" ELSE s."amountPaid" END, 2) > 0
          AND NOT EXISTS (SELECT 1 FROM "finance_transactions" f WHERE f."refType" = 'Sale' AND f."refId" = s."id")
      ) AS "missingIncome",
      EXISTS (
        SELECT 1 FROM "finance_transactions" f JOIN "sales" s ON s."id" = f."refId"
        WHERE f."refType" = 'Sale' AND f."brandId" IS NULL
          AND s."status" <> 'CANCELLED' AND s."type" = 'CASH'
          AND (s."settlementId" IS NOT NULL OR s."salesRepId" IS NULL) ${saleSince}
          AND (SELECT COUNT(DISTINCT p."brandId") FROM "sale_items" si JOIN "products" p ON p."id" = si."productId"
               WHERE si."saleId" = s."id" AND p."brandId" IS NOT NULL) = 1
      ) AS "untaggedIncome",
      EXISTS (
        SELECT 1 FROM "commission_withdrawals" w
        WHERE w."status" = 'PAID' ${paidSince}
          AND NOT EXISTS (SELECT 1 FROM "finance_transactions" f WHERE f."refType" = 'CommissionWithdrawal' AND f."refId" = w."id")
      ) AS "missingPayout"`;
  const r = rows && rows[0];
  return { missingIncome: Boolean(r && r.missingIncome), untaggedIncome: Boolean(r && r.untaggedIncome), missingPayout: Boolean(r && r.missingPayout) };
}

// What Finance and Home run before they read: the full self-heal only when the check above finds a gap,
// so a missed ledger row is still picked up on the very next read, exactly as before. If the check
// itself cannot run, the full pass runs, as it always did.
async function healLedgerOnRead() {
  let gaps = null;
  try {
    gaps = await ledgerGaps();
  } catch {
    gaps = null;
  }
  if (gaps && !gaps.missingIncome && !gaps.untaggedIncome && !gaps.missingPayout) return { skipped: true };
  return backfillShared();
}

// --- Transactions ----------------------------------------------------------

// A date-only value ("2026-07-05") is a day in TANZANIA (audit #62). It was read as a UTC day plus the
// UTC time of day, so a "today" picked between 00:00 and 03:00 EAT landed on tomorrow, and the form's
// own UTC default offered yesterday. These turn a day + a time of day on the business's clock into the
// real instant, and back.
const DAY_MS = 86_400_000;
const EAT_MS = EAT_OFFSET_H * 3_600_000;
const eatTimeOfDay = (d) => (((new Date(d).getTime() + EAT_MS) % DAY_MS) + DAY_MS) % DAY_MS;
const eatDateOf = (d) => new Date(new Date(d).getTime() + EAT_MS).toISOString().slice(0, 10);
const eatDayAt = (day, timeOfDay) => new Date(Date.parse(`${day}T00:00:00Z`) - EAT_MS + timeOfDay);

// A date-only value parsed to midnight would sort BEFORE same-day transactions
// (and before the finance epoch on go-live day), silently excluding it from
// balances. So it is anchored to the current time of day — Tanzania's — on
// the day picked: picking today means now.
function resolveOccurredAt(v) {
  if (!v) return new Date();
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return eatDayAt(s, eatTimeOfDay(Date.now()));
  return new Date(v);
}

// The last moment of today in Dar es Salaam.
const endOfTodayEat = () => eatDayAt(eatDateOf(Date.now()), DAY_MS - 1);

// The date a person gives money is kept between the day the books started and the end of today in Dar es Salaam
// (audit perm00 / fina01, 15 Nov 2026). Before go-live a row is in no balance and can never be reversed, so an
// account could pay out more than it held and a supplier's bill could fall with no money leaving; a day after
// today comes off the balance now but lands in a later month's cash flow. A day picked on go-live day itself
// counts from the moment the books started.
async function bookDate(v) {
  const when = resolveOccurredAt(v);
  if (Number.isNaN(when.getTime())) throw ApiError.badRequest('That date cannot be read. Pick a day like 2026-11-15.');
  if (when > endOfTodayEat()) {
    throw ApiError.badRequest(`Money cannot be dated after today (${eatDateOf(Date.now())}). Record it on the day it really moves.`);
  }
  const epoch = await reports.financeEpoch();
  if (epoch && when < epoch) {
    if (String(v) === eatDateOf(epoch)) return new Date(epoch);
    throw ApiError.badRequest(
      `The books start on ${eatDateOf(epoch)}. Money from before that day is already in the opening balances, so pick a date from ${eatDateOf(epoch)} to today.`,
    );
  }
  return when;
}

// `client` lets a caller record the money INSIDE its own transaction — a stock
// purchase paid in cash at the counter is one event, and a purchase that saved
// while its payment did not is the bug this prevents.
// `checkBrand` is for the hand-typed entries, where a person picks the account
// and the brand separately (#79).
// `anyDate` is only for money the app records by itself from another record (a sale's money in, an old pocket
// payout record): that row takes the date of what it mirrors, and refusing it would lose the money's record.
// Every date a person gives is kept inside the books (bookDate).
async function recordTransaction(data, actor, client = prisma, { checkBrand = false, anyDate = false } = {}) {
  const amount = round2(toNumber(data.amount));
  if (!(amount > 0)) throw ApiError.badRequest('Amount must be greater than zero');
  // Bigger than the money column holds: a clean refusal, not a 500 with the database's error text.
  if (amount > DB_MAX_AMOUNT) throw ApiError.badRequest('That amount is too large — check the number of zeros');
  const occurredAt = anyDate ? resolveOccurredAt(data.occurredAt) : await bookDate(data.occurredAt);
  // Said plainly: without it Prisma answered "Invalid database query".
  if (!data.accountId) throw ApiError.badRequest('Choose the account the money moved through');
  const account = await client.businessAccount.findUnique({ where: { id: data.accountId } });
  if (!account || !account.isActive) throw ApiError.badRequest('Select a valid account');
  // The commission account holds the record of rep payouts and nothing else.
  // An expense, an income or the owner's own money filed there would print a
  // figure under "recorded" that was never commission.
  if (account.type === COMMISSION_TYPE && data.type !== 'COMMISSION_PAYMENT') {
    throw ApiError.badRequest('The Commission account only holds the record of rep commission. Choose the account the money actually moved through.');
  }
  // A brand-reserved account only holds its own brand's money — the rule a
  // correction already obeys (updateTransaction). A new entry skipped it, so
  // M-Pesa could be handed a Civlily expense that could then never be corrected.
  if (checkBrand && !(await accountServesBrand(client, account.brandId, data.brandId))) {
    throw ApiError.badRequest(`${account.name} is reserved for another brand's payments`);
  }
  // One entry per press of a form (15 Nov 2026): a double tap, or a retry after a lost answer, finds the first
  // one and records nothing more. The unique column stops two presses racing each other.
  if (data.clientKey) {
    const seen = await client.financeTransaction.findUnique({ where: { clientKey: data.clientKey }, select: { txnNumber: true } });
    if (seen) throw ApiError.conflict(`Already recorded as ${seen.txnNumber} — your first press went through.`);
  }
  const txnNumber = await nextDocNumber(client.financeTransaction, 'txnNumber', 'FTX');
  return client.financeTransaction.create({
    data: {
      txnNumber,
      clientKey: data.clientKey || null,
      accountId: data.accountId,
      direction: data.direction,
      type: data.type || (data.direction === 'IN' ? 'INCOME' : 'EXPENSE'),
      amount,
      brandId: data.brandId || null,
      category: data.category || null,
      description: data.description || null,
      reference: data.reference || null,
      refType: data.refType || null,
      refId: data.refId || null,
      receiptUrl: data.receiptUrl || null,
      notes: data.notes || null,
      occurredAt,
      createdById: actor ? actor.id : null,
    },
  });
}

// ── Business money only (15 Nov 2026) ──────────────────────────────────────────
// Every payment comes out of a recorded business account, and never more than it holds: no account may go
// below zero. The account row is locked (FOR UPDATE) and its balance read inside the same transaction, by the
// formula every screen shows, so two payments at once queue up instead of both spending the same shillings.
// Personal money is put in first ("Put my money in"), then paid out like any other.
async function assertFunds(tx, accountId, amount, what = 'this payment') {
  if (!accountId) throw ApiError.badRequest('Choose the account the money is paid from.');
  // $queryRaw, not $executeRaw: it returns the locked row, which also says whether the account exists.
  const locked = await tx.$queryRaw`SELECT id FROM "business_accounts" WHERE id = ${accountId} FOR UPDATE`;
  if (!locked.length) throw ApiError.badRequest('Select a valid account');
  const [acc] = await accountBalances({ client: tx, accountId });
  if (!acc) throw ApiError.badRequest('Select a valid account');
  if (acc.isCommissionRecord) {
    throw ApiError.badRequest(`${acc.name} is a record of past payouts, not a wallet — pay from one of the business accounts that holds money.`);
  }
  const amt = round2(toNumber(amount));
  if (acc.balance < amt - 0.001) {
    throw ApiError.badRequest(
      `Not enough money in ${acc.name}: it holds ${formatCurrency(acc.balance)} and ${what} needs ${formatCurrency(amt)}, `
      + `so ${formatCurrency(round2(amt - acc.balance))} is missing. If you are paying with your own money, record it first with Put my money in, or pay from another account.`,
      { code: 'NOT_ENOUGH_MONEY', balance: acc.balance, needed: amt },
    );
  }
  return acc;
}

// The old Correct balance body ({ direction, amount }, still accepted): out only if the account holds it.
const recordPlainAdjustment = (data, actor) => (data.direction === 'OUT'
  ? spend(data, actor, { checkBrand: true }, 'this correction')
  : withDocNumberRetry(() => recordTransaction(data, actor, prisma, { checkBrand: true })));

// A repeat press of the same form, recognised under the account's lock — before the balance is judged, so a
// double tap is told "already recorded", never "not enough money" because the first press spent it.
async function assertNotRecorded(tx, accountId, clientKey) {
  if (!clientKey || !accountId) return;
  await tx.$queryRaw`SELECT id FROM "business_accounts" WHERE id = ${accountId} FOR UPDATE`;
  const seen = await tx.financeTransaction.findUnique({ where: { clientKey }, select: { txnNumber: true } });
  if (seen) throw ApiError.conflict(`Already recorded as ${seen.txnNumber} — your first press went through.`);
}

// A money-out entry written only if its account can pay it, in one transaction.
const spend = (data, actor, opts = {}, what) => withDocNumberRetry(() => prisma.$transaction(async (tx) => {
  await assertNotRecorded(tx, data.accountId, data.clientKey);
  await assertFunds(tx, data.accountId, data.amount, what);
  return recordTransaction(data, actor, tx, opts);
}));

// A rep's commission or bonus withdrawal paid from a business account (15 Nov 2026 — it used to be the owner's
// pocket, recorded off every account). Called inside the withdrawal's own transaction, after the withdrawal is
// locked and claimed, so the payment and PAID land together or not at all. A business expense: it comes off the
// account and off profit; "Commission Payments" / "Bonus Payments" say which. Never twice: one row per withdrawal.
async function recordPayoutFromAccount(tx, w, { accountId, occurredAt, who }, actor) {
  const already = await tx.financeTransaction.findFirst({ where: { refType: 'CommissionWithdrawal', refId: w.id }, select: { txnNumber: true } });
  if (already) throw ApiError.conflict(`This withdrawal is already paid (${already.txnNumber}).`);
  const amount = round2(toNumber(w.amount));
  await assertFunds(tx, accountId, amount, `this ${w.source === 'BONUS' ? 'bonus' : 'commission'} payment`);
  return recordTransaction(
    {
      accountId,
      direction: 'OUT',
      type: 'EXPENSE',
      amount,
      ...payoutWords(w.source, who),
      refType: 'CommissionWithdrawal',
      refId: w.id,
      occurredAt,
    },
    actor,
    tx,
  );
}

// Money spent on stock is not a P&L expense — the cost of those boxes reaches
// profit as COGS when they sell. Recording it as EXPENSE charged the business
// twice (once here, once in COGS): OHIS's stock buys went through this flow
// and pushed its brand net TSh 3.3M below the truth. The category the user
// picks still shows on the row; only the P&L treatment changes.
const isStockPurchaseCategory = (c) => /stock\s*purchase/i.test(String(c || ''));
// A hand-typed entry is never tied to a sale, an order, a supplier or a payout
// (#79): those links decide where a row counts, and only the server makes them.
// A form's "+ New category…" choice is not a category (audit money-flows-6): an expense was saved and
// listed under "__new". Such placeholders start with two underscores; no real category name does.
function assertRealCategory(category) {
  if (category != null && /^__/.test(String(category).trim())) {
    throw ApiError.badRequest('Type a name for the new category, or pick one from the list.');
  }
}
const handTyped = ({ refType, refId, ...data }) => { // eslint-disable-line no-unused-vars
  assertRealCategory(data.category);
  return data;
};
const HAND_TYPED = { checkBrand: true };

// The owner's own money. A contribution is his personal cash entering the
// business (he pays rep commissions this way); a drawing is profit he takes
// out. Neither is trade: excluded from revenue, profit, and money in/out.
const recordOwnerMoney = ({ direction, ...data }, actor) => {
  const row = {
    ...handTyped(data),
    direction,
    type: direction === 'IN' ? 'OWNER_CONTRIBUTION' : 'OWNER_DRAWING',
    category: direction === 'IN' ? 'Owner contribution' : 'Owner drawing',
  };
  // Taking profit out can only take what the account holds; putting money in needs no check.
  return direction === 'OUT' ? spend(row, actor, HAND_TYPED, 'taking this out') : withDocNumberRetry(() => recordTransaction(row, actor, prisma, HAND_TYPED));
};

// "Correct balance": the owner says what an account really holds, and the server writes the difference
// from the balance as it is NOW, not from a figure the browser worked out earlier (audit freshness-1).
// The browser used to send the difference itself, so anything that landed between its last read and
// the write (a settlement approved, a payout, a second admin's correction) left the account at a figure
// nobody typed. Here the account row is locked (FOR UPDATE, so two corrections queue up instead of both
// reading the same balance), its balance is read by the same formula the screens use, and:
//   expectedBalance — the balance the window showed; if the account no longer holds it, nothing is
//                     written (409 with the new balance) and the owner checks again;
//   targetBalance   — what it really holds; the ADJUSTMENT is target − live, and none at all if that is 0.
// The old body ({ direction, amount }) still goes through recordTransaction as before.
async function recordBalanceCorrection({ accountId, targetBalance, expectedBalance, brandId, description, notes, occurredAt }, actor) {
  const target = round2(toNumber(targetBalance));
  if (!Number.isFinite(target)) throw ApiError.badRequest('Type what the account really holds');
  if (!accountId) throw ApiError.badRequest('Choose the account the money moved through');
  return withDocNumberRetry(() => prisma.$transaction(async (tx) => {
    // $queryRaw, not $executeRaw: it returns the locked row, which also says whether the account exists.
    const locked = await tx.$queryRaw`SELECT id FROM "business_accounts" WHERE id = ${accountId} FOR UPDATE`;
    if (!locked.length) throw ApiError.badRequest('Select a valid account');
    const [acc] = await accountBalances({ client: tx, accountId });
    if (!acc) throw ApiError.badRequest('Select a valid account');
    const live = acc.balance;
    if (expectedBalance != null && Math.abs(round2(toNumber(expectedBalance)) - live) >= 0.01) {
      throw ApiError.conflict(
        `${acc.name} changed to ${formatCurrency(live)} since you opened this window — nothing was recorded. Check what it really holds now.`,
        { code: 'BALANCE_MOVED', balance: live },
      );
    }
    const delta = round2(target - live);
    if (delta === 0) throw ApiError.badRequest(`${acc.name} already holds ${formatCurrency(live)} — nothing to record`);
    // No account holds less than nothing (15 Nov 2026).
    if (target < 0) throw ApiError.badRequest('An account cannot hold less than zero. Type what it really holds today.');
    return recordTransaction(
      {
        accountId,
        direction: delta > 0 ? 'IN' : 'OUT',
        type: 'ADJUSTMENT',
        amount: Math.abs(delta),
        brandId: brandId || null,
        category: 'Manual adjustment',
        description: description || 'Manual balance adjustment',
        notes: notes || `Corrected from ${formatCurrency(live)} to ${formatCurrency(target)}.`,
        occurredAt,
      },
      actor,
      tx,
      { checkBrand: true }, // a brand-reserved account only takes its own brand's money (#79)
    );
  }));
}

const recordExpense = async (data, actor) => {
  if (!String(data.description || '').trim()) throw ApiError.badRequest('Say what the money was spent on.');
  if (!String(data.category || '').trim()) throw ApiError.badRequest('Choose a category for this expense.');
  return spend({
    ...handTyped(data),
    direction: 'OUT',
    type: isStockPurchaseCategory(data.category) ? 'STOCK_PURCHASE' : 'EXPENSE',
  }, actor, HAND_TYPED, 'this expense');
};
const recordIncome = (data, actor) => withDocNumberRetry(() => recordTransaction({ ...handTyped(data), direction: 'IN', type: 'INCOME' }, actor, prisma, HAND_TYPED));

// Automatic money-in for a completed cash sale (settlement or direct warehouse).
// `accountId` = the payment account the money actually went to (rep's choice on
// submission); falls back to the default (Cash). `brandId` tags whose money it
// is. Best-effort — never throws into the sale/settlement flow.
async function recordSaleIncome({ saleId, saleNumber, amount, fromSettlement, who, occurredAt, accountId, brandId }, actor) {
  try {
    const amt = round2(toNumber(amount));
    if (!(amt > 0)) return null;
    // The rep's chosen account, then the wallet this brand settles to, then
    // the last-resort default. A commission account is never a landing place
    // for sale money, whoever named it.
    let account = null;
    if (accountId) {
      account = await prisma.businessAccount.findFirst({
        where: { id: accountId, isActive: true, ...MONEY_ACCOUNT_WHERE },
      });
    }
    if (!account) account = await settlementAccountFor(brandId || null);
    if (!account) return null;
    return await recordTransaction(
      {
        accountId: account.id,
        direction: 'IN',
        type: fromSettlement ? 'SETTLEMENT' : 'WAREHOUSE_SALE',
        amount: amt,
        brandId: brandId || null,
        category: fromSettlement ? 'Settlement received' : 'Warehouse sale',
        description: fromSettlement ? `Settlement received${who ? ` — ${who}` : ''}` : 'Direct warehouse sale',
        reference: saleNumber || null,
        refType: 'Sale',
        refId: saleId || null,
        occurredAt,
      },
      actor,
      prisma,
      { anyDate: true }, // dated as the sale it mirrors
    );
  } catch (e) {
    return null;
  }
}

// How a paid withdrawal reads in the ledger. A BONUS withdrawal (14 Nov 2026) is the same kind of row as a
// commission payout — type COMMISSION_PAYMENT, on the commission account, off every balance and out of money
// in/out — named for what it was.
function payoutWords(source, who) {
  const bonus = source === 'BONUS';
  return {
    category: bonus ? 'Bonus Payments' : 'Commission Payments',
    description: `${bonus ? 'Bonus' : 'Commission'} paid${who ? ` — ${who}` : ''}`,
  };
}

// Automatic money-out when a commission withdrawal is paid.
// Write a payout's ledger row at most once. The withdrawal row is locked first (FOR UPDATE), then the
// check for an existing COMMISSION_PAYMENT row and the write run in the same transaction. Approve & pay
// and a Finance page read (the self-heal rebuild) used to both see "missing" in the same few
// milliseconds and both write, so one 20,000 payout was booked twice and "Paid reps from your pocket"
// went up by 20,000 for good (audit backend-integrity-1). No schema change: the lock serialises them,
// so the second one finds the first one's row and writes nothing. Returns { row, created }.
async function writePayoutRowOnce(withdrawalId, makeData) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "commission_withdrawals" WHERE id = ${withdrawalId} FOR UPDATE`;
    // Any row for this withdrawal — a pocket record (COMMISSION_PAYMENT) or an account payout (EXPENSE).
    const existing = await tx.financeTransaction.findFirst({
      where: { refType: 'CommissionWithdrawal', refId: withdrawalId },
    });
    if (existing) return { row: existing, created: false };
    const row = await makeData(tx);
    return { row, created: !!row };
  });
}

async function recordCommissionPayment({ amount, who, reference, refId, occurredAt, fromOwnPocket, source }, actor) {
  try {
    const amt = round2(toNumber(amount));
    if (!(amt > 0)) return null;
    // Reps are paid from the owner's own pocket, never from M-Pesa or Airtel.
    // Those are the brands' income accounts and commission has no business
    // touching them. This used to pin the payout to a CASH account and fall
    // back to the DEFAULT one — so retiring Cash would have quietly sent every
    // payout into a brand's wallet. It now targets the commission account and
    // nothing else: if that account cannot be had, no row is written at all,
    // because a payout on the wrong account is worse than a missing record we
    // can rebuild from the withdrawal itself.
    const acc = await commissionAccount();
    if (!acc) return null;
    // One payout, one record (audit #31, 11 Nov 2026): if this withdrawal already has its payment row,
    // return it instead of writing a second one.
    if (refId) {
      const existing = await prisma.financeTransaction.findFirst({
        where: { refType: 'CommissionWithdrawal', refId },
      });
      if (existing) return existing;
    }
    // The owner pays reps directly from his pocket — no business account is
    // involved on either side. This row exists ONLY as the record of what the
    // rep was paid (rule: "i only want the record of rep to be there"). It
    // carries an accountId because the column is required, but no aggregate
    // treats it as account movement: OFF_ACCOUNT_WHERE takes it back out of
    // every balance, and NON_TRADE_TYPES keeps it out of money in/out. What he
    // lays out is an investment the business owes him — see ownerFigures().
    const write = (client) => recordTransaction(
      {
        accountId: acc.id,
        direction: 'OUT',
        type: 'COMMISSION_PAYMENT',
        amount: amt,
        ...payoutWords(source, who),
        reference: reference || null,
        refType: 'CommissionWithdrawal',
        refId: refId || null,
        occurredAt,
      },
      actor,
      client,
      { anyDate: true }, // a record of a payout already made, dated as the withdrawal
    );
    // Tied to a withdrawal: written under that withdrawal's lock, so a rebuild running at the same
    // moment cannot write it a second time.
    if (refId) return (await writePayoutRowOnce(refId, write)).row;
    return await write(prisma);
  } catch (e) {
    return null;
  }
}

async function listTransactions(filters, pagination) {
  const where = {};
  if (filters.accountId) where.accountId = filters.accountId;
  if (filters.direction) where.direction = filters.direction;
  // "Rep commissions" on the Ledger's type list: commission and bonus paid from an account (EXPENSE rows tied to
  // a withdrawal, 15 Nov 2026). It is not a stored type, so it used to answer "Invalid database query".
  if (filters.type === 'REP_COMMISSION') { where.type = 'EXPENSE'; where.refType = 'CommissionWithdrawal'; } else if (filters.type) where.type = filters.type;
  if (filters.category) where.category = filters.category;
  // Free-text search across everything a person might remember about a
  // movement — what it was, its reference, its note.
  if (filters.search && String(filters.search).trim()) {
    const term = String(filters.search).trim();
    where.OR = [
      { description: { contains: term, mode: 'insensitive' } },
      { category: { contains: term, mode: 'insensitive' } },
      { reference: { contains: term, mode: 'insensitive' } },
      { notes: { contains: term, mode: 'insensitive' } },
    ];
  }
  if (filters.brandId) where.brandId = filters.brandId === 'none' ? null : filters.brandId;
  if (filters.from || filters.to) {
    // A day is a Dar es Salaam day (audit backend-integrity-8).
    const bounds = eatDayBounds({ from: filters.from, to: filters.to });
    if (!bounds) throw ApiError.badRequest('Use dates like 2026-11-11 for from and to');
    where.occurredAt = bounds;
  }
  if (filters.minAmount != null || filters.maxAmount != null) {
    where.amount = {};
    if (filters.minAmount != null) where.amount.gte = filters.minAmount;
    if (filters.maxAmount != null) where.amount.lte = filters.maxAmount;
  }
  // Composed with AND, never by spreading: `where` may already carry an `OR`
  // from the free-text search, and a second `OR` key would silently replace it.
  const and = (...parts) => ({ AND: [where, ...parts] });
  // The totals count from the finance epoch, like every balance: rows before it stay in the LIST (audit
  // history) but are not money the accounts hold. Without this an account statement's "came in / went
  // out" did not add up to its "balance now" (Airtel showed -480,000 by the strip, 1,060,000 held).
  const epoch = await reports.financeEpoch();
  const sinceEpoch = epoch ? { occurredAt: { gte: epoch } } : {};
  // Rows that share a date keep one fixed order, so a page and the rows "before" it never overlap.
  const orderBy = [pagination.orderBy, { id: 'desc' }];
  const [items, total, brands, inAgg, outAgg, offInAgg, offOutAgg, byCatRows, newerRows] = await Promise.all([
    prisma.financeTransaction.findMany({
      where,
      include: { account: { select: { name: true, type: true } } },
      skip: pagination.skip,
      take: pagination.take,
      orderBy,
    }),
    prisma.financeTransaction.count({ where }),
    prisma.brand.findMany({ select: { id: true, name: true } }),
    // Totals of the WHOLE filtered view, not the visible page — a strip that
    // changes as you page through it is worse than none.
    prisma.financeTransaction.aggregate({ where: and({ direction: 'IN' }, sinceEpoch), _sum: { amount: true } }),
    prisma.financeTransaction.aggregate({ where: and({ direction: 'OUT' }, sinceEpoch), _sum: { amount: true } }),
    // Rows that moved no account balance — rep commission out of the owner's
    // pocket. The ROWS stay in the list (they are the record of what each rep
    // was paid); they come off the money in/out strip so the Ledger agrees with
    // the account balances and with every other screen.
    prisma.financeTransaction.aggregate({ where: and(OFF_ACCOUNT_WHERE, { direction: 'IN' }, sinceEpoch), _sum: { amount: true } }),
    prisma.financeTransaction.aggregate({ where: and(OFF_ACCOUNT_WHERE, { direction: 'OUT' }, sinceEpoch), _sum: { amount: true } }),
    prisma.financeTransaction.groupBy({
      by: ['category'],
      // Spending by category, so rep commission has no place in it.
      where: and({ direction: 'OUT' }, { type: { notIn: ['COMMISSION_PAYMENT'] } }, sinceEpoch),
      _sum: { amount: true },
      _count: true,
    }),
    // An account statement walks its "balance after" column back from today's balance, newest
    // first. Page 2 onwards needs the rows on the earlier pages to start from the right figure —
    // without them every page restarted at today's balance. Same filter, same order, just the
    // rows before this page.
    filters.accountId && pagination.skip > 0
      ? prisma.financeTransaction.findMany({ where, select: { amount: true, direction: true, occurredAt: true }, take: pagination.skip, orderBy })
      : [],
  ]);
  // In minus out over every row newer than this page. Rows before go-live are not in the balance, so
  // they never move it here either.
  const inBooks = (t) => !epoch || new Date(t.occurredAt) >= epoch;
  const newerNet = round2(newerRows.filter(inBooks).reduce((s, t) => s + (t.direction === 'IN' ? 1 : -1) * toNumber(t.amount), 0));
  const brandName = new Map(brands.map((b) => [b.id, b.name]));
  const fromPocket = round2(toNumber(offOutAgg._sum.amount));
  const sumIn = round2(toNumber(inAgg._sum.amount) - toNumber(offInAgg._sum.amount));
  const sumOut = round2(toNumber(outAgg._sum.amount) - fromPocket);

  // WHO A PAYOUT WENT TO. "when i pay commission show it on its account name
  // and etc so i can know just like other transactions" — a transaction anyone
  // can read names the other party, and for a commission payout that is the
  // rep. The withdrawal it mirrors is the record of that, so the name is read
  // from there rather than from the row's own description text: a rep renamed
  // since the payout should read by the name they have now.
  const reversedRows = items.length
    ? await prisma.financeTransaction.findMany({ where: { reversalOfId: { in: items.map((t) => t.id) } }, select: { reversalOfId: true, txnNumber: true } })
    : [];
  const reversedBy = new Map(reversedRows.map((r) => [r.reversalOfId, r.txnNumber]));
  const payoutRefs = [...new Set(items.filter((t) => t.refType === 'CommissionWithdrawal' && t.refId).map((t) => t.refId))];
  const payouts = new Map();
  if (payoutRefs.length) {
    const found = await prisma.commissionWithdrawal.findMany({
      where: { id: { in: payoutRefs } },
      select: { id: true, status: true, paidAt: true, requestedAt: true, salesRep: { select: { code: true, user: { select: { name: true } } } } },
    }).catch(() => []);
    found.forEach((w) => payouts.set(w.id, w));
  }

  return {
    items: items.map((t) => {
      const isPayout = t.type === 'COMMISSION_PAYMENT';
      const w = t.refType === 'CommissionWithdrawal' ? payouts.get(t.refId) : null;
      return {
        ...t,
        brandName: t.brandId ? brandName.get(t.brandId) || null : null,
        // Flagged for the row itself, so a reader can see why a listed amount is
        // absent from the totals above it.
        offAccount: isOffAccount(t),
        // Named on the row, so a payout reads like every other transaction:
        // account, amount, who, when. Null on every row that is not a payout —
        // a settlement's description carries a rep's name too, and that rep is
        // the person who HANDED money over, not someone who was paid.
        payee: isPayout || (t.refType === 'CommissionWithdrawal' && w)
          ? (w?.salesRep?.user?.name || payeeFromDescription(t.description))
          : null,
        // Reversed entries and their reversals, named on the row (15 Nov 2026).
        reversedBy: reversedBy.get(t.id) || null,
        payeeCode: w?.salesRep?.code || null,
        payoutStatus: w?.status || null,
        paidAt: w?.paidAt || null,
      };
    }),
    total,
    newerNet,
    // Go-live. Rows before it stay listed (history) but are in no balance or total, so a statement
    // marks them instead of walking its balance through them (audit admin-money-3).
    epochAt: epoch || null,
    // `fromPocket` is reported beside in/out, never inside them.
    sums: { in: sumIn, out: sumOut, net: round2(sumIn - sumOut), fromPocket },
    byCategory: byCatRows
      .map((c) => ({ category: c.category || 'Uncategorised', amount: round2(toNumber(c._sum.amount)), count: c._count }))
      .sort((a, b) => b.amount - a.amount),
  };
}

async function updateTransaction(id, data) {
  const existing = await prisma.financeTransaction.findUnique({ where: { id } });
  if (!existing) throw ApiError.notFound('Transaction not found');
  assertRealCategory(data.category);
  // What moved and where is final once recorded (15 Nov 2026): a wrong amount or account is corrected by
  // reversing the entry and recording it again, so both stay in the ledger. Words can still be fixed.
  if (data.amount !== undefined && data.amount !== null && round2(toNumber(data.amount)) !== round2(toNumber(existing.amount))) {
    throw ApiError.badRequest('A recorded amount cannot be changed. Reverse this entry and record it again with the right amount — both stay in the ledger.');
  }
  if (data.accountId !== undefined && data.accountId !== existing.accountId) {
    throw ApiError.badRequest('The account of a recorded entry cannot be changed. Reverse it and record it again on the right account, or move the money with a transfer.');
  }
  // A reversed entry and its reversal stay a matching pair: same day, brand and category (the words can change).
  const inPair = existing.reversalOfId || (await prisma.financeTransaction.count({ where: { reversalOfId: id } }));
  if (inPair) {
    if (data.brandId !== undefined && (data.brandId || null) !== (existing.brandId || null)) {
      throw ApiError.badRequest('A reversed entry and its reversal keep their brand.');
    }
    if (data.category !== undefined && (data.category || null) !== (existing.category || null)) {
      throw ApiError.badRequest('A reversed entry and its reversal keep their category.');
    }
  }
  const patch = {};
  ['category', 'description', 'notes', 'accountId', 'reference', 'brandId'].forEach((k) => { if (data[k] !== undefined) patch[k] = data[k]; });
  // A typed-in expense counts as an expense or as stock bought by its category (recordExpense). A new category
  // moves it with it (audit fina06): left alone, "Fuel" filed as stock was missing from expenses, and "Stock
  // Purchase" filed as an expense was counted twice, once here and again as cost of goods. Only rows a person
  // typed (no link to a supplier, order or payout); a reversal pair already keeps its category.
  if (data.category !== undefined && !existing.refType && !inPair && ['EXPENSE', 'STOCK_PURCHASE'].includes(existing.type)) {
    patch.type = isStockPurchaseCategory(data.category) ? 'STOCK_PURCHASE' : 'EXPENSE';
  }
  if (data.amount !== undefined) {
    // Sale-linked money mirrors the sale document — correcting the amount here
    // would silently desync revenue. The sale itself must be cancelled/redone.
    if (existing.refType === 'Sale' && round2(toNumber(data.amount)) !== round2(toNumber(existing.amount))) {
      throw ApiError.badRequest('This amount comes from a sale and cannot be edited here. Recall/cancel the sale instead.');
    }
    patch.amount = round2(toNumber(data.amount));
    if (patch.amount > DB_MAX_AMOUNT) throw ApiError.badRequest('That amount is too large — check the number of zeros');
  }
  // The edit form sends only a DAY. Saving the same day used to restamp the row with the time of the
  // edit (#77); a different day keeps the row's own time of day. A full timestamp is taken as given.
  // Both the day and the time of day are Tanzania's (#62): compared on the UTC day, a row from 00:00 to
  // 03:00 EAT read as the day before, and moving it to the day it shows pushed it a day further.
  if (data.occurredAt !== undefined && data.occurredAt !== null && data.occurredAt !== '') {
    const s = String(data.occurredAt);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      const prev = new Date(existing.occurredAt);
      if (eatDateOf(prev) !== s) patch.occurredAt = eatDayAt(s, eatTimeOfDay(prev));
    } else {
      patch.occurredAt = new Date(s);
    }
  }
  if (patch.occurredAt) {
    if (inPair) throw ApiError.badRequest('A reversed entry and its reversal keep their dates.');
    if (Number.isNaN(patch.occurredAt.getTime())) throw ApiError.badRequest('That date cannot be read. Pick a day like 2026-11-15.');
    // After today it would come off the balance now and land in a later month's cash flow (audit fina01).
    if (patch.occurredAt > endOfTodayEat()) {
      throw ApiError.badRequest(`Money cannot be dated after today (${eatDateOf(Date.now())}). Use the day it really moved.`);
    }
    // Moving a row across the day the books started would add it to (or drop it from) every balance unseen.
    const epoch = await reports.financeEpoch();
    if (epoch && (new Date(existing.occurredAt) >= epoch) !== (patch.occurredAt >= epoch)) {
      throw ApiError.badRequest(`The date cannot move across ${eatDateOf(epoch)}, the day the books started — that would add this money to, or take it out of, the balances.`);
    }
  }
  const amountChanged = patch.amount !== undefined && patch.amount !== round2(toNumber(existing.amount));
  // A payout's record IS the withdrawal's amount — like deleting it, changing it is done on the payout.
  if (existing.refType === 'CommissionWithdrawal' && amountChanged) {
    throw ApiError.badRequest('This row mirrors a commission payout — its amount is the payout\'s. Reverse or redo the payout from the Commissions screen instead.');
  }

  // A brand-reserved account only holds its own brand's money.
  const targetAccountId = patch.accountId ?? existing.accountId;
  const targetBrandId = patch.brandId !== undefined ? patch.brandId : existing.brandId;
  const account = await prisma.businessAccount.findUnique({ where: { id: targetAccountId } });
  if (!account) throw ApiError.badRequest('Account not found');
  // Correcting a row may not move ordinary money onto the commission record,
  // nor move a payout off it — the record is held in one place or it is not a
  // record at all.
  if (account.type === COMMISSION_TYPE && existing.type !== 'COMMISSION_PAYMENT') {
    throw ApiError.badRequest('The Commission account only holds the record of rep commission. Choose the account the money actually moved through.');
  }
  if (existing.type === 'COMMISSION_PAYMENT' && account.type !== COMMISSION_TYPE) {
    throw ApiError.badRequest('Commission you paid from your own pocket is recorded in one place and cannot be filed against a wallet.');
  }
  if (!(await accountServesBrand(prisma, account.brandId, targetBrandId))) {
    throw ApiError.badRequest(`${account.name} is reserved for another brand's payments`);
  }

  // A transfer is two legs of one movement (audit #21, 11 Nov 2026). Correcting one leg's amount or day
  // alone made money vanish: OUT 1,000 -> 5,000 took 4,000 off M-Pesa that never reached Airtel. The
  // amount and the day now move on both legs together, in one transaction, and a leg cannot be put on
  // the same account as its other half.
  if (existing.type === 'TRANSFER') {
    const partner = existing.refType === 'Transfer' && existing.refId
      ? await prisma.financeTransaction.findUnique({ where: { id: existing.refId } })
      : await prisma.financeTransaction.findFirst({ where: { type: 'TRANSFER', refType: 'Transfer', refId: id } });
    if (partner) {
      if (partner.accountId === targetAccountId) {
        throw ApiError.badRequest('Both sides of a transfer cannot be on the same account.');
      }
      const both = {};
      if (amountChanged) both.amount = patch.amount;
      if (patch.occurredAt) both.occurredAt = patch.occurredAt;
      if (Object.keys(both).length) {
        const [updated] = await prisma.$transaction([
          prisma.financeTransaction.update({ where: { id }, data: patch }),
          prisma.financeTransaction.update({ where: { id: partner.id }, data: both }),
        ]);
        return { updated, previous: existing };
      }
    }
  }

  const updated = await prisma.financeTransaction.update({ where: { id }, data: patch });
  return { updated, previous: existing };
}

// Move money between two business accounts (e.g. banked cash into M-Pesa, or
// fixing money recorded against the wrong account when an edit isn't enough).
// Posts a linked OUT + IN pair of type TRANSFER — balance-effective on both
// accounts but excluded from income/expense/cash-flow reporting.
async function transferBetweenAccounts({ fromAccountId, toAccountId, amount, notes, occurredAt, clientKey }, actor) {
  const amt = round2(toNumber(amount));
  if (!(amt > 0)) throw ApiError.badRequest('Enter an amount greater than zero');
  if (!fromAccountId || !toAccountId) throw ApiError.badRequest('Choose both accounts');
  if (fromAccountId === toAccountId) throw ApiError.badRequest('Choose two different accounts');

  const balances = await accountBalances();
  const from = balances.find((a) => a.id === fromAccountId);
  const to = balances.find((a) => a.id === toAccountId);
  if (!from || !to) throw ApiError.badRequest('Account not found');
  // No money is held in the commission account, so none can be moved in or out
  // of it. Its figure is a record of what the owner paid, not a balance.
  const commission = [from, to].find((a) => a.type === COMMISSION_TYPE);
  if (commission) {
    throw ApiError.badRequest(`${commission.name} is a record of what you paid reps, not a wallet — there is no money in it to move.`);
  }
  // What the account holds is judged only inside the transaction below, after a repeat press is recognised: judged
  // here first, the second press of a transfer that emptied the account was told "only holds 0" although the
  // first one went through (audit fina07).

  const when = await bookDate(occurredAt);
  const reference = `Transfer ${from.name} → ${to.name}`;
  return withDocNumberRetry(() => prisma.$transaction(async (tx) => {
    // A repeat press first, then the balance under the account's lock.
    await assertNotRecorded(tx, from.id, clientKey);
    await assertFunds(tx, from.id, amt, 'this transfer');
    const outNumber = await nextDocNumber(tx.financeTransaction, 'txnNumber', 'FTX');
    const outTxn = await tx.financeTransaction.create({
      data: {
        txnNumber: outNumber, clientKey: clientKey || null, accountId: from.id, direction: 'OUT', type: 'TRANSFER', amount: amt,
        category: 'Account transfer', description: `Transfer to ${to.name}`, reference,
        notes: notes || null, occurredAt: when, createdById: actor?.id || null,
      },
    });
    const inNumber = await nextDocNumber(tx.financeTransaction, 'txnNumber', 'FTX');
    const inTxn = await tx.financeTransaction.create({
      data: {
        txnNumber: inNumber, accountId: to.id, direction: 'IN', type: 'TRANSFER', amount: amt,
        category: 'Account transfer', description: `Transfer from ${from.name}`, reference,
        refType: 'Transfer', refId: outTxn.id,
        notes: notes || null, occurredAt: when, createdById: actor?.id || null,
      },
    });
    return { out: outTxn, in: inTxn, amount: amt, from: from.name, to: to.name };
  }));
}

// Entries are never deleted (15 Nov 2026): a mistake is undone by a reversal, so the ledger keeps both.
async function deleteTransaction(id) {
  const existing = await prisma.financeTransaction.findUnique({ where: { id } });
  if (!existing) throw ApiError.notFound('Transaction not found');
  throw ApiError.badRequest('Recorded money is never deleted. Use Reverse: it records the opposite entry and keeps both in the ledger.');
}

// The kinds of entry a person typed in, and so may reverse here. Money that mirrors a sale, a purchase order, a
// supplier bill or a rep payout is corrected where it came from, never by a free-standing reversal.
const REVERSIBLE_TYPES = ['INCOME', 'EXPENSE', 'STOCK_PURCHASE', 'OWNER_CONTRIBUTION', 'OWNER_DRAWING', 'ADJUSTMENT', 'TRANSFER'];

// Reverse an entry: a new entry on the same account, of the same kind, for minus the same amount, tied to the
// original (`reversalOfId`, unique — an entry is reversed once). Every total that counted the original now nets
// it to nothing; the balance is back where it was; the ledger shows both and who did it. A transfer is reversed
// on both sides. Undoing money that came IN cannot take an account below zero.
async function reverseTransaction(id, { reason } = {}, actor) {
  const why = String(reason || '').trim();
  if (!why) throw ApiError.badRequest('Say why this entry is being reversed — it stays in the ledger beside it.');
  return withDocNumberRetry(() => prisma.$transaction(async (tx) => {
    const original = await tx.financeTransaction.findUnique({ where: { id } });
    if (!original) throw ApiError.notFound('Transaction not found');
    if (original.reversalOfId) throw ApiError.badRequest('This entry is itself a reversal — record the money again instead.');
    // A payment a person made to a supplier (balance or an older order) can be reversed; the reversal keeps its link
    // so the supplier's paid and owed figures net out. A payment made by Confirm purchase is undone on the order.
    if (original.refType === 'PurchaseOrder') {
      const po = await tx.purchaseOrder.findUnique({ where: { id: original.refId }, select: { poNumber: true, purchasedAt: true, dispatchedAt: true } });
      if (po?.purchasedAt && po.dispatchedAt && new Date(original.createdAt) >= new Date(po.dispatchedAt)) {
        throw ApiError.badRequest(`This is the payment of ${po.poNumber}, made with Confirm purchase. Use Undo purchase on the order instead.`);
      }
    }
    const linked = ['Supplier', 'PurchaseOrder'].includes(original.refType) && original.type === 'STOCK_PURCHASE';
    if (!REVERSIBLE_TYPES.includes(original.type) || (original.refType && !linked && original.type !== 'TRANSFER')) {
      const where = ['Sale', 'SalePayment', 'SaleRefund'].includes(original.refType) ? 'Cancel or refund the sale it came from.'
        : original.refType === 'CommissionWithdrawal' ? 'It is a rep payout, recorded with the withdrawal.'
          : original.refType === 'PurchaseOrder' || original.refType === 'Supplier' ? 'It is a supplier or purchase order payment.'
            : 'It was recorded by the app, not typed in.';
      throw ApiError.badRequest(`This entry cannot be reversed here. ${where}`);
    }
    // Both sides of a transfer, found from either side.
    const legs = [original];
    if (original.type === 'TRANSFER') {
      const partner = original.refType === 'Transfer' && original.refId
        ? await tx.financeTransaction.findUnique({ where: { id: original.refId } })
        : await tx.financeTransaction.findFirst({ where: { type: 'TRANSFER', refType: 'Transfer', refId: original.id } });
      if (partner) legs.push(partner);
    }
    for (const leg of legs) {
      if (await tx.financeTransaction.findUnique({ where: { reversalOfId: leg.id }, select: { id: true } })) {
        throw ApiError.conflict('This entry was already reversed.');
      }
    }
    // Money that counted in no balance — from before the books started, or on an account since switched off —
    // has nothing to reverse: a reversal dated today would add or remove money that was never there.
    const epoch = await reports.financeEpoch();
    if (epoch && legs.some((l) => new Date(l.occurredAt) < epoch)) {
      throw ApiError.badRequest('This entry is from before the books started, so it is in no balance and there is nothing to reverse.');
    }
    const closed = await tx.businessAccount.findFirst({ where: { id: { in: legs.map((l) => l.accountId) }, isActive: false }, select: { name: true } });
    if (closed) throw ApiError.badRequest(`${closed.name} is switched off. Switch it back on before reversing this entry, so both sides count.`);
    // Undoing money that came in takes it back out of that account: only what is there.
    for (const leg of legs.filter((l) => l.direction === 'IN')) {
      await assertFunds(tx, leg.accountId, leg.amount, `reversing ${leg.txnNumber}`);
    }
    const made = [];
    for (const leg of legs) {
      const txnNumber = await nextDocNumber(tx.financeTransaction, 'txnNumber', 'FTX');
      made.push(await tx.financeTransaction.create({
        data: {
          txnNumber,
          reversalOfId: leg.id,
          accountId: leg.accountId,
          direction: leg.direction,
          type: leg.type,
          amount: round2(-toNumber(leg.amount)),
          brandId: leg.brandId,
          category: leg.category,
          description: `Reversal of ${leg.txnNumber}${leg.description ? ` — ${leg.description}` : ''}`.slice(0, 500),
          reference: leg.reference,
          // A supplier or order payment keeps its link, so that supplier's figures net out. A transfer's reversal
          // legs point at their originals by reversalOfId; refType stays off so the pair is never taken for a new one.
          ...(linked ? { refType: leg.refType, refId: leg.refId } : {}),
          notes: why.slice(0, 2000),
          occurredAt: new Date(),
          createdById: actor?.id || null,
        },
      }));
    }
    return { original, reversals: made };
  }));
}


// --- Categories ------------------------------------------------------------

async function listCategories() {
  await ensureDefaults();
  return prisma.expenseCategory.findMany({ where: { isActive: true }, orderBy: [{ isDefault: 'desc' }, { name: 'asc' }] });
}
async function createCategory(name) {
  const n = (name || '').trim();
  if (!n) throw ApiError.badRequest('Category name is required');
  return prisma.expenseCategory.upsert({ where: { name: n }, create: { name: n }, update: { isActive: true } });
}

// --- Cash flow ----------------------------------------------------------------

// Resolve { period } or { from, to } into a date range (null = all time).
function rangeFor(opts = {}) {
  if (opts.start && opts.end) return resolveRange({ start: opts.start, end: opts.end });
  if (opts.from || opts.to) return resolveRange({ from: opts.from, to: opts.to });
  if (opts.period && opts.period !== 'all') return resolveRange({ period: opts.period });
  return null;
}

// occurredAt filter for aggregates, clamped to the finance epoch: a null range
// means "since the epoch" (or truly all time when no epoch is set).
function epochWhere(range, epoch) {
  const start = range && epoch ? (range.start > epoch ? range.start : epoch) : range ? range.start : epoch;
  const end = range ? range.end : null;
  if (!start && !end) return {};
  return { occurredAt: { ...(start ? { gte: start } : {}), ...(end ? { lte: end } : {}) } };
}

// ── The owner's own money, in ONE shape ───────────────────────────────────────
// Every screen that says "your money" reads from here. Three places used to
// compute it three ways — the balance sheet unclamped and unfiltered, the
// period strip epoch-clamped, the cash-flow tab clamped AND active-only — so
// one drawing made the same label print two different numbers. The population
// is fixed here and cannot be varied by a caller:
//
//   • ACTIVE accounts only, from the finance epoch on — exactly the population
//     `accountBalances()` builds the cash figure from, so his money and the
//     cash it moved are always measured against the same books.
//   • The only thing a caller may narrow is the TIME WINDOW, and any screen
//     that narrows it has to say so in its label.
//
// The four parts, and what each one is allowed to be used for:
//   intoAccounts         cash he moved INTO a business account. Contributions
//                        only — drawings are their own line, never netted in.
//   commissionFromPocket cash he handed reps directly. Never touched an
//                        account, so it can never appear in cash flow.
//   drawn                profit he has taken back out.
//   accountMovement      intoAccounts − drawn. The ONLY part that moved a
//                        balance, so this is what a closing balance uses.
//   total                putIn − drawn. What the business owes him.
async function ownerFigures({ start = null, end = null } = {}) {
  const epoch = await reports.financeEpoch();
  const from = start && epoch ? (start > epoch ? start : epoch) : (start || epoch);
  const scope = { account: { is: { isActive: true } } };
  if (from || end) scope.occurredAt = { ...(from ? { gte: from } : {}), ...(end ? { lte: end } : {}) };
  const [contribAgg, fundingAgg, drawAgg, pocketAgg, byBrandRows] = await Promise.all([
    prisma.financeTransaction.aggregate({ where: { ...scope, direction: 'IN', type: 'OWNER_CONTRIBUTION' }, _sum: { amount: true } }),
    // Legacy rows that "funded" a payout — the same shilling recorded on both
    // sides. Queried as its own whole population and subtracted, never as a
    // `refType: { not: … }` filter: refType is NULL on every ordinary
    // contribution and that filter's NULL handling is a Prisma detail.
    prisma.financeTransaction.aggregate({ where: { ...scope, direction: 'IN', type: 'OWNER_CONTRIBUTION', refType: 'CommissionWithdrawal' }, _sum: { amount: true } }),
    prisma.financeTransaction.aggregate({ where: { ...scope, direction: 'OUT', type: 'OWNER_DRAWING' }, _sum: { amount: true } }),
    prisma.financeTransaction.aggregate({ where: { ...scope, direction: 'OUT', type: 'COMMISSION_PAYMENT' }, _sum: { amount: true } }),
    // Which brand each contribution was put behind. Older rows carry no brand
    // and group under null — named "not tagged" rather than guessed at.
    prisma.financeTransaction.groupBy({
      by: ['brandId'],
      where: { ...scope, direction: 'IN', type: 'OWNER_CONTRIBUTION' },
      _sum: { amount: true },
    }),
  ]);
  const repFundingExcluded = round2(toNumber(fundingAgg._sum.amount));
  const intoAccounts = round2(round2(toNumber(contribAgg._sum.amount)) - repFundingExcluded);
  const commissionFromPocket = round2(toNumber(pocketAgg._sum.amount));
  const drawn = round2(toNumber(drawAgg._sum.amount));
  return {
    intoAccounts,
    commissionFromPocket,
    drawn,
    repFundingExcluded,
    byBrand: byBrandRows
      .map((r) => ({ brandId: r.brandId, amount: round2(toNumber(r._sum.amount)) }))
      .filter((r) => r.amount !== 0)
      .sort((a, b) => b.amount - a.amount),
    putIn: round2(intoAccounts + commissionFromPocket),
    accountMovement: round2(intoAccounts - drawn),
    total: round2(intoAccounts + commissionFromPocket - drawn),
  };
}

async function flowBetween(start, end) {
  // Internal account-to-account transfers move balances but are not business
  // cash flow (they would inflate money-in AND money-out by the same amount).
  // Only active accounts: the opening balance sums active accounts' openings,
  // so counting a deactivated account's movements here would make
  // Opening + In − Out drift from the account balances it must reconcile to.
  // Transfers move balances without being business cash flow; owner money is
  // the owner's, not the business's trading. Both would inflate in/out.
  const where = { type: { notIn: NON_TRADE_TYPES }, account: { is: { isActive: true } } };
  if (start || end) where.occurredAt = { ...(start ? { gte: start } : {}), ...(end ? { lte: end } : {}) };
  const [i, o] = await Promise.all([
    prisma.financeTransaction.aggregate({ where: { ...where, direction: 'IN' }, _sum: { amount: true } }),
    prisma.financeTransaction.aggregate({ where: { ...where, direction: 'OUT' }, _sum: { amount: true } }),
  ]);
  const moneyIn = round2(toNumber(i._sum.amount));
  const moneyOut = round2(toNumber(o._sum.amount));
  return { moneyIn, moneyOut, net: round2(moneyIn - moneyOut) };
}

// Cash-flow statement for a window: opening balance (all money before the
// window), money in/out, and the closing balance. All-time uses the accounts'
// opening balances as the opening figure.
async function cashflow(opts = {}) {
  await ensureDefaults();
  await healLedgerOnRead().catch(() => {});
  const range = rangeFor(opts);
  const epoch = await reports.financeEpoch();
  // Every read below depends only on the window and the epoch, never on another read's answer, so they
  // are sent together: one wait instead of a dozen in a row. Same queries, same arguments, same figures.

  // ...the owner's own money that went through an account before the window (contributions in,
  // drawings out). flowBetween leaves it out because it is not trade — but the stock it paid for IS
  // in `before`, so without it every opening (and so every closing) was short by exactly what he had
  // put in: 3,300,000 on every statement and PDF since 26 Sep (audit #36, 11 Nov 2026).
  const countsBefore = range && (!epoch || range.start > epoch);
  const start = range && epoch ? (range.start > epoch ? range.start : epoch) : range ? range.start : epoch;

  // Where the money actually came from and went, by kind — settlements vs
  // counter sales vs other income; stock vs commissions vs expenses. The four
  // headline figures say HOW MUCH moved; this says WHAT moved it.
  const typeWhere = { type: { notIn: NON_TRADE_TYPES }, account: { is: { isActive: true } } };
  if (start || (range && range.end)) {
    typeWhere.occurredAt = { ...(start ? { gte: start } : {}), ...(range ? { lte: range.end } : {}) };
  }

  // Six EAT months of in/out/net, so the tab can show motion, not one frame.
  // Anchored to the business's clock like every other window.
  const { eatNow, eatToUtc } = require('../utils/dates');
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const m = eatNow().subtract(i, 'month');
    const mStart = eatToUtc(m.startOf('month')).toDate();
    const mEnd = eatToUtc(m.endOf('month')).toDate();
    const from = epoch && mStart < epoch ? epoch : mStart;
    months.push({ period: m.format('MMM'), from, mEnd, beforeEpoch: !!(epoch && mEnd < epoch) });
  }

  const [openAgg, before, ownerBefore, inPeriod, owner, byTypeRows, monthFlows] = await Promise.all([
    prisma.businessAccount.aggregate({ where: { isActive: true }, _sum: { openingBalance: true } }),
    // Opening = account openings (the truth at the epoch) + movements between the
    // epoch and the window start. Pre-epoch ledger rows never count.
    range
      ? flowBetween(epoch || null, new Date(range.start.getTime() - 1))
      : { net: 0 },
    countsBefore
      ? ownerFigures({ start: null, end: new Date(range.start.getTime() - 1) })
      : { accountMovement: 0 },
    flowBetween(start || null, range ? range.end : null),
    // The owner's own money is not trading, so it is kept out of money in/out —
    // but the part of it that went through an account DOES move balances, and
    // leaving it out of the statement made the closing balance disagree with the
    // cash actually held (2,439,500 against a real 2,915,500). It gets its own
    // lines instead: excluded from trade, included in the balance.
    //
    // One shape, shared with the Overview and the balance sheet, so no two
    // screens can print different numbers under the same label.
    ownerFigures({ start: start || null, end: range ? range.end : null }),
    prisma.financeTransaction.groupBy({
      by: ['type', 'direction'],
      where: typeWhere,
      _sum: { amount: true },
      _count: true,
    }),
    Promise.all(months.map((mo) => (mo.beforeEpoch ? null : flowBetween(mo.from, mo.mEnd)))),
  ]);
  const baseOpening = round2(toNumber(openAgg._sum.openingBalance));
  const openingBalance = round2(baseOpening + (countsBefore ? before.net + ownerBefore.accountMovement : 0));
  const ownerIn = owner.intoAccounts;
  const ownerOut = owner.drawn;
  // ACCOUNT MOVEMENT ONLY, and the closing balance is built from it. Commission
  // he pays reps from his own hand never lands in an account, so it is not
  // here; `owner.commissionFromPocket` carries that half.
  const ownerNet = owner.accountMovement;

  // Rep payouts from an account are expenses, but the reader asked to see them as their own line (15 Nov 2026):
  // taken out of EXPENSE and shown as REP_COMMISSION.
  const repPaid = byTypeRows.length
    ? await prisma.financeTransaction.aggregate({
      where: { ...typeWhere, type: 'EXPENSE', direction: 'OUT', refType: 'CommissionWithdrawal' }, _sum: { amount: true }, _count: true,
    })
    : null;
  const repAmount = round2(toNumber(repPaid?._sum?.amount));
  const byType = byTypeRows
    .map((r) => ({ type: r.type, direction: r.direction, amount: round2(toNumber(r._sum.amount)), count: r._count }))
    .map((r) => (r.type === 'EXPENSE' && r.direction === 'OUT' && repAmount
      ? { ...r, amount: round2(r.amount - repAmount), count: r.count - (repPaid._count || 0) }
      : r))
    .concat(repAmount ? [{ type: 'REP_COMMISSION', direction: 'OUT', amount: repAmount, count: repPaid._count || 0 }] : [])
    .filter((r) => r.amount !== 0 || r.count > 0)
    .sort((a, b) => b.amount - a.amount);

  const series = months.map((mo, i) => (mo.beforeEpoch
    ? { period: mo.period, moneyIn: 0, moneyOut: 0, net: 0 }
    : { period: mo.period, moneyIn: monthFlows[i].moneyIn, moneyOut: monthFlows[i].moneyOut, net: monthFlows[i].net }));

  return {
    period: opts.from || opts.to ? 'custom' : opts.period || 'all',
    range: range ? { start: range.start, end: range.end } : null,
    // With no range the figures start at go-live, not at the first record: say so on screen.
    epochAt: epoch || null,
    openingBalance,
    ...inPeriod,
    // Contributions in, drawings out, and the net of the two — the part of his
    // money that actually moved a balance in this window.
    ownerIn,
    ownerOut,
    ownerNet,
    // The whole of his money in this window, in the shared shape: intoAccounts,
    // commissionFromPocket, drawn, putIn, accountMovement, total. Nothing on
    // screen may label account movement as everything he has put in.
    owner,
    // Opening + trade + the owner's own money = what the accounts actually
    // hold. Every part is on screen, so the reader can add it up themselves.
    closingBalance: round2(openingBalance + inPeriod.net + ownerNet),
    byType,
    series,
  };
}

// --- Financial report ----------------------------------------------------------

// One consolidated report for a period or custom date range: P&L, cash flow,
// supplier/commission payments, stock-purchase spend, top products & brands.
async function report(opts = {}) {
  await ensureDefaults();
  const profOpts = opts.start && opts.end
    ? { start: opts.start, end: opts.end }
    : opts.from || opts.to ? { from: opts.from, to: opts.to } : { period: opts.period || 'all' };
  const [prof, cf, epoch] = await Promise.all([reports.profitOverview(profOpts), cashflow(opts), reports.financeEpoch()]);
  const range = rangeFor(opts);
  const base = epochWhere(range, epoch);
  const sumOf = async (extra) =>
    round2(toNumber((await prisma.financeTransaction.aggregate({ where: { ...base, ...extra }, _sum: { amount: true } }))._sum.amount));
  const [expenses, supplierPayments, commissionPaid, otherIncome, losses] = await Promise.all([
    sumOf({ direction: 'OUT', type: 'EXPENSE' }),
    sumOf({ direction: 'OUT', type: 'STOCK_PURCHASE' }),
    // What reps were paid: payouts from a business account (since 15 Nov 2026 — already inside `expenses`, and so
    // inside netProfit) and the older pocket records (outside cash flow and profit), together on one line.
    sumOf({ direction: 'OUT', refType: 'CommissionWithdrawal' }),
    sumOf({ direction: 'IN', type: 'INCOME' }),
    // Stock lost in the window (written off, or bought and damaged / never received) — part of THE net profit.
    reports.stockLosses(range),
  ]);
  return {
    range: range ? { start: range.start, end: range.end } : null,
    period: cf.period,
    revenue: prof.totals.revenue,
    cogs: prof.totals.cost,
    grossProfit: prof.totals.profit,
    margin: prof.totals.margin,
    boxesSold: prof.totals.boxes,
    // Boxes sold before a buying price was set: in revenue, not in profit.
    noCost: prof.totals.noCost,
    expenses,
    stockLoss: losses.total,
    commissionAccrued: prof.totals.commission,
    // One net profit everywhere (reports.netProfitOf): gross − expenses − stock lost.
    netProfit: profitMath.netProfitOf({ grossProfit: prof.totals.profit, expenses, stockLoss: losses.total }),
    supplierPayments,
    commissionPaid,
    otherIncome,
    cashFlow: {
      openingBalance: cf.openingBalance,
      moneyIn: cf.moneyIn,
      moneyOut: cf.moneyOut,
      net: cf.net,
      closingBalance: cf.closingBalance,
    },
    // The best sellers, by sales value (audit repo02, 15 Nov 2026): the reports print them as "Top product"
    // with revenue and boxes, and byProduct is ranked by profit, so the most PROFITABLE product was
    // printed as the best seller (October: OHIS at 1,440,000 above Civlily at 2,275,000).
    topProducts: [...prof.byProduct].sort((a, b) => b.revenue - a.revenue).slice(0, 8),
    topBrands: prof.byBrand,
  };
}

// --- Suppliers (accounts payable) -----------------------------------------------

// Every supplier with their financial picture: total purchased (non-cancelled
// Goods returned to a supplier, by supplier. Supplier debt is worked out in
// more than one place in this file — the per-supplier roll-up, the detail for
// one supplier, and a raw aggregate behind the Finance overview — so all of
// them read the credits from here. Two subtractions written twice is how the
// modal and the dashboard end up quoting different debt.
// The orders a supplier counts as bought from (and so can be owed for): not cancelled, and not a draft — a
// draft is a plan, paid for only when Confirm purchase pays it (cash-only, 15 Nov 2026). Every supplier figure
// reads this one rule, so the Suppliers tab, a supplier's page and the Overview never disagree.
const PAYABLE_PO = { status: { notIn: ['CANCELLED', 'DRAFT'] } };

async function creditsBySupplier(supplierIds = null) {
  const rows = await prisma.supplierCredit.groupBy({
    by: ['supplierId'],
    ...(supplierIds ? { where: { supplierId: { in: supplierIds } } } : {}),
    _sum: { amount: true },
  });
  return new Map(rows.map((r) => [r.supplierId, round2(toNumber(r._sum.amount))]));
}

// POs), total paid (ledger payments keyed to their POs), outstanding balance.
async function supplierSummaries() {
  await ensureDefaults();
  const [suppliers, pos, brands] = await Promise.all([
    prisma.supplier.findMany({ orderBy: { name: 'asc' } }),
    prisma.purchaseOrder.findMany({
      where: PAYABLE_PO, // a draft is not bought yet, so nobody is owed for it
      select: { id: true, supplierId: true, totalCost: true, receivedAt: true, createdAt: true },
    }),
    prisma.brand.findMany({ select: { id: true, name: true } }),
  ]);
  const brandName = new Map(brands.map((b) => [b.id, b.name]));
  const poIds = pos.map((p) => p.id);
  const supplierIds = suppliers.map((s) => s.id);
  // Payments live at two levels: keyed to a specific PO, or to the supplier as
  // a whole (paying down the running balance). Both reduce what is owed.
  const [payRows, supplierPayRows] = await Promise.all([
    poIds.length
      ? prisma.financeTransaction.groupBy({
          by: ['refId'],
          where: { refType: 'PurchaseOrder', refId: { in: poIds }, direction: 'OUT' },
          _sum: { amount: true },
        })
      : [],
    prisma.financeTransaction.groupBy({
      by: ['refId'],
      where: { refType: 'Supplier', refId: { in: supplierIds }, direction: 'OUT' },
      _sum: { amount: true },
      _max: { occurredAt: true },
    }),
  ]);
  const creditBySupplier = await creditsBySupplier(supplierIds);
  const paidByPo = new Map(payRows.map((p) => [p.refId, toNumber(p._sum.amount)]));
  const paidBySupplier = new Map(supplierPayRows.map((p) => [p.refId, toNumber(p._sum.amount)]));
  const lastPayBySupplier = new Map(supplierPayRows.map((p) => [p.refId, p._max.occurredAt]));

  const agg = new Map();
  for (const p of pos) {
    const cur = agg.get(p.supplierId) || { purchased: 0, paid: 0, poCount: 0, last: null };
    cur.purchased += toNumber(p.totalCost);
    cur.paid += paidByPo.get(p.id) || 0;
    cur.poCount += 1;
    const d = p.receivedAt || p.createdAt;
    if (!cur.last || d > cur.last) cur.last = d;
    agg.set(p.supplierId, cur);
  }
  for (const [sid, amt] of paidBySupplier) {
    const cur = agg.get(sid) || { purchased: 0, paid: 0, poCount: 0, last: null };
    cur.paid += amt;
    agg.set(sid, cur);
  }
  return suppliers.map((s) => {
    const f = agg.get(s.id) || { purchased: 0, paid: 0, poCount: 0, last: null };
    return {
      id: s.id, name: s.name, country: s.country, contactName: s.contactName,
      phone: s.phone, email: s.email, isActive: s.isActive,
      brandId: s.brandId || null, brandName: s.brandId ? brandName.get(s.brandId) || null : null,
      totalPurchased: round2(f.purchased),
      totalPaid: round2(f.paid),
      // Goods that went back. Off the purchases, never onto the payments — no
      // money moved, and counting it as paid would report shillings as having
      // left an account when none did.
      totalReturned: round2(creditBySupplier.get(s.id) || 0),
      outstanding: round2(f.purchased - (creditBySupplier.get(s.id) || 0) - f.paid),
      poCount: f.poCount,
      lastActivity: f.last,
      lastPayment: lastPayBySupplier.get(s.id) || null,
    };
  });
}

// Share a supplier's balance payments, then his returned goods, over his POs, oldest first. Each PO
// takes only what is still open on it after its own PO payments. Pure (tested). Returns
// Map(poId -> { paid, returned, outstanding }), where paid = the PO's own payments + its share of the
// balance payments. A PO paid directly beyond its cost keeps its negative outstanding (shown, not hidden).
function spreadOverOrders(orders, { balancePaid = 0, returned = 0 } = {}) {
  let pay = round2(balancePaid);
  let back = round2(returned);
  const out = new Map();
  const oldestFirst = [...orders].sort((a, b) => new Date(a.at) - new Date(b.at) || String(a.id).localeCompare(String(b.id)));
  for (const o of oldestFirst) {
    const total = round2(o.totalCost);
    const direct = round2(o.paidDirect);
    let open = Math.max(0, round2(total - direct));
    const fromPay = Math.min(open, pay);
    pay = round2(pay - fromPay);
    open = round2(open - fromPay);
    const fromBack = Math.min(open, back);
    back = round2(back - fromBack);
    out.set(o.id, {
      paid: round2(direct + fromPay),
      returned: round2(fromBack),
      outstanding: round2(total - direct - fromPay - fromBack),
    });
  }
  return out;
}

// One supplier's full accounts-payable profile: purchases, payments (both
// PO-level and supplier-level), products supplied, balances and last activity.
// `client` lets a payment read what is owed inside its own transaction, under the supplier's lock.
async function supplierDetail(id, { client: db = prisma } = {}) {
  const s = await db.supplier.findUnique({ where: { id } });
  if (!s) throw ApiError.notFound('Supplier not found');
  const [pos, brand] = await Promise.all([
    db.purchaseOrder.findMany({
      where: { supplierId: id, ...PAYABLE_PO },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, poNumber: true, status: true, totalCost: true, receivedAt: true, createdAt: true,
        items: { select: { quantity: true, baseQuantity: true, product: { select: { name: true } } } },
      },
    }),
    s.brandId ? db.brand.findUnique({ where: { id: s.brandId }, select: { name: true } }) : null,
  ]);
  const poIds = pos.map((p) => p.id);
  const credits = await db.supplierCredit.findMany({
    where: { supplierId: id },
    orderBy: { occurredAt: 'desc' },
  });
  const txns = await db.financeTransaction.findMany({
    where: {
      direction: 'OUT',
      OR: [
        ...(poIds.length ? [{ refType: 'PurchaseOrder', refId: { in: poIds } }] : []),
        { refType: 'Supplier', refId: id },
      ],
    },
    include: { account: { select: { name: true } } },
    orderBy: { occurredAt: 'desc' },
  });
  const paidByPo = new Map();
  let balancePaid = 0;
  txns.forEach((t) => {
    if (t.refType === 'PurchaseOrder') paidByPo.set(t.refId, (paidByPo.get(t.refId) || 0) + toNumber(t.amount));
    else balancePaid += toNumber(t.amount);
  });
  const paid = round2(txns.reduce((x, t) => x + toNumber(t.amount), 0));
  const returned = round2(credits.reduce((x, c) => x + toNumber(c.amount), 0));

  // Balance payments and goods returned belong to the supplier, not to one PO. Spread over the POs,
  // oldest first, each PO row says what is really still owed on it, and the rows add up to the
  // balance owed. Without this every PO showed its full cost as outstanding with a Pay PO button
  // (Bonge: 22,942,000 offered while 12,000,000 was owed) and could be paid twice (audit admin-money-1).
  const spread = spreadOverOrders(
    pos.map((p) => ({ id: p.id, totalCost: toNumber(p.totalCost), paidDirect: paidByPo.get(p.id) || 0, at: p.receivedAt || p.createdAt })),
    { balancePaid, returned },
  );
  const orders = pos.map((p) => {
    const f = spread.get(p.id);
    return {
      id: p.id, poNumber: p.poNumber, status: p.status,
      totalCost: round2(toNumber(p.totalCost)), paid: f.paid, returned: f.returned, outstanding: f.outstanding,
      boxes: p.items.reduce((n, it) => n + (it.baseQuantity || 0), 0), // boxes, also for an order bought in cartons
      products: [...new Set(p.items.map((it) => it.product?.name).filter(Boolean))],
      receivedAt: p.receivedAt, createdAt: p.createdAt,
    };
  });
  const purchased = round2(orders.reduce((x, o) => x + o.totalCost, 0));
  const outstanding = round2(purchased - returned - paid);
  // Balance payments or returned goods beyond every bill fit on no PO row, so the rows alone add up to
  // more than the balance owed; this is that difference (STG: rows 0, balance −1,000, 1,000 here).
  // Never below zero: a PO paid directly beyond its cost shows its own negative row instead.
  const notOnAnyPo = Math.max(0, round2(orders.reduce((x, o) => x + o.outstanding, 0) - outstanding));
  const productsPurchased = [...new Set(orders.flatMap((o) => o.products))];
  return {
    supplier: { ...s, brandName: brand?.name || null },
    orders,
    payments: txns.map((t) => ({
      id: t.id, txnNumber: t.txnNumber, amount: toNumber(t.amount), account: t.account?.name,
      reference: t.refType === 'Supplier' ? 'Balance payment' : t.reference,
      occurredAt: t.occurredAt, notes: t.notes,
    })),
    productsPurchased,
    lastPurchase: orders[0]?.receivedAt || orders[0]?.createdAt || null,
    lastPayment: txns[0]?.occurredAt || null,
    credits: credits.map((c) => ({
      id: c.id, amount: toNumber(c.amount), reason: c.reason, occurredAt: c.occurredAt,
    })),
    totals: { purchased, paid, returned, outstanding, notOnAnyPo },
  };
}

// Record goods sent back to a supplier. Money only — the boxes are corrected
// through the stock ledger, which is the one place stock is allowed to change.
//
// Capped at what is still owed: a return bigger than the outstanding bill would
// mean the supplier owes money back, which is a refund and a different
// transaction, not a credit against a bill that no longer exists.
async function recordSupplierCredit(supplierId, { amount, reason, occurredAt }, actor) {
  const amt = round2(toNumber(amount));
  if (!(amt > 0)) throw ApiError.badRequest('Enter the value of the goods going back');
  if (!String(reason || '').trim()) {
    throw ApiError.badRequest('Say what went back — a credit against a bill with no reason cannot be checked later');
  }
  const when = await bookDate(occurredAt);
  // Under the supplier's lock, like a payment: a credit and a payment at the same moment could each take the
  // same shillings off the bill.
  return prisma.$transaction(async (tx) => {
    await lockSupplier(tx, supplierId);
    const detail = await supplierDetail(supplierId, { client: tx });
    if (amt > detail.totals.outstanding + 0.001) {
      throw ApiError.badRequest(
        `You only owe ${detail.supplier.name} TZS ${detail.totals.outstanding.toLocaleString()}. A return bigger than the bill means they owe you money back, which is a refund rather than a credit.`,
      );
    }
    return tx.supplierCredit.create({
      data: {
        supplierId,
        amount: amt,
        reason: String(reason).trim().slice(0, 300),
        occurredAt: when,
        createdById: actor?.id || null,
      },
    });
  });
}

// Every write that changes what a supplier is owed takes this lock first, then reads the bill inside the same
// transaction (audit fina00 / perm01): two payments sent at the same moment both read "7,000 owed" outside any
// lock and both went through, so the supplier was paid 14,000 more than his bills. Locks are always taken
// supplier, then order, then account, so two writers never wait on each other in a circle.
async function lockSupplier(tx, supplierId) {
  // $queryRaw, not $executeRaw: it returns the locked row, which also says whether the supplier exists.
  const rows = await tx.$queryRaw`SELECT id FROM "suppliers" WHERE id = ${supplierId} FOR UPDATE`;
  if (!rows.length) throw ApiError.notFound('Supplier not found');
}

// Pay down a supplier's overall balance (installments welcome): one OUT
// transaction from the chosen account, keyed to the supplier, brand-tagged.
// Not an expense — it settles the liability created when stock was received;
// the P&L cost is recognised as COGS when boxes sell.
// One transaction: the supplier locked, a repeat press recognised, what is owed read under the lock, the account
// checked and charged (audit fina00 / perm01).
async function paySupplierBalance(supplierId, { accountId, amount, notes, occurredAt, clientKey }, actor) {
  return withDocNumberRetry(() => prisma.$transaction(async (tx) => {
    await lockSupplier(tx, supplierId);
    // Before what is owed is judged: the first press may have paid it all.
    await assertNotRecorded(tx, accountId, clientKey);
    const detail = await supplierDetail(supplierId, { client: tx });
    const s = detail.supplier;
    const outstanding = detail.totals.outstanding;
    const amt = amount != null ? round2(toNumber(amount)) : outstanding;
    if (!(amt > 0)) throw ApiError.badRequest('Payment amount must be greater than zero');
    if (amt > outstanding + 0.001) {
      throw ApiError.badRequest(`You only owe ${s.name} TZS ${outstanding.toLocaleString()}`);
    }
    await assertFunds(tx, accountId, amt, `paying ${s.name}`);
    return recordTransaction(
      {
        accountId,
        clientKey,
        direction: 'OUT',
        type: 'STOCK_PURCHASE',
        amount: amt,
        brandId: s.brandId || null,
        category: 'Supplier Payment',
        description: `Supplier payment — ${s.name}`,
        reference: s.name,
        refType: 'Supplier',
        refId: s.id,
        notes,
        occurredAt,
      },
      actor,
      tx,
      { checkBrand: true },
    );
  }));
}

// Pay a supplier against a purchase order: posts a STOCK_PURCHASE OUT
// transaction from the chosen account (immediately reducing its balance) and
// tracks against the PO so the supplier's outstanding falls. Over-payment is
// blocked.
async function paySupplier(body, actor) {
  const first = await prisma.purchaseOrder.findUnique({ where: { id: body.purchaseOrderId }, select: { supplierId: true } });
  if (!first) throw ApiError.notFound('Purchase order not found');
  // Supplier, then the order, then the account (audit fina00 / perm01): the supplier lock queues every payment
  // that changes his bill, the order lock queues Confirm purchase / Undo purchase / Add cost on this order.
  return withDocNumberRetry(() => prisma.$transaction(async (tx) => {
    await lockSupplier(tx, first.supplierId);
    await tx.$queryRaw`SELECT id FROM "purchase_orders" WHERE id = ${body.purchaseOrderId} FOR UPDATE`;
    return payOrderLocked(tx, body, actor);
  }));
}

async function payOrderLocked(tx, { purchaseOrderId, accountId, amount, notes, occurredAt, clientKey }, actor) {
  const po = await tx.purchaseOrder.findUnique({
    where: { id: purchaseOrderId },
    include: { supplier: { select: { name: true, brandId: true } } },
  });
  if (!po) throw ApiError.notFound('Purchase order not found');
  if (po.status === 'CANCELLED') throw ApiError.badRequest('This purchase order is cancelled');
  // Before what is owed is judged: the first press may have paid it all.
  await assertNotRecorded(tx, accountId, clientKey);
  // What is left on this PO counts the supplier's balance payments and returned goods too (shared over
  // his POs, oldest first), and a PO payment can never take the supplier past what he is owed
  // overall — the same cap as Pay supplier. Before, only this PO's own payments were counted, so a
  // bill already paid as a balance payment could be paid again (audit admin-money-1).
  // Which POs count as owed (ordered vs received) is unchanged here: that is decision D8.
  const detail = await supplierDetail(po.supplierId, { client: tx });
  const row = detail.orders.find((o) => o.id === po.id);
  const onOrder = row ? row.outstanding : 0;
  const owedOverall = detail.totals.outstanding;
  const remaining = Math.max(0, round2(Math.min(onOrder, owedOverall)));
  const amt = amount != null ? round2(toNumber(amount)) : remaining;
  // Why nothing can be paid on it: the supplier is owed nothing in all (he may have been paid beyond the
  // bills, even on another PO — then this PO's own row can still show an amount), or balance payments
  // and returned goods cover this PO.
  const supplierName = po.supplier?.name || 'this supplier';
  const nothingLeft = () => ApiError.badRequest(
    owedOverall < 0 ? `You owe ${supplierName} nothing in all — they have been paid TZS ${Math.abs(owedOverall).toLocaleString()} more than the bills`
      : onOrder > 0 ? `You owe ${supplierName} nothing in all — the payments already made cover every bill`
        : `Nothing is left to pay on ${po.poNumber} — balance payments and returned goods already cover it`,
  );
  if (!(amt > 0)) {
    if (amount == null && remaining <= 0) throw nothingLeft();
    throw ApiError.badRequest('Payment amount must be greater than zero');
  }
  if (amt > remaining + 0.001) {
    if (remaining <= 0) throw nothingLeft();
    if (owedOverall < onOrder) {
      throw ApiError.badRequest(`You only owe ${supplierName} TZS ${owedOverall.toLocaleString()} in all`);
    }
    throw ApiError.badRequest(`Only TZS ${remaining.toLocaleString()} is outstanding on ${po.poNumber}`);
  }
  await assertFunds(tx, accountId, amt, `paying ${po.poNumber}`);
  return recordTransaction(
    {
      accountId,
      clientKey,
      direction: 'OUT',
      type: 'STOCK_PURCHASE',
      amount: amt,
      // Supplier's brand → this spend belongs to that brand's books.
      brandId: po.supplier?.brandId || null,
      category: 'Stock Purchase',
      description: `Supplier payment — ${po.supplier?.name || 'supplier'} (${po.poNumber})`,
      reference: po.poNumber,
      refType: 'PurchaseOrder',
      refId: po.id,
      notes,
      occurredAt,
    },
    actor,
    tx,
    { checkBrand: true },
  );
}

// --- Capital ---------------------------------------------------------------
// "What do I have in this business?" — the balance sheet, in the owner's own
// terms. Deliberately PURE: every input is a figure another screen already
// shows, so this can never invent a number, can be tested without a database,
// and cannot drift from the pages it summarises.
//
// WHAT IT HOLDS   cash in the accounts + stock at what it cost.
// WHAT IT OWES    the supplier's outstanding bill + commission reps can still
//                 withdraw + what the business owes the OWNER.
// YOUR CAPITAL    holds − the outside debts (supplier + reps). Sole owner, so
//                 everything left after outsiders are squared is his.
// WHAT IS LEFT    holds − everything owed, the owner included: the worth the
//                 business has built beyond the money he put in.
//
// Everything here is ALL TIME and as-things-stand-right-now. It never narrows
// to the selected period: a balance sheet that moved when you clicked "Today"
// would not be a balance sheet.
//
// Three double-counts are avoided here on purpose, and each has a test:
//  1. Stock a rep is holding is counted ONCE, as stock at cost. The
//     settlement "outstanding" for those same boxes is their SELLING value —
//     adding it would count the same boxes twice and book unearned profit as
//     an asset. It is reported as `stock.withReps` instead, at cost.
//  2. Commission the owner paid reps is counted ONCE, as money the business
//     owes him. It moves no account balance and is no business spending, so
//     it appears in `owner.commissionFromPocket` and nowhere else.
//  3. An OWNER_CONTRIBUTION posted to fund a rep payout is left out of
//     `intoAccounts` (and out of the cash balance), because the payout it
//     funded is already counted in `commissionFromPocket`.
//
// WHAT CUSTOMERS OWE IS A MEMO, NOT AN ASSET — deliberately.
// Credit collections do not post a finance transaction (credit.service.js
// reduces CreditSale.balance and stops there), so a collected shilling leaves
// the receivable and never arrives in cash. Counted inside the total, that
// makes collecting 50,000 SHRINK the owner's capital by 50,000 — a total that
// moves the wrong way on good news is worse than a total that is missing a
// real asset. So it is carried as `memo.customersOwe`: named, on screen, and
// outside every total until the credit ledger posts cash. Production carries
// roughly 7.18M of it across 73 overdue accounts, so this is not a rounding
// choice — it is the difference between a figure the owner can trust and one
// that argues with him.
// 15 Nov 2026: collections DO post cash now (sales.recordSalePayment — a credit payment or the rest of a part-paid
// sale is received into a chosen account). It stays a memo all the same: most of what is owed is old, overdue
// credit, and money not yet in hand is not counted as the owner's capital until it is.
// What one supplier is owed RIGHT NOW: the cost of what has already SOLD, less
// what he has been paid — never more than he is actually invoiced for.
// Over-payment shows as zero due, not as a negative.
function supplierDueNow({ outstanding, costOfSold, alreadyPaid }) {
  const bill = round2(toNumber(outstanding));
  const earned = round2(toNumber(costOfSold) - toNumber(alreadyPaid));
  return round2(Math.min(bill, Math.max(0, earned)));
}

// The same split across every supplier, driven by ONE map of cost-of-sales.
// The balance sheet must hand it the ALL-TIME map: fed a period's cost of sales
// it answers "what would be due if the business had only ever traded today",
// which is not a thing anybody wants to know and moved when a tab was clicked.
function supplierDueNowAcross(supplierByKey, costByKey) {
  let total = 0;
  for (const [key, sup] of supplierByKey) {
    total += supplierDueNow({
      outstanding: sup.outstanding,
      costOfSold: (costByKey.get(key) || {}).cost || 0,
      alreadyPaid: sup.paid,
    });
  }
  return round2(total);
}

// True for a ledger row that is a RECORD rather than a movement of money: the
// owner's cash, hand to hand, with no business account on either side. Used to
// flag the row for the Ledger; the aggregates use OFF_ACCOUNT_WHERE, which is
// the same rule expressed as a query.
function isOffAccount(txn = {}) {
  return txn.type === 'COMMISSION_PAYMENT'
    || (txn.type === 'OWNER_CONTRIBUTION' && txn.refType === 'CommissionWithdrawal');
}

// Who a commission payout went to, read off the description as a last resort.
// recordCommissionPayment writes `Commission paid — Juma`, so the name is the
// tail. A row written before the name was carried has no tail and this returns
// null rather than inventing one.
function payeeFromDescription(description) {
  const tail = String(description || '').split(/\s+—\s+/)[1];
  return tail ? tail.trim() : null;
}

function buildCapital(input = {}) {
  const v = (x) => round2(toNumber(x));
  const int = (x) => Math.round(toNumber(x));

  // ── What the business holds ────────────────────────────────────────────
  const cash = v(input.cash);
  const stock = {
    // At cost — what the boxes were actually paid for. The basis every other
    // asset here uses, and the only one that is not a guess about the future.
    atCost: v(input.stockAtCost),
    inWarehouse: v(input.stockInWarehouse),
    withReps: v(input.stockWithReps),
    // What the same boxes would bring in at today's selling price. Context,
    // never an asset: nothing has been sold yet.
    atSellingPrice: v(input.stockAtSellingPrice),
    units: int(input.stockUnits),
  };
  const holdsTotal = round2(cash + stock.atCost);

  // ── Owed to the business, but not yet countable ────────────────────────
  const customersOwe = {
    // The UNPAID balance of live credit sales, never the invoice total. A
    // written-off debt is zeroed at source, so it drops out on its own.
    amount: v(input.customersOwe),
    count: int(input.customersOweCount),
  };

  // ── What it owes ───────────────────────────────────────────────────────
  const supplierTotal = v(input.supplierOutstanding);
  // Bonge is paid box by box: only the cost of what has SOLD is due today.
  // The rest of the invoice is still a debt — it simply falls due later.
  const dueNow = round2(Math.min(supplierTotal, Math.max(0, v(input.supplierDueNow))));
  const suppliers = {
    total: supplierTotal,
    dueNow,
    dueLater: round2(supplierTotal - dueNow),
    name: input.supplierLabel || null,
  };
  const reps = v(input.repCommissionPayable);

  // His own money, straight from `ownerFigures()` — one shape for every screen.
  const src = input.owner || {};
  const owner = {
    // (i) Cash he moved INTO a business account. Contributions only; what he
    //     has taken back out is its own line and is never netted in here.
    intoAccounts: v(src.intoAccounts),
    // (ii) Commission he handed reps himself. It never touched an account,
    //      which is exactly why it is a separate line and not merged above.
    commissionFromPocket: v(src.commissionFromPocket),
    drawn: v(src.drawn),
    // Diagnostic only — legacy rows deliberately left out of (i) AND out of the
    // cash balance. Not for display; it exists so the exclusion is testable.
    repFundingExcluded: v(src.repFundingExcluded),
  };
  owner.putIn = round2(owner.intoAccounts + owner.commissionFromPocket);
  owner.total = round2(owner.putIn - owner.drawn);

  const outside = round2(suppliers.total + reps);
  const owesTotal = round2(outside + owner.total);

  // ── What is left ───────────────────────────────────────────────────────
  const yourCapital = round2(holdsTotal - outside);
  const left = round2(holdsTotal - owesTotal); // === yourCapital − owner.total
  // A share only means something when he is actually owed money. When he has
  // drawn more than he put in, `owner.total` is negative and a percentage of
  // his capital "out of his own pocket" would be a negative share of a thing
  // he is not owed — nonsense on screen, so it is zero and the page says why.
  owner.shareOfCapitalPct = yourCapital > 0 && owner.total > 0
    ? round2((owner.total / yourCapital) * 100)
    : 0;

  return {
    holds: {
      cash,
      stock,
      total: holdsTotal,
      lines: [
        { key: 'cash', label: 'Cash in your accounts', amount: cash, hint: 'across every account' },
        { key: 'stock', label: 'Stock you are holding', amount: stock.atCost, hint: 'at what it cost you' },
      ],
    },
    owes: {
      suppliers,
      reps,
      owner,
      outside,
      total: owesTotal,
      lines: [
        { key: 'suppliers', label: `Owed to ${suppliers.name || 'your supplier'}`, amount: suppliers.total, hint: 'stock they financed' },
        { key: 'reps', label: 'Owed to your reps', amount: reps, hint: 'commission and bonus they can withdraw' },
        { key: 'owner', label: 'Owed back to you', amount: owner.total, hint: 'money out of your own pocket' },
      ],
    },
    // Real, owed to the business, and deliberately outside every total above —
    // see the note on this function. The page must say so in words.
    memo: {
      customersOwe,
      note: 'Collecting a credit sale does not yet post money into an account, so this is kept out of the totals — counting it would make your capital fall every time a customer pays you.',
    },
    // What the business is worth to YOU once the outside debts are settled.
    yourCapital,
    // What it has built on top of your own money. Negative means the business
    // is still behind what you have put in.
    left,
  };
}

// --- Finance dashboard -----------------------------------------------------

// `shared` (optional) lets a caller that has already started the same reads hand them in, so one request
// does not compute them twice: { commSummary, valuation, supplierSummaries } are promises of
// commission.summaryAllReps(), inventory.valuation() and supplierSummaries(). Only the dashboard does this.
async function overview(period = 'month', shared = {}) {
  await ensureDefaults();
  // Self-healing sync: fold any business activity not yet in the ledger
  // (historical or missed) into finance before computing. Idempotent by refId.
  // Every read below starts only after it, as before.
  await healLedgerOnRead().catch(() => {});
  const [accounts, prof, inv, commSummary, epoch, bonusSummary] = await Promise.all([
    accountBalances(),
    reports.profitOverview(period),
    shared.valuation || inventory.valuation(),
    shared.commSummary || commission.summaryAllReps(),
    reports.financeEpoch(),
    // The reps' bonus wallets (14 Nov 2026): credited bonus and bonus withdrawals not yet paid are owed too.
    // Read only (`heal: false`): opening Finance never credits anything.
    require('./bonus.service').summaryAllReps({ heal: false }),
  ]);

  const cashPosition = round2(accounts.reduce((s, a) => s + a.balance, 0));

  // Money in / out for each window (from the epoch onward).
  const flowFor = async (p) => {
    const r = periodRange(p);
    const base = epochWhere(r, epoch);
    const [inAgg, outAgg, owner] = await Promise.all([
      prisma.financeTransaction.aggregate({ where: { ...base, direction: 'IN', type: { notIn: NON_TRADE_TYPES } }, _sum: { amount: true } }),
      prisma.financeTransaction.aggregate({ where: { ...base, direction: 'OUT', type: { notIn: NON_TRADE_TYPES } }, _sum: { amount: true } }),
      // The owner's own money is not trade, but the part that went through an
      // account does move the balances. The overview showed only the trading net
      // (2,439,500) directly under the cash held (2,915,500) — the same 476,000
      // gap that made the cash-flow statement disagree with reality. Carried
      // here, in the SHARED shape, so the strip, the cash-flow tab and the
      // balance sheet cannot print three different numbers for the same thing.
      ownerFigures({ start: r ? r.start : null, end: r ? r.end : null }),
    ]);
    const moneyIn = round2(toNumber(inAgg._sum.amount));
    const moneyOut = round2(toNumber(outAgg._sum.amount));
    return {
      moneyIn,
      moneyOut,
      // Account movement only (contributions − drawings). `owner` below is the
      // honest whole; anything labelled "your own money" comes from there.
      ownerNet: owner.accountMovement,
      net: round2(moneyIn - moneyOut),
      // What the accounts actually moved by: trade plus the owner's money.
      netWithOwner: round2(moneyIn - moneyOut + owner.accountMovement),
      // His money in this window, in parts that add up: cash he moved into an
      // account, cash he handed reps, and anything he has taken back out.
      // Never one merged figure — they are different kinds of money.
      owner,
    };
  };
  const FLOW_PERIODS = ['today', 'week', 'month', 'all'];

  // Expenses + breakdown for the selected period.
  const range = periodRange(period);
  const expWhere = { direction: 'OUT', type: 'EXPENSE', ...epochWhere(range, epoch) };

  // Everything else this page shows needs only the period and the epoch, never another read's answer,
  // so it is all asked for at once: one wait instead of ~15 in a row. Each figure below is still worked
  // out from the same query as before, in the same place.
  const [
    flowRows, [expAgg, byCat], [allBrands, brandTxnRows, products],
    [poAgg, poCreditAgg, poPayAgg, wdAgg, pendingApprovals],
    ownerAllTime, lifetime, lifetimeExpAgg, debtAgg, suppliersForSplit, stockSpendRows,
    [periodLosses, lifetimeLosses],
  ] = await Promise.all([
    Promise.all(FLOW_PERIODS.map(flowFor)),
    Promise.all([
      prisma.financeTransaction.aggregate({ where: expWhere, _sum: { amount: true } }),
      prisma.financeTransaction.groupBy({ by: ['category'], where: expWhere, _sum: { amount: true }, _count: true }),
    ]),
    // ── Per-brand finance: each brand's P&L, cash movement and inventory value,
    // computed from real transactions/records only. Scales to any brand count.
    Promise.all([
      prisma.brand.findMany({ where: { isActive: true }, select: { id: true, name: true } }),
      prisma.financeTransaction.groupBy({
        by: ['brandId', 'direction', 'type'],
        // A brand's money in/out has to reconcile to the wallets it moved. Rep
        // commission moved none of them, so it cannot appear in either figure.
        where: { ...epochWhere(range, epoch), type: { notIn: ['COMMISSION_PAYMENT'] } },
        _sum: { amount: true },
      }),
      prisma.product.findMany({ select: { id: true, brandId: true } }),
    ]),
    // What is waiting for the owner, so the Overview can lead with it — the
    // Target-style "needs you" strip: nothing here means genuinely nothing.
    // Payments must be counted against the SAME population as the purchases.
    // Summing every PO payment ever made — including payments against orders
    // later cancelled, which drop out of the purchased side — understated the
    // debt here while the Suppliers tab (which excludes them) showed more.
    prisma.purchaseOrder.findMany({
      where: PAYABLE_PO,
      select: { id: true },
    }).then((livePos) => {
      const livePoIds = livePos.map((x) => x.id);
      return Promise.all([
        prisma.purchaseOrder.aggregate({ where: PAYABLE_PO, _sum: { totalCost: true } }),
        prisma.supplierCredit.aggregate({ _sum: { amount: true } }),
        prisma.financeTransaction.aggregate({
          where: {
            direction: 'OUT',
            OR: [
              { refType: 'PurchaseOrder', refId: { in: livePoIds } },
              { refType: 'Supplier' },
            ],
          },
          _sum: { amount: true },
        }),
        // Approved but not yet paid still waits for the owner's money (audit money-flows-7).
        prisma.commissionWithdrawal.aggregate({ where: { status: { in: ['PENDING', 'APPROVED'] } }, _count: true, _sum: { amount: true } }),
        prisma.settlementSubmission.count({ where: { status: 'PENDING' } }),
      ]);
    }),
    // ALL TIME and epoch-clamped, from the same shared shape the period strip and
    // the cash-flow tab use (see "Where the profit actually IS" below).
    ownerFigures(),
    // All-time earnings, so "taken out" and "still working" compare like with
    // like no matter which period is on screen.
    period === 'all' ? prof : reports.profitOverview('all'),
    prisma.financeTransaction.aggregate({
      where: { direction: 'OUT', type: 'EXPENSE', ...epochWhere(null, epoch) },
      _sum: { amount: true },
    }),
    // What customers still owe on credit sales. The UNPAID balance only, and
    // `balance > 0` is the same test the Debts page uses, so the two screens can
    // never quote different debt. A written-off debt is zeroed at source.
    prisma.creditSale.aggregate({
      where: { balance: { gt: 0 } },
      _sum: { balance: true },
      _count: true,
    }),
    shared.supplierSummaries || supplierSummaries(),
    // What has actually been spent putting stock back — supplier payments and
    // stock purchases, by the brand the money BOUGHT (not the account it left).
    prisma.financeTransaction.groupBy({
      by: ['brandId'],
      where: { direction: 'OUT', type: 'STOCK_PURCHASE' },
      _sum: { amount: true },
    }),
    // Stock lost (written off, or bought and damaged / never received) in the period and since go-live: part of
    // THE net profit (reports.netProfitOf), the same figure the Dashboard and Reports print.
    Promise.all([reports.stockLosses(range), period === 'all' ? null : reports.stockLosses(null)]),
  ]);
  const flow = {};
  FLOW_PERIODS.forEach((p, i) => { flow[p] = flowRows[i]; });

  const expenses = round2(toNumber(expAgg._sum.amount));
  const expenseBreakdown = byCat
    .map((c) => ({ category: c.category || 'Uncategorised', amount: round2(toNumber(c._sum.amount)), count: c._count }))
    .sort((a, b) => b.amount - a.amount);

  const grossProfit = prof.totals.profit;
  // What the boxes earned reps — reported, never subtracted. The owner funds
  // every commission himself, so it never leaves the business's money and
  // cannot reduce what the business made.
  const commissionAccrued = prof.totals.commission;
  const stockLoss = periodLosses.total;
  const netProfit = profitMath.netProfitOf({ grossProfit, expenses, stockLoss });

  // ── Per-brand finance (rows read above).
  const productBrand = new Map(products.map((p) => [p.id, p.brandId]));
  const invByBrand = new Map();
  for (const it of inv.items) {
    const b = productBrand.get(it.productId);
    if (!b) continue;
    const cur = invByBrand.get(b) || { cost: 0, units: 0 };
    cur.cost += it.costValue;
    cur.units += it.totalBase;
    invByBrand.set(b, cur);
  }
  const profByBrand = new Map(prof.byBrand.map((b) => [b.brandId, b]));
  const brandFinance = allBrands.map((b) => {
    const p = profByBrand.get(b.id) || { revenue: 0, cost: 0, profit: 0, boxes: 0, margin: 0, commission: 0 };
    let moneyIn = 0;
    let moneyOut = 0;
    let brandExpenses = 0;
    for (const r of brandTxnRows) {
      if (r.brandId !== b.id) continue;
      const amt = toNumber(r._sum.amount);
      if (r.direction === 'IN') moneyIn += amt;
      else {
        moneyOut += amt;
        // Stock purchases settle a supplier liability — cash out, not P&L.
        if (r.type === 'EXPENSE') brandExpenses += amt;
      }
    }
    const invB = invByBrand.get(b.id) || { cost: 0, units: 0 };
    const brandLoss = periodLosses.byBrand.get(b.id) || 0;
    return {
      brandId: b.id,
      name: b.name,
      revenue: p.revenue,
      cogs: p.cost,
      grossProfit: p.profit,
      margin: p.margin,
      boxesSold: p.boxes,
      // Boxes of this brand sold before a buying price was set: in revenue, not in profit or margin.
      noCost: p.noCost || { boxes: 0, revenue: 0 },
      commission: round2(p.commission || 0),
      expenses: round2(brandExpenses),
      stockLoss: brandLoss,
      netProfit: profitMath.netProfitOf({ grossProfit: p.profit, expenses: brandExpenses, stockLoss: brandLoss }),
      moneyIn: round2(moneyIn),
      moneyOut: round2(moneyOut),
      netCash: round2(moneyIn - moneyOut),
      inventoryValue: round2(invB.cost),
      inventoryUnits: invB.units,
    };
  });

  // ── Where the profit actually IS ────────────────────────────────────────
  // The owner has taken nothing out: every shilling earned went back into
  // stock or to the supplier. "Profit" and "cash" are therefore different
  // numbers, and the page has to say so plainly rather than let the reader
  // assume the profit is sitting in an account.
  //
  // ALL TIME and epoch-clamped, from the same shared shape the period strip and
  // the cash-flow tab use. The balance sheet is "as things stand right now", so
  // it never narrows the window — but it must not use a different POPULATION
  // either, which is what let the same label print 476,000 in one place and
  // 426,000 in another. (ownerAllTime, lifetime and lifetimeExpAgg are read above.)
  const ownerIn = ownerAllTime.intoAccounts;
  const ownerOut = ownerAllTime.drawn;
  // The same net profit as every other screen, over all time (since go-live): gross − expenses − stock lost.
  const earnedAllTime = profitMath.netProfitOf({
    grossProfit: lifetime.totals.profit,
    expenses: round2(toNumber(lifetimeExpAgg._sum.amount)),
    stockLoss: (lifetimeLosses || periodLosses).total,
  });
  // Every shilling of rep commission comes out of the owner's pocket, so the
  // payouts themselves are the record of what he has put in. The business owes
  // him this back when it can afford to. Counted HERE and nowhere else: no
  // balance moves by it and no money-out aggregate includes it.
  const paidRepsFromPocket = ownerAllTime.commissionFromPocket;

  // What customers still owe on credit sales (debtAgg, read above).
  const customersOwe = round2(toNumber(debtAgg._sum.balance));

  const needsYou = {
    // Returned goods come off here too. This aggregate is computed
    // independently of supplierSummaries, so a credit that lands in one and not
    // the other makes the overview card and the supplier modal disagree about
    // the same debt.
    supplierOutstanding: round2(Math.max(0, toNumber(poAgg._sum.totalCost) - toNumber(poCreditAgg._sum.amount || 0) - toNumber(poPayAgg._sum.amount))),
    pendingWithdrawals: { count: wdAgg._count, amount: round2(toNumber(wdAgg._sum.amount)) },
    pendingApprovals,
    negativeAccounts: accounts.filter((a) => a.balance < 0).map((a) => a.name),
  };

  // ── Whose money is this? ────────────────────────────────────────────────
  // The supplier is paid the COST of the boxes that actually SOLD — not the
  // whole stock bill. The rest of his invoice comes due only as the boxes on
  // the shelf sell. Setting aside the entire outstanding balance was wrong:
  // it demanded money the owner does not owe yet, and hid the profit that is
  // genuinely his. Everything above the cost of sold goods is his.
  // (suppliersForSplit is read above.)
  const supplierByBrand = new Map();
  for (const sup of suppliersForSplit) {
    const key = sup.brandId || 'general';
    const row = supplierByBrand.get(key) || { outstanding: 0, paid: 0, name: null };
    row.outstanding = round2(row.outstanding + sup.outstanding);
    row.paid = round2(row.paid + sup.totalPaid);
    if (!row.name && sup.outstanding > 0) row.name = sup.name;
    if (!row.name) row.name = sup.name;
    supplierByBrand.set(key, row);
  }
  const brandNameById = new Map(allBrands.map((b) => [b.id, b.name]));
  const profitByBrandId = new Map((prof.byBrand || []).map((b) => [b.brandId, b]));

  // What has actually been spent putting stock back — supplier payments and
  // stock purchases, by the brand the money BOUGHT (not the account it left).
  // This is what decides whether the cost of the boxes sold has been covered
  // yet, and therefore whether the cash on hand is cost or profit.
  // (stockSpendRows is read above.)
  const stockSpendByBrand = new Map(stockSpendRows.map((r) => [r.brandId || 'general', round2(toNumber(r._sum.amount))]));

  const cashByBrand = new Map();
  for (const a of accounts) {
    const key = a.brandId || 'general';
    const row = cashByBrand.get(key) || { key, cash: 0, moneyIn: 0, moneyOut: 0, accounts: [] };
    row.cash = round2(row.cash + a.balance);
    // What actually moved through this wallet. These DO reconcile to the
    // balance above it; all-time sales figures never could, which is what
    // made the card contradict itself.
    row.moneyIn = round2(row.moneyIn + toNumber(a.moneyIn));
    row.moneyOut = round2(row.moneyOut + toNumber(a.moneyOut));
    row.accounts.push({ name: a.name, balance: a.balance });
    cashByBrand.set(key, row);
  }
  for (const key of supplierByBrand.keys()) {
    if (!cashByBrand.has(key)) cashByBrand.set(key, { key, cash: 0, moneyIn: 0, moneyOut: 0, accounts: [] });
  }

  // ALL-TIME cost of sales by brand. What the supplier is owed today is a fact
  // about the whole bill, so the wallets' "due now" reads it from here, the
  // same map the balance sheet below uses (supplierDueNowAllTime).
  const lifetimeByBrand = new Map((lifetime.byBrand || []).map((b) => [b.brandId, b]));

  const buckets = [...cashByBrand.values()].map((row) => {
    const sup = supplierByBrand.get(row.key) || { outstanding: 0, paid: 0, name: null };
    const p = profitByBrandId.get(row.key) || { cost: 0, commission: 0, profit: 0, revenue: 0 };
    const costOfSold = round2(p.cost);
    const stockSpend = stockSpendByBrand.get(row.key) || 0;
    const costStillToCover = round2(Math.max(0, costOfSold - stockSpend));
    const costPart = round2(Math.min(row.cash, costStillToCover));
    // What the supplier is owed RIGHT NOW: the cost of every box ever sold,
    // less what he has been paid. ALL TIME, like his bill and his payments.
    // Fed this period's cost it moved with the chip: "Today" said none of a
    // 12,118,000 bill was due while "All time" said 2,717,500 was, for the
    // same debt on the same day. The balance sheet's figure is the same sum
    // (supplierDueNowAllTime). Revenue and the cost/profit mix stay per period.
    const lifeCost = round2((lifetimeByBrand.get(row.key) || {}).cost || 0);
    const dueNow = supplierDueNow({ outstanding: sup.outstanding, costOfSold: lifeCost, alreadyPaid: sup.paid });
    // His remaining invoice, which falls due only as shelf stock sells.
    const dueLater = round2(Math.max(0, sup.outstanding - dueNow));
    const paidAhead = round2(Math.max(0, sup.paid - lifeCost));
    // Never below zero: a wallet that is overdrawn has nothing to put aside (it showed "-1 set aside").
    const setAside = round2(Math.max(0, Math.min(row.cash, dueNow)));
    return {
      key: row.key,
      brandName: row.key === 'general' ? 'General business' : (brandNameById.get(row.key) || 'Brand'),
      supplierName: sup.name,
      accounts: row.accounts,
      cash: row.cash,
      moneyIn: row.moneyIn,
      moneyOut: row.moneyOut,
      // Is the cash on hand cost or profit? Split it the same way the SALES
      // split. Money in a wallet has no label on it: every shilling that came
      // in was partly the cost of a box and partly profit, in a fixed ratio,
      // so the money still sitting there carries that same ratio. Saying "the
      // cost is covered, so all of it is profit" was technically defensible
      // and useless — it told the owner he holds pure profit when what he
      // holds is simply what has not been spent yet.
      spentOnStock: stockSpend,
      costStillToCover,
      // The share of every shilling sold that was the cost of the boxes.
      costShare: p.revenue > 0 ? round2((costOfSold / p.revenue) * 100) : 0,
      profitShare: p.revenue > 0 ? round2(((p.revenue - costOfSold) / p.revenue) * 100) : 0,
      costPart: p.revenue > 0 ? round2(row.cash * (costOfSold / p.revenue)) : 0,
      profitPart: p.revenue > 0
        ? round2(row.cash - round2(row.cash * (costOfSold / p.revenue)))
        : row.cash,
      // Profit that has already gone back into stock rather than sitting here.
      profitReinvested: round2(Math.max(0, stockSpend - costOfSold)),
      // What the brand's sales were made of, so "where is the cost and where
      // is the profit" is answered on the row itself.
      revenue: round2(p.revenue),
      costOfSold,
      commission: round2(p.commission || 0),
      profitEarned: round2(p.contribution ?? p.profit),
      // What this wallet's sales left after paying for the boxes. Rep
      // commission is not taken out here: the owner pays that himself, so it
      // never comes out of this money.
      grossKept: round2(p.revenue - p.cost),
      supplierPaid: sup.paid,
      supplierOwedTotal: sup.outstanding,
      dueNow,
      dueLater,
      paidAhead,
      setAside,
      yours: round2(row.cash - setAside),
    };
  }).sort((a, b) => b.cash - a.cash);

  // Name the supplier when there is only one owed, so the cards can say
  // "due to Bonge" rather than the vaguer "suppliers".
  const owedNames = [...new Set(buckets.filter((b) => b.supplierOwedTotal > 0 && b.supplierName).map((b) => b.supplierName))];
  const cashSplit = {
    totalCash: cashPosition,
    supplierLabel: owedNames.length === 1 ? owedNames[0] : 'your suppliers',
    paidAhead: round2(buckets.reduce((a, b) => a + b.paidAhead, 0)),
    setAside: round2(buckets.reduce((a, b) => a + b.setAside, 0)),
    yours: round2(buckets.reduce((a, b) => a + b.yours, 0)),
    dueLater: round2(buckets.reduce((a, b) => a + b.dueLater, 0)),
    // The real figures, uncapped (audit 11 Nov 2026). `setAside` is what a wallet CAN put aside, so it
    // stops at the wallet's cash; "total you owe" was built as setAside + dueLater and lost whatever was
    // due beyond the cash (10,410,000 shown against a 12,000,000 bill). These two are what is owed.
    dueNow: round2(buckets.reduce((a, b) => a + b.dueNow, 0)),
    owedTotal: round2(buckets.reduce((a, b) => a + b.supplierOwedTotal, 0)),
    buckets,
  };

  // ── What the business is really worth ───────────────────────────────────
  // Profit alone answers "did the boxes sell for more than they cost". It
  // does NOT answer "am I ahead", because the stock those boxes came from is
  // partly the supplier's money. Everything the business HOLDS against
  // everything it OWES — the only figure that settles the question.
  // What the reps can actually take: withdrawable balances, requests in
  // flight, and requests already approved but not yet handed over. One figure,
  // used by the capital block and by `outstandingCommission` alike, so no two
  // places on the page can quote a different debt to the same reps. Requests approved but not yet paid
  // are inside `requested` (commission withdrawalTotals counts them as waiting, audit money-flows-7), so
  // they are not added a second time here.
  // The bonus wallets are added in (14 Nov 2026): a credited bonus ready to withdraw, and a bonus
  // withdrawal asked for or approved but not yet paid, are money the reps can take just the same.
  const bonusTotals = (bonusSummary && bonusSummary.totals) || {};
  const repCommissionPayable = round2(
    commSummary.totals.available + commSummary.totals.requested
      + (Number(bonusTotals.available) || 0) + (Number(bonusTotals.pending) || 0),
  );
  // ── The supplier split, ALL TIME ────────────────────────────────────────
  // A balance sheet answers "right now", so what the supplier is owed today
  // must not move when the reader clicks Today or Week, so it is computed from
  // ALL-TIME cost of sales — the same map the wallets' "due now" uses above,
  // so the two always agree. The identity `dueNow + dueLater === total` held
  // throughout and hid this: both halves moved together while the bill stayed
  // all-time.
  const supplierDueNowAllTime = supplierDueNowAcross(supplierByBrand, lifetimeByBrand);

  const capital = buildCapital({
    cash: cashPosition,
    stockAtCost: inv.totals.totalValue,
    stockInWarehouse: inv.totals.warehouseValue,
    // Boxes a rep is holding are still the business's stock, counted here at
    // COST — once, on this line. The settlement balance for the same boxes is
    // their selling value and is deliberately NOT added anywhere.
    stockWithReps: inv.totals.repValue,
    stockAtSellingPrice: inv.totals.retailValue,
    stockUnits: inv.totals.totalBaseUnits,
    customersOwe,
    customersOweCount: debtAgg._count,
    supplierOutstanding: needsYou.supplierOutstanding,
    // Only the cost of what has already SOLD is due today; the rest of the
    // invoice falls due as the shelf empties. ALL-TIME, never the selected
    // period — see supplierDueNowAllTime above.
    supplierDueNow: supplierDueNowAllTime,
    supplierLabel: cashSplit.supplierLabel,
    repCommissionPayable,
    // One shape, one query, all time — the same `ownerFigures()` the period
    // strip and the cash-flow tab read from.
    owner: ownerAllTime,
  });

  // The banner's figures ARE the capital block's, so the two can never read as
  // a contradiction: one arithmetic, quoted in two places.
  const ownerMoney = {
    contributed: capital.owes.owner.intoAccounts,
    paidRepsFromPocket: capital.owes.owner.commissionFromPocket,
    // What the business owes him: money he has laid out, less anything taken.
    owedBackToOwner: capital.owes.owner.total,
    drawn: capital.owes.owner.drawn,
    earnedAllTime,
    stillWorking: round2(earnedAllTime - ownerOut),
    // Where it is working, at cost — the stock the profit turned into.
    stockAtCost: capital.holds.stock.atCost,
    owedToSuppliers: capital.owes.suppliers.total,
    // Which brand he put his cash behind, named for display.
    byBrand: (ownerAllTime.byBrand || []).map((r) => ({
      brandId: r.brandId,
      name: r.brandId ? (brandNameById.get(r.brandId) || 'Unknown brand') : 'Not tagged to a brand',
      amount: r.amount,
    })),
  };

  // Kept as the older name for the same balance sheet, derived from `capital`
  // so it cannot drift. It no longer counts rep-held boxes twice.
  const position = {
    owns: capital.holds.lines,
    owes: capital.owes.lines,
    totalOwns: capital.holds.total,
    totalOwes: capital.owes.total,
    worth: capital.left,
  };

  return {
    period,
    // The go-live moment the figures count from, so "All time" can say where it starts
    // (the Profit tab already does). Sales before it are not in these figures.
    epochAt: epoch || null,
    cashPosition,
    accounts,
    flow,
    needsYou,
    ownerMoney,
    capital,
    position,
    cashSplit,
    brandFinance,
    revenue: prof.totals.revenue,
    cogs: prof.totals.cost,
    boxesSold: prof.totals.boxes,
    grossProfit,
    // Boxes sold before a buying price was set: in revenue, not in profit ("N boxes … — not in profit").
    noCost: prof.totals.noCost,
    commissionAccrued,
    expenses,
    stockLoss,
    netProfit,
    expenseBreakdown,
    byBrand: prof.byBrand,
    // The five products that matter most this period, for the front page —
    // name, boxes, and what each one left in the owner's pocket.
    topProducts: (prof.byProduct || []).slice(0, 5).map((x) => ({
      productId: x.productId,
      name: x.name,
      brandName: x.brandName,
      boxes: x.boxes,
      revenue: x.revenue,
      contribution: x.contribution,
      contributionMargin: x.contributionMargin,
    })),
    // What the business actually owes reps right now: withdrawable balances
    // plus requests in flight. The old figure (earned − paid) included fines
    // the reps will never receive. Same figure the capital block owes.
    outstandingCommission: repCommissionPayable,
    inventoryValue: {
      cost: inv.totals.totalValue,
      selling: inv.totals.retailValue,
      potential: round2(inv.totals.retailValue - inv.totals.totalValue),
      units: inv.totals.totalBaseUnits,
    },
  };
}

module.exports = {
  // The dashboard builds its month-by-month cash series on this.
  flowBetween,
  ensureDefaults,
  backfillFromHistory,
  ledgerGaps,
  healLedgerOnRead,
  accountBalances,
  defaultAccount,
  commissionAccount,
  paymentAccountsForBrand,
  settlementAccountFor,
  COMMISSION_TYPE,
  createAccount,
  updateAccount,
  recordTransaction,
  recordExpense,
  recordIncome,
  recordSaleIncome,
  transferBetweenAccounts,
  recordCommissionPayment,
  recordPayoutFromAccount,
  recordPlainAdjustment,
  accountServesBrand,
  assertFunds,
  reverseTransaction,
  recordOwnerMoney,
  recordBalanceCorrection,
  listTransactions,
  updateTransaction,
  deleteTransaction,
  listCategories,
  createCategory,
  buildCapital,
  ownerFigures,
  supplierDueNow,
  supplierDueNowAcross,
  isOffAccount,
  payeeFromDescription,
  overview,
  cashflow,
  report,
  supplierSummaries,
  supplierDetail,
  spreadOverOrders,
  recordSupplierCredit,
  paySupplier,
  paySupplierBalance,
};
