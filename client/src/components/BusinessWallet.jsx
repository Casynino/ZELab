import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { Banknote, ChevronRight, ChevronsRight, Landmark, Minus, Smartphone, TrendingDown, TrendingUp, Wallet } from 'lucide-react';
import { Modal } from '@/components/ui';
import { pageQueries } from '@/lib/pageQueries';
import { formatCurrency, formatDate, sharePercents } from '@/lib/format';
import { TXN_TYPE_LABEL } from '@/lib/financeFigures';

// The money on the owner's Home: the "In the accounts" card, its look and colours as they were (Nino, 16 Nov
// 2026: "the same look, don't change the colour or anything"). Inside, the accounts are set out the way the
// Accounts page sets them (an icon in the account's colour, the name, the balance, its share), Cash included
// when it holds nothing; today's move sits under the total with the arrow that says the card opens — no
// Withdraw, the business is not a rep. A swipe across the card, or a tap, opens the details: today's money in
// and out, every account and the latest movements.
//
// Every figure is the dashboard's own (the accounts and today's flow from Finance); nothing is worked out here
// but each account's share of the total.

const ICON = { CASH: Banknote, MOBILE_MONEY: Smartphone, BANK: Landmark };
// One colour per account, by its place in the list: the bar, its icon and its share (the colours this card had).
const BAR = ['bg-brand-400', 'bg-violet-400', 'bg-cyan-300', 'bg-amber-300'];
const CHIP = ['bg-brand-500/15 text-brand-400', 'bg-violet-500/15 text-violet-300', 'bg-cyan-400/15 text-cyan-300', 'bg-amber-400/15 text-amber-300'];
const SHARE = ['text-brand-400', 'text-violet-300', 'text-cyan-300', 'text-amber-300'];

// The money accounts: those holding money first (biggest first), then the empty ones. The Commission account is
// only the record of payouts the owner made from his own pocket before 15 Nov 2026; no money sits in it.
function pockets(accounts) {
  const list = (accounts || []).filter((a) => !a.isCommissionRecord).map((a, i) => ({ ...a, balance: Number(a.balance) || 0, _i: i }));
  const held = list.filter((a) => a.balance > 0).sort((a, b) => b.balance - a.balance);
  const rest = list.filter((a) => a.balance <= 0);
  const above = held.reduce((s, a) => s + a.balance, 0);
  const shares = sharePercents(held.map((a) => a.balance), above);
  return { held: held.map((a, k) => ({ ...a, share: shares[k] })), rest, above };
}

// One account, as the Accounts page lists it. An empty one is greyed and has no share.
function AccountLine({ a, roomy = false }) {
  const Icon = ICON[a.type] || Wallet;
  const empty = a.share == null;
  return (
    <li className={clsx('flex min-w-0 items-center gap-2.5 text-[13px]', roomy ? 'py-2' : 'py-1')}>
      <span className={clsx('flex h-7 w-7 shrink-0 items-center justify-center rounded-full', empty ? 'bg-white/[0.05] text-white/40' : CHIP[a._i % CHIP.length])}>
        <Icon className="h-3.5 w-3.5" />
      </span>
      <span className={clsx('min-w-0 flex-1 truncate leading-tight', empty ? 'text-white/50' : 'text-muted')}>{a.name}</span>
      <span className={clsx('shrink-0 whitespace-nowrap font-semibold tabular-nums', a.balance < 0 ? 'text-rose-300' : empty ? 'text-white/60' : 'text-foreground')}>
        {formatCurrency(a.balance)}
      </span>
      <span className={clsx('w-9 shrink-0 text-right text-[11px] font-semibold tabular-nums', empty ? 'text-faint' : SHARE[a._i % SHARE.length])}>
        {empty ? '—' : `${a.share}%`}
      </span>
    </li>
  );
}

// Today's move in the balance, as one small plain line under the total: a little arrow and the amount, green up,
// rose down (Nino, 16 Nov 2026: "clean and nice, not with the shade around, and not big").
function TodayMove({ net }) {
  const up = net > 0;
  const down = net < 0;
  const Icon = up ? TrendingUp : down ? TrendingDown : Minus;
  return (
    <span className={clsx(
      'inline-flex items-center gap-1 text-[12px] font-medium tabular-nums',
      up ? 'text-emerald-400' : down ? 'text-rose-300' : 'text-faint',
    )}>
      <Icon className="h-3.5 w-3.5" strokeWidth={2.2} />
      {net === 0 ? 'No change today' : <>{up ? '+' : '−'}{formatCurrency(Math.abs(net))} today</>}
    </span>
  );
}

