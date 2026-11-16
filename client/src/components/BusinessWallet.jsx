import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { Banknote, ChevronRight, Landmark, Minus, Smartphone, TrendingDown, TrendingUp, Wallet } from 'lucide-react';
import WalletCard from '@/components/WalletCard';
import { Modal } from '@/components/ui';
import { pageQueries } from '@/lib/pageQueries';
import { formatCurrency, formatNumber, formatDate, sharePercents } from '@/lib/format';
import { TXN_TYPE_LABEL } from '@/lib/financeFigures';

// The business money on the owner's Home, on the same card a rep's wallet wears (Nino, 16 Nov 2026: "copy how
// the wallet there looks, the way it slides … only the card there with the money, with the details of the
// money — M-Pesa, Airtel and Cash"). The card says the total and today's move; a swipe or a tap opens the
// accounts, today's money in and out and the latest movements. On an iPad or a computer the accounts also
// sit beside the card, where a phone has no room for them.
//
// Every figure is the dashboard's own (the accounts and today's flow from Finance); nothing is worked out here
// but each account's share of the total.

const ICON = { CASH: Banknote, MOBILE_MONEY: Smartphone, BANK: Landmark };

// The money accounts, biggest first. The Commission account is only the record of payouts the owner made from
// his own pocket before 15 Nov 2026: no money sits in it, so it is not one of them. An account holding nothing
// (Cash, often) is still listed: it is one of the places the money can be.
function pockets(accounts, total) {
  const list = (accounts || []).filter((a) => !a.isCommissionRecord).sort((a, b) => Number(b.balance) - Number(a.balance));
  const shares = sharePercents(list.map((a) => Math.max(0, Number(a.balance) || 0)), total);
  return list.map((a, i) => ({ ...a, share: shares[i] }));
}

// Today's move in the balance, where a rep's card has its Withdraw button: the same round glass button, an
// arrow up or down, and the amount under it.
function TodayMove({ net, hidden }) {
  const up = net > 0;
  const down = net < 0;
  const Icon = up ? TrendingUp : down ? TrendingDown : Minus;
  return (
    <div className="flex shrink-0 flex-col items-center gap-1" aria-label={net === 0 ? 'No change today' : `${up ? 'Up' : 'Down'} ${formatCurrency(Math.abs(net))} today`}>
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-white/[0.12] ring-1 ring-inset ring-white/20 backdrop-blur-sm">
        <Icon className={clsx('h-[18px] w-[18px]', up ? 'text-emerald-300' : down ? 'text-rose-300' : 'text-white/50')} strokeWidth={2.4} />
      </span>
      <span className="text-center leading-tight">
        <span className={clsx('block whitespace-nowrap text-[11px] font-semibold tabular-nums', up ? 'text-emerald-300' : down ? 'text-rose-300' : 'text-white/55')}>
          {net === 0 ? 'No change' : hidden ? '•••' : `${up ? '+' : '−'}${formatNumber(Math.abs(net))}`}
        </span>
        <span className="block text-[10px] text-white/45">today</span>
      </span>
    </div>
  );
}

// One account: what it is, its share of the money, its balance.
function AccountRow({ a, onOpen, compact = false }) {
  const Icon = ICON[a.type] || Wallet;
  return (
    <li>
      <button type="button" onClick={onOpen}
        className={clsx(
          'flex w-full cursor-pointer items-center gap-3 text-left transition hover:opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/30',
          compact ? 'py-1.5' : 'py-2',
        )}>
        <span className={clsx(
          'flex shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-muted ring-1 ring-inset ring-white/[0.08]',
          compact ? 'h-7 w-7' : 'h-8 w-8',
        )}>
          <Icon className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-medium leading-snug text-foreground">{a.name}</span>
          <span className="block text-[11.5px] tabular-nums text-muted">{a.share}% of the money</span>
        </span>
        <span className={clsx('shrink-0 text-[13.5px] font-semibold tabular-nums', Number(a.balance) < 0 ? 'text-rose-300' : 'text-foreground')}>
          {formatCurrency(a.balance)}
        </span>
      </button>
    </li>
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
  const list = pockets(accounts, total);
  const net = today.netCash || 0;
  const toAccounts = () => { setOpen(false); navigate('/finance?tab=accounts'); };

  return (
    <>
      <div className="mb-3 grid gap-3 sm:mb-4 md:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]">
        <WalletCard
          balance={formatCurrency(total)}
          negative={total < 0}
          label="ZELab balance"
          hint="Swipe for details"
          openLabel="Open the money details"
          aside={(hidden) => <TodayMove net={net} hidden={hidden} />}
          onOpen={() => setOpen(true)}
        />

        {/* Beside the card where there is room: the three biggest accounts, so the card keeps its own size;
            the rest, today's in and out and the movements are one swipe away, as on a phone. */}
        <div className="card hidden flex-col justify-center px-4 py-2.5 md:flex">
          <div className="flex items-center justify-between gap-3">
            <Heading>Accounts</Heading>
            <button type="button" onClick={toAccounts} className="cursor-pointer text-[11px] font-semibold text-brand-600 transition hover:underline">
              {list.length > 3 ? `All ${list.length} →` : 'Open accounts →'}
            </button>
          </div>
          <ul className="divide-y divide-white/[0.05]">
            {list.slice(0, 3).map((a) => <AccountRow key={a.id} a={a} onOpen={toAccounts} compact />)}
          </ul>
        </div>
      </div>

      <Modal open={open} onClose={() => setOpen(false)} title="ZELab wallet">
        <div className="space-y-4">
          <div className="rounded-2xl bg-white/[0.03] px-4 py-3.5 ring-1 ring-inset ring-white/[0.06]">
            <p className="text-[11px] text-muted">ZELab balance</p>
            <p className={clsx('mt-0.5 text-[22px] font-bold leading-tight tabular-nums', total < 0 ? 'text-rose-300' : 'text-foreground')}>
              {formatCurrency(total)}
            </p>
            <div className="mt-3 border-t border-white/[0.06] pt-3">
              <TodayInOut today={today} />
            </div>
          </div>

          <section>
            <Heading>Accounts</Heading>
            {list.length ? (
              <ul className="divide-y divide-white/[0.05]">
                {list.map((a) => <AccountRow key={a.id} a={a} onOpen={toAccounts} />)}
              </ul>
            ) : <p className="py-3 text-center text-[12px] text-muted">No accounts yet.</p>}
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
