'use strict';

const asyncHandler = require('../utils/asyncHandler');
const { created } = require('../utils/response');
const invoices = require('../services/invoice.service');
const audit = require('../services/audit.service');

// POST /invoices/number — the next invoice number, given out once by the server (sale10). What the invoice is for
// (customer, lines, total) is kept in the audit log beside the number, so a number can always be traced back.
const number = asyncHandler(async (req, res) => {
  const { after, customer, total, lines } = req.body || {};
  const out = await invoices.nextInvoiceNumber({ after });
  await audit.record(req, {
    action: 'INVOICE_NUMBER',
    entityType: 'Invoice',
    entityId: out.number,
    newValues: { number: out.number, customer: customer || null, total: total ?? null, lines: lines ?? null },
  });
  return created(res, out);
});

module.exports = { number };
