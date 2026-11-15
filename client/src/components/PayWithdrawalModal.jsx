import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Coins } from 'lucide-react';
import api, { apiError } from '@/lib/api';
import { pageQueries } from '@/lib/pageQueries';
import { wentThrough } from '@/lib/once';
import { formatCurrency } from '@/lib/format';
import { eatISODate } from '@/lib/tz';
import { Modal, Button, Field, Input, Select, PageSpinner } from '@/components/ui';

// Paying a rep (15 Nov 2026): the money leaves a business account — Cash, Airtel Money or M-Pesa — chosen here,
// checked against what it holds, taken once, and the withdrawal is marked paid in the same step. Paying from your
// own pocket means putting the money in first (Finance → Put my money in), then paying from that account.
export default function PayWithdrawalModal({ w, onClose, onDone }) {
  const { data: all = [], isLoading } = useQuery(pageQueries.financeAccounts());
  const accounts = all.filter((a) => !a.isCommissionRecord);
  const [accountId, setAccountId] = useState('');
  const [date, setDate] = useState(eatISODate());
  const account = accounts.find((a) => a.id === (accountId || accounts.find((x) => x.isDefault)?.id || accounts[0]?.id));
  const amount = Number(w.amount || 0);
  const short = account ? Math.max(0, amount - Number(account.balance || 0)) : 0;
  const bonus = w.source === 'BONUS';
  const pay = useMutation({
    mutationFn: () => api.post(`/commissions/withdrawals/${w.id}/decide`, { action: 'PAY', accountId: account?.id, occurredAt: date }),
    onSuccess: () => { toast.success(`Paid ${formatCurrency(amount)} from ${account?.name}`); onDone(); onClose(); },
    // Already paid (a second press, or a lost answer): say so and show the real state.
    onError: (e) => { if (wentThrough(e)) { toast.success('Already paid'); onDone(); onClose(); return; } toast.error(apiError(e), { duration: 9000 }); },
  });
  return (
    <Modal open onClose={onClose} title={`Pay ${w.salesRep?.user?.name || w.repName || 'rep'} · ${formatCurrency(amount)}`}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button loading={pay.isPending} disabled={!account || short > 0} onClick={() => pay.mutate()}>
          <Coins className="h-4 w-4" /> Pay {formatCurrency(amount)}
        </Button>
      </>}>
      {isLoading ? <PageSpinner /> : (
        <div className="space-y-4">
          {(w.notes || w.payTo) && (
            <div className="rounded-lg bg-white/[0.03] px-3 py-2 ring-1 ring-white/[0.08]">
              <p className="text-[11px] text-faint">Send it to</p>
              <p className="font-mono text-sm text-amber-300">{w.notes || w.payTo}</p>
            </div>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Paid from">
              <Select value={account?.id || ''} onChange={(e) => setAccountId(e.target.value)}>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name} — {formatCurrency(a.balance)}</option>)}
              </Select>
            </Field>
            <Field label="Date paid"><Input type="date" max={eatISODate()} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          </div>
          {short > 0 && (
            <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-300 ring-1 ring-rose-500/20">
              {account.name} holds {formatCurrency(account.balance)} — {formatCurrency(short)} short. If you are paying with your own money, first record it in Finance with Put my money in.
            </p>
          )}
          <p className="text-[11px] leading-snug text-faint">
            Send the money first. This takes it from {account?.name || 'the account'}, records it as a{bonus ? ' bonus' : ' commission'} payment and tells the rep it has been paid.
          </p>
        </div>
      )}
    </Modal>
  );
}
