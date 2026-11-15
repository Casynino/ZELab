import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Modal, PageSpinner, LoadError } from '@/components/ui';
import { pageQueries } from '@/lib/pageQueries';
import { formatCurrency } from '@/lib/format';

// Everything behind the rep's wallet card (Nino, 15 Nov 2026: the card shows only the balance; tapping it
// opens every transaction, and here he sees what he has earned and been paid in total). The totals come
// from the same answer as the list, so the two always agree. Kept small and plain ("nice and well arranged,
// no need to be big"): one slim summary, then the statement.

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'in', label: 'Earned', kinds: ['EARNED', 'BONUS', 'ADJUSTMENT'] },
  { key: 'out', label: 'Paid out', kinds: ['PAID_OUT', 'WAITING'] },
  { key: 'fines', label: 'Fines', kinds: ['FINE'] },
];
const PAGE = 60;
const boxes = (n) => `${n} ${n === 1 ? 'box' : 'boxes'}`;
// The month is the heading, so a row only needs the day.
const day = (at) => new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

function describe(it) {
  switch (it.kind) {
    case 'EARNED': return { title: 'Commission', sub: [boxes(it.boxes), it.ref], tone: 'text-earn-300', sign: '+' };
    case 'BONUS': return { title: 'Bonus', sub: ['Sales target reached'], tone: 'text-earn-300', sign: '+' };
    case 'ADJUSTMENT': return {
      title: 'Adjustment', sub: [it.ref || 'Set by ZELab'], tone: it.amount >= 0 ? 'text-earn-300' : 'text-rose-300', sign: it.amount >= 0 ? '+' : '−',
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
        <div className="space-y-4">
          {/* One slim summary: the balance, then earned and paid out side by side. Fines and a request still
              waiting are said only when there are any. */}
          <div className="rounded-2xl bg-white/[0.03] px-4 py-3.5 ring-1 ring-inset ring-white/[0.06]">
            <p className="text-[11px] text-muted">Available balance</p>
            <p className={clsx('mt-0.5 text-[22px] font-bold leading-tight tabular-nums', t.balance < 0 ? 'text-rose-300' : 'text-foreground')}>
              {formatCurrency(t.balance)}
            </p>
            <div className="mt-3 grid grid-cols-2 border-t border-white/[0.06] pt-3">
              <div className="min-w-0 pr-3">
                <p className="text-[11px] text-muted">Total earned</p>
                <p className="mt-0.5 truncate text-[14px] font-semibold tabular-nums text-earn-300">{formatCurrency(t.earned)}</p>
              </div>
              <div className="min-w-0 border-l border-white/[0.06] pl-3">
                <p className="text-[11px] text-muted">Total paid out</p>
                <p className="mt-0.5 truncate text-[14px] font-semibold tabular-nums text-foreground">{formatCurrency(t.paid)}</p>
              </div>
            </div>
            {(t.fines > 0 || t.waiting > 0) && (
              <p className="mt-2.5 flex flex-wrap gap-x-3 text-[11.5px] tabular-nums">
                {t.fines > 0 && <span className="text-rose-300">Fines {formatCurrency(t.fines)}</span>}
                {t.waiting > 0 && <span className="text-amber-300">Waiting to be paid {formatCurrency(t.waiting)}</span>}
              </p>
            )}
          </div>

          <div className="flex gap-1.5 overflow-x-auto [scrollbar-width:none] [&>*]:shrink-0">
            {FILTERS.map((f) => (
              <button key={f.key} type="button" onClick={() => { setFilter(f.key); setShown(PAGE); }}
                className={clsx('rounded-full px-3 py-1 text-[12px] font-medium ring-1 ring-inset transition',
                  filter === f.key ? 'bg-white/[0.1] text-foreground ring-white/[0.14]' : 'text-muted ring-white/[0.08] hover:text-foreground')}>
                {f.label}
              </button>
            ))}
          </div>

          {!rows.length ? (
            <p className="py-6 text-center text-sm text-muted">Nothing here yet.</p>
          ) : (
            <div className="space-y-3">
              {groups.map((g) => (
                <section key={g.key}>
                  <h4 className="mb-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-faint">{g.label}</h4>
                  <ul className="divide-y divide-white/[0.05]">
                    {g.items.map((it) => {
                      const d = describe(it);
                      const amount = it.kind === 'FINE' && it.forgiven ? it.fine : Math.abs(it.amount);
                      return (
                        <li key={it.id} className="flex items-center justify-between gap-3 py-2">
                          <span className="min-w-0">
                            <span className="block text-[13.5px] font-medium leading-snug text-foreground">{d.title}</span>
                            <span className="block truncate text-[11.5px] tabular-nums text-muted">
                              {[day(it.at), ...d.sub].filter(Boolean).join(' · ')}
                            </span>
                          </span>
                          <span className={clsx('shrink-0 text-[13.5px] font-semibold tabular-nums', d.tone)}>
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
                  className="w-full rounded-xl py-2 text-[12px] font-medium text-muted ring-1 ring-inset ring-white/[0.08] transition hover:text-foreground">
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
