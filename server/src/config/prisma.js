'use strict';

const { PrismaClient } = require('@prisma/client');
const { datasourceUrl } = require('./databaseUrl');

// Single shared PrismaClient. We attach it to globalThis so it is reused across
// dev hot-reloads (nodemon) AND warm serverless invocations on Vercel — both
// would otherwise create duplicate clients and exhaust the connection pool.
// On the deployed app the address carries a connection pool size (see databaseUrl.js).
const globalForPrisma = globalThis;

const url = datasourceUrl();
const prisma =
  globalForPrisma.__haoStockPrisma ||
  new PrismaClient({ log: ['warn', 'error'], ...(url ? { datasourceUrl: url } : {}) });

globalForPrisma.__haoStockPrisma = prisma;

module.exports = prisma;
