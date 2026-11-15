'use strict';

const prisma = require('../config/prisma');
const ApiError = require('../utils/ApiError');
const inventory = require('./inventory.service');
const { nextDocNumber, withDocNumberRetry } = require('../utils/numbering');
const { toNumber, round2, formatCurrency } = require('../utils/money');
const env = require('../config/env');

// Average cost (15 Nov 2026): when new boxes come in, a product's cost per box becomes the average of what was paid
// for every box held — warehouse and reps — so a cheaper batch lowers the cost (more profit on every sale) and a dearer
// one raises it. Every sale records the cost at that moment, so past profits never move. Called BEFORE the new boxes
// are added. Selling prices are never touched.
async function averageCostAfter(tx, productId, addBase, addCost) {
  const [held, product] = await Promise.all([
    tx.inventoryTransaction.aggregate({ where: { productId }, _sum: { baseQuantity: true } }),
    tx.product.findUnique({ where: { id: productId }, select: { purchasePrice: true } }),
  ]);
  const onHand = Math.max(0, held._sum.baseQuantity || 0);
  const current = toNumber(product?.purchasePrice);
  if (!(onHand > 0) || !(current > 0)) return round2(addCost);
  return round2((onHand * current + addBase * addCost) / (onHand + addBase));
}

// Six places: a carton price divided by the boxes in a carton (e.g. 100,000 / 24) must multiply back to exactly
// what was typed once the line total is rounded to shillings.
const round6 = (n) => Math.round((Number(n) || 0) * 1e6) / 1e6;

// --- Suppliers -------------------------------------------------------------

async function listSuppliers(filters, pagination) {
  const where = {};
  if (filters.isActive !== undefined) where.isActive = filters.isActive;
  if (filters.search) where.name = { contains: filters.search, mode: 'insensitive' };
  const [items, total] = await Promise.all([
    prisma.supplier.findMany({ where, include: { _count: { select: { purchaseOrders: true } } }, skip: pagination.skip, take: pagination.take, orderBy: pagination.orderBy }),
    prisma.supplier.count({ where }),
  ]);
  return { items, total };
}

async function createSupplier(data) {
  return prisma.supplier.create({ data });
}
async function updateSupplier(id, data) {
  const s = await prisma.supplier.findUnique({ where: { id } });
  if (!s) throw ApiError.notFound('Supplier not found');
  if (data.isActive === false && s.isActive) await assertSupplierSettled(s);
  return prisma.supplier.update({ where: { id }, data });
}

// A supplier with money still open — owed to him, or paid beyond his bills — is not switched off or deleted
// (audit perm03): he would drop out of the new-order picker and the Suppliers tab with the balance unexplained.
// The rule the Suppliers tab already showed ("only once nothing is owed") now holds on the server.
async function assertSupplierSettled(s) {
  const finance = require('./finance.service'); // lazy: avoids an import cycle
  const { totals } = await finance.supplierDetail(s.id);
  if (Math.abs(totals.outstanding) >= 0.5) {
    const tzs = (n) => `TZS ${Math.abs(n).toLocaleString('en-US')}`;
    throw ApiError.badRequest(totals.outstanding > 0
      ? `${s.name} is still owed ${tzs(totals.outstanding)}. Pay the balance first, then switch the supplier off.`
      : `${s.name} has been paid ${tzs(totals.outstanding)} more than the bills. Settle that first, then switch the supplier off.`);
  }
}
// Remove a supplier. One with history — purchase orders, goods sent back, or balance payments — is
// switched off instead, so the money stays explained, and the answer says which happened (audit
// money-flows-8: it answered 200 either way, and a supplier with returns but no PO was deleted along
// with its returns).
async function removeSupplier(id) {
  const s = await prisma.supplier.findUnique({ where: { id } });
  if (!s) throw ApiError.notFound('Supplier not found');
  await assertSupplierSettled(s);
  const [orders, credits, payments] = await Promise.all([
    prisma.purchaseOrder.count({ where: { supplierId: id } }),
    prisma.supplierCredit.count({ where: { supplierId: id } }),
    prisma.financeTransaction.count({ where: { refType: 'Supplier', refId: id } }),
  ]);
  if (orders + credits + payments > 0) {
    const updated = await prisma.supplier.update({ where: { id }, data: { isActive: false } });
    const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
    const history = [
      orders && n(orders, 'purchase order', 'purchase orders'),
      credits && n(credits, 'return', 'returns'),
      payments && n(payments, 'balance payment', 'balance payments'),
    ].filter(Boolean).join(', ');
    return {
      ...updated,
      deleted: false,
      deactivated: true,
      message: `${s.name} has ${history}, so it was switched off, not deleted. Its history stays; switch it back on in Edit supplier.`,
    };
  }
  await prisma.supplier.delete({ where: { id } });
  return { id, name: s.name, deleted: true, deactivated: false, message: `${s.name} deleted.` };
}

// --- Purchase orders -------------------------------------------------------

const PO_INCLUDE = {
  supplier: true,
  warehouse: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
  items: { include: { product: { select: { id: true, name: true, sku: true, baseUnitName: true, brandId: true } }, packagingUnit: true } },
  receipts: { include: { items: true }, orderBy: { createdAt: 'asc' } },
};

// Where an order stands, in words, for the refusals below.
const PO_STATE = {
  DRAFT: 'still a draft',
  ORDERED: 'ordered but not paid',
  PURCHASED: 'already bought',
  IN_TRANSIT: 'already bought and on its way',
  PARTLY_RECEIVED: 'partly received',
  RECEIVED: 'already received',
  CANCELLED: 'cancelled',
};
// Before the money is paid: the lines can still change, the order can be deleted or cancelled.
const NOT_YET_BOUGHT = ['DRAFT', 'ORDERED'];
// Bought and on its way (or partly in): it can be received. Confirm purchase puts an order straight on its way
// (Nino, 15 Nov 2026: "once I confirm purchased, no need to press dispatch"); PURCHASED is only an order confirmed
// in the hours before that, treated the same.
const ARRIVING = ['PURCHASED', 'IN_TRANSIT', 'PARTLY_RECEIVED'];

// Goods cannot be expected before they were ordered (a PO dated "ordered 20 Nov, arriving 1 Nov" was
// accepted; audit, 11 Nov 2026). Compared by calendar day, so the same day is fine whatever the time.
function assertArrivalNotBeforeOrder(orderedAt, expectedArrival) {
  if (!orderedAt || !expectedArrival) return;
  const day = (d) => new Date(d).toISOString().slice(0, 10);
  if (Number.isNaN(new Date(orderedAt).getTime()) || Number.isNaN(new Date(expectedArrival).getTime())) return;
  if (day(expectedArrival) < day(orderedAt)) {
    throw ApiError.badRequest('Expected arrival cannot be before the order date.');
  }
}

