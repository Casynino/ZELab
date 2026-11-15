import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { FileText, FileSpreadsheet } from 'lucide-react';
import api, { unwrap, apiError } from '@/lib/api';
import { formatCurrency, formatNumber, formatPercent } from '@/lib/format';
import {
  PageHeader, Card, CardHeader, CardBody, PageSpinner, EmptyState, LoadError, Select, Button,
  Table, THead, TBody, TR, TH, TD, RowsOrTable, RowList, RowItem,
} from '@/components/ui';
import { TrendChart, BarChartCard } from '@/components/charts';
// The rep side's chart colours (components/RepCharts): revenue green, profit sky — red is kept for alerts.
const GREEN = '#34d399';
const SKY = '#38bdf8';

const TABS = [
  { key: 'sales', label: 'Sales', path: '/reports/sales', file: 'sales-report' },
  { key: 'profit', label: 'Profit', path: '/reports/profit', file: 'profit-report' },
  { key: 'products', label: 'Products', path: '/reports/products', file: 'product-performance' },
  { key: 'regional', label: 'Regional', path: '/reports/regional', file: 'regional-performance' },
  { key: 'salesReps', label: 'Sales reps', path: '/reports/sales-reps', file: 'salesrep-performance' },
  { key: 'valuation', label: 'Valuation', path: '/reports/inventory-valuation', file: 'inventory-valuation' },
];

async function downloadReport(path, params, format, file) {
  try {
    const res = await api.get(path, { params: { ...params, format }, responseType: 'blob' });
    const url = URL.createObjectURL(res.data);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${file}.${format === 'excel' ? 'xlsx' : 'pdf'}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    toast.error(apiError(e, 'Export failed'));
  }
}

// Boxes sold before their product had a buying price (Pepa, 15 Nov 2026): their cost is not known, so they are in
// revenue but never in profit or margin — said in one line wherever such boxes are in the figures.
function NoCostNote({ noCost, className = 'mt-3' }) {
  if (!(noCost?.boxes > 0)) return null;
  return (
    <p className={`${className} text-xs text-amber-300`}>
      {formatNumber(noCost.boxes)} {noCost.boxes === 1 ? 'box' : 'boxes'} sold before a buying price was set
      ({formatCurrency(noCost.revenue)} of revenue) — not in profit or margin.
    </p>
  );
}

