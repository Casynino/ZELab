-- Pepa (15 Nov 2026, Nino): a new brand, listed first, with its own category, two products and 6,000 TZS commission
-- a box. Reps pay for Pepa into the same account as Civlily (Airtel Money). Additive and safe to run twice: every
-- insert checks first, nothing existing is changed or removed.

-- A brand whose money goes into another brand's account.
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "settlesWithBrandId" TEXT;

-- The brand, paying into Civlily's account.
INSERT INTO "brands" ("id", "name", "isActive", "createdAt", "updatedAt", "settlesWithBrandId")
SELECT 'brand_pepa_20261115', 'Pepa', true, now(), now(), (SELECT "id" FROM "brands" WHERE lower("name") = 'civlily' LIMIT 1)
WHERE NOT EXISTS (SELECT 1 FROM "brands" WHERE lower("name") = 'pepa');
UPDATE "brands" SET "settlesWithBrandId" = (SELECT "id" FROM "brands" WHERE lower("name") = 'civlily' LIMIT 1), "updatedAt" = now()
WHERE lower("name") = 'pepa' AND "settlesWithBrandId" IS NULL;

-- Its category.
INSERT INTO "categories" ("id", "name", "isActive", "createdAt", "updatedAt")
SELECT 'cat_pepa_20261115', 'Pepa', true, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "categories" WHERE lower("name") = 'pepa');

-- The two products: sold by the box, bought by the carton of 50. Buying price 0 until the first purchase order
-- sets it; selling prices as given.
INSERT INTO "products" ("id", "name", "sku", "brandId", "categoryId", "baseUnitName", "purchasePrice", "sellingPrice", "minStockLevel", "reorderQuantity", "isActive", "createdAt", "updatedAt")
SELECT v.id, v.name, v.sku, b."id", c."id", 'Box', 0, v.price, 50, 50, true, now(), now()
FROM (VALUES
  ('prod_pepa_ndogo_20261115', 'Pepa Ndogo', 'PEPA-NDOGO', 30000),
  ('prod_pepa_ndogo_kubwa_20261115', 'Pepa Ndogo Kubwa', 'PEPA-NDOGO-KUBWA', 35000)
) AS v(id, name, sku, price)
JOIN "brands" b ON lower(b."name") = 'pepa'
JOIN "categories" c ON lower(c."name") = 'pepa'
WHERE NOT EXISTS (SELECT 1 FROM "products" p WHERE lower(p."name") = lower(v.name) OR p."sku" = v.sku);

-- Box (the base unit) and Carton (50 boxes) for each.
INSERT INTO "product_packagings" ("id", "productId", "packagingUnitId", "baseQuantity", "isBaseUnit", "isActive", "createdAt", "updatedAt")
SELECT 'pp_' || md5(p."id" || u."shortCode"), p."id", u."id", CASE WHEN u."shortCode" = 'CT' THEN 50 ELSE 1 END, u."shortCode" = 'BX', true, now(), now()
FROM "products" p
JOIN "packaging_units" u ON u."shortCode" IN ('BX', 'CT')
WHERE p."id" IN ('prod_pepa_ndogo_20261115', 'prod_pepa_ndogo_kubwa_20261115')
  AND NOT EXISTS (SELECT 1 FROM "product_packagings" x WHERE x."productId" = p."id" AND x."packagingUnitId" = u."id");

-- Commission: 6,000 TZS a box.
INSERT INTO "commission_rates" ("id", "brandId", "perBox", "effectiveFrom", "note", "createdAt")
SELECT 'rate_pepa_20261115', b."id", 6000, TIMESTAMP '2026-11-15 00:00:00', 'Pepa — 6,000 a box', now()
FROM "brands" b
WHERE lower(b."name") = 'pepa'
  AND NOT EXISTS (SELECT 1 FROM "commission_rates" r WHERE r."brandId" = b."id");
