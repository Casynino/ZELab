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
      <Card className="mt-4">
        <CardHeader title="Revenue & profit trend" />
        <CardBody>
          {data.series.length ? <TrendChart data={data.series} series={[{ key: 'revenue', name: 'Revenue', color: GREEN }, { key: 'profit', name: 'Profit', color: SKY }]} /> : <EmptyState title="No sales in this period" />}
        </CardBody>
      </Card>
    </>
  );
}

function ProfitReport({ data }) {
  const rows = [
    ['Revenue', data.revenue], ['Cost of goods sold', data.cogs], ['Gross profit', data.grossProfit],
    ['Discounts given', data.discounts], ['Shrinkage & damage', data.shrinkageAndDamageValue], ['Net profit', data.netProfit],
  ];
  return (
    <Card>
      <CardHeader title="Profit & loss" subtitle={`Gross margin ${formatPercent(data.grossMargin)} · ${data.orders} orders`} />
      <Table>
        <TBody>
          {rows.map(([k, v]) => (
            <TR key={k}><TD className="font-medium text-muted">{k}</TD><TD className="text-right font-semibold">{formatCurrency(v)}</TD></TR>
          ))}
        </TBody>
      </Table>
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
                  behind a sideways scroll on a phone and an iPad). The table in a wide box. */}
              <RowsOrTable>
                <RowList>
                  {(data.all || []).map((p) => (
                    <RowItem key={p.productId} title={p.name} figure={formatCurrency(p.revenue)}
                      sub={`${formatNumber(p.unitsSold)} units · profit ${formatCurrency(p.profit)}`}
                      badge={<span className="text-[12px] tabular-nums text-muted">{formatPercent(p.margin)}</span>} />
                  ))}
                </RowList>
                <Table className="rot-table">
                  <THead><TR><TH>Product</TH><TH>Units</TH><TH>Revenue</TH><TH>Profit</TH><TH>Margin</TH></TR></THead>
                  <TBody>{(data.all || []).map((p) => (
                    <TR key={p.productId}><TD>{p.name}</TD><TD>{formatNumber(p.unitsSold)}</TD><TD>{formatCurrency(p.revenue)}</TD><TD>{formatCurrency(p.profit)}</TD><TD>{formatPercent(p.margin)}</TD></TR>
                  ))}</TBody>
                </Table>
              </RowsOrTable>
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
            </Card>
          )}
          {tab === 'salesReps' && (
            <Card>
              <CardHeader title="Sales rep performance" />
              <RowsOrTable>
                <RowList>
                  {(data.items || []).map((r) => (
                    <RowItem key={r.salesRepId} title={r.name} figure={formatCurrency(r.revenue)}
                      sub={`${r.region || 'No region'} · ${formatNumber(r.orders)} order${r.orders === 1 ? '' : 's'} · profit ${formatCurrency(r.profit)}`}
                      badge={r.attainment != null ? <span className="text-[12px] tabular-nums text-muted">target {formatPercent(r.attainment)}</span> : null}
                      extra={<span className="mt-1 block text-[11px] tabular-nums text-amber-500">commission owed {formatCurrency(r.commissionOwed)}</span>} />
                  ))}
                </RowList>
                {/* In a wide box (an iPad held sideways, a laptop): the region under the name, so Commission owed and Target fit an iPad held sideways. */}
                <Table className="rot-table">
                  <THead><TR><TH>Rep</TH><TH>Orders</TH><TH>Revenue</TH><TH>Profit</TH><TH>Commission owed</TH><TH>Target</TH></TR></THead>
                  <TBody>{(data.items || []).map((r) => (
                    <TR key={r.salesRepId}><TD><div className="font-medium">{r.name}</div><div className="mt-0.5 text-[11px] text-faint">{r.region || '—'}</div></TD><TD>{r.orders}</TD><TD>{formatCurrency(r.revenue)}</TD><TD>{formatCurrency(r.profit)}</TD><TD className="text-amber-500">{formatCurrency(r.commissionOwed)}</TD><TD>{r.attainment != null ? formatPercent(r.attainment) : '—'}</TD></TR>
                  ))}</TBody>
                </Table>
              </RowsOrTable>
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
