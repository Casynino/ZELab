-- 15 Nov 2026, Nino: "all of them can withdraw at 250,000, even KP". KP (REP-004) was the only rep on a
-- minimum of his own (500,000); clearing a rep's own minimum puts him on the business minimum
-- (setting commission.amountPerThreshold, 250,000) like every other rep. Only this column changes, only on
-- reps that had their own minimum; balances, earnings and payouts are untouched. Safe to run twice.
UPDATE "sales_representatives" SET "withdrawalThreshold" = NULL WHERE "withdrawalThreshold" IS NOT NULL;
