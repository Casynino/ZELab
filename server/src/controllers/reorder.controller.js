'use strict';

const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/response');
const reorder = require('../services/reorder.service');

// What a reorder costs is worked out at the buying price, so it is the owner's (audit ui-ad01 / reps-01, 15 Nov
// 2026): a line's cost divided by its boxes was the product's buying price. Warehouse staff get the boxes to order,
// not the money.
const noLineCost = ({ recommendedValue, ...rest }) => rest; // eslint-disable-line no-unused-vars
function withoutCost(data) {
  const { estimatedReorderValue, urgentValue, ...summary } = data.summary; // eslint-disable-line no-unused-vars
  return { ...data, summary, recommendations: data.recommendations.map(noLineCost), items: data.items.map(noLineCost) };
}

const analysis = asyncHandler(async (req, res) => {
  const q = req.validatedQuery || req.query;
  const data = await reorder.reorderAnalysis({
    lookbackDays: q.lookbackDays ? Number(q.lookbackDays) : undefined,
    coverDays: q.coverDays ? Number(q.coverDays) : undefined,
  });
  return ok(res, req.user?.role === 'ADMIN' ? data : withoutCost(data));
});

const lowStock = asyncHandler(async (_req, res) => {
  const data = await reorder.lowStock();
  return ok(res, data);
});

module.exports = { analysis, lowStock, withoutCost };