async function createPurchaseOrder(payload, actor) {
  if (!payload.items || payload.items.length === 0) {
    throw ApiError.badRequest('A purchase order needs at least one item');
  }
  // Cash-only (15 Nov 2026): a new order is a draft and no money moves until Confirm purchase. An older
  // screen that still sends a payment with the order is refused outright rather than half-obeyed.
  if (payload.payment) {
    throw ApiError.badRequest('Money is paid with Confirm purchase, not when the order is created. Refresh the page and try again.');
  }
  assertArrivalNotBeforeOrder(payload.orderedAt, payload.expectedArrival);
  return prisma.$transaction(async (tx) => {
    const lines = [];
    for (const i of payload.items) {
      const { baseQuantity } = await inventory.convertToBase(tx, i.productId, i.packagingUnitId, i.quantity);
      lines.push({
        productId: i.productId,
        packagingUnitId: i.packagingUnitId,
        quantity: i.quantity,
        baseQuantity,
        unitCost: round6(i.unitCost || 0), // goods cost per base unit, precise enough for a carton price / boxes
      });
    }
    const goodsCost = round2(lines.reduce((s, l) => s + l.unitCost * l.baseQuantity, 0));
    const shippingCost = round2(payload.shippingCost || 0);
    const clearingCost = round2(payload.clearingCost || 0);
    const otherCost = round2(payload.otherCost || 0);
    const totalCost = round2(goodsCost + shippingCost + clearingCost + otherCost);

    const poNumber = await nextDocNumber(tx.purchaseOrder, 'poNumber', 'PO');
    const po = await tx.purchaseOrder.create({
      data: {
        poNumber,
        supplierId: payload.supplierId,
        status: 'DRAFT', // bought only when Confirm purchase pays for it
        // Every figure on the form is in shillings (audit reversals-stock-8: a PO saved from Purchases was
        // labelled USD while Finance's were TZS).
        currency: payload.currency || env.business.currency || 'TZS',
        goodsCost,
        shippingCost,
        clearingCost,
        otherCost,
        totalCost,
        warehouseId: payload.warehouseId || null,
        orderedAt: payload.orderedAt ? new Date(payload.orderedAt) : null,
        expectedArrival: payload.expectedArrival ? new Date(payload.expectedArrival) : null,
        notes: payload.notes || null,
        createdById: actor ? actor.id : null,
        items: { create: lines },
      },
    });

    return tx.purchaseOrder.findUnique({ where: { id: po.id }, include: PO_INCLUDE });
  });
}

async function listPurchaseOrders(filters, pagination) {
  const where = {};
  if (filters.status) where.status = filters.status;
  if (filters.supplierId) where.supplierId = filters.supplierId;
  if (filters.productId) where.items = { some: { productId: filters.productId } };
  if (filters.from || filters.to) {
    where.createdAt = {
      ...(filters.from ? { gte: new Date(`${filters.from}T00:00:00+03:00`) } : {}),
      ...(filters.to ? { lte: new Date(`${filters.to}T23:59:59.999+03:00`) } : {}),
    };
  }
  // The tab counts ignore the status being viewed (each tab shows its own number), not the other filters.
  const { status: _viewing, ...countWhere } = where; // eslint-disable-line no-unused-vars
  const [items, total, incoming, byStatus] = await Promise.all([
    prisma.purchaseOrder.findMany({ where, include: PO_INCLUDE, skip: pagination.skip, take: pagination.take, orderBy: pagination.orderBy }),
    prisma.purchaseOrder.count({ where }),
    // Stock that is bought but has not landed: ordered or in transit, never
    // received or cancelled. It is real — it is paid for or owed for — but it
    // is not inventory yet, so it belongs in its own count rather than
    // silently missing from the page until the day it arrives.
    // Bought and not all in yet. A draft is not bought, so it is not on the way (cash-only, 15 Nov 2026);
    // ORDERED is an older order placed before Confirm purchase existed.
    prisma.purchaseOrder.findMany({
      where: { status: { in: ['ORDERED', ...ARRIVING] } },
      include: { items: true, supplier: { select: { name: true } } },
      orderBy: { expectedArrival: 'asc' },
    }),
    prisma.purchaseOrder.groupBy({ by: ['status'], where: countWhere, _count: true }),
  ]);
  const counts = Object.fromEntries(byStatus.map((r) => [r.status, r._count]));

  const boxesOf = (po) => (po.items || []).reduce((n, it) => n + (it.baseQuantity || 0), 0);
  // Still to come: what was bought less what a confirmed check-in already brought in.
  const leftOf = (po) => (po.items || []).reduce((n, it) => n + Math.max(0, (it.baseQuantity || 0) - (it.receivedBase || 0)), 0);
  const withBoxes = items.map((po) => ({ ...po, boxes: boxesOf(po) }));
  const onTheWay = {
    orders: incoming.length,
    boxes: incoming.reduce((n, po) => n + leftOf(po), 0),
    value: round2(incoming.reduce((n, po) => n + (boxesOf(po) > 0 ? toNumber(po.totalCost) * (leftOf(po) / boxesOf(po)) : 0), 0)),
    nextArrival: incoming.find((po) => po.expectedArrival)?.expectedArrival || null,
    orders_: incoming.map((po) => ({
      id: po.id,
      poNumber: po.poNumber,
      supplier: po.supplier?.name || null,
      status: po.status,
      boxes: leftOf(po),
      totalCost: round2(toNumber(po.totalCost)),
      expectedArrival: po.expectedArrival,
    })),
  };
  return { items: withBoxes, total, onTheWay, counts };
}

async function getPurchaseOrder(id) {
  const po = await prisma.purchaseOrder.findUnique({ where: { id }, include: PO_INCLUDE });
  if (!po) throw ApiError.notFound('Purchase order not found');
  // The money and the people behind each step, so the order is traceable on its own page.
  const [payments, people] = await Promise.all([
    prisma.financeTransaction.findMany({
      where: { refType: 'PurchaseOrder', refId: id },
      select: { id: true, txnNumber: true, direction: true, amount: true, category: true, occurredAt: true, account: { select: { name: true } } },
      orderBy: { occurredAt: 'asc' },
    }),
    prisma.user.findMany({
      where: { id: { in: [po.purchasedById, ...po.receipts.map((r) => r.receivedById)].filter(Boolean) } },
      select: { id: true, name: true },
    }),
  ]);
  const nameOf = new Map(people.map((u) => [u.id, u.name]));
  return {
    ...po,
    // What Confirm purchase would take now (older orders may already be paid through the supplier's balance).
    toPay: NOT_YET_BOUGHT.includes(po.status) ? await stillToPay(prisma, po) : 0,
    purchasedBy: nameOf.get(po.purchasedById) || null,
    receipts: po.receipts.map((r) => ({ ...r, receivedBy: nameOf.get(r.receivedById) || null })),
    payments: payments.map((t) => ({ ...t, amount: round2(toNumber(t.amount)), account: t.account?.name || null })),
  };
}

