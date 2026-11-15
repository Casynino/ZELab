'use strict';

const prisma = require('../config/prisma');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created, paginated } = require('../utils/response');
const { parsePagination } = require('../utils/pagination');
const { toNumber, round2 } = require('../utils/money');
const audit = require('../services/audit.service');
const { ROLES } = require('../middleware/authorize');
const { isCustomerPhone, CUSTOMER_PHONE_HINT } = require('../validators/people.validator');

// Sales reps only see/manage their own customers.
function repScope(req, where) {
  if (req.user.role === ROLES.SALES_REP && req.user.salesRepId) {
    where.salesRepId = req.user.salesRepId;
  }
  return where;
}

const list = asyncHandler(async (req, res) => {
  const q = req.validatedQuery || req.query;
  const pagination = parsePagination(q, {
    allowedSortFields: ['name', 'createdAt', 'region'],
    defaultSortBy: 'name',
    defaultSortDir: 'asc',
  });
  const where = repScope(req, {});
  if (q.salesRepId && req.user.role === ROLES.ADMIN) where.salesRepId = q.salesRepId;
  if (q.region) where.region = q.region;
  if (q.isActive !== undefined) where.isActive = q.isActive;
  if (q.search) {
    where.OR = [
      { name: { contains: q.search, mode: 'insensitive' } },
      { phone: { contains: q.search, mode: 'insensitive' } },
    ];
  }

  const [items, total] = await Promise.all([
    prisma.customer.findMany({
      where,
      include: {
        salesRep: { include: { user: { select: { name: true } } } },
        // Live sales only (ui-a05): a cancelled sale is no order, the same rule the customer's own page counts by.
        _count: {
          select: {
            sales: { where: { status: { not: 'CANCELLED' } } },
            creditSales: { where: { sale: { is: { status: { not: 'CANCELLED' } } } } },
          },
        },
      },
      skip: pagination.skip,
      take: pagination.take,
      orderBy: pagination.orderBy,
    }),
    prisma.customer.count({ where }),
  ]);
  return paginated(res, items, { page: pagination.page, limit: pagination.limit, total });
});

const get = asyncHandler(async (req, res) => {
  const customer = await prisma.customer.findUnique({
    where: { id: req.params.id },
    include: {
      salesRep: { include: { user: { select: { name: true } } } },
      sales: { orderBy: { soldAt: 'desc' }, take: 20, select: { id: true, saleNumber: true, type: true, total: true, balanceDue: true, status: true, soldAt: true } },
      creditSales: { orderBy: { dueDate: 'asc' }, include: { payments: { orderBy: { paidAt: 'desc' } } } },
    },
  });
  if (!customer) throw ApiError.notFound('Customer not found');
  if (req.user.role === ROLES.SALES_REP && customer.salesRepId !== req.user.salesRepId) {
    throw ApiError.forbidden('This customer is not assigned to you');
  }

  const [purchaseAgg, outstandingAgg] = await Promise.all([
    prisma.sale.aggregate({ where: { customerId: customer.id, status: { not: 'CANCELLED' } }, _sum: { total: true }, _count: true }),
    // What the customer still owes, from the sales themselves (15 Nov 2026, sale02): a credit sale AND the rest of
    // a part-paid cash sale. Only credit sales were counted, so a part-paid sale's debt was on no customer.
    // (sale.balanceDue moves with every payment, credit ones included, and is 0 on a cancelled sale.)
    prisma.sale.aggregate({ where: { customerId: customer.id, status: { not: 'CANCELLED' }, balanceDue: { gt: 0 } }, _sum: { balanceDue: true } }),
  ]);

  return ok(res, {
    ...customer,
    stats: {
      totalPurchases: round2(toNumber(purchaseAgg._sum.total)),
      orderCount: purchaseAgg._count,
      outstandingDebt: round2(toNumber(outstandingAgg._sum.balanceDue)),
    },
  });
});

// One shop, one customer (ui-a06, 15 Nov 2026): a double tap or a second entry made twins that split one shop's
// sales and debts. An exact duplicate — the same name (any case) and the same phone (written any usual way; no
// phone counts as the same "no phone"), among the active customers of the same rep (or of ZELab) — is refused.
const phoneKey = (p) => {
  const d = String(p ?? '').replace(/\D/g, '');
  return d.length >= 9 ? d.slice(-9) : d; // 0712 345 678 = +255 712 345 678
};
const nameKey = (n) => String(n ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

const create = asyncHandler(async (req, res) => {
  const data = { ...req.body, createdById: req.user.id };
  if (req.user.role === ROLES.SALES_REP) data.salesRepId = req.user.salesRepId;
  const customer = await prisma.$transaction(async (tx) => {
    // Two presses at the same moment wait for each other here, so the second one sees the first one's customer.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`customer:${nameKey(data.name)}`}))`;
    const same = await tx.customer.findMany({
      where: { isActive: true, salesRepId: data.salesRepId || null, name: { equals: String(data.name || '').trim(), mode: 'insensitive' } },
      select: { id: true, name: true, phone: true },
    });
    const twin = same.find((c) => nameKey(c.name) === nameKey(data.name) && phoneKey(c.phone) === phoneKey(data.phone));
    if (twin) {
      throw ApiError.conflict(`Already a customer: ${twin.name}${twin.phone ? ` (${twin.phone})` : ''}.`, { customerId: twin.id, code: 'DUPLICATE_CUSTOMER' });
    }
    return tx.customer.create({ data });
  });
  await audit.record(req, { action: 'CREATE', entityType: 'Customer', entityId: customer.id, newValues: { name: customer.name } });
  return created(res, customer);
});

const update = asyncHandler(async (req, res) => {
  const existing = await prisma.customer.findUnique({ where: { id: req.params.id } });
  if (!existing) throw ApiError.notFound('Customer not found');
  if (req.user.role === ROLES.SALES_REP && existing.salesRepId !== req.user.salesRepId) {
    throw ApiError.forbidden('This customer is not assigned to you');
  }
  const data = { ...req.body };
  if (req.user.role === ROLES.SALES_REP) delete data.salesRepId; // reps can't reassign
  // The phone is checked when it changes. The one already saved, even one written before the check
  // (two numbers, a "-"), must not block an edit of the name or the notes.
  if (typeof data.phone === 'string' && data.phone !== String(existing.phone ?? '').trim() && !isCustomerPhone(data.phone)) {
    throw ApiError.unprocessable('Validation failed', [{ path: 'phone', message: CUSTOMER_PHONE_HINT }]);
  }
  const customer = await prisma.customer.update({ where: { id: req.params.id }, data });
  await audit.record(req, { action: 'UPDATE', entityType: 'Customer', entityId: customer.id, oldValues: existing, newValues: data });
  return ok(res, customer);
});

const remove = asyncHandler(async (req, res) => {
  const sales = await prisma.sale.count({ where: { customerId: req.params.id } });
  if (sales > 0) {
    const customer = await prisma.customer.update({ where: { id: req.params.id }, data: { isActive: false } });
    await audit.record(req, { action: 'DEACTIVATE', entityType: 'Customer', entityId: customer.id });
    return ok(res, { ...customer, deactivated: true, reason: 'has sales history' });
  }
  await prisma.customer.delete({ where: { id: req.params.id } });
  await audit.record(req, { action: 'DELETE', entityType: 'Customer', entityId: req.params.id });
  return ok(res, { id: req.params.id, deleted: true });
});

module.exports = { list, get, create, update, remove };
