'use strict';

const prisma = require('../config/prisma');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created, paginated } = require('../utils/response');
const { parsePagination } = require('../utils/pagination');
const inventory = require('../services/inventory.service');
const audit = require('../services/audit.service');
const settlementSvc = require('../services/settlement.service');
const { toNumber, round2 } = require('../utils/money');
const { eatDayBounds } = require('../utils/dates');

// A rep's boxes that an open order still owes come back through a Return on that order, never an
// adjustment or a damage entry: either took them off the rep while the order went on owing them — and
// drawing late fines on boxes he no longer had (audit #23 part b, 11 Nov 2026; the transfer half is in
// transfers.service). Boxes he holds beyond what his open orders owe may still be taken off this way.
async function refuseOwedRepBoxes(tx, { location, productId, baseQuantity }) {
  if (location?.type !== inventory.LOCATION.SALES_REP) return;
  const open = await tx.settlement.findMany({
    where: { salesRepId: location.salesRepId, status: { in: ['OPEN', 'PARTIAL', 'OVERDUE'] } },
  });
  let owed = 0;
  const owing = [];
  for (const stl of open) {
    const left = await settlementSvc.productOutstanding(tx, stl, productId);
    if (left > 0) { owed += left; owing.push(stl.settlementNumber); }
  }
  if (!owed) return;
  const held = await inventory.getBalance(tx, { productId, type: inventory.LOCATION.SALES_REP, salesRepId: location.salesRepId });
  const free = Math.max(0, held - owed);
  if (baseQuantity > free) {
    const product = await tx.product.findUnique({ where: { id: productId }, select: { name: true } });
    throw ApiError.badRequest(
      `${owed} box(es) of ${product?.name || 'this product'} are still owed on order ${owing.join(', ')}. Bring them back with a Return on that order — it closes the order and stops its fines.${free ? ` Only ${free} box(es) can be taken off this way.` : ''}`,
    );
  }
}

