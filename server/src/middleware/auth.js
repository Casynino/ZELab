'use strict';

const prisma = require('../config/prisma');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { verifyAccessToken } = require('../utils/tokens');
const { assertDeviceAllowed } = require('../utils/device');

// The live user behind a token, read fresh on every request: active flag, session version, role and its
// permissions, and the rep profile. One statement, one round trip (15 Nov 2026): the Prisma include below
// made four in a row (users, roles, role permissions, rep profile) before every API call did any work.
// Nothing is cached, so a deactivation, a password change (session version) or a role change still
// stops the very next request. If the statement ever fails, the old read answers instead.
let joinedReadFailed = false;
async function loadSessionUser(id) {
  if (typeof prisma.$queryRaw === 'function' && !joinedReadFailed) {
    try {
      const rows = await prisma.$queryRaw`
        SELECT u."id", u."name", u."email", u."roleId", u."warehouseId", u."isActive", u."sessionVersion",
               r."name" AS "roleName",
               sr."id" AS "salesRepId", sr."isActive" AS "salesRepActive",
               COALESCE((SELECT array_agg(p."key") FROM "_RolePermissions" rp JOIN "permissions" p ON p."id" = rp."A"
                         WHERE rp."B" = u."roleId"), ARRAY[]::text[]) AS "permissions"
        FROM "users" u
        JOIN "roles" r ON r."id" = u."roleId"
        LEFT JOIN "sales_representatives" sr ON sr."userId" = u."id"
        WHERE u."id" = ${String(id)}`;
      const r = rows && rows[0];
      if (!r) return null;
      return {
        id: r.id,
        name: r.name,
        email: r.email,
        roleId: r.roleId,
        warehouseId: r.warehouseId,
        isActive: r.isActive,
        sessionVersion: r.sessionVersion,
        role: { name: r.roleName, permissions: (r.permissions || []).map((key) => ({ key })) },
        salesRep: r.salesRepId ? { id: r.salesRepId, isActive: r.salesRepActive } : null,
      };
    } catch (err) {
      // A statement that cannot run here (a schema it does not match: Prisma's P2010) must never lock anyone
      // out: say so once, and use the Prisma read from then on. Any other failure falls back for this request.
      if (err && err.code === 'P2010') joinedReadFailed = true;
      console.warn('[auth] joined user read failed, using the step-by-step read:', err && err.message);
    }
  }
  return prisma.user.findUnique({
    where: { id },
    include: {
      role: { include: { permissions: true } },
      salesRep: true,
    },
  });
}

// Authenticate a request from its `Authorization: Bearer <token>` header.
// Loads the live user (with role + permissions + sales-rep profile) so that
// deactivated users or revoked roles are rejected immediately.
const authenticate = asyncHandler(async (req, _res, next) => {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    throw ApiError.unauthorized('Authentication token missing');
  }

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    throw ApiError.unauthorized('Invalid or expired token');
  }

  const user = await loadSessionUser(payload.sub);

  if (!user || !user.isActive) {
    throw ApiError.unauthorized('Account not found or deactivated');
  }
  // A token from before a password change, reset, role change or deactivation no longer works.
  if ((payload.sv || 0) !== (user.sessionVersion || 0)) {
    throw ApiError.unauthorized('Your session has ended. Please sign in again.');
  }
  // A rep account without its rep profile would fall through every "only mine" filter; refuse it.
  if (user.role.name === 'SALES_REP' && !user.salesRep) {
    throw ApiError.forbidden('This account has no sales-rep profile yet. Ask ZELab to finish setting it up.');
  }
  // A rep suspended from his rep profile stops at once, on every request (audit #101). 401, like a
  // deactivated login: the app then tries to renew, is refused too, and goes back to the sign-in page.
  if (user.role.name === 'SALES_REP' && user.salesRep.isActive === false) {
    throw ApiError.unauthorized('Your sales-rep account is suspended. Ask ZELab to reactivate it.');
  }
  // Reps on phones only — on every request, so a session cannot be carried to a computer or tablet.
  assertDeviceAllowed(user.role.name, req.headers, ApiError);

  req.user = {
    id: user.id,
    name: user.name,
    email: user.email,
    roleId: user.roleId,
    role: user.role.name,
    permissions: user.role.permissions.map((p) => p.key),
    warehouseId: user.warehouseId,
    salesRepId: user.salesRep ? user.salesRep.id : null,
  };

  // The checks that are due at a moment (the owner's "fine about to start" warning, the 21:00 report's
  // fallback) ride on signed-in requests: at most every 5 minutes, in the background, never holding this
  // request up or failing it. No scheduler on the free plans runs them reliably (audit repo00, 15 Nov 2026).
  try { require('../services/whatsappNotify.service').dueChecksSoon(); } catch { /* never blocks a request */ }

  return next();
});

module.exports = { authenticate, loadSessionUser };
