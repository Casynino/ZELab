import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Modal, PageSpinner, LoadError } from '@/components/ui';
import { pageQueries } from '@/lib/pageQueries';
import { formatCurrency, formatDate } from '@/lib/format';

// Everything behind the rep's wallet card (Nino, 15 Nov 2026: the card shows only the balance; tapping it
// opens every transaction, and here he sees what he has earned and been paid in total). The totals come
// from the same answer as the list, so the two always agree.

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'in', label: 'Earned', kinds: ['EARNED', 'BONUS', 'ADJUSTMENT'] },
  { key: 'out', label: 'Paid out', kinds: ['PAID_OUT', 'WAITING'] },
  { key: 'fines', label: 'Fines', kinds: ['FINE'] },
];
const PAGE = 60;
const boxes = (n) => `${n} ${n === 1 ? 'box' : 'boxes'}`;

function describe(it) {
  switch (it.kind) {
    case 'EARNED': return { title: 'Commission', sub: [boxes(it.boxes), it.ref], tone: 'text-violet-300', sign: '+' };
    case 'BONUS': return { title: 'Bonus', sub: ['Sales target reached'], tone: 'text-violet-300', sign: '+' };
    case 'ADJUSTMENT': return {
      title: 'Adjustment', sub: [it.ref || 'Set by ZELab'], tone: it.amount >= 0 ? 'text-violet-300' : 'text-rose-300', sign: it.amount >= 0 ? '+' : '−',
    };
    case 'PAID_OUT': return { title: 'Paid to you', sub: [it.ref], tone: 'text-foreground', sign: '−' };
    case 'WAITING': return {
      title: 'Withdrawal requested', sub: [it.status === 'APPROVED' ? 'Approved, waiting to be paid' : 'Waiting for ZELab'], tone: 'text-amber-300', sign: '−',
    };
    case 'FINE': return it.forgiven
      ? { title: 'Fine forgiven', sub: [it.ref, it.day ? `day ${it.day}` : null], tone: 'text-faint line-through', sign: '' }
      : { title: it.late ? 'Late fine' : 'Fine', sub: [it.ref, it.day ? `day ${it.day}` : null], tone: 'text-rose-300', sign: '−' };
    default: return { title: it.kind, sub: [], tone: 'text-foreground', sign: '' };
  }
}

function Total({ label, value, tone }) {
  return (
    <div className="min-w-0 rounded-xl bg-white/[0.04] px-3 py-2.5 ring-1 ring-inset ring-white/[0.06]">
      <p className="text-[11px] text-muted">{label}</p>
      <p className={clsx('mt-0.5 truncate text-[15px] font-bold tabular-nums', tone)}>{formatCurrency(value)}</p>
    </div>
  );
}

export default function WalletActivity({ open, onClose }) {
  const q = useQuery({ ...pageQueries.walletActivity(), enabled: open });
  const [filter, setFilter] = useState('all');
  const [shown, setShown] = useState(PAGE);
  const data = q.data;

  const rows = useMemo(() => {
    const f = FILTERS.find((x) => x.key === filter);
    return (data?.items || []).filter((it) => !f?.kinds || f.kinds.includes(it.kind));
  }, [data, filter]);

  // Rows under a month heading, newest first, as a bank statement reads.
  const groups = useMemo(() => {
    const out = [];
    for (const it of rows.slice(0, shown)) {
      const d = new Date(it.at);
      const key = `${d.getFullYear()}-${d.getMonth()}`;
      if (!out.length || out[out.length - 1].key !== key) {
        out.push({ key, label: d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }), items: [] });
      }
      out[out.length - 1].items.push(it);
    }
    return out;
  }, [rows, shown]);

  const t = data?.totals;
  return (
    <Modal open={open} onClose={onClose} title="My wallet">
      {q.isError && !data ? <LoadError what="your wallet" onRetry={q.refetch} /> : !data ? <PageSpinner /> : (
        <div className="space-y-5">
          <div>
            <p className="text-[12px] text-muted">Available balance</p>
            <p className={clsx('mt-0.5 text-[28px] font-bold leading-tight tabular-nums', t.balance < 0 ? 'text-rose-300' : 'text-foreground')}>
              {formatCurrency(t.balance)}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Total label="Total earned" value={t.earned} tone="text-violet-300" />
            <Total label="Total paid out" value={t.paid} tone="text-foreground" />
            <Total label="Fines" value={t.fines} tone={t.fines > 0 ? 'text-rose-300' : 'text-faint'} />
            <Total label="Waiting to be paid" value={t.waiting} tone={t.waiting > 0 ? 'text-amber-300' : 'text-faint'} />
          </div>

          <div className="flex gap-2 overflow-x-auto [scrollbar-width:none] [&>*]:shrink-0">
            {FILTERS.map((f) => (
              <button key={f.key} type="button" onClick={() => { setFilter(f.key); setShown(PAGE); }}
                className={clsx('rounded-full px-3.5 py-1.5 text-[13px] font-medium ring-1 ring-inset transition',
                  filter === f.key ? 'bg-white/[0.1] text-foreground ring-white/[0.14]' : 'text-muted ring-white/[0.08] hover:text-foreground')}>
                {f.label}
              </button>
            ))}
          </div>

          {!rows.length ? (
            <p className="py-6 text-center text-sm text-muted">Nothing here yet.</p>
          ) : (
            <div className="space-y-4">
              {groups.map((g) => (
                <section key={g.key}>
                  <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-faint">{g.label}</h4>
                  <ul className="divide-y divide-white/[0.06]">
                    {g.items.map((it) => {
                      const d = describe(it);
                      const amount = it.kind === 'FINE' && it.forgiven ? it.fine : Math.abs(it.amount);
                      return (
                        <li key={it.id} className="flex items-baseline justify-between gap-3 py-2.5">
                          <span className="min-w-0">
                            <span className="block text-[14px] font-medium text-foreground">{d.title}</span>
                            <span className="block truncate text-[12px] tabular-nums text-muted">
                              {[formatDate(it.at), ...d.sub].filter(Boolean).join(' · ')}
                            </span>
                          </span>
                          <span className={clsx('shrink-0 text-[14px] font-semibold tabular-nums', d.tone)}>
                            {d.sign}{formatCurrency(amount)}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
              {rows.length > shown && (
                <button type="button" onClick={() => setShown((n) => n + PAGE)}
                  className="w-full rounded-xl py-2.5 text-[13px] font-medium text-muted ring-1 ring-inset ring-white/[0.08] transition hover:text-foreground">
                  Show older ({rows.length - shown} more)
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