// Money paid against one order (PO-level payments only).
async function paidOnOrder(id) {
  const paid = await prisma.financeTransaction.aggregate({
    where: { refType: 'PurchaseOrder', refId: id, direction: 'OUT' },
    _sum: { amount: true },
  });
  return round2(toNumber(paid._sum.amount));
}

// An order cannot shrink below what was paid against it (audit reversals-stock-2): an edit from
// 50,000 down to 10,000 with 40,000 paid left the order, and the supplier, quietly overpaid.
function assertNotBelowPaid(paidOnThis, newTotal) {
  if (newTotal < paidOnThis - 0.001) {
    throw ApiError.badRequest(
      `${formatCurrency(paidOnThis)} has been paid against this order; the new total ${formatCurrency(newTotal)} is less. Correct the payment in Finance first.`,
    );
  }
}

// What the supplier would be owed once this order counts for `newTotal` instead of its total today
// (0 when it is deleted, cancelled or moved to another supplier), by the supplier window's own formula:
// orders − goods returned − every payment, on an order or on the balance. Refused when that goes below
// zero (audit reversals-stock-3): deleting an order after a balance payment left the supplier overpaid
// with nothing said, and the next payment was refused with "You only owe … TZS -10,000".
// `leaving` is true when the order and its own payments leave this supplier's books together.
async function assertSupplierNotOverpaid(po, newTotal, { leaving = false, action }) {
  // A cancelled order already counts nowhere, and a draft is not bought yet (finance's PAYABLE_PO), so
  // dropping either cannot leave the supplier overpaid.
  if (po.status === 'CANCELLED' || po.status === 'DRAFT' || !po.supplierId) return;
  const drop = round2(toNumber(po.totalCost) - newTotal);
  if (!(drop > 0)) return;
  const paidOnThis = leaving ? await paidOnOrder(po.id) : 0;
  const finance = require('./finance.service'); // lazy: avoids an import cycle
  const [{ supplier, totals }, balance] = await Promise.all([
    finance.supplierDetail(po.supplierId),
    prisma.financeTransaction.aggregate({
      where: { refType: 'Supplier', refId: po.supplierId, direction: 'OUT' },
      _sum: { amount: true },
    }),
  ]);
  const after = round2(totals.outstanding - drop + paidOnThis);
  if (after < -0.001) {
    const onBalance = round2(toNumber(balance._sum.amount));
    throw ApiError.badRequest(
      `${action} would leave ${supplier.name} overpaid by ${formatCurrency(-after)}: ${formatCurrency(totals.paid)} has been paid to them`
      + `${onBalance > 0 ? ` (${formatCurrency(onBalance)} of it on the balance)` : ''}. Correct that payment in Finance first.`,
    );
  }
}

// Edit, cancel and delete lock the order row first, like every money step: an edit read as DRAFT while a
// Confirm purchase was paying could otherwise write CANCELLED over a paid order (review, 15 Nov 2026).
async function updatePurchaseOrder(id, payload) {
  return prisma.$transaction(async (tx) => {
    await lockOrder(tx, id);
    return updateLockedOrder(tx, id, payload);
  }, { timeout: 20000 });
}