function SalesReport({ data }) {
  return (
    <>
      {/* Two across until lg: four across an iPad held upright left 138 px tiles, and "TSh 19,567,035" (151 px)
          ran over their edge (ui-a09). */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Metric label="Revenue" value={formatCurrency(data.totals.revenue)} />
        <Metric label="Gross profit" value={formatCurrency(data.totals.grossProfit)} />
        <Metric label="Margin" value={formatPercent(data.totals.margin)} />
        <Metric label="Orders" value={formatNumber(data.totals.orders)} />
      </div>
      <NoCostNote noCost={data.totals.noCost} />
      <Card className="mt-4">
        <CardHeader title="Revenue & profit trend" />
        <CardBody>
          {data.series.length ? <TrendChart data={data.series} series={[{ key: 'revenue', name: 'Revenue', color: GREEN }, { key: 'profit', name: 'Profit', color: SKY }]} /> : <EmptyState title="No sales in this period" />}
        </CardBody>
      </Card>
    </>
  );
}

// The same net profit as the Dashboard and Finance (15 Nov 2026): gross profit − expenses − stock lost. The rows add
// up as read; discounts are already inside revenue, so they are a note under it, never a line of their own.
function ProfitReport({ data }) {
  const stockLoss = data.stockLoss ?? data.shrinkageAndDamageValue ?? 0;
  const rows = [
    { k: 'Revenue', v: data.revenue, note: data.discounts > 0 ? `after ${formatCurrency(data.discounts)} of discounts` : null },
    { k: 'Cost of goods sold', v: -data.cogs },
    { k: 'Gross profit', v: data.grossProfit, strong: true },
    { k: 'Expenses', v: -(data.expenses || 0) },
    { k: 'Stock lost', v: -stockLoss, note: 'written off, or bought and damaged / never received' },
    { k: 'Net profit', v: data.netProfit, strong: true },
  ];
  return (
    <Card>
      <CardHeader title="Profit & loss" subtitle={`Gross margin ${formatPercent(data.grossMargin)} · ${data.orders} orders`} />
      <Table>
        <TBody>
          {rows.map((r) => (
            <TR key={r.k}>
              <TD className={r.strong ? 'font-semibold text-foreground' : 'font-medium text-muted'}>
                {r.k}
                {r.note && <span className="ml-2 text-xs font-normal text-faint">{r.note}</span>}
              </TD>
              <TD className={`text-right tabular-nums ${r.strong ? 'font-bold text-foreground' : 'font-semibold'}`}>
                {r.v < 0 ? `−${formatCurrency(-r.v)}` : formatCurrency(r.v)}
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
      <NoCostNote noCost={data.noCost} className="px-4 pb-4 pt-3" />
    </Card>
  );
}

function Metric({ label, value }) {
  return <div className="card p-4"><div className="text-xs text-muted">{label}</div><div className="mt-1 text-xl font-bold text-foreground">{value}</div></div>;
}

// Renders standalone (own page header) or embedded inside Finance's Reports
// tab (compact toolbar, no page title).
export default function Reports({ embedded = false }) {
  const [tab, setTab] = useState('sales');
  const [period, setPeriod] = useState('month');
  const active = TABS.find((t) => t.key === tab);
  const params = { period };

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['report', tab, period],
    queryFn: async () => unwrap(await api.get(active.path, { params })).data,
  });

  const controls = (
    <>
      <Select value={period} onChange={(e) => setPeriod(e.target.value)} className="w-36">
        <option value="today">Today</option><option value="week">This week</option><option value="month">This month</option><option value="year">This year</option>
      </Select>
      <Button variant="secondary" onClick={() => downloadReport(active.path, params, 'pdf', active.file)}><FileText className="h-4 w-4" /> PDF</Button>
      <Button variant="secondary" onClick={() => downloadReport(active.path, params, 'excel', active.file)}><FileSpreadsheet className="h-4 w-4" /> Excel</Button>
    </>
  );

  return (
    <div>
      {embedded ? (
        <div className="mb-4 flex flex-wrap items-center justify-end gap-2">{controls}</div>
      ) : (
        <PageHeader title="Reports" subtitle="Sales, profit, performance and valuation — with PDF & Excel export.">
          {controls}
        </PageHeader>
      )}

      <div className="mb-4 tab-row">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)} className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition ${tab === t.key ? 'border border-white/25 bg-white/[0.12] text-foreground' : 'border border-border text-muted hover:bg-elevated'}`}>{t.label}</button>
        ))}
      </div>

      {isError && !data ? <LoadError what="this report" onRetry={refetch} /> : isLoading || !data ? <PageSpinner /> : (
        <div>
          {tab === 'sales' && <SalesReport data={data} />}
          {tab === 'profit' && <ProfitReport data={data} />}
          {tab === 'products' && (
            <Card>
              <CardHeader title="Top selling products" subtitle="By revenue" />
              <CardBody>{data.topSelling?.length ? <BarChartCard data={data.topSelling.map((p) => ({ name: p.name.slice(0, 22), value: p.revenue }))} color={GREEN} /> : <EmptyState title="No sales" />}</CardBody>
              {/* Phones and tablets: one short row each, as on Settle (the tables hid their money columns
                  behind a sideways scroll on a phone and an iPad). The table in a wide box. A product whose every
                  box was sold before a buying price was set has no known profit. */}
              <RowsOrTable>
                <RowList>
                  {(data.all || []).map((p) => {
                    const unknown = p.noCost?.boxes > 0 && p.noCost.boxes >= p.unitsSold;
                    return (
                      <RowItem key={p.productId} title={p.name} figure={formatCurrency(p.revenue)}
                        sub={`${formatNumber(p.unitsSold)} units · ${unknown ? 'profit not known' : `profit ${formatCurrency(p.profit)}`}`}
                        badge={<span className="text-[12px] tabular-nums text-muted">{unknown ? '—' : formatPercent(p.margin)}</span>}
                        extra={p.noCost?.boxes > 0 && <span className="mt-1 block text-[11px] text-amber-300">{formatNumber(p.noCost.boxes)} with no buying price</span>} />
                    );
                  })}
                </RowList>
                <Table className="rot-table">
                  <THead><TR><TH>Product</TH><TH>Units</TH><TH>Revenue</TH><TH>Profit</TH><TH>Margin</TH></TR></THead>
                  <TBody>{(data.all || []).map((p) => {
                    // Every box of it sold before a buying price was set: its profit is not known.
                    const unknown = p.noCost?.boxes > 0 && p.noCost.boxes >= p.unitsSold;
                    return (
                      <TR key={p.productId}>
                        <TD>{p.name}{p.noCost?.boxes > 0 && <span className="ml-2 text-xs text-amber-300">{formatNumber(p.noCost.boxes)} with no buying price</span>}</TD>
                        <TD>{formatNumber(p.unitsSold)}</TD><TD>{formatCurrency(p.revenue)}</TD>
                        <TD>{unknown ? <span className="text-faint">Not known</span> : formatCurrency(p.profit)}</TD>
                        <TD>{unknown ? <span className="text-faint">—</span> : formatPercent(p.margin)}</TD>
                      </TR>
                    );
                  })}</TBody>
                </Table>
              </RowsOrTable>
              <NoCostNote noCost={(data.all || []).reduce((t, p) => ({ boxes: t.boxes + (p.noCost?.boxes || 0), revenue: t.revenue + (p.noCost?.revenue || 0) }), { boxes: 0, revenue: 0 })} className="px-4 pb-4 pt-3" />
            </Card>
          )}
          {tab === 'regional' && (
            <Card>
              <CardHeader title="Regional performance" />
              <CardBody>{data.items?.length ? <BarChartCard data={data.items.map((r) => ({ name: r.region, value: r.revenue }))} color={GREEN} /> : <EmptyState title="No regional sales" />}</CardBody>
              <RowsOrTable>
                <RowList>
                  {(data.items || []).map((r) => (
                    <RowItem key={r.region} title={r.region} figure={formatCurrency(r.revenue)}
                      sub={`${formatNumber(r.orders)} order${r.orders === 1 ? '' : 's'} · profit ${formatCurrency(r.profit)}`} />
                  ))}
                </RowList>
                <Table className="rot-table">
                  <THead><TR><TH>Region</TH><TH>Orders</TH><TH>Revenue</TH><TH>Profit</TH></TR></THead>
                  <TBody>{(data.items || []).map((r) => (<TR key={r.region}><TD>{r.region}</TD><TD>{r.orders}</TD><TD>{formatCurrency(r.revenue)}</TD><TD>{formatCurrency(r.profit)}</TD></TR>))}</TBody>
                </Table>
              </RowsOrTable>
              <NoCostNote noCost={(data.items || []).reduce((t, r) => ({ boxes: t.boxes + (r.noCost?.boxes || 0), revenue: t.revenue + (r.noCost?.revenue || 0) }), { boxes: 0, revenue: 0 })} className="px-4 pb-4 pt-3" />
            </Card>
          )}
          {tab === 'salesReps' && (
            <Card>
              <CardHeader title="Sales rep performance" />
              {/* Commission owed is what the business owes the rep (never below zero); fines bigger than what he
                  earned are the rep owing the business, said apart (sale12). */}
              <RowsOrTable>
                <RowList>
                  {(data.items || []).map((r) => (
                    <RowItem key={r.salesRepId} title={r.name} figure={formatCurrency(r.revenue)}
                      sub={`${r.region || 'No region'} · ${formatNumber(r.orders)} order${r.orders === 1 ? '' : 's'} · profit ${formatCurrency(r.profit)}`}
                      badge={r.attainment != null ? <span className="text-[12px] tabular-nums text-muted">target {formatPercent(r.attainment)}</span> : null}
                      extra={(
                        <span className="mt-1 block text-[11px] tabular-nums">
                          <span className="text-violet-300">commission owed {formatCurrency(Math.max(0, Number(r.commissionOwed) || 0))}</span>
                          {r.repOwes > 0 && <span className="text-rose-300"> · owes {formatCurrency(r.repOwes)} in fines</span>}
                        </span>
                      )} />
                  ))}
                </RowList>
                {/* In a wide box (an iPad held sideways, a laptop): the region under the name, so Commission owed and Target fit an iPad held sideways. */}
                <Table className="rot-table">
                  <THead><TR><TH>Rep</TH><TH>Orders</TH><TH>Revenue</TH><TH>Profit</TH><TH>Commission owed</TH><TH>Rep owes (fines)</TH><TH>Target</TH></TR></THead>
                  <TBody>{(data.items || []).map((r) => (
                    <TR key={r.salesRepId}>
                      <TD><div className="font-medium">{r.name}</div><div className="mt-0.5 text-[11px] text-faint">{r.region || '—'}</div></TD>
                      <TD>{r.orders}</TD><TD>{formatCurrency(r.revenue)}</TD><TD>{formatCurrency(r.profit)}</TD>
                      <TD className="text-violet-300">{formatCurrency(Math.max(0, Number(r.commissionOwed) || 0))}</TD>
                      <TD className={r.repOwes > 0 ? 'text-rose-300' : 'text-faint'}>{r.repOwes > 0 ? formatCurrency(r.repOwes) : '—'}</TD>
                      <TD>{r.attainment != null ? formatPercent(r.attainment) : '—'}</TD>
                    </TR>
                  ))}</TBody>
                </Table>
              </RowsOrTable>
              <NoCostNote noCost={(data.items || []).reduce((t, r) => ({ boxes: t.boxes + (r.noCost?.boxes || 0), revenue: t.revenue + (r.noCost?.revenue || 0) }), { boxes: 0, revenue: 0 })} className="px-4 pb-4 pt-3" />
            </Card>
          )}
          {tab === 'valuation' && (
            <Card>
              <CardHeader title="Inventory valuation" subtitle={`Cost ${formatCurrency(data.totals.totalValue)} · Retail ${formatCurrency(data.totals.retailValue)}`} />
              <RowsOrTable>
                <RowList>
                  {(data.items || []).map((p) => (
                    <RowItem key={p.productId} title={p.name} figure={formatCurrency(p.costValue)}
                      sub={`${formatNumber(p.warehouseBase)} warehouse · ${formatNumber(p.repBase)} reps · ${formatNumber(p.totalBase)} total`}
                      badge={<span className="text-[12px] tabular-nums text-muted">retail {formatCurrency(p.retailValue)}</span>} />
                  ))}
                </RowList>
                <Table className="rot-table">
                  <THead><TR><TH>Product</TH><TH>Warehouse</TH><TH>Reps</TH><TH>Total units</TH><TH>Cost value</TH><TH>Retail value</TH></TR></THead>
                  <TBody>{(data.items || []).map((p) => (
                    <TR key={p.productId}><TD>{p.name}</TD><TD>{formatNumber(p.warehouseBase)}</TD><TD>{formatNumber(p.repBase)}</TD><TD>{formatNumber(p.totalBase)}</TD><TD>{formatCurrency(p.costValue)}</TD><TD>{formatCurrency(p.retailValue)}</TD></TR>
                  ))}</TBody>
                </Table>
              </RowsOrTable>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
