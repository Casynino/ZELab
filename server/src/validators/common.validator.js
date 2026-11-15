'use strict';

const { z } = require('zod');

// Reusable primitives shared across module validators.
const id = z.string().min(1, 'id is required');
const idParam = { params: z.object({ id }) };

// Query boolean that respects the literal strings "true"/"false".
const boolQuery = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .optional();

const positiveInt = z.coerce.number().int().positive();
const nonNegativeInt = z.coerce.number().int().min(0);
// A real, finite amount the money column can hold (audit perm08): 'Infinity' or '1e400' answered "Invalid database
// query" and a figure past the column's size a 500. Mirrors utils/money DB_MAX_AMOUNT.
const MAX_AMOUNT = 999_999_999_999.99;
const money = z.coerce.number().finite('Enter a real amount').min(0).max(MAX_AMOUNT, 'That amount is too large — check the number of zeros');
// A quantity on one line, in its own unit (boxes, cartons…). Capped well below what a box count can hold once a
// carton is turned into boxes, so a mistyped 2147483647 is a clear refusal, not a 500 (audit perm08).
const MAX_LINE_QUANTITY = 1_000_000;
const lineQuantity = z.number().int().positive().max(MAX_LINE_QUANTITY, 'That quantity is too large — check the number');

// Standard pagination / sorting fields mixed into list query schemas.
const paginationFields = {
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  sortBy: z.string().optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
  search: z.string().trim().optional(),
};

const dateRangeFields = {
  from: z.string().datetime().optional().or(z.string().date().optional()),
  to: z.string().datetime().optional().or(z.string().date().optional()),
  period: z.enum(['today', 'week', 'month', 'year']).optional(),
};

module.exports = {
  id,
  idParam,
  boolQuery,
  positiveInt,
  nonNegativeInt,
  money,
  lineQuantity,
  MAX_LINE_QUANTITY,
  paginationFields,
  dateRangeFields,
};