async function updateLockedOrder(tx, id, payload) {
  const po = await tx.purchaseOrder.findUnique({ where: { id } });
  if (!po) throw ApiError.notFound('Purchase order not found');
  if (po.status === 'RECEIVED') throw ApiError.badRequest('A received purchase order cannot be edited');
  // Received is reached only by receiving (audit #40): marking it here left the order "received" with
  // no stock ever brought in, and Receive then refused it as already received.
  if (payload.status === 'RECEIVED') {
    throw ApiError.badRequest('Use Receive to mark it received — that is what brings the stock into the warehouse.');
  }
  // The steps have their own buttons (Confirm purchase, Dispatch, Check in): an edit can only cancel.
  if (payload.status !== undefined && payload.status !== po.status && payload.status !== 'CANCELLED') {
    throw ApiError.badRequest('Use the order\'s own buttons to move it on: Confirm purchase, Dispatch, Check in.');
  }
  // Once paid for, what was bought and what it cost are locked (cash-only, 15 Nov 2026). Notes and the
  // expected arrival can still be updated; a wrong price or quantity is corrected through Finance (remove
  // the payment, which reopens nothing on its own) — never silently here.
  if (!NOT_YET_BOUGHT.includes(po.status) && po.status !== 'CANCELLED') {
    const locked = ['items', 'supplierId', 'shippingCost', 'clearingCost', 'otherCost', 'warehouseId', 'orderedAt', 'currency']
      .filter((k) => payload[k] !== undefined);
    if (locked.length) {
      throw ApiError.badRequest(`${po.poNumber} is ${PO_STATE[po.status]}: its products, quantities and prices are locked. Only the notes and the expected arrival can change. Add shipping or clearing with Add cost.`);
    }
    if (payload.status === 'CANCELLED' && ARRIVING.includes(po.status)) {
      throw ApiError.badRequest(`${po.poNumber} is bought and on its way — it cannot be cancelled. Use Undo purchase if it was confirmed by mistake, or receive it and mark what never came as missing.`);
    }
  }

  // A PO with money already paid against it cannot simply be cancelled:
  // cancelling removes it from "purchased" AND its payments from "paid" at
  // once, so the supplier's outstanding balance quietly swallows real money.
  // The payments must be reversed (or moved to the supplier's balance) first.
  const cancelling = payload.status === 'CANCELLED' && po.status !== 'CANCELLED';
  if (cancelling) {
    const paid = await paidOnOrder(id);
    if (paid > 0) {
      throw ApiError.badRequest(
        `${formatCurrency(paid)} has been paid against this order. Delete or reassign those payments in Finance before cancelling, or the supplier balance would silently absorb them.`,
      );
    }
    // Balance payments are the supplier's, not this order's: cancelling must not leave him overpaid.
    await assertSupplierNotOverpaid(po, 0, { leaving: true, action: `Cancelling ${po.poNumber}` });
  }
  // Moving the order to another supplier takes it, and its own payments, off this supplier's books.
  if (!cancelling && payload.supplierId && payload.supplierId !== po.supplierId) {
    await assertSupplierNotOverpaid(po, 0, { leaving: true, action: `Moving ${po.poNumber} to another supplier` });
  }

  const data = {};
  ['status', 'currency', 'notes', 'warehouseId', 'supplierId'].forEach((f) => {
    if (payload[f] !== undefined) data[f] = payload[f];
  });
  ['orderedAt', 'expectedArrival'].forEach((f) => {
    if (payload[f] !== undefined) data[f] = payload[f] ? new Date(payload[f]) : null;
  });
  // Only when a date is being changed, checked against the stored one when just one is sent — an
  // edit of anything else on an older order is never refused for its dates.
  if (data.orderedAt !== undefined || data.expectedArrival !== undefined) {
    assertArrivalNotBeforeOrder(
      data.orderedAt !== undefined ? data.orderedAt : po.orderedAt,
      data.expectedArrival !== undefined ? data.expectedArrival : po.expectedArrival,
    );
  }
  ['shippingCost', 'clearingCost', 'otherCost'].forEach((f) => {
    if (payload[f] !== undefined) data[f] = round2(payload[f]);
  });
  if (data.shippingCost != null || data.clearingCost != null || data.otherCost != null) {
    const shipping = data.shippingCost ?? toNumber(po.shippingCost);
    const clearing = data.clearingCost ?? toNumber(po.clearingCost);
    const other = data.otherCost ?? toNumber(po.otherCost);
    data.totalCost = round2(toNumber(po.goodsCost) + shipping + clearing + other);
  }
  // A new total, from the costs above or from new lines below, is checked before anything is written.
  const checkNewTotal = async (newTotal) => {
    if (cancelling) return; // a cancel was checked above
    assertNotBelowPaid(await paidOnOrder(id), newTotal);
    // Only while the order stays with this supplier; a move was checked above.
    if (!payload.supplierId || payload.supplierId === po.supplierId) {
      await assertSupplierNotOverpaid(po, newTotal, { action: `Lowering ${po.poNumber} to ${formatCurrency(newTotal)}` });
    }
  };
  if (data.totalCost !== undefined && !payload.items) await checkNewTotal(data.totalCost);
  // Correcting the lines while the order has not landed: replace them
  // wholesale and reprice, the same way the order was costed when created. A
  // received order never reaches here — it is refused above, because its
  // boxes are already on the shelf at a cost derived from these lines.
  if (payload.items) {
    {
      const lines = [];
      for (const i of payload.items) {
        const { baseQuantity } = await inventory.convertToBase(tx, i.productId, i.packagingUnitId, i.quantity);
        // Same shape createPurchaseOrder writes — there is no lineTotal column
        // on a purchase line; the goods total is derived from unitCost x
        // baseQuantity, exactly as it is on create.
        lines.push({
          productId: i.productId,
          packagingUnitId: i.packagingUnitId,
          quantity: i.quantity,
          baseQuantity,
          unitCost: round6(i.unitCost || 0),
        });
      }
      const goodsCost = round2(lines.reduce((sum, l) => sum + l.unitCost * l.baseQuantity, 0));
      const shipping = data.shippingCost ?? toNumber(po.shippingCost);
      const clearing = data.clearingCost ?? toNumber(po.clearingCost);
      const other = data.otherCost ?? toNumber(po.otherCost);
      const totalCost = round2(goodsCost + shipping + clearing + other);
      await checkNewTotal(totalCost);
      await tx.purchaseOrderItem.deleteMany({ where: { purchaseOrderId: id } });
      return tx.purchaseOrder.update({
        where: { id },
        data: {
          ...data,
          goodsCost,
          totalCost,
          items: { create: lines },
        },
        include: PO_INCLUDE,
      });
    }
  }

  return tx.purchaseOrder.update({ where: { id }, data, include: PO_INCLUDE });
}

// Delete a purchase order outright. Only ever safe before it lands: once
// received its boxes are on the shelf and its cost is inside every profit
// figure, so removing the order would strand the stock with no origin. Money
// paid against it blocks deletion too — the payment would survive its reason.
async function deletePurchaseOrder(id) {
  return prisma.$transaction(async (tx) => {
    await lockOrder(tx, id);
    return deleteLockedOrder(tx, id);
  }, { timeout: 20000 });
}

async function deleteLockedOrder(tx, id) {
  const po = await tx.purchaseOrder.findUnique({ where: { id } });
  if (!po) throw ApiError.notFound('Purchase order not found');
  if (po.status === 'RECEIVED') {
    throw ApiError.badRequest('This order has already been received — its boxes are in the warehouse. Adjust the stock instead of deleting the order it came from.');
  }
  // Paid for, on its way or partly in: the money and the cargo both need it, so it stays.
  if (!NOT_YET_BOUGHT.includes(po.status) && po.status !== 'CANCELLED') {
    throw ApiError.badRequest(`${po.poNumber} is ${PO_STATE[po.status]} — it cannot be deleted. Only a draft can.`);
  }
  const paid = await paidOnOrder(id);
  if (paid > 0) {
    throw ApiError.badRequest(
      `${formatCurrency(paid)} has been paid against this order. Remove those payments in Finance first, or the money would outlive its reason.`,
    );
  }
  // Money has moved for it, even if it was reversed since (an undone purchase): the order stays as the reason
  // for those ledger entries. Cancel it instead.
  if (await tx.financeTransaction.count({ where: { refType: 'PurchaseOrder', refId: id } })) {
    throw ApiError.badRequest(`${po.poNumber} has payments in the ledger (reversed or not), so it stays as their record. Cancel it instead.`);
  }
  // Balance payments are the supplier's, not this order's: deleting it must not leave him overpaid.
  await assertSupplierNotOverpaid(po, 0, { leaving: true, action: `Deleting ${po.poNumber}` });
  await tx.purchaseOrder.delete({ where: { id } });
  return po;
}

