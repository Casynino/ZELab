'use strict';

// How many database connections one server instance may open (15 Nov 2026). Left unset, Prisma opens
// (CPU cores x 2 + 1) — 3 to 5 on a Vercel function — and the heavy pages (Home, Finance, Commissions,
// Sales reps), which send dozens of reads at once, queued behind them. Neon's pooler (the "-pooler" host,
// PgBouncer, `pgbouncer=true` in the address) takes thousands of client connections, so 10 per instance is
// safe there.
//
// Only on the deployed app (Vercel, or NODE_ENV=production), only through the pooler, and only when the
// address does not already say: a connection_limit written into DATABASE_URL always wins, so the owner can
// change it in the Vercel settings without a code change. PRISMA_CONNECTION_LIMIT overrides the default of
// 10. A direct (non-pooler) address is left exactly as it is: there every connection is a real Postgres
// connection, and Neon allows only about a hundred. The address is never rewritten, only added to, so its
// password and options stay exactly as typed.
const DEFAULT_CONNECTION_LIMIT = 10;

function viaPooler(raw, query) {
  if (query.split('&').some((part) => part.toLowerCase() === 'pgbouncer=true')) return true;
  try {
    return new URL(raw).hostname.includes('-pooler');
  } catch {
    return false;
  }
}

function datasourceUrl(raw = process.env.DATABASE_URL, env = process.env) {
  if (!raw || typeof raw !== 'string') return raw;
  const deployed = Boolean(env.VERCEL) || env.NODE_ENV === 'production';
  if (!deployed) return raw;
  const q = raw.indexOf('?');
  const query = q === -1 ? '' : raw.slice(q + 1);
  if (!viaPooler(raw, query)) return raw;
  if (query.split('&').some((part) => part.split('=')[0] === 'connection_limit')) return raw;
  const n = Number.parseInt(env.PRISMA_CONNECTION_LIMIT, 10);
  const add = `connection_limit=${Number.isFinite(n) && n > 0 ? n : DEFAULT_CONNECTION_LIMIT}`;
  const joiner = q === -1 ? '?' : (raw.endsWith('?') || raw.endsWith('&') ? '' : '&');
  return `${raw}${joiner}${add}`;
}

module.exports = { datasourceUrl, DEFAULT_CONNECTION_LIMIT };
