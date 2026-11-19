import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { AlertTriangle, Clock, Wallet, Gauge, ChevronDown, PackageSearch, CheckCircle2, Boxes } from 'lucide-react';
import api, { unwrap } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { ROLES } from '@/lib/constants';
import { formatCurrency, formatNumber, pluralizeUnit } from '@/lib/format';
import {
  PageHeader, Card, CardHeader, PageSpinner, EmptyState, Badge, LoadError,
  Table, THead, TBody, TR, TH, TD, RowsOrTable, RowList, RowItem,
} from '@/components/ui';

// Urgency is days of cover now, so the colours run with the clock: rose when
// the shelf empties this week, amber inside a fortnight, sky inside the month,
// and quiet slate for stock that is only below an old minimum.
const URGENCY = {
  CRITICAL: { label: 'Critical', badge: 'bg-rose-500/15 text-rose-300', num: 'text-rose-300' },
  HIGH: { label: 'High', badge: 'bg-amber-500/15 text-amber-300', num: 'text-amber-300' },
  MEDIUM: { label: 'Medium', badge: 'bg-sky-500/15 text-sky-300', num: 'text-sky-300' },
  LOW: { label: 'Below min', badge: 'bg-white/10 text-muted', num: 'text-foreground' },
  // Never had a box in (a new product still being made, like Pepa): not out of stock, nothing to reorder.
  NEW: { label: 'New', badge: 'bg-violet-500/15 text-violet-300', num: 'text-faint' },
  OK: { label: 'OK', badge: 'bg-emerald-500/15 text-emerald-300', num: 'text-foreground' },
};

const CHIP_TONE = {
  slate: 'bg-white/10 text-foreground ring-white/20',
  rose: 'bg-rose-500/15 text-rose-300 ring-rose-500/30',
  amber: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
  sky: 'bg-sky-500/15 text-sky-300 ring-sky-500/30',
};

// Days of cover is the figure that ranks the list, so it gets to be the figure.
function CoverCell({ item }) {
  const tone = URGENCY[item.urgency] || URGENCY.OK;
  if (item.daysRemaining === null) {
    return (
      <div>
        <span className="text-lg font-bold text-faint">—</span>
        <div className="text-[11px] text-faint">{item.neverStocked ? 'not stocked yet' : 'no sales to measure'}</div>
      </div>
    );
  }
  return (
    <div>
      <span className={`text-lg font-bold tabular-nums ${tone.num}`}>{formatNumber(item.daysRemaining)}</span>
      <span className="ml-1 text-[11px] text-faint">day{item.daysRemaining === 1 ? '' : 's'}</span>
      <div className="text-[11px] text-faint">{item.avgDailySales > 0 ? `${item.avgDailySales}/day` : 'not selling'}</div>
    </div>
  );
}