// Receive a PO into the warehouse: allocate shipping/clearing/other across
// lines (by goods value) to get a landed unit cost, post PURCHASE_RECEIPT
// ledger entries, and update each product's cost to the latest landed cost.
// `stockAlreadyCounted` receives the PO as documentation of stock that is
// ALREADY in the system (e.g. attributing existing inventory to its supplier):
// the purchase + supplier debt are recorded, but no stock moves and the
// product cost basis is left untouched.
async function receivePurchaseOrder(id, actor, { actualArrival, stockAlreadyCounted } = {}) {
  return prisma.$transaction(async (tx) => {
    const po = await tx.purchaseOrder.findUnique({ where: { id }, include: { items: true } });
    if (!po) throw ApiError.notFound('Purchase order not found');
    // 409, like the claim below: a retry after a lost answer finds it received, and the screens treat
    // that as done instead of saying it is not received yet (audit reversals-stock-5).
    if (po.status === 'RECEIVED') throw ApiError.conflict('This purchase order was already received.');
    if (po.status === 'CANCELLED') throw ApiError.badRequest('Cancelled purchase order cannot be received');
    if (po.items.length === 0) throw ApiError.badRequest('Purchase order has no items');
    // One-step receiving is kept only for orders made before the cash-only flow (15 Nov 2026). A draft has
    // not been bought, and an order bought with Confirm purchase comes in through the warehouse check-in.
    if (po.status === 'DRAFT' || po.purchasedAt || !['ORDERED', 'IN_TRANSIT'].includes(po.status)) {
      throw ApiError.badRequest('Confirm the purchase, dispatch it, then receive the cargo when it arrives — that is what brings the boxes into stock.');
    }
    if (await tx.purchaseReceipt.count({ where: { purchaseOrderId: id } })) {
      throw ApiError.badRequest('Part of this order has already been received — receive the rest the same way.');
    }
    // Claim it before any stock moves (audit #41): two clicks on Receive used to both pass the check
    // above and both bring the stock in. The second one now waits for the first, finds it received,
    // and stops here with nothing written.
    // Only the states one-step receiving may start from: when it waits behind a Receive cargo on the same order,
    // Postgres re-checks this after that commits, finds PARTLY_RECEIVED, and nothing is brought in twice.
    const claimed = await tx.purchaseOrder.updateMany({
      where: { id, status: { in: ['ORDERED', 'IN_TRANSIT'] }, purchasedAt: null },
      data: { status: 'RECEIVED' },
    });
    if (claimed.count !== 1) throw ApiError.conflict('This purchase order was already received.');

    let warehouseId = po.warehouseId;
    if (!warehouseId) {
      const wh = await tx.warehouse.findFirst({ where: { isActive: true }, orderBy: { isPrimary: 'desc' } });
      if (!wh) throw ApiError.badRequest('No warehouse to receive into');
      warehouseId = wh.id;
    }

    const extraCost = toNumber(po.shippingCost) + toNumber(po.clearingCost) + toNumber(po.otherCost);
    const goodsTotal = po.items.reduce((s, it) => s + toNumber(it.unitCost) * it.baseQuantity, 0);
    const baseTotal = po.items.reduce((s, it) => s + it.baseQuantity, 0);

    for (const it of po.items) {
      const lineGoods = toNumber(it.unitCost) * it.baseQuantity;
      // Allocate extra by goods value, or by quantity if goods value is zero.
      const share = goodsTotal > 0 ? lineGoods / goodsTotal : baseTotal > 0 ? it.baseQuantity / baseTotal : 0;
      const allocated = extraCost * share;
      const landedUnitCost = round2(toNumber(it.unitCost) + (it.baseQuantity > 0 ? allocated / it.baseQuantity : 0));

      const averaged = stockAlreadyCounted ? null : await averageCostAfter(tx, it.productId, it.baseQuantity, landedUnitCost);
      if (!stockAlreadyCounted) {
        await inventory.increaseStock(tx, {
          productId: it.productId,
          packagingUnitId: it.packagingUnitId,
          quantity: it.quantity,
          baseQuantity: it.baseQuantity,
          type: 'PURCHASE_RECEIPT',
          location: { type: inventory.LOCATION.WAREHOUSE, warehouseId },
          unitCost: landedUnitCost,
          referenceType: 'PURCHASE',
          referenceId: po.id,
          userId: actor ? actor.id : null,
          notes: `Received PO ${po.poNumber}`,
        });
      }

      await tx.purchaseOrderItem.update({ where: { id: it.id }, data: { landedUnitCost, receivedBase: it.baseQuantity } });
      if (!stockAlreadyCounted) {
        // The product's cost per box becomes the average over every box held (15 Nov 2026).
        await tx.product.update({ where: { id: it.productId }, data: { purchasePrice: averaged } });
      }
    }

    return tx.purchaseOrder.update({
      where: { id },
      data: {
        status: 'RECEIVED',
        warehouseId,
        receivedAt: new Date(),
        actualArrival: actualArrival ? new Date(actualArrival) : new Date(),
      },
      include: PO_INCLUDE,
    });
  });
}


// --- Cash-only purchasing (15 Nov 2026) -------------------------------------
// Draft → Confirm purchase (paid in full from an account, lines locked) → Dispatch (in transit) → warehouse
// Check in (counted, damaged noted) → owner Confirms arrival (only accepted boxes enter stock) → all in, or
// Close with the rest marked missing. Every step locks the order row first, so two presses — or two people —
// queue up and the second finds the step already done instead of doing it twice.

async function lockOrder(tx, id) {
  // $queryRaw, not $executeRaw: it returns the locked row, which also says whether the order exists.
  const rows = await tx.$queryRaw`SELECT id FROM "purchase_orders" WHERE id = ${id} FOR UPDATE`;
  if (!rows.length) throw ApiError.notFound('Purchase order not found');
}

// Whose money it is: the brand of the products when they are all one brand, else the supplier's brand.
function brandOfOrder(po) {
  const brands = [...new Set((po.items || []).map((i) => i.product?.brandId).filter(Boolean))];
  return brands.length === 1 ? brands[0] : po.supplier?.brandId || null;
}

// Pay `amount` for an order out of one account, inside the caller's transaction: the account row is locked,
// its live balance read by the formula every screen uses, and a shortfall refused with the numbers.
async function payForOrder(tx, po, { accountId, amount, occurredAt, notes, category, what }, actor) {
  const finance = require('./finance.service'); // lazy: avoids an import cycle
  // Locks the account, reads its live balance and refuses a shortfall with the numbers — the same check every
  // business payment goes through (finance.assertFunds).
  const acc = await finance.assertFunds(tx, accountId, amount, what);
  // An account reserved for one brand (M-Pesa = OHIS, Airtel = Civlily) pays only for an order whose products are
  // all that brand — a mixed order would otherwise slip past (its brand falls back to the supplier's, often none).
  // (A brand that pays into another brand's account — Pepa into Civlily's — counts as that brand here.)
  const productBrands = [...new Set((po.items || []).map((i) => i.product?.brandId).filter(Boolean))];
  const served = await Promise.all(productBrands.map((b) => finance.accountServesBrand(tx, acc.brandId, b)));
  if (acc.brandId && served.some((ok) => !ok)) {
    throw ApiError.badRequest(`${acc.name} only pays for its own brand's stock, and ${po.poNumber} has another brand's products. Pay it from an account that is not reserved for one brand, such as Cash.`);
  }
  return finance.recordTransaction(
    {
      accountId,
      direction: 'OUT',
      // Stock money, not an expense: it reaches profit as cost of the boxes when they sell.
      type: 'STOCK_PURCHASE',
      amount,
      brandId: brandOfOrder(po),
      category,
      description: `${po.poNumber} — ${po.supplier?.name || 'supplier'}`,
      reference: po.poNumber,
      refType: 'PurchaseOrder',
      refId: po.id,
      notes: notes || null,
      occurredAt,
    },
    actor,
    tx,
    { checkBrand: true }, // a brand-reserved account only pays for its own brand's stock
  );
}

