import { useRef, useState } from 'react';
import clsx from 'clsx';
import { ArrowUpRight, ChevronsRight, Eye, EyeOff } from 'lucide-react';

// The rep's balance as a small digital wallet card (Nino, 10 Nov 2026: "a nice
// digital card, like a wallet, well designed, premium look, small — show the
// balance but not take too much space"). One card holds everything the top of the
// Commissions page used to spread over a box and three tiles: the balance, the
// Withdraw action, how far to the minimum, and the three supporting figures.
//
// The eye hides every amount on the card, so a rep can open the page with
// people around. The choice is remembered on this phone only (a convenience —
// nothing depends on it, and a blocked storage just means it starts shown).

const KEY = 'zelab:hideBalance';
const readHidden = () => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } };
const saveHidden = (v) => { try { localStorage.setItem(KEY, v ? '1' : '0'); } catch { /* private window: fine */ } };

const DOTS = '••••••';

export default function WalletCard({
  balance,            // formatted, e.g. "TSh 245,500"
  negative,           // balance below zero (overdue fines)
  canWithdraw,
  pct,                // 0–100, progress to the withdrawal minimum
  stats = [],         // [{ label, value (formatted), tone? }] — optional; the rep's own card shows none
  onWithdraw,
  onOpen,             // tap the card: every transaction, with the totals (Nino, 15 Nov 2026)
  // The owner's home wears the same card for the business money (Nino, 16 Nov 2026: "exactly like the rep
  // wallet"): its own words, and `aside(hidden)` in the Withdraw button's place (today's move in the balance).
  label = 'Available balance',
  hint = 'Swipe for history',
  openLabel = 'Open my wallet history',
  aside,
}) {
  const [hidden, setHidden] = useState(readHidden);
  const toggle = () => setHidden((h) => { saveHidden(!h); return !h; });
  const mask = (s) => (hidden ? '•••' : s);

  // The whole card opens the wallet's transactions — a tap, or a swipe across it, as the hint on it says
  // (Nino, 15 Nov 2026, after a banking app he showed). The eye and Withdraw keep their own job.
  const own = (fn) => (e) => { e.stopPropagation(); fn?.(e); };
  const touch = useRef(null);
  const swiped = useRef(false);
  const onTouchStart = (e) => { const t = e.touches[0]; touch.current = { x: t.clientX, y: t.clientY }; swiped.current = false; };
  const onTouchEnd = (e) => {
    const from = touch.current; touch.current = null;
    if (!from || !onOpen) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - from.x;
    const dy = t.clientY - from.y;
    // A sideways swipe, not a page scroll.
    if (Math.abs(dx) > 40 && Math.abs(dy) < 30) { swiped.current = true; onOpen(); }
  };
  const onClick = () => { if (swiped.current) { swiped.current = false; return; } onOpen?.(); };
  return (
    <section
      role={onOpen ? 'button' : undefined}
      tabIndex={onOpen ? 0 : undefined}
      aria-label={onOpen ? openLabel : undefined}
      onClick={onOpen ? onClick : undefined}
      onTouchStart={onOpen ? onTouchStart : undefined}
      onTouchEnd={onOpen ? onTouchEnd : undefined}
      onKeyDown={onOpen ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } } : undefined}
      className={clsx(
        // The card keeps the size it had with its figures row (Nino, 15 Nov 2026: "same size as before"):
        // the label at the top, the balance low on the card, as on a bank card.
        'relative isolate flex min-h-[148px] flex-col overflow-hidden rounded-[22px] p-4 text-white ring-1 ring-inset',
        negative ? 'ring-rose-400/25' : 'ring-white/[0.09]',
        // Touched, it lifts a little towards the finger, the way the card in his example rises.
        onOpen && 'wallet-lift cursor-pointer',
      )}
      style={{
        background: negative
          ? 'linear-gradient(140deg,#2a0f16 0%,#160b0e 55%,#0e0e10 100%)'
          : 'linear-gradient(140deg,#2c0e0c 0%,#170a0a 52%,#0e0e10 100%)',
        boxShadow: '0 14px 32px -16px rgba(0,0,0,.9), inset 0 1px 0 rgba(255,255,255,.07)',
      }}
    >
      {/* Soft red light from the corner and two hair-thin arcs — the card's only
          decoration. They sit behind everything and never carry information. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-12 -top-20 -z-10 h-56 w-56 rounded-full"
        style={{ background: `radial-gradient(closest-side, ${negative ? 'rgba(244,63,94,.28)' : 'rgba(238,49,36,.34)'}, transparent)` }}
      />
      <svg aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 h-full w-full" viewBox="0 0 360 180" preserveAspectRatio="none">
        <path d="M-10 150 C 100 70, 240 40, 380 96" fill="none" stroke="rgba(255,255,255,.07)" strokeWidth="1" />
        <path d="M-10 178 C 120 100, 250 78, 380 128" fill="none" stroke="rgba(255,255,255,.05)" strokeWidth="1" />
      </svg>

      {/* Label, the eye, and the house mark where a bank card keeps its logo. */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[11px] font-medium tracking-wide text-white/60">{label}</span>
          <button
            type="button"
            onClick={own(toggle)}
            aria-pressed={hidden}
            aria-label={hidden ? 'Show amounts' : 'Hide amounts'}
            className="-m-3 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white/55 transition hover:text-white active:scale-95"
          >
            {hidden ? <EyeOff className="h-[15px] w-[15px]" /> : <Eye className="h-[15px] w-[15px]" />}
          </button>
        </div>
        <img src="/brand/zelab-dark.svg" alt="ZELab" className="h-[15px] w-auto shrink-0 opacity-90" />
      </div>

      {/* Bottom of the card: the balance with the hint under it on the left, Withdraw as a round button with its
          arrow on the right (Nino, 15 Nov 2026: "small and nice", like his example). */}
      <div className="mt-auto flex items-end justify-between gap-3 pt-4">
        <div className="min-w-0">
          <p
            className={clsx(
              'truncate text-[27px] font-bold leading-none tabular-nums',
              negative ? 'text-rose-300' : 'text-white',
              hidden && 'tracking-[0.18em]',
            )}
          >
            {hidden ? DOTS : balance}
          </p>
          {onOpen && (
            <p className="mt-2 flex items-center gap-1 text-[11px] font-medium text-white/55">
              <ChevronsRight className="wallet-nudge h-3.5 w-3.5 shrink-0" strokeWidth={2.4} aria-hidden="true" />
              {hint}
            </p>
          )}
        </div>
        {aside ? aside(hidden) : <button
          type="button"
          onClick={own(onWithdraw)}
          onTouchStart={(e) => e.stopPropagation()}
          onTouchEnd={(e) => e.stopPropagation()}
          disabled={!canWithdraw}
          aria-label="Withdraw"
          className={clsx('flex shrink-0 flex-col items-center gap-1 transition active:scale-95', !canWithdraw && 'cursor-not-allowed')}
        >
          <span
            className={clsx(
              'flex h-11 w-11 items-center justify-center rounded-full ring-1 ring-inset backdrop-blur-sm',
              canWithdraw ? 'bg-white/[0.16] text-white ring-white/25' : 'bg-white/[0.06] text-white/40 ring-white/10',
            )}
          >
            <ArrowUpRight className="h-[18px] w-[18px]" strokeWidth={2.4} />
          </span>
          <span className={clsx('text-[11px] font-semibold', canWithdraw ? 'text-white' : 'text-white/45')}>Withdraw</span>
        </button>}
      </div>

      {/* Nothing is written on the card but the figures (Nino, 11 Nov 2026: keep the
          notices off it). Below the minimum a thin line shows how far there is to
          go and the greyed Withdraw says why it cannot be pressed; at the minimum
          the line goes and Withdraw lights up. A negative balance only turns the
          figure rose; the page says why, in a line under the card. */}
      {!aside && !negative && !canWithdraw && (
        <div className="mt-3 h-[3px] w-full overflow-hidden rounded-full bg-white/[0.09]">
          <div
            className="h-full rounded-full bg-gradient-to-r from-earn-500 to-earn-300 transition-[width] duration-700 ease-out"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}

      {/* Supporting figures, where a page still passes them: small, plain, no lines or boxes around them. */}
      {stats.length > 0 && <div className="mt-3.5 flex flex-wrap justify-between gap-x-4 gap-y-2">
        {stats.map((s) => (
          <div key={s.label} className="min-w-0">
            <p className="text-[10px] text-white/40">{s.label}</p>
            <p className={clsx('mt-px whitespace-nowrap text-[12.5px] font-medium tabular-nums', s.tone === 'rose' ? 'text-rose-300' : s.tone === 'amber' ? 'text-amber-300' : 'text-white/85')}>
              {mask(s.value)}
            </p>
          </div>
        ))}
      </div>}
    </section>
  );
}
