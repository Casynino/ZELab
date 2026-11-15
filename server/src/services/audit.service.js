'use strict';

const prisma = require('../config/prisma');
const logger = require('../utils/logger');

// Pull the actor + network context off a request for audit entries.
function contextFromReq(req) {
  if (!req) return {};
  const ipAddress =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.ip ||
    req.socket?.remoteAddress ||
    null;
  return {
    userId: req.user ? req.user.id : null,
    ipAddress,
    userAgent: req.headers['user-agent'] || null,
  };
}

// Keys, passwords and tokens never go into the log in plain text (audit perm07): the log keeps them for
// good, long after they were changed. A field named like one — and a Setting whose own key is one
// (whatsapp.apikey) — keeps only the fact that it was set; null (removed) stays null.
const SECRET_NAME = /api_?key|password|secret|token/i;
const HIDDEN = '[hidden]';

function redact(value, depth = 0) {
  if (depth > 6 || value == null) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_NAME.test(k) && typeof v === 'string' && v !== '' ? HIDDEN : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

function redactEntry(entry) {
  const secretSetting = entry.entityType === 'Setting' && SECRET_NAME.test(String(entry.entityId || ''));
  const clean = (vals) => {
    const out = redact(vals);
    if (secretSetting && out && typeof out === 'object' && typeof out.value === 'string' && out.value !== '') {
      return { ...out, value: HIDDEN };
    }
    return out;
  };
  return { oldValues: clean(entry.oldValues), newValues: clean(entry.newValues) };
}

// Write an audit row. Auditing must never break the business operation, so
// failures here are logged and swallowed. Pass a tx client to record inside an
// existing transaction.
async function log(entry, client = prisma) {
  try {
    const { oldValues, newValues } = redactEntry(entry);
    await client.auditLog.create({
      data: {
        userId: entry.userId ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ? String(entry.entityId) : null,
        oldValues: oldValues ?? undefined,
        newValues: newValues ?? undefined,
        ipAddress: entry.ipAddress ?? null,
        userAgent: entry.userAgent ?? null,
      },
    });
  } catch (err) {
    logger.error('Failed to write audit log', err.message);
  }
}

// Convenience: record an action using request context in one call.
async function record(req, { action, entityType, entityId, oldValues, newValues }, client) {
  return log(
    { ...contextFromReq(req), action, entityType, entityId, oldValues, newValues },
    client,
  );
}

module.exports = { log, record, contextFromReq, redactEntry };