const orderForMoney = (tx, id) => tx.purchaseOrder.findUnique({
  where: { id },
  include: { items: { include: { product: { select: { brandId: true } } } }, supplier: { select: { name: true, brandId: true } } },
});

async function paidOnOrderTx(tx, id) {
  const paid = await tx.financeTransaction.aggregate({ where: { refType: 'PurchaseOrder', refId: id, direction: 'OUT' }, _sum: { amount: true } });
  return round2(toNumber(paid._sum.amount));
}

// What Confirm purchase still has to pay: the order's total less its own payments, capped by the supplier's
// books — balance payments and returned goods made before the cash-only flow may already cover an older order
// (the same cap Finance's Pay PO uses, audit admin-money-1). An ORDERED order is on the books: never more than its
// row's outstanding or the supplier's in all. A draft joins the books now: whatever credit the supplier holds
// (from paying drafts when they still counted as debt) comes off it first.
async function stillToPay(client, po) {
  let due = round2(toNumber(po.totalCost) - (await paidOnOrderTx(client, po.id)));
  if (due > 0 && po.supplierId) {
    const finance = require('./finance.service'); // lazy: avoids an import cycle
    const { orders, totals } = await finance.supplierDetail(po.supplierId);
    const row = orders.find((o) => o.id === po.id);
    due = row ? Math.min(due, row.outstanding, totals.outstanding) : Math.min(due, round2(totals.outstanding + due));
  }
  return Math.max(0, round2(due));
}

// Confirm purchase: the goods were bought with cash. The whole order is paid from one account in the same
// transaction as the status change, so it is paid exactly once, and a short account is refused.
async function confirmPurchase(id, { accountId, occurredAt, notes, expectedArrival } = {}, actor) {
  return withDocNumberRetry(() => prisma.$transaction(async (tx) => {
    await lockOrder(tx, id);
    const po = await orderForMoney(tx, id);
    if (!NOT_YET_BOUGHT.includes(po.status)) {
      throw ApiError.conflict(`${po.poNumber} is ${PO_STATE[po.status]} — it cannot be purchased again.`);
    }
    if (!po.items.length) throw ApiError.badRequest('This order has no products.');
    if (po.items.some((i) => !(toNumber(i.unitCost) > 0))) {
      throw ApiError.badRequest('Every product needs its buying price before the purchase is confirmed. Edit the order and fill them in.');
    }
    // An order made before this flow may already be paid, on the order or through the supplier's balance;
    // only what is left is paid now.
    const due = await stillToPay(tx, po);
    let txn = null;
    if (due > 0) {
      txn = await payForOrder(tx, po, { accountId, amount: due, occurredAt, notes, category: 'Stock Purchase', what: po.poNumber }, actor);
    }
    const when = txn ? txn.occurredAt : occurredAt ? new Date(occurredAt) : new Date();
    if (expectedArrival) assertArrivalNotBeforeOrder(when, expectedArrival);
    // Bought = on its way: no separate dispatch step.
    await tx.purchaseOrder.update({
      where: { id },
      data: {
        // dispatchedAt holds the moment of the confirm on the DATABASE's clock — the confirm payment's own createdAt —
        // so Undo purchase can tell the payments written from then on from older ones by one clock (purchasedAt is
        // the business day, which can be earlier).
        status: 'IN_TRANSIT', purchasedAt: when, purchasedById: actor?.id || null, dispatchedAt: txn ? txn.createdAt : new Date(),
        orderedAt: po.orderedAt || when,
        ...(expectedArrival ? { expectedArrival: new Date(expectedArrival) } : {}),
      },
    });
    return tx.purchaseOrder.findUnique({ where: { id }, include: PO_INCLUDE });
  }, { timeout: 20000 }));
}

// Undo purchase: a Confirm purchase made by mistake (wrong account, wrong price), before anything has arrived.
// Recorded money is never deleted, so every payment on the order is reversed — the opposite entry beside it, in
// the ledger for good — and the order goes back to a draft that can be corrected and confirmed again.
async function undoPurchase(id, { reason } = {}, actor) {
  const why = String(reason || '').trim();
  if (!why) throw ApiError.badRequest('Say why the purchase is being undone — it stays beside the payment in the ledger.');
  return withDocNumberRetry(() => prisma.$transaction(async (tx) => {
    await lockOrder(tx, id);
    const po = await tx.purchaseOrder.findUnique({ where: { id }, include: { receipts: { select: { id: true } } } });
    if (!['PURCHASED', 'IN_TRANSIT'].includes(po.status)) {
      throw ApiError.badRequest(`${po.poNumber} is ${PO_STATE[po.status]} — only a bought order with nothing received can be undone.`);
    }
    if (po.receipts.length) throw ApiError.badRequest(`Part of ${po.poNumber} has already been received, so the purchase cannot be undone.`);
    if (!po.purchasedAt || !po.dispatchedAt) {
      throw ApiError.badRequest(`${po.poNumber} was not bought with Confirm purchase, so there is nothing to undo — receive it, and mark what never came as missing.`);
    }
    // Only what Confirm purchase and Add cost paid (written from the confirm on). Older payments on an order made
    // before the cash-only flow are real money sent to the supplier and stay.
    const paid = await tx.financeTransaction.findMany({
      where: { refType: 'PurchaseOrder', refId: id, reversalOfId: null, createdAt: { gte: po.dispatchedAt } },
      orderBy: { occurredAt: 'asc' },
    });
    const olderPaid = await tx.financeTransaction.count({ where: { refType: 'PurchaseOrder', refId: id, createdAt: { lt: po.dispatchedAt } } });
    const reversed = await tx.financeTransaction.findMany({ where: { reversalOfId: { in: paid.map((t) => t.id) } }, select: { reversalOfId: true } });
    const done = new Set(reversed.map((r) => r.reversalOfId));
    for (const t of paid.filter((x) => !done.has(x.id))) {
      const txnNumber = await nextDocNumber(tx.financeTransaction, 'txnNumber', 'FTX');
      await tx.financeTransaction.create({
        data: {
          txnNumber,
          reversalOfId: t.id,
          accountId: t.accountId,
          direction: t.direction,
          type: t.type,
          amount: round2(-toNumber(t.amount)),
          brandId: t.brandId,
          category: t.category,
          description: `Reversal of ${t.txnNumber} — purchase undone`.slice(0, 500),
          reference: t.reference,
          refType: 'PurchaseOrder',
          refId: id,
          notes: why.slice(0, 2000),
          occurredAt: new Date(),
          createdById: actor?.id || null,
        },
      });
    }
    // An older order that carried payments goes back to ORDERED (still owed for, those payments still counted);
    // anything else is a draft again.
    return tx.purchaseOrder.update({
      where: { id },
      data: { status: olderPaid ? 'ORDERED' : 'DRAFT', purchasedAt: null, purchasedById: null, dispatchedAt: null },
      include: PO_INCLUDE,
    });
  }, { timeout: 20000 }));
}