// Money in and money out today, side by side.
function TodayInOut({ today }) {
  return (
    <div className="grid grid-cols-2">
      <div className="min-w-0 pr-3">
        <p className="text-[11px] text-muted">Money in today</p>
        <p className="mt-0.5 truncate text-[14px] font-semibold tabular-nums text-emerald-300">{formatCurrency(today.moneyIn || 0)}</p>
      </div>
      <div className="min-w-0 border-l border-white/[0.06] pl-3">
        <p className="text-[11px] text-muted">Money out today</p>
        <p className="mt-0.5 truncate text-[14px] font-semibold tabular-nums text-foreground">{formatCurrency(today.moneyOut || 0)}</p>
      </div>
    </div>
  );
}

// The newest movements across every account, in the Finance page's words and signs.
function Movements({ open }) {
  const q = useQuery({ ...pageQueries.financeLatest(), enabled: open });
  if (q.isError && !q.data) return <p className="py-3 text-center text-[12px] text-muted">Could not load the movements.</p>;
  if (!q.data) return <p className="py-3 text-center text-[12px] text-muted">Loading…</p>;
  if (!q.data.length) return <p className="py-3 text-center text-[12px] text-muted">Nothing has moved yet.</p>;
  return (
    <ul className="divide-y divide-white/[0.05]">
      {q.data.map((t) => {
        // A commission paid from the owner's pocket (before 15 Nov 2026) left no account: gold, no sign, as in Finance.
        const payout = t.type === 'COMMISSION_PAYMENT';
        // A reversal carries minus the amount: the sign follows the money, not just the direction.
        const signed = (t.direction === 'IN' ? 1 : -1) * Number(t.amount || 0);
        const tone = payout ? 'text-earn-300' : signed >= 0 ? 'text-emerald-300' : 'text-rose-300';
        const sign = payout ? '' : signed >= 0 ? '+' : '−';
        const what = (payout && t.payee ? `Commission to ${t.payee}` : t.description) || t.category || TXN_TYPE_LABEL[t.type] || t.type;
        return (
          <li key={t.id} className="flex items-center justify-between gap-3 py-2">
            <span className="min-w-0">
              <span className="block truncate text-[13.5px] font-medium leading-snug text-foreground">{what}</span>
              <span className="block truncate text-[11.5px] tabular-nums text-muted">
                {[formatDate(t.occurredAt), t.account?.name].filter(Boolean).join(' · ')}
              </span>
            </span>
            <span className={clsx('shrink-0 text-[13.5px] font-semibold tabular-nums', tone)}>
              {sign}{formatCurrency(payout ? t.amount : Math.abs(Number(t.amount)))}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

const Heading = ({ children }) => <h4 className="mb-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-faint">{children}</h4>;

export default function BusinessWallet({ accounts, totalFunds, today }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const total = Number(totalFunds) || 0;
  const { held, rest } = pockets(accounts);
  // Only the accounts holding money (Nino, 16 Nov 2026: "only show the accounts with money — Cash should not be
  // visible" when it holds nothing). One below zero still shows, in rose: that is something to see.
  const all = [...held, ...rest.filter((a) => a.balance !== 0)];
  const net = today.netCash || 0;
  const toAccounts = (e) => { e?.stopPropagation(); setOpen(false); navigate('/finance?tab=accounts'); };

  // A sideways swipe across the card opens it, as the rep's wallet does; a tap does too. A page scroll does not.
  const touch = useRef(null);
  const swiped = useRef(false);
  const onTouchStart = (e) => { const t = e.touches[0]; touch.current = { x: t.clientX, y: t.clientY }; swiped.current = false; };
  const onTouchEnd = (e) => {
    const from = touch.current; touch.current = null;
    if (!from) return;
    const t = e.changedTouches[0];
    if (Math.abs(t.clientX - from.x) > 40 && Math.abs(t.clientY - from.y) < 30) { swiped.current = true; setOpen(true); }
  };
  const onClick = () => { if (swiped.current) { swiped.current = false; return; } setOpen(true); };

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        aria-label="Open the money details"
        onClick={onClick}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(true); } }}
        className="card wallet-lift mb-3 cursor-pointer overflow-hidden focus:outline-none focus-visible:ring-2 focus-visible:ring-white/30 sm:mb-4"
      >
        <div className="flex flex-col gap-3 p-4 sm:p-5 lg:flex-row lg:items-center lg:gap-6">
          <div className="min-w-0 lg:w-[17rem] lg:shrink-0">
            {/* No "Open accounts" words: the moving swipe arrows are the sign that the card opens (Nino, 16 Nov
                2026: "no need to say open accounts there, just put those swipe icons"). */}
            <div className="flex items-center justify-between gap-2">
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-faint">In the accounts</p>
              <ChevronsRight className="wallet-nudge h-4 w-4 shrink-0 text-white/60 lg:hidden" strokeWidth={2.4} aria-hidden="true" />
            </div>
            <p className="mt-1 text-[26px] font-bold leading-none tracking-tight text-foreground sm:text-[32px]">
              {formatCurrency(total)}
            </p>
            {/* Today's move in the balance (no Withdraw here: the business is not a rep). */}
            <div className="mt-1.5" title={`In ${formatCurrency(today.moneyIn || 0)} · out ${formatCurrency(today.moneyOut || 0)}`}>
              <TodayMove net={net} />
            </div>
          </div>

          {/* Where it sits: the bar carries the proportions; each account below it, as on the Accounts page. */}
          <div className="min-w-0 flex-1 border-t border-white/[0.06] pt-3 lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0">
            {total > 0 && held.length > 0 && (
              <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-white/[0.07]">
                {held.map((a) => (
                  <div key={a.id} className={BAR[a._i % BAR.length]} style={{ width: `${Math.max(0, (a.balance / total) * 100)}%` }} />
                ))}
              </div>
            )}
            {/* The accounts side by side, set out like the Money in / Money out / Opening figures on an account's
                card (Nino, 16 Nov 2026: "that is how I want to list the accounts"): the name small on top, the
                balance under it, no lines or boxes. Four at most (on live, M-Pesa and Airtel Money while Cash is empty);
                the details list them all. */}
            <div className="mt-3 flex flex-wrap justify-between gap-x-4 gap-y-2.5">
              {all.slice(0, 4).map((a) => {
                const empty = a.share == null;
                return (
                  <div key={a.id} className="min-w-0 max-w-[11rem]">
                    <p className="flex items-center gap-1.5 text-[10px] text-white/45">
                      <span aria-hidden className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', empty ? 'bg-white/25' : BAR[a._i % BAR.length])} />
                      <span className="truncate">{a.name}</span>
                      {!empty && <span className="tabular-nums text-white/35">{a.share}%</span>}
                    </p>
                    <p className={clsx('mt-px whitespace-nowrap text-[12.5px] font-medium tabular-nums',
                      a.balance < 0 ? 'text-rose-300' : empty ? 'text-white/55' : 'text-white/85')}>
                      {formatCurrency(a.balance)}
                    </p>
                  </div>
                );
              })}
            </div>
            {all.length > 4 && <p className="mt-1.5 text-[11px] text-faint">+{all.length - 4} more accounts</p>}
            {!all.length && <p className="text-[12px] text-muted">No account holds money right now.</p>}
          </div>

          {/* On a wide screen the sign sits at the card's far end, where "Open accounts" was. */}
          <ChevronsRight className="wallet-nudge hidden h-5 w-5 shrink-0 text-white/60 lg:block" strokeWidth={2.4} aria-hidden="true" />
        </div>
      </div>

      <Modal open={open} onClose={() => setOpen(false)} title="In the accounts">
        <div className="space-y-4">
          <div className="rounded-2xl bg-white/[0.03] px-4 py-3.5 ring-1 ring-inset ring-white/[0.06]">
            <p className="text-[11px] text-muted">Total</p>
            <p className={clsx('mt-0.5 text-[22px] font-bold leading-tight tabular-nums', total < 0 ? 'text-rose-300' : 'text-foreground')}>
              {formatCurrency(total)}
            </p>
            <div className="mt-3 border-t border-white/[0.06] pt-3">
              <TodayInOut today={today} />
            </div>
          </div>

          <section>
            <Heading>Accounts</Heading>
            {all.length ? (
              <ul className="divide-y divide-white/[0.05]">
                {all.map((a) => <AccountLine key={a.id} a={a} roomy />)}
              </ul>
            ) : <p className="py-3 text-center text-[12px] text-muted">No account holds money right now.</p>}
          </section>

          <section>
            <Heading>Latest movements</Heading>
            <Movements open={open} />
          </section>

          <button type="button" onClick={toAccounts}
            className="flex w-full cursor-pointer items-center justify-center gap-1 rounded-xl py-2 text-[12px] font-medium text-muted ring-1 ring-inset ring-white/[0.08] transition hover:text-foreground">
            Open accounts <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </Modal>
    </>
  );
}