// `tabs`: Inventory's tabs, drawn under this page's title (Reorder is a tab of Inventory).
export default function Reorder({ tabs } = {}) {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['reorder'],
    queryFn: async () => unwrap(await api.get('/reorder')).data,
  });
  const [band, setBand] = useState('');
  const [showAll, setShowAll] = useState(false);
  // What the order costs is at the buying price, so the owner's (audit ui-ad01): staff get the boxes to order and
  // no money — the server sends them none.
  const isAdmin = useAuth().user?.role === ROLES.ADMIN;

  // Labels quote the thresholds and the window, so they need a floor to read
  // sensibly if the request ever comes back empty.
  const s = { lookbackDays: 30, coverDays: 30, criticalDays: 7, highDays: 14, ...(data?.summary || {}) };
  const recs = useMemo(() => data?.recommendations || [], [data]);
  const all = data?.items || [];
  const shown = band ? recs.filter((r) => r.urgency === band) : recs;

  // The title and the tabs stay while the list loads or fails, so another tab is one tap away.
  const head = tabs ? <PageHeader title="Reorder Engine" tabs={tabs} /> : null;
  if (isLoading) return <div>{head}<PageSpinner /></div>;
  // Not "nothing to reorder": the list never came back.
  if (isError && !data) return <div>{head}<LoadError what="the reorder list" onRetry={refetch} /></div>;

  const pace = `the last ${s.lookbackDays} days`;
  const urgent = (s.criticalCount || 0) + (s.highCount || 0);
  const boxesOf = (rows) => rows.reduce((n, r) => n + (Number(r.recommendedQty) || 0), 0);
  const orderBoxes = boxesOf(recs);
  const urgentBoxes = boxesOf(recs.filter((r) => r.urgency === 'CRITICAL' || r.urgency === 'HIGH'));

  const chips = [
    { key: '', label: 'Everything to reorder', count: s.reorderCount || 0, tone: 'slate' },
    { key: 'CRITICAL', label: `Within ${s.criticalDays} days`, count: s.criticalCount || 0, tone: 'rose' },
    { key: 'HIGH', label: `Within ${s.highDays} days`, count: s.highCount || 0, tone: 'amber' },
    { key: 'MEDIUM', label: `Within ${s.coverDays} days`, count: s.mediumCount || 0, tone: 'sky' },
    { key: 'LOW', label: 'Below minimum only', count: s.lowCount || 0, tone: 'slate' },
  ];

  const cards = [
    {
      label: `Runs out within ${s.criticalDays} days`, value: formatNumber(s.criticalCount || 0), icon: AlertTriangle,
      sub: `at the selling pace of ${pace}`,
      quiet: !(s.criticalCount > 0),
      ring: 'ring-rose-500/30', glow: 'from-rose-500/[0.14]', chip: 'bg-rose-500/15 text-rose-300', num: 'text-rose-300',
      tone: s.criticalCount > 0 ? 'late' : undefined,
    },
    {
      label: `Runs out within ${s.highDays} days`, value: formatNumber(s.highCount || 0), icon: Clock,
      sub: `${(s.criticalDays || 0) + 1} to ${s.highDays} days of cover left`,
      quiet: !(s.highCount > 0),
      ring: 'ring-amber-500/30', glow: 'from-amber-500/[0.14]', chip: 'bg-amber-500/15 text-amber-300', num: 'text-amber-300',
    },
    isAdmin ? {
      label: 'Cost of this order', value: formatCurrency(s.estimatedReorderValue || 0), icon: Wallet,
      sub: urgent > 0
        ? `${formatCurrency(s.urgentValue || 0)} of it cannot wait`
        : `${formatNumber(s.reorderCount || 0)} product${s.reorderCount === 1 ? '' : 's'}, none urgent`,
      quiet: !(s.estimatedReorderValue > 0),
      ring: 'ring-brand-500/25', glow: 'from-brand-500/[0.12]', chip: 'bg-brand-500/15 text-brand-600', num: 'text-brand-600',
    } : {
      label: 'Boxes to order', value: formatNumber(orderBoxes), icon: Boxes,
      sub: urgent > 0
        ? `${formatNumber(urgentBoxes)} of them cannot wait`
        : `${formatNumber(s.reorderCount || 0)} product${s.reorderCount === 1 ? '' : 's'}, none urgent`,
      quiet: !(orderBoxes > 0),
      ring: 'ring-white/[0.08]', glow: 'from-white/[0.03]', chip: 'bg-white/10 text-foreground', num: 'text-foreground',
    },
    {
      label: 'Below minimum, still covered', value: formatNumber(s.lowCount || 0), icon: Gauge,
      sub: 'old minimums, long cover — not urgent',
      quiet: true,
      ring: 'ring-white/[0.08]', glow: 'from-white/[0.03]', chip: 'bg-white/10 text-muted', num: 'text-foreground',
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Reorder Engine"
        subtitle={`Selling pace measured over ${pace}; target ${s.coverDays} days of cover held.`}
        tabs={tabs}
      />

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {cards.map((c) => (
          <div
            key={c.label}
            className="stat-glass p-4"
            data-tone={c.tone}
          >
            <div className="relative flex items-start justify-between gap-2">
              <p className="text-xs font-medium text-muted">{c.label}</p>
              <span className={`rounded-full p-1.5 ring-1 ring-inset ring-white/10 ${c.quiet ? 'bg-white/10 text-muted' : c.chip}`}><c.icon className="h-3.5 w-3.5" /></span>
            </div>
            <p className={`relative mt-2 text-2xl font-bold tabular-nums ${c.quiet ? 'text-foreground' : c.num}`}>{c.value}</p>
            <p className="relative mt-0.5 text-[11px] text-faint">{c.sub}</p>
          </div>
        ))}
      </div>

      {/* The same thing in words — four numbers still need someone to say what they mean. */}
      {s.productsAnalyzed > 0 && (
        <p className="text-xs leading-relaxed text-muted">
          Of <b className="text-foreground">{formatNumber(s.productsAnalyzed)}</b> active products,
          {' '}<b className="text-foreground">{formatNumber(s.reorderCount || 0)}</b> are worth putting on an order.
          {s.criticalCount > 0
            ? <> <b className="text-rose-400">{formatNumber(s.criticalCount)}</b> run out within {s.criticalDays} days</>
            : <> Nothing runs out within {s.criticalDays} days</>}
          {s.highCount > 0 && <>, <b className="text-amber-400">{formatNumber(s.highCount)}</b> inside {s.highDays}</>}
          {' '}at the pace of {pace}.
          {isAdmin && s.estimatedReorderValue > 0 && (
            <> The whole order comes to <b className="text-foreground">{formatCurrency(s.estimatedReorderValue)}</b>
              {urgent > 0 ? <>, of which <b className="text-rose-400">{formatCurrency(s.urgentValue || 0)}</b> cannot wait</> : ' — none of it urgent'}.</>
          )}
          {!isAdmin && orderBoxes > 0 && (
            <> The whole order comes to <b className="text-foreground">{formatNumber(orderBoxes)}</b> boxes
              {urgent > 0 ? <>, of which <b className="text-rose-400">{formatNumber(urgentBoxes)}</b> cannot wait</> : ' — none of them urgent'}.</>
          )}
          {s.belowMinCount > 0 && (
            <> <b className="text-foreground">{formatNumber(s.belowMinCount)}</b> product{s.belowMinCount === 1 ? ' sits' : 's sit'} at or below the
              {' '}minimum stock level in the warehouse — where the cover is still long that is printed as a reason, not sounded as an alarm.</>
          )}
          {s.coveredCount > 0 && (
            <> <b className="text-foreground">{formatNumber(s.coveredCount)}</b> more {s.coveredCount === 1 ? 'is' : 'are'} short, but already covered by stock bought and on the way.</>
          )}
          {s.noVelocityCount > 0 && (
            <> {formatNumber(s.noVelocityCount)} sold nothing at all in {pace}, so they have no run-out date to rank by.</>
          )}
          {s.newCount > 0 && (
            <> <b className="text-foreground">{formatNumber(s.newCount)}</b> {s.newCount === 1 ? 'is' : 'are'} new and not stocked yet
              {' '}({all.filter((i) => i.neverStocked).map((i) => i.name).join(', ')}), so {s.newCount === 1 ? 'it is' : 'they are'} not counted as out of stock or put on the order.</>
          )}
        </p>
      )}

      <Card>
        <CardHeader
          title="Worth reordering"
          subtitle={`Ranked by how soon the shelf empties at the pace of ${pace}`}
        />
        {/* One swipeable line of filters on a phone, as on Settle. */}
        <div className="flex items-center gap-2 overflow-x-auto border-b border-border p-3 [scrollbar-width:none] sm:flex-wrap sm:p-4 [&>*]:shrink-0">
          {chips.map((c) => (
            <button
              key={c.key || 'all'}
              type="button"
              onClick={() => setBand(c.key)}
              className={`cursor-pointer rounded-full px-3.5 py-2 text-sm font-medium ring-1 transition duration-200 ${
                band === c.key ? CHIP_TONE[c.tone] : 'bg-transparent text-muted ring-white/10 hover:bg-white/[0.05] hover:text-foreground'}`}
            >
              {c.label} <span className="tabular-nums opacity-70">{formatNumber(c.count)}</span>
            </button>
          ))}
        </div>

        {shown.length === 0 ? (
          <EmptyState
            icon={CheckCircle2}
            title={band ? 'Nothing in this band' : 'Nothing to reorder'}
            message={band
              ? 'Try another band — the counts on the chips show where the products are.'
              : `Every product holds more than ${s.coverDays} days of cover at the pace of ${pace}.`}
          />
        ) : (
          <>
          {/* Phones and tablets: one row per product, as on Settle — the product and its days of cover, what
              is on hand and what to order with the urgency, and why it is here under that. */}
          <RowsOrTable>
            <RowList>
              {shown.map((r) => {
                const meta = URGENCY[r.urgency] || URGENCY.OK;
                const unit = pluralizeUnit(r.baseUnitName);
                return (
                  <RowItem
                    key={r.productId}
                    title={r.name}
                    figure={r.daysRemaining === null ? '—' : <>{formatNumber(r.daysRemaining)} <span className="text-[12px] font-medium text-muted">day{r.daysRemaining === 1 ? '' : 's'}</span></>}
                    figureClass={r.daysRemaining === null ? 'text-faint' : meta.num}
                    sub={`${formatNumber(r.onHand)} on hand${r.onTheWay > 0 ? ` · ${formatNumber(r.onTheWay)} on the way` : ''} · ${r.recommendedQty > 0 ? `order ${formatNumber(r.recommendedQty)} ${unit}${isAdmin ? ` · ${formatCurrency(r.recommendedValue)}` : ''}` : 'nothing to order yet'}`}
                    badge={<Badge className={meta.badge}>{meta.label}</Badge>}
                    extra={<span className="mt-1 block text-[11px] leading-snug text-faint">{r.brand ? `${r.brand} · ` : ''}{r.reason}</span>}
                  />
                );
              })}
            </RowList>
            <Table className="rot-table">
              <THead>
                <TR>
                  <TH>Product</TH><TH>Cover left</TH><TH>Why it is here</TH><TH>On hand</TH><TH>Order</TH><TH>Urgency</TH>
                </TR>
              </THead>
              <TBody>
                {shown.map((r) => {
                  const meta = URGENCY[r.urgency] || URGENCY.OK;
                  return (
                    <TR key={r.productId}>
                      <TD className="min-w-[11rem] whitespace-normal">
                        <div className="font-medium text-foreground">{r.name}</div>
                        <div className="text-xs text-faint">{r.brand}</div>
                      </TD>
                      <TD><CoverCell item={r} /></TD>
                      <TD className="min-w-[12rem] whitespace-normal"><span className="text-xs text-muted">{r.reason}</span></TD>
                      <TD>
                        <span className="tabular-nums">{formatNumber(r.onHand)}</span>
                        <span className="text-xs text-faint"> {pluralizeUnit(r.baseUnitName)}</span>
                        <div className="text-[11px] text-faint">minimum {formatNumber(r.minStockLevel)}</div>
                        {r.onTheWay > 0 && <div className="text-[11px] text-sky-300">{formatNumber(r.onTheWay)} on the way</div>}
                      </TD>
                      <TD>
                        {r.recommendedQty > 0 ? (
                          <>
                            <span className="font-semibold tabular-nums text-foreground">{formatNumber(r.recommendedQty)}</span>
                            <span className="text-xs text-faint"> {pluralizeUnit(r.baseUnitName)}</span>
                            {isAdmin && <div className="text-[11px] text-faint">{formatCurrency(r.recommendedValue)}</div>}
                          </>
                        ) : (
                          <span className="text-xs text-faint">nothing yet</span>
                        )}
                      </TD>
                      <TD><Badge className={meta.badge}>{meta.label}</Badge></TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </RowsOrTable>
          </>
        )}
      </Card>

      {/* Secondary by design: the recommendations above are the point of the page. */}
      <Card>
        <CardHeader
          title="Every product, by selling pace"
          subtitle={`All ${formatNumber(all.length)} active products over ${pace} — background, not a to-do list`}
          action={
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="flex cursor-pointer items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium text-muted ring-1 ring-white/10 transition duration-200 hover:bg-white/[0.05] hover:text-foreground"
            >
              {showAll ? 'Hide' : 'Show'}
              <ChevronDown className={`h-3.5 w-3.5 transition-transform duration-200 ${showAll ? 'rotate-180' : ''}`} />
            </button>
          }
        />
        <AnimatePresence initial={false}>
          {showAll && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.25, ease: [0.2, 0.7, 0.3, 1] }}
              className="overflow-hidden"
            >
              {all.length === 0 ? (
                <EmptyState icon={PackageSearch} title="No active products" />
              ) : (
                <>
                <RowsOrTable>
                  <RowList>
                    {all.map((r) => {
                      const meta = URGENCY[r.urgency] || URGENCY.OK;
                      return (
                        <RowItem
                          key={r.productId}
                          title={r.name}
                          figure={r.daysRemaining === null ? '—' : `${formatNumber(r.daysRemaining)} day${r.daysRemaining === 1 ? '' : 's'}`}
                          figureClass={r.daysRemaining === null ? 'text-faint' : 'text-foreground'}
                          sub={`${formatNumber(r.onHand)} on hand${r.onTheWay > 0 ? ` · ${formatNumber(r.onTheWay)} on the way` : ''} · ${r.avgDailySales > 0 ? `${r.avgDailySales}/day` : 'not selling'} · minimum ${formatNumber(r.minStockLevel)}`}
                          badge={<Badge className={meta.badge}>{meta.label}</Badge>}
                        />
                      );
                    })}
                  </RowList>
                  <Table className="rot-table">
                    <THead>
                      <TR>
                        <TH>Product</TH><TH>On hand</TH><TH>Sold per day</TH><TH>Cover left</TH><TH>Minimum</TH><TH>Status</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {all.map((r) => {
                        const meta = URGENCY[r.urgency] || URGENCY.OK;
                        return (
                          <TR key={r.productId}>
                            <TD>
                              <div className="text-foreground">{r.name}</div>
                              <div className="text-xs text-faint">{r.brand}</div>
                            </TD>
                            <TD className="tabular-nums">
                              {formatNumber(r.onHand)}
                              {r.onTheWay > 0 && <div className="text-[11px] text-sky-300">{formatNumber(r.onTheWay)} on the way</div>}
                            </TD>
                            <TD className="tabular-nums">{r.avgDailySales > 0 ? r.avgDailySales : <span className="text-faint">—</span>}</TD>
                            <TD className="tabular-nums">
                              {r.daysRemaining === null
                                ? <span className="text-faint">—</span>
                                : `${formatNumber(r.daysRemaining)} day${r.daysRemaining === 1 ? '' : 's'}`}
                            </TD>
                            <TD className="tabular-nums">{formatNumber(r.minStockLevel)}</TD>
                            <TD><Badge className={meta.badge}>{meta.label}</Badge></TD>
                          </TR>
                        );
                      })}
                    </TBody>
                  </Table>
                </RowsOrTable>
                </>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </Card>
    </div>
  );
}