// Receive cargo (admin, one step — 15 Nov 2026: the admin is also the warehouse, so there is no separate
// approval). For each product, in the line's own unit (cartons for a carton line): how many arrived, how many
// of those are damaged or rejected, and how many are missing (will not come). Only accepted = received −
// damaged enters stock, at once, tied to the order, at the line's landed cost. What is neither received nor
// missing stays outstanding for the next receiving; the order is complete when nothing is outstanding.
// `clientKey` is one per press of the form: a double tap or a retry finds it recorded and adds nothing.
async function receiveCargo(id, { items = [], notes, arrivedAt, clientKey } = {}, actor) {
  if (!clientKey) throw ApiError.badRequest('Refresh the page and try again.');
  return prisma.$transaction(async (tx) => {
    await lockOrder(tx, id);
    if (await tx.purchaseReceipt.findUnique({ where: { clientKey }, select: { id: true } })) {
      throw ApiError.conflict('This receiving was already recorded — its boxes are in stock.');
    }
    const po = await tx.purchaseOrder.findUnique({
      where: { id },
      include: { items: { include: { product: { select: { name: true } }, packagingUnit: { select: { name: true } } } } },
    });
    if (!ARRIVING.includes(po.status)) {
      throw ApiError.badRequest(
        NOT_YET_BOUGHT.includes(po.status) || po.status === 'PURCHASED'
          ? `${po.poNumber} has not been bought yet — confirm the purchase first.`
          : `${po.poNumber} is ${PO_STATE[po.status]}.`,
      );
    }
    const byId = new Map(po.items.map((i) => [i.id, i]));
    const seen = new Set();
    const lines = [];
    for (const l of items) {
      const it = byId.get(l.itemId);
      if (!it) throw ApiError.badRequest('A product in this receiving is not on the order.');
      if (seen.has(l.itemId)) throw ApiError.badRequest(`${it.product?.name || 'A product'} is entered twice.`);
      seen.add(l.itemId);
      const received = l.received || 0;
      const damaged = l.damaged || 0;
      const missing = l.missing || 0;
      if (!received && !damaged && !missing) continue;
      const name = it.product?.name || 'A product';
      const size = it.quantity > 0 ? Math.max(1, Math.round(it.baseQuantity / it.quantity)) : 1;
      const unit = String(it.packagingUnit?.name || 'box').toLowerCase();
      if (damaged > received) throw ApiError.badRequest(`${name}: ${damaged} damaged or rejected, but only ${received} received.`);
      const note = l.note ? String(l.note).trim().slice(0, 300) : '';
      if (damaged > 0 && !note) throw ApiError.badRequest(`${name}: say what is wrong with the ${damaged} damaged or rejected.`);
      const leftBase = it.baseQuantity - it.receivedBase - it.missingBase;
      if ((received + missing) * size > leftBase) {
        const left = leftBase % size === 0 ? `${leftBase / size} ${unit}${leftBase / size === 1 ? '' : 's'}` : `${leftBase} boxes`;
        throw ApiError.badRequest(`${name}: ${received + missing} received or missing, but only ${left} still to come (${it.quantity} bought).`);
      }
      lines.push({
        purchaseOrderItemId: it.id,
        receivedQty: received, damagedQty: damaged, missingQty: missing,
        receivedBase: received * size, damagedBase: damaged * size, missingBase: missing * size,
        acceptedBase: (received - damaged) * size,
        note: note || null,
      });
    }
    if (!lines.length) throw ApiError.badRequest('Enter what arrived, or what is missing, for at least one product.');

    let warehouseId = po.warehouseId;
    if (!warehouseId) {
      const wh = await tx.warehouse.findFirst({ where: { isActive: true }, orderBy: { isPrimary: 'desc' } });
      if (!wh) throw ApiError.badRequest('No warehouse to receive into');
      warehouseId = wh.id;
    }
    // Landed cost, the same rule as ever: shipping, clearing and other costs spread over the lines by goods
    // value (by quantity when there is none), per box bought. The buying price on the line never changes.
    const extraCost = toNumber(po.shippingCost) + toNumber(po.clearingCost) + toNumber(po.otherCost);
    const goodsTotal = po.items.reduce((n, it) => n + toNumber(it.unitCost) * it.baseQuantity, 0);
    const baseTotal = po.items.reduce((n, it) => n + it.baseQuantity, 0);
    const landedOf = (it) => {
      const share = goodsTotal > 0 ? (toNumber(it.unitCost) * it.baseQuantity) / goodsTotal : baseTotal > 0 ? it.baseQuantity / baseTotal : 0;
      return round2(toNumber(it.unitCost) + (it.baseQuantity > 0 ? (extraCost * share) / it.baseQuantity : 0));
    };
    const baseUnits = await tx.productPackaging.findMany({
      where: { productId: { in: po.items.map((it) => it.productId) }, isBaseUnit: true },
      select: { productId: true, packagingUnitId: true },
    });
    const baseUnitOf = new Map(baseUnits.map((b) => [b.productId, b.packagingUnitId]));
    const when = arrivedAt ? new Date(arrivedAt) : new Date();

    const receipt = await tx.purchaseReceipt.create({
      data: {
        purchaseOrderId: id, clientKey, arrivedAt: when, receivedById: actor?.id || null,
        notes: notes ? String(notes).trim().slice(0, 1000) || null : null,
        items: { create: lines },
      },
    });

    const after = new Map(po.items.map((it) => [it.id, { ...it }]));
    for (const ln of lines) {
      const it = after.get(ln.purchaseOrderItemId);
      const landedUnitCost = landedOf(it);
      if (ln.acceptedBase > 0) {
        const unitId = baseUnitOf.get(it.productId);
        if (!unitId) throw ApiError.badRequest(`${it.product?.name || 'A product'} has no box unit set up.`);
        const averaged = await averageCostAfter(tx, it.productId, ln.acceptedBase, landedUnitCost);
        await inventory.increaseStock(tx, {
          productId: it.productId,
          packagingUnitId: unitId,
          quantity: ln.acceptedBase,
          baseQuantity: ln.acceptedBase,
          type: 'PURCHASE_RECEIPT',
          location: { type: inventory.LOCATION.WAREHOUSE, warehouseId },
          unitCost: landedUnitCost,
          referenceType: 'PURCHASE',
          referenceId: po.id,
          userId: actor ? actor.id : null,
          notes: `Received PO ${po.poNumber}${ln.damagedBase ? ` (${ln.damagedBase} damaged or rejected not added)` : ''}`,
        });
        // The product's cost per box becomes the average over every box held. Selling prices are never touched.
        await tx.product.update({ where: { id: it.productId }, data: { purchasePrice: averaged } });
      }
      it.receivedBase += ln.receivedBase;
      it.damagedBase += ln.damagedBase;
      it.missingBase += ln.missingBase;
      await tx.purchaseOrderItem.update({
        where: { id: it.id },
        data: { receivedBase: it.receivedBase, damagedBase: it.damagedBase, missingBase: it.missingBase, landedUnitCost },
      });
    }

    const complete = [...after.values()].every((it) => it.baseQuantity - it.receivedBase - it.missingBase <= 0);
    const order = await tx.purchaseOrder.update({
      where: { id },
      data: {
        status: complete ? 'RECEIVED' : 'PARTLY_RECEIVED',
        warehouseId,
        actualArrival: when,
        ...(complete ? { receivedAt: new Date() } : {}),
      },
      include: PO_INCLUDE,
    });
    return { order, receipt };
  }, { timeout: 20000 });
}