// Opening stock into a warehouse (admin only — audit purc05, 15 Nov 2026). Bought cargo never comes in here: it is
// received on its purchase order, which ties the boxes to what was paid and stops the same cargo coming in twice.
// One entry per press of the form: its `clientKey` is kept on the ledger rows, so a double tap or a retry after a
// lost answer finds them and adds nothing.
const stockIn = asyncHandler(async (req, res) => {
  const { warehouseId, items, notes, occurredAt, clientKey } = req.body;
  const type = 'STOCK_IN';
  if (!clientKey) throw ApiError.badRequest('Refresh the page and try again.');

  const warehouse = await prisma.warehouse.findUnique({ where: { id: warehouseId } });
  if (!warehouse) throw ApiError.badRequest('Warehouse not found');

  const result = await prisma.$transaction(async (tx) => {
    // Two presses with the same key wait for each other here; the second then finds the first one's rows.
    if (typeof tx.$executeRaw === 'function') await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`stock-in:${clientKey}`}))`;
    const done = await tx.inventoryTransaction.findFirst({ where: { referenceType: 'MANUAL', referenceId: clientKey }, select: { id: true } });
    if (done) throw ApiError.conflict('This stock was already added — it is in the ledger.');

    const productIds = [...new Set(items.map((i) => i.productId))];
    const products = await tx.product.findMany({ where: { id: { in: productIds } } });
    const pMap = new Map(products.map((p) => [p.id, p]));
    if (pMap.size !== productIds.length) throw ApiError.badRequest('One or more products were not found');
    const off = products.filter((p) => p.isActive === false);
    if (off.length) {
      throw ApiError.badRequest(`${off.map((p) => p.name).join(', ')} ${off.length === 1 ? 'is' : 'are'} switched off. Switch ${off.length === 1 ? 'it' : 'them'} back on in Products before adding stock.`);
    }

    const movements = [];
    for (const item of items) {
      const { baseQuantity } = await inventory.convertToBase(tx, item.productId, item.packagingUnitId, item.quantity);
      const product = pMap.get(item.productId);
      const movement = await inventory.increaseStock(tx, {
        productId: item.productId,
        packagingUnitId: item.packagingUnitId,
        quantity: item.quantity,
        baseQuantity,
        type,
        location: { type: inventory.LOCATION.WAREHOUSE, warehouseId },
        unitCost: item.unitCost != null ? item.unitCost : toNumber(product.purchasePrice),
        referenceType: 'MANUAL',
        referenceId: clientKey,
        userId: req.user.id,
        notes,
        occurredAt: occurredAt ? new Date(occurredAt) : undefined,
      });
      movements.push(movement);
    }
    return movements;
  });

  await audit.record(req, { action: 'STOCK_IN', entityType: 'Warehouse', entityId: warehouseId, newValues: { type, lines: items.length, reason: notes } });
  return created(res, { warehouseId, type, movements: result });
});

// The products of an adjustment or damage entry: the list, or the one product of the old body. Sorted by product
// so two entries saved at the same moment lock the same stock rows in the same order (never wait on each other).
const linesOf = (body) => (body.items || [{ productId: body.productId, packagingUnitId: body.packagingUnitId, quantity: body.quantity }])
  .slice().sort((a, b) => (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0));

// One adjustment or damage entry, every product in ONE transaction: a line that cannot be taken (not enough at
// the place, or boxes an open order still owes) refuses the whole entry, so nothing half-moves.
async function moveLines(req, { type, increase }) {
  const { location, reason, occurredAt } = req.body;
  const lines = linesOf(req.body);
  return prisma.$transaction(async (tx) => {
    const products = await tx.product.findMany({ where: { id: { in: lines.map((l) => l.productId) } }, select: { id: true, purchasePrice: true } });
    const price = new Map(products.map((p) => [p.id, p.purchasePrice]));
    const movements = [];
    for (const line of lines) {
      const { baseQuantity } = await inventory.convertToBase(tx, line.productId, line.packagingUnitId, line.quantity);
      const common = {
        productId: line.productId,
        packagingUnitId: line.packagingUnitId,
        quantity: line.quantity,
        baseQuantity,
        type,
        location,
        unitCost: toNumber(price.get(line.productId)),
        referenceType: 'ADJUSTMENT',
        userId: req.user.id,
        notes: reason,
        occurredAt: occurredAt ? new Date(occurredAt) : undefined,
      };
      if (increase) { movements.push(await inventory.increaseStock(tx, common)); continue; }
      await refuseOwedRepBoxes(tx, { location, productId: line.productId, baseQuantity });
      movements.push(await inventory.decreaseStock(tx, common));
    }
    return { lines, movements };
  });
}

// Manual signed adjustment with a mandatory reason.
const adjust = asyncHandler(async (req, res) => {
  const { direction, reason } = req.body;
  const { lines, movements } = await moveLines(req, { type: 'ADJUSTMENT', increase: direction === 'INCREASE' });
  for (const l of lines) {
    await audit.record(req, { action: 'ADJUSTMENT', entityType: 'Product', entityId: l.productId, newValues: { direction, quantity: l.quantity, reason, ...(lines.length > 1 ? { products: lines.length } : {}) } });
  }
  return created(res, req.body.items ? { movements } : movements[0]);
});

// Write off damaged stock.
const damage = asyncHandler(async (req, res) => {
  const { reason } = req.body;
  const { lines, movements } = await moveLines(req, { type: 'DAMAGE', increase: false });
  for (const l of lines) {
    await audit.record(req, { action: 'DAMAGE', entityType: 'Product', entityId: l.productId, newValues: { quantity: l.quantity, reason, ...(lines.length > 1 ? { products: lines.length } : {}) } });
  }
  return created(res, req.body.items ? { movements } : movements[0]);
});

// Current on-hand balances, grouped by product with per-location breakdown.
const balances = asyncHandler(async (req, res) => {
  const q = req.validatedQuery || req.query;
  const scope = q.scope || 'ALL';

  const [whBalances, repBalances, warehouses, reps, products, shelf] = await Promise.all([
    scope === 'SALES_REP' ? [] : inventory.warehouseBalances(prisma, q.warehouseId),
    scope === 'WAREHOUSE' ? [] : inventory.repBalances(prisma, q.salesRepId),
    prisma.warehouse.findMany({ select: { id: true, name: true } }),
    prisma.salesRepresentative.findMany({ include: { user: { select: { name: true } } } }),
    prisma.product.findMany({
      where: q.productId ? { id: q.productId } : undefined,
      select: { id: true, name: true, sku: true, baseUnitName: true, purchasePrice: true, sellingPrice: true, minStockLevel: true, brand: { select: { id: true, name: true } } },
    }),
    // Low is measured on the warehouse shelves, whatever scope is being viewed — as the stock alerts do.
    inventory.warehouseOnHand(prisma),
  ]);

  const whName = new Map(warehouses.map((w) => [w.id, w.name]));
  const repName = new Map(reps.map((r) => [r.id, r.user?.name || r.code]));
  const pMap = new Map(products.map((p) => [p.id, p]));

  const grouped = new Map();
  const ensure = (productId) => {
    if (!grouped.has(productId)) {
      grouped.set(productId, { productId, locations: [], totalBase: 0 });
    }
    return grouped.get(productId);
  };

  whBalances.forEach((b) => {
    if (q.productId && b.productId !== q.productId) return;
    if (!pMap.has(b.productId) || b.baseQuantity === 0) return;
    const g = ensure(b.productId);
    g.locations.push({ type: 'WAREHOUSE', id: b.warehouseId, name: whName.get(b.warehouseId), baseQuantity: b.baseQuantity });
    g.totalBase += b.baseQuantity;
  });
  repBalances.forEach((b) => {
    if (q.productId && b.productId !== q.productId) return;
    if (!pMap.has(b.productId) || b.baseQuantity === 0) return;
    const g = ensure(b.productId);
    g.locations.push({ type: 'SALES_REP', id: b.salesRepId, name: repName.get(b.salesRepId), baseQuantity: b.baseQuantity });
    g.totalBase += b.baseQuantity;
  });

  // A product with nothing left has no balance rows, so it never reached
  // `grouped` — which meant it vanished from the page entirely and the
  // out-of-stock count could only ever be zero. An empty line is exactly what
  // an inventory page should be showing, so they are added back at zero.
  //
  // Only when looking at everything: a scope or location filter is asking
  // "what is in this place", and a product that is nowhere is not an answer
  // to that.
  const unfiltered = scope === 'ALL' && !q.warehouseId && !q.salesRepId;
  if (unfiltered) {
    for (const prod of products) {
      if (!grouped.has(prod.id)) grouped.set(prod.id, { productId: prod.id, locations: [], totalBase: 0 });
    }
  }

  let rows = [...grouped.values()].map((g) => {
    const p = pMap.get(g.productId);
    return {
      productId: g.productId,
      name: p.name,
      sku: p.sku,
      baseUnitName: p.baseUnitName,
      brandId: p.brand?.id || null,
      brandName: p.brand?.name || null,
      minStockLevel: p.minStockLevel,
      sellingPrice: toNumber(p.sellingPrice),
      lowStock: g.totalBase > 0 && p.minStockLevel > 0 && (shelf.get(g.productId) || 0) <= p.minStockLevel,
      totalBase: g.totalBase,
      value: round2(g.totalBase * toNumber(p.purchasePrice)),
      locations: g.locations.sort((a, b) => b.baseQuantity - a.baseQuantity),
    };
  });

  if (q.brand) {
    const b = q.brand.toLowerCase();
    rows = rows.filter((r) => (r.brandName || '').toLowerCase() === b);
  }
  if (q.search) {
    const s = q.search.toLowerCase();
    rows = rows.filter((r) => r.name.toLowerCase().includes(s) || r.sku.toLowerCase().includes(s));
  }
  rows.sort((a, b) => {
    // Out of stock first, then running low, then by what the stock is worth.
    const rank = (r) => (r.totalBase <= 0 ? 0 : r.lowStock ? 1 : 2);
    return rank(a) - rank(b) || b.value - a.value;
  });

  const pagination = parsePagination(q, { defaultLimit: 50 });
  const total = rows.length;
  const paged = rows.slice(pagination.skip, pagination.skip + pagination.take);

  // Totals and holdings are computed across EVERY row, not the page being sent.
  // A summary drawn from one page would change as you paged through it, which
  // is worse than not showing one.
  const holders = new Map();
  let totalBoxes = 0;
  let totalValue = 0;
  let lowCount = 0;
  let outCount = 0;
  for (const r of rows) {
    totalBoxes += r.totalBase;
    totalValue += r.value;
    if (r.totalBase <= 0) outCount += 1;
    else if (r.lowStock) lowCount += 1;
    const perBox = r.totalBase > 0 ? r.value / r.totalBase : 0;
    for (const loc of r.locations) {
      const key = `${loc.type}:${loc.id}`;
      const h = holders.get(key) || { type: loc.type, id: loc.id, name: loc.name, boxes: 0, value: 0 };
      h.boxes += loc.baseQuantity;
      h.value = round2(h.value + loc.baseQuantity * perBox);
      holders.set(key, h);
    }
  }

  const summary = {
    totalBoxes,
    totalValue: round2(totalValue),
    productCount: rows.length,
    lowCount,
    outCount,
    warehouseBoxes: [...holders.values()].filter((h) => h.type === 'WAREHOUSE').reduce((a, h) => a + h.boxes, 0),
    repBoxes: [...holders.values()].filter((h) => h.type === 'SALES_REP').reduce((a, h) => a + h.boxes, 0),
    holders: [...holders.values()].sort((a, b) => {
      if ((a.type === 'WAREHOUSE') !== (b.type === 'WAREHOUSE')) return a.type === 'WAREHOUSE' ? -1 : 1;
      return b.boxes - a.boxes;
    }),
  };

  // Stock valued at cost is the owner's (audit ui-r03, 15 Nov 2026): staff get the boxes, not what they cost.
  if (req.user?.role !== 'ADMIN') {
    const noValue = ({ value, ...rest }) => rest; // eslint-disable-line no-unused-vars
    const { totalValue: _tv, ...countsOnly } = summary; // eslint-disable-line no-unused-vars
    return paginated(res, paged.map(noValue), {
      page: pagination.page, limit: pagination.limit, total, summary: { ...countsOnly, holders: summary.holders.map(noValue) },
    });
  }
  return paginated(res, paged, { page: pagination.page, limit: pagination.limit, total, summary });
});

// Raw ledger movements (audit trail), paginated and filterable.
const movements = asyncHandler(async (req, res) => {
  const q = req.validatedQuery || req.query;
  const pagination = parsePagination(q, { defaultSortBy: 'occurredAt', defaultSortDir: 'desc', allowedSortFields: ['occurredAt', 'createdAt'] });
  const where = {};
  if (q.productId) where.productId = q.productId;
  if (q.type) where.type = q.type;
  if (q.warehouseId) where.warehouseId = q.warehouseId;
  if (q.salesRepId) where.salesRepId = q.salesRepId;
  if (q.from || q.to) {
    // A bare day is a Dar es Salaam day, not UTC midnight (audit backend-integrity-8).
    const bounds = eatDayBounds({ from: q.from, to: q.to });
    if (!bounds) throw ApiError.badRequest('Use dates like 2026-11-11 for from and to');
    where.occurredAt = bounds;
  }

  const [items, total] = await Promise.all([
    prisma.inventoryTransaction.findMany({
      where,
      include: {
        product: { select: { name: true, sku: true, baseUnitName: true } },
        packagingUnit: { select: { name: true } },
        warehouse: { select: { name: true } },
        salesRep: { include: { user: { select: { name: true } } } },
        user: { select: { name: true } },
      },
      skip: pagination.skip,
      take: pagination.take,
      orderBy: pagination.orderBy,
    }),
    prisma.inventoryTransaction.count({ where }),
  ]);

  return paginated(res, items, { page: pagination.page, limit: pagination.limit, total });
});

const recomputeCaches = asyncHandler(async (req, res) => {
  const result = await inventory.recomputeAllCaches(prisma);
  await audit.record(req, { action: 'RECOMPUTE_CACHE', entityType: 'Inventory' });
  return ok(res, result);
});

module.exports = { stockIn, adjust, damage, balances, movements, recomputeCaches };