// Purchase history by product line: every price paid for a product, order by order, with what came in.
// The same product bought at different prices keeps each price on its own order line.
async function listPurchaseLines({ productId, from, to } = {}) {
  const po = { status: { not: 'CANCELLED' } };
  if (from || to) {
    po.purchasedAt = {
      ...(from ? { gte: new Date(`${from}T00:00:00+03:00`) } : {}),
      ...(to ? { lte: new Date(`${to}T23:59:59.999+03:00`) } : {}),
    };
  }
  const rows = await prisma.purchaseOrderItem.findMany({
    where: { ...(productId ? { productId } : {}), purchaseOrder: po },
    include: {
      product: { select: { id: true, name: true, sku: true } },
      packagingUnit: { select: { name: true } },
      purchaseOrder: { select: { id: true, poNumber: true, status: true, purchasedAt: true, createdAt: true, actualArrival: true, supplier: { select: { name: true } } } },
    },
    orderBy: [{ purchaseOrder: { createdAt: 'desc' } }],
    take: 500,
  });
  return rows.map((r) => ({
    id: r.id,
    product: r.product,
    poId: r.purchaseOrder.id,
    poNumber: r.purchaseOrder.poNumber,
    status: r.purchaseOrder.status,
    supplier: r.purchaseOrder.supplier?.name || null,
    purchasedAt: r.purchaseOrder.purchasedAt,
    createdAt: r.purchaseOrder.createdAt,
    arrivedAt: r.purchaseOrder.actualArrival,
    quantity: r.quantity,
    unit: r.packagingUnit?.name || null,
    boxes: r.baseQuantity,
    unitCost: round2(toNumber(r.unitCost)),
    unitPrice: round2(toNumber(r.unitCost) * (r.quantity > 0 ? r.baseQuantity / r.quantity : 1)),
    lineTotal: round2(toNumber(r.unitCost) * r.baseQuantity),
    landedUnitCost: round2(toNumber(r.landedUnitCost)),
    received: r.receivedBase,
    damaged: r.damagedBase,
    missing: r.missingBase,
    accepted: r.receivedBase - r.damagedBase,
    outstanding: Math.max(0, r.baseQuantity - r.receivedBase - r.missingBase),
  }));
}

// Shipping, clearing or other cost on a bought order, paid in cash as it is recorded — so the order stays fully
// paid and nobody is left "owed". It enters the landed cost of the boxes confirmed after it; boxes already in
// stock keep the cost they came in at.
const COST_FIELD = { shipping: 'shippingCost', clearing: 'clearingCost', other: 'otherCost' };
const COST_WORD = { shipping: 'Shipping', clearing: 'Clearing', other: 'Other cost' };
async function addOrderCost(id, { kind, amount, accountId, occurredAt, notes } = {}, actor) {
  const field = COST_FIELD[kind];
  if (!field) throw ApiError.badRequest('Choose shipping, clearing or other.');
  const amt = round2(toNumber(amount));
  if (!(amt > 0)) throw ApiError.badRequest('Enter an amount greater than zero.');
  return withDocNumberRetry(() => prisma.$transaction(async (tx) => {
    await lockOrder(tx, id);
    const po = await orderForMoney(tx, id);
    if (!ARRIVING.includes(po.status)) {
      throw ApiError.badRequest(
        NOT_YET_BOUGHT.includes(po.status)
          ? `${po.poNumber} is ${PO_STATE[po.status]} — put the cost on the order itself (Edit).`
          : `${po.poNumber} is ${PO_STATE[po.status]} — its costs are final.`,
      );
    }
    await payForOrder(tx, po, { accountId, amount: amt, occurredAt, notes, category: `${COST_WORD[kind]} (${po.poNumber})`, what: `${COST_WORD[kind]} for ${po.poNumber}` }, actor);
    return tx.purchaseOrder.update({
      where: { id },
      data: { [field]: round2(toNumber(po[field]) + amt), totalCost: round2(toNumber(po.totalCost) + amt) },
      include: PO_INCLUDE,
    });
  }, { timeout: 20000 }));
}

module.exports = {
  listSuppliers,
  createSupplier,
  updateSupplier,
  removeSupplier,
  createPurchaseOrder,
  listPurchaseOrders,
  getPurchaseOrder,
  updatePurchaseOrder,
  deletePurchaseOrder,
  receivePurchaseOrder,
  confirmPurchase,
  undoPurchase,
  receiveCargo,
  listPurchaseLines,
  addOrderCost,
  PO_INCLUDE,
};
