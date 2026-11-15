import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Plus, Ship, PackageCheck, Pencil, Trash2, Eye, Wallet } from 'lucide-react';
import api, { unwrap, apiError } from '@/lib/api';
import { keepOnPageTurn, pageQueries } from '@/lib/pageQueries';
import { useAuth } from '@/context/AuthContext';
import { useProducts, useWarehouses, useBrands } from '@/lib/hooks';
import { wentThrough } from '@/lib/once';
import { refreshAfter } from '@/lib/afterWrite';
import { PO_STATUS_META, ROLES } from '@/lib/constants';
import { formatCurrency, formatDate, formatNumber, pluralizeUnit } from '@/lib/format';
import { eatISODate } from '@/lib/tz';
import ProductPicker, { useHomeWarehouse, PlaceLine, Chips, Caution, MoreToggle, DiscardFooter, changeBtn } from '@/components/ProductPicker';
import { pickerRows, cartonRows, rowsWithSaved, pickedBoxes, primaryWarehouse, lineCost, boxWord, shortPlace, buttonPlace } from '@/lib/stockPick';
import {
  PageHeader, Card, PageSpinner, EmptyState, Badge, Button, Modal, Field, Input, NumberInput, Textarea, Select,
  Pagination, LoadError, Table, THead, TBody, TR, TH, TD,
} from '@/components/ui';

// New purchase order — the quick way (Nino, 11 Nov 2026: "the PO should be easy, not complicated and hard to
// fill and select all the time"). The supplier is the one this device last ordered from; the order goes to the
// primary warehouse (named in no request, as before) unless changed here — never to the warehouse another
// window last used; ordered today; every product is listed with a  −  qty  +  and its cost per box filled in
// from the buying price (still editable). The dates and the shipping, clearing and other costs sit behind two
// quiet toggles that only show or hide them — closing one never changes a figure. An order being edited keeps
// every saved line as it was — a carton line stays in cartons.
// The request is the old one, field for field.
const LAST_SUPPLIER_KEY = 'zl.po.supplier';
const readLastSupplier = () => { try { return localStorage.getItem(LAST_SUPPLIER_KEY) || ''; } catch { return ''; } };
const saveLastSupplier = (id) => { try { if (id) localStorage.setItem(LAST_SUPPLIER_KEY, id); } catch { /* private window */ } };

function POModal({ onClose, editing }) {
  const qc = useQueryClient();
  const { data: products = [], isLoading: productsLoading } = useProducts();
  const { data: warehouses = [] } = useWarehouses();
  const { data: suppliers = [], isLoading: suppliersLoading } = useQuery({ queryKey: ['suppliers', 'opts'], queryFn: async () => unwrap(await api.get('/suppliers', { params: { limit: 200 } })).data });
  const { active } = useHomeWarehouse(warehouses);
  const primary = primaryWarehouse(active);

  const day = (d) => (d ? String(d).slice(0, 10) : '');
  const [lastSupplier] = useState(readLastSupplier);
  const [supplierPick, setSupplierPick] = useState(editing?.supplierId || '');
  const [editSupplier, setEditSupplier] = useState(false);
  // '' = the primary warehouse (the server's own choice when none is named), as the old "Primary warehouse".
  const [whPick, setWhPick] = useState(editing?.warehouseId || '');
  const [editWh, setEditWh] = useState(false);
  const [qty, setQty] = useState({});
  const [cost, setCost] = useState({});
  // Bought by the carton (fixed boxes per carton) or by the box. A new order starts in cartons, as goods are
  // bought from the factory (15 Nov 2026); an order being edited keeps the unit it was saved in.
  const savedInCartons = !!editing?.items?.length && editing.items.every((i) => /^carton$/i.test(i.packagingUnit?.name || ''));
  const [unit, setUnit] = useState(editing ? (savedInCartons ? 'carton' : 'box') : 'carton');
  const inCartons = unit === 'carton';
  const [costs, setCosts] = useState({
    shippingCost: Number(editing?.shippingCost) || 0,
    clearingCost: Number(editing?.clearingCost) || 0,
    otherCost: Number(editing?.otherCost) || 0,
  });
  const [extras, setExtras] = useState(!!(Number(editing?.shippingCost) || Number(editing?.clearingCost) || Number(editing?.otherCost)));
  const [showDates, setShowDates] = useState(false);
  const [expectedArrival, setExpectedArrival] = useState(day(editing?.expectedArrival));
  // No date by default, as before: a new PO starts as a DRAFT. A date makes it ORDERED, and whether an ordered
  // PO already counts as money owed to the supplier is the owner's open decision (D8) — not changed here.
  const [orderedAt, setOrderedAt] = useState(day(editing?.orderedAt));
  const [notes, setNotes] = useState(editing?.notes || '');
  const [touched, setTouched] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const sending = useRef(false);

  // A deleted (switched-off) supplier is never picked for a new order, even if it was the last one used.
  const supplierId = supplierPick || (!editing && suppliers.some((s) => s.id === lastSupplier && s.isActive !== false) ? lastSupplier : '');
  const supplier = suppliers.find((s) => s.id === supplierId) || (editing && editing.supplierId === supplierId ? editing.supplier : null);
  // A new order names no warehouse unless one is picked here (the server then uses the primary, as before).
  const warehouseId = whPick;
  const into = warehouseId ? (active.find((w) => w.id === warehouseId) || (editing?.warehouseId === warehouseId ? editing.warehouse : null)) : primary;
  const intoAway = !!(warehouseId && primary && warehouseId !== primary.id);

  // Every product in its carton (or its box); an order being edited in boxes also gets a row for any saved
  // line that is not that.
  const baseRows = useMemo(() => (inCartons ? cartonRows(products) : pickerRows(products)), [products, inCartons]);
  const productsReady = !productsLoading;
  const saved = useMemo(() => {
    if (!editing || !productsReady) return null;
    if (!inCartons) return rowsWithSaved(baseRows, editing.items, products);
    // In cartons: each saved line on its product's carton row, at its price per carton.
    const q = {};
    const c = {};
    editing.items.forEach((it) => {
      const key = `${it.productId}:ct`;
      const size = it.quantity ? Number(it.baseQuantity) / Number(it.quantity) : 1;
      q[key] = Number(it.quantity) || 0;
      c[key] = String(Math.round(Number(it.unitCost || 0) * size * 100) / 100);
    });
    return { rows: baseRows, qty: q, cost: c };
  }, [editing, productsReady, baseRows, products, inCartons]);
  const rows = saved ? saved.rows : baseRows;
  const seeded = useRef(false);
  useEffect(() => {
    if (!saved || seeded.current) return;
    seeded.current = true;
    setQty(saved.qty);
    setCost(saved.cost);
  }, [saved]);

  const picked = rows.filter((r) => Number(qty[r.key]) > 0);
  const payload = () => ({
    supplierId,
    // Every figure on this form is in shillings (audit reversals-stock-8: new orders were saved as USD). Only
    // on a new order: an edit leaves an older order's stored label as it is.
    currency: editing ? undefined : 'TZS',
    // The server keeps the cost per box: a carton price is divided by the boxes in a carton, to six places, so
    // qty × price rounds back to exactly what was typed (100,000 a carton of 24 is still 100,000).
    items: picked.map((r) => ({
      productId: r.id, packagingUnitId: r.packagingUnitId, quantity: Number(qty[r.key]),
      unitCost: inCartons && r.unitName ? Math.round(((Number(lineCost(cost, r)) || 0) / (r.size || 1)) * 1e6) / 1e6 : Number(lineCost(cost, r)) || 0,
    })),
    shippingCost: Number(costs.shippingCost) || 0,
    clearingCost: Number(costs.clearingCost) || 0,
    otherCost: Number(costs.otherCost) || 0,
    warehouseId: warehouseId || undefined,
    orderedAt: orderedAt || undefined,
    expectedArrival: expectedArrival || undefined,
    notes: notes || undefined,
  });

  const save = useMutation({
    mutationFn: () => (editing
      ? api.put(`/purchase-orders/${editing.id}`, payload())
      : api.post('/purchase-orders', payload())),
    onSuccess: () => {
      saveLastSupplier(supplierId);
      toast.success(editing ? 'Purchase order updated' : 'Draft saved — confirm the purchase once you have paid for it');
      qc.invalidateQueries({ queryKey: ['purchase-orders'] });
      onClose();
    },
    onError: (e) => toast.error(apiError(e)),
    onSettled: () => { sending.current = false; },
  });

  // Same sums as before: boxes × cost per box, plus the extra costs.
  const boxes = pickedBoxes(rows, qty);
  const goods = picked.reduce((n, r) => n + Number(qty[r.key]) * (inCartons && r.unitName ? 1 : (r.size || 1)) * (Number(lineCost(cost, r)) || 0), 0);
  const extraSum = (Number(costs.shippingCost) || 0) + (Number(costs.clearingCost) || 0) + (Number(costs.otherCost) || 0);
  const total = goods + extraSum;

  const valid = !!supplierId && picked.length > 0 && !(editing && !seeded.current);
  const submit = () => {
    if (sending.current || save.isPending || !valid) return;
    sending.current = true;
    save.mutate();
  };
  const dirty = editing ? touched : picked.length > 0;
  const requestClose = () => {
    if (save.isPending) return;
    if (!dirty || confirmDiscard) onClose(); else setConfirmDiscard(true);
  };
  const touch = () => { setTouched(true); setConfirmDiscard(false); };
  const pick = (next) => { setQty(next); touch(); };
  const setRowCost = (key, v) => { setCost((c) => ({ ...c, [key]: v })); touch(); };
  // The toggle only shows or hides the costs: closing it never changes a figure, and the closed toggle shows their sum.
  const toggleExtras = () => setExtras((x) => !x);

  // A deleted (switched-off) supplier is offered only on an old order that already names it, marked as such
  // (audit money-flows-8); new orders never list it.
  const supplierOptions = suppliers.filter((s) => s.isActive !== false || s.id === supplierId).map((s) => ({
    value: s.id, label: s.name,
    sub: [s.isActive === false ? 'switched off' : null, s.country].filter(Boolean).join(' · ') || undefined,
  }));
  // The primary is '' (named in no request) — except on an order saved into another warehouse: there, choosing
  // the primary must name it, or the server would keep the old warehouse while the window says the primary.
  const primaryValue = (id) => (primary && id === primary.id && !editing?.warehouseId ? '' : id);

  const today = eatISODate();
  const datesLabel = `${orderedAt ? (orderedAt === today ? 'Ordered today' : `Ordered ${formatDate(orderedAt)}`) : 'No order date (draft)'}`
    + `${expectedArrival ? ` · arriving ${formatDate(expectedArrival)}` : ''}`;

  return (
    <Modal open onClose={requestClose} size="lg" title={editing ? `Edit ${editing.poNumber}` : 'New purchase order (import)'}
      footer={confirmDiscard ? (
        <DiscardFooter what={editing ? 'change' : 'order'} detail={editing ? 'What you changed on this order will be lost.' : `${formatNumber(boxes)} ${boxWord(boxes)} picked will be lost.`}
          onDiscard={onClose} onKeep={() => setConfirmDiscard(false)} />
      ) : (
        <>
          <div className="mr-auto min-w-0 flex-1 basis-0 text-sm">
            {picked.length === 0 ? <span className="text-muted">Tap + on what you are ordering</span> : (
              <>
                <div className="truncate text-muted">
                  <span className="font-semibold tabular-nums text-foreground">{formatNumber(boxes)}</span> {boxWord(boxes)}
                  {supplier && <> from <span className="font-medium text-foreground">{supplier.name}</span></>}
                  {into && <> into <span className={clsx('font-medium', intoAway ? 'text-amber-300' : 'text-foreground')}>{buttonPlace(into.name)}</span></>}
                </div>
                {boxes > 0 && total > 0 && (
                  <div className="text-xs text-faint">
                    goods {formatCurrency(goods)}{extraSum > 0 && <> + costs {formatCurrency(extraSum)}</>} · {formatCurrency(total / boxes)} a box
                  </div>
                )}
              </>
            )}
          </div>
          <Button variant="secondary" className="hidden sm:inline-flex" onClick={requestClose}>Cancel</Button>
          <Button data-picker-submit="" className="h-12 w-full text-base sm:h-auto sm:w-auto sm:text-sm" loading={save.isPending} disabled={!valid} onClick={submit}>
            {editing ? 'Save changes' : 'Save draft'}
            {picked.length > 0 && <span className="tabular-nums">· {formatCurrency(total)}</span>}
          </Button>
        </>
      )}>
      <div className="space-y-2.5 sm:space-y-4 max-sm:min-h-[calc(100dvh_-_17rem)]">
        {supplierId && !editSupplier ? (
          <PlaceLine
            parts={[
              { label: 'Supplier', kind: 'supplier', name: supplier?.name || '…', sub: supplier?.country },
              { label: 'Into', kind: 'warehouse', name: into ? shortPlace(into.name) : '…', sub: warehouseId ? into?.region : 'primary', title: into?.name, amber: intoAway },
            ]}
            open={false}
            onToggle={() => { setEditSupplier(true); setEditWh(true); }}
            note={intoAway && primary && (
              <Caution action={<button type="button" onClick={() => { setWhPick(primaryValue(primary.id)); touch(); }} className={changeBtn}>Use {shortPlace(primary.name)}</button>}>
                Not the usual warehouse.
              </Caution>
            )}
          />
        ) : (
          <div className="space-y-3 rounded-xl bg-white/[0.03] p-3 ring-1 ring-white/[0.08]">
            <Chips label="Supplier" value={supplierId} onChange={(id) => { setSupplierPick(id); touch(); }} options={supplierOptions}
              empty={suppliersLoading ? 'Loading suppliers…' : 'No suppliers yet — add one under Suppliers.'} />
            {(editWh || editSupplier) && active.length > 0 && (
              <Chips label="Receive into" value={primaryValue(warehouseId)} onChange={(id) => { setWhPick(id); touch(); }}
                options={active.map((w) => ({ value: primaryValue(w.id), label: w.name, sub: primary && w.id === primary.id ? 'primary' : w.region }))} />
            )}
            {supplierId && (
              <div className="flex justify-end">
                <button type="button" onClick={() => { setEditSupplier(false); setEditWh(false); }} className={clsx(changeBtn, 'text-foreground')}>Done</button>
              </div>
            )}
          </div>
        )}

        <div className="flex items-center justify-between gap-3 px-1">
          <span className="text-xs text-muted">Buy by the</span>
          <div className="inline-flex rounded-lg bg-white/[0.04] p-0.5 ring-1 ring-white/[0.08]" role="radiogroup" aria-label="Unit">
            {[['carton', 'Carton'], ['box', 'Box']].map(([k, label]) => (
              <button key={k} type="button" role="radio" aria-checked={unit === k}
                disabled={unit !== k && picked.length > 0}
                title={unit !== k && picked.length > 0 ? 'Clear the list to switch' : undefined}
                onClick={() => { if (unit !== k) { setUnit(k); setQty({}); setCost({}); seeded.current = true; } }}
                className={clsx('min-h-[36px] cursor-pointer rounded-md px-3 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-40',
                  unit === k ? 'bg-white/[0.12] text-foreground' : 'text-muted hover:text-foreground')}>
                {label}
              </button>
            ))}
          </div>
        </div>

        <ProductPicker rows={rows} value={qty} onChange={pick} cost={cost} onCost={setRowCost} inUnits={inCartons}
          loading={productsLoading || (!!editing && !seeded.current)} emptyText="No products yet." />

        <div className="flex flex-col gap-1 [&>div]:mb-2">
          <MoreToggle open={showDates} onToggle={() => setShowDates((x) => !x)}>{datesLabel}</MoreToggle>
          {showDates && (
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-xs text-muted">Ordered
                <Input type="date" value={orderedAt} onChange={(e) => { setOrderedAt(e.target.value); touch(); }} className="mt-1" />
              </label>
              <label className="block text-xs text-muted">Expected arrival <span className="text-faint">(optional)</span>
                <Input type="date" min={orderedAt || undefined} value={expectedArrival} onChange={(e) => { setExpectedArrival(e.target.value); touch(); }} className="mt-1" />
              </label>
            </div>
          )}
          <MoreToggle open={extras} onToggle={toggleExtras}>
            Extra costs{!extras && extraSum > 0 ? ` · ${formatCurrency(extraSum)}` : ''}
          </MoreToggle>
          {extras && (
            <div className="space-y-2">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Field label="Shipping (TZS)"><NumberInput min="0" value={costs.shippingCost} onChange={(e) => { setCosts({ ...costs, shippingCost: e.target.value }); touch(); }} /></Field>
                <Field label="Clearing (TZS)"><NumberInput min="0" value={costs.clearingCost} onChange={(e) => { setCosts({ ...costs, clearingCost: e.target.value }); touch(); }} /></Field>
                <Field label="Other (TZS)"><NumberInput min="0" value={costs.otherCost} onChange={(e) => { setCosts({ ...costs, otherCost: e.target.value }); touch(); }} /></Field>
              </div>
              <p className="text-xs text-faint">Spread over the boxes as landed cost when the order is received.</p>
            </div>
          )}
        </div>

        <Field label="Notes"><Textarea rows={2} value={notes} onChange={(e) => { setNotes(e.target.value); touch(); }} placeholder="Optional" /></Field>
      </div>
    </Modal>
  );
}

function SupplierModal({ editing, onClose }) {
  const qc = useQueryClient();
  const [form, setForm] = useState(editing || { name: '', country: 'China', brandId: '', contactName: '', phone: '', email: '' });
  // The brand, as on Finance's supplier form (audit money-flows-8: a supplier made here could never get one).
  const { data: brands = [] } = useBrands();
  // A blank brand is "no brand": cleared on an edit, left out on a new supplier.
  const body = () => ({ ...form, brandId: form.brandId || (editing ? null : undefined) });
  const save = useMutation({
    mutationFn: () => (editing ? api.put(`/suppliers/${editing.id}`, body()) : api.post('/suppliers', body())),
    onSuccess: () => {
      toast.success('Saved');
      qc.invalidateQueries({ queryKey: ['suppliers'] });
      qc.invalidateQueries({ queryKey: ['finance'] });
      onClose();
    },
    onError: (e) => toast.error(apiError(e)),
  });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  return (
    <Modal open onClose={onClose} title={editing ? 'Edit supplier' : 'New supplier'}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={save.isPending} disabled={!form.name} onClick={() => save.mutate()}>Save</Button></>}>
      <div className="space-y-4">
        <Field label="Name" required><Input value={form.name} onChange={set('name')} /></Field>
        <Field label="Brand" hint="Payments to this supplier count against this brand's books">
          <Select value={form.brandId || ''} onChange={set('brandId')}>
            <option value="">General (no brand)</option>
            {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Country"><Input value={form.country || ''} onChange={set('country')} /></Field>
          <Field label="Contact"><Input value={form.contactName || ''} onChange={set('contactName')} /></Field>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Phone"><Input value={form.phone || ''} onChange={set('phone')} /></Field>
          <Field label="Email"><Input value={form.email || ''} onChange={set('email')} /></Field>
        </div>
        {/* Switching a supplier off or back on (audit money-flows-8: one switched off could not come back). */}
        {editing && (
          <label className="flex min-h-[44px] w-fit cursor-pointer items-center gap-2 text-sm text-foreground sm:min-h-0">
            <input type="checkbox" checked={form.isActive !== false} onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
              className="h-4 w-4 rounded accent-zinc-300" /> Active
          </label>
        )}
      </div>
    </Modal>
  );
}

// ── Cash-only purchasing (15 Nov 2026) ─────────────────────────────────────────────────────────────────
// Draft → Confirm purchase (paid from an account) → Dispatch → Receive (as many times as the cargo comes in
// parts) → Completed. The admin does every step; other staff can look, without prices. Receiving follows the
// SuperDrive pattern: per product what arrived (with "Arrived fine" to fill what is still to come), what of it is
// damaged or rejected (with a reason), what is missing, and "Nothing more is coming" to close the rest.
const NOT_YET_BOUGHT = ['DRAFT', 'ORDERED'];
const ARRIVING = ['IN_TRANSIT', 'PARTLY_RECEIVED'];
const sizeOf = (it) => (it.quantity ? Math.max(1, Math.round(it.baseQuantity / it.quantity)) : 1);
const unitWord = (it, n) => {
  const u = String(it.packagingUnit?.name || 'box').toLowerCase();
  return n === 1 ? u : pluralizeUnit(u);
};
// Boxes shown in the line's own unit when they divide evenly ("4 cartons"), else as boxes.
const inUnit = (it, base) => {
  const size = sizeOf(it);
  if (size > 1 && base % size === 0) return `${formatNumber(base / size)} ${unitWord(it, base / size)}`;
  return `${formatNumber(base)} ${boxWord(base)}`;
};
const leftOf = (it) => Math.max(0, (it.baseQuantity || 0) - (it.receivedBase || 0) - (it.missingBase || 0));
const orderBoxes = (po) => (po.items || []).reduce((n, i) => n + (i.baseQuantity || 0), 0);
const orderInStock = (po) => (po.items || []).reduce((n, i) => n + (i.receivedBase || 0) - (i.damagedBase || 0), 0);
const orderLeft = (po) => (po.items || []).reduce((n, i) => n + leftOf(i), 0);
const paidOn = (po) => (po.payments || []).filter((t) => t.direction === 'OUT').reduce((n, t) => n + Number(t.amount || 0), 0);
const newKey = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `k-${Date.now()}-${Math.round(Math.random() * 1e9)}`);

// One order, fresh from the server (payments and who did each step come only with this read).
const usePO = (id) => useQuery({
  queryKey: ['purchase-orders', 'one', id],
  queryFn: async () => unwrap(await api.get(`/purchase-orders/${id}`)).data,
  enabled: !!id,
});

// After any step: the orders, the money and (on receiving) the stock everywhere.
function useAfterStep() {
  const qc = useQueryClient();
  return (stock = false) => {
    qc.invalidateQueries({ queryKey: ['purchase-orders'] });
    qc.invalidateQueries({ queryKey: ['finance'] });
    if (stock) refreshAfter(qc, 'stock');
  };
}

function MoneyAccountSelect({ value, onChange, accounts }) {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)}>
      {accounts.map((a) => <option key={a.id} value={a.id}>{a.name} — {formatCurrency(a.balance)}</option>)}
    </Select>
  );
}

// The accounts that can pay for this order. The commission account is a record of payouts, never a wallet; an
// account reserved for one brand only pays for that brand's stock (OHIS and Civlily money never mix) — the
// server refuses it too. The order's brand is its products' brand when they are all one brand.
function useMoneyAccounts(po) {
  const q = useQuery(pageQueries.financeAccounts());
  const brands = [...new Set((po?.items || []).map((i) => i.product?.brandId).filter(Boolean))];
  // A brand's own account only when every product is that brand; a mixed order is paid from a shared account.
  return { ...q, accounts: (q.data || []).filter((a) => !a.isCommissionRecord && (!a.brandId || (brands.length === 1 && a.brandId === brands[0]))) };
}

// Confirm purchase: the goods were bought with cash. Pays the whole order from one account, once.
function ConfirmPurchaseModal({ poId, onClose }) {
  const { data: po } = usePO(poId);
  const { accounts, isLoading } = useMoneyAccounts(po);
  const [accountId, setAccountId] = useState('');
  const [date, setDate] = useState(eatISODate());
  const [notes, setNotes] = useState('');
  const after = useAfterStep();
  const account = accounts.find((a) => a.id === (accountId || accounts.find((x) => x.isDefault)?.id || accounts[0]?.id));
  // What the server would take now: an older order may already be paid through the supplier's balance.
  const due = po ? Math.max(0, Number(po.toPay ?? (Number(po.totalCost || 0) - paidOn(po)))) : 0;
  const short = account && due > 0 ? Math.max(0, due - Number(account.balance || 0)) : 0;
  const noPrice = (po?.items || []).some((i) => !(Number(i.unitCost) > 0));
  const done = () => { after(); onClose(); };
  const save = useMutation({
    mutationFn: () => api.post(`/purchase-orders/${poId}/purchase`, { accountId: due > 0 ? account?.id : undefined, occurredAt: date, notes: notes.trim() || undefined }),
    onSuccess: () => { toast.success(due > 0 ? `${po.poNumber} purchased — ${formatCurrency(due)} paid from ${account?.name}` : `${po.poNumber} purchased — it was already paid`); done(); },
    onError: (e) => { if (wentThrough(e)) { toast.success(`${po.poNumber} is already purchased`); done(); return; } toast.error(apiError(e), { duration: 9000 }); },
  });
  return (
    <Modal open onClose={onClose} title={po ? `Confirm purchase · ${po.poNumber}` : 'Confirm purchase'}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button loading={save.isPending} disabled={!po || (due > 0 && (!account || short > 0)) || noPrice} onClick={() => save.mutate()}>
          <Wallet className="h-4 w-4" /> {due > 0 ? `Pay ${formatCurrency(due)} and confirm` : 'Confirm — already paid'}
        </Button>
      </>}>
      {!po || isLoading ? <PageSpinner /> : (
        <div className="space-y-4">
          <p className="text-sm text-muted">You bought these in China with cash. The money leaves the account you choose, once, and the order is locked.</p>
          <div className="divide-y divide-white/[0.06] rounded-xl ring-1 ring-white/[0.08]">
            {po.items.map((i) => (
              <div key={i.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <span className="min-w-0 truncate text-foreground">{i.product?.name}</span>
                <span className="shrink-0 tabular-nums text-muted">
                  {formatNumber(i.quantity)} {unitWord(i, i.quantity)} × {formatNumber(Number(i.unitCost || 0) * sizeOf(i))} = <span className="font-semibold text-foreground">{formatCurrency(Number(i.unitCost || 0) * i.baseQuantity)}</span>
                </span>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Paid from"><MoneyAccountSelect value={account?.id || ''} onChange={setAccountId} accounts={accounts} /></Field>
            <Field label="Date paid"><Input type="date" max={eatISODate()} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          </div>
          {noPrice && <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-300 ring-1 ring-amber-500/20">A product has no buying price. Edit the order and fill it in first.</p>}
          {short > 0 && (
            <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-300 ring-1 ring-rose-500/20">
              {account.name} holds {formatCurrency(account.balance)}. You need {formatCurrency(due)}, so {formatCurrency(short)} is missing. Put money into {account.name} or choose another account.
            </p>
          )}
          <Field label="Notes"><Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional — e.g. paid at the factory" /></Field>
        </div>
      )}
    </Modal>
  );
}

function DispatchModal({ po, onClose }) {
  const [date, setDate] = useState(eatISODate());
  const [expected, setExpected] = useState(po.expectedArrival ? String(po.expectedArrival).slice(0, 10) : '');
  const after = useAfterStep();
  const done = () => { after(); onClose(); };
  const save = useMutation({
    mutationFn: () => api.post(`/purchase-orders/${po.id}/dispatch`, { dispatchedAt: date, expectedArrival: expected || undefined }),
    onSuccess: () => { toast.success(`${po.poNumber} is on its way`); done(); },
    onError: (e) => { if (wentThrough(e)) { toast.success(`${po.poNumber} is already on its way`); done(); return; } toast.error(apiError(e)); },
  });
  return (
    <Modal open onClose={onClose} title={`Dispatch · ${po.poNumber}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={save.isPending} onClick={() => save.mutate()}><Ship className="h-4 w-4" /> Mark as in transit</Button></>}>
      <div className="space-y-4">
        <p className="text-sm text-muted">The goods left China. Nothing enters stock until you receive them here.</p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Dispatched"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label="Expected arrival"><Input type="date" min={date} value={expected} onChange={(e) => setExpected(e.target.value)} /></Field>
        </div>
      </div>
    </Modal>
  );
}

// Shipping, clearing or other cost on a bought order — paid in cash as it is recorded.
function AddCostModal({ po, onClose }) {
  const { accounts } = useMoneyAccounts(po);
  const [kind, setKind] = useState('shipping');
  const [amount, setAmount] = useState('');
  const [accountId, setAccountId] = useState('');
  const [date, setDate] = useState(eatISODate());
  const [notes, setNotes] = useState('');
  const after = useAfterStep();
  const account = accounts.find((a) => a.id === (accountId || accounts.find((x) => x.isDefault)?.id || accounts[0]?.id));
  const amt = Number(amount) || 0;
  const short = account ? Math.max(0, amt - Number(account.balance || 0)) : 0;
  const save = useMutation({
    mutationFn: () => api.post(`/purchase-orders/${po.id}/costs`, { kind, amount: amt, accountId: account?.id, occurredAt: date, notes: notes.trim() || undefined }),
    onSuccess: () => { toast.success(`${formatCurrency(amt)} added to ${po.poNumber}`); after(); onClose(); },
    onError: (e) => toast.error(apiError(e), { duration: 9000 }),
  });
  return (
    <Modal open onClose={onClose} title={`Add cost · ${po.poNumber}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={save.isPending} disabled={!(amt > 0) || !account || short > 0} onClick={() => save.mutate()}>Pay {formatCurrency(amt)}</Button></>}>
      <div className="space-y-4">
        <Chips label="Cost" value={kind} onChange={setKind} options={[{ value: 'shipping', label: 'Shipping' }, { value: 'clearing', label: 'Clearing' }, { value: 'other', label: 'Other' }]} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Amount (TZS)"><NumberInput min="0" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
          <Field label="Paid from"><MoneyAccountSelect value={account?.id || ''} onChange={setAccountId} accounts={accounts} /></Field>
        </div>
        {short > 0 && <p className="text-xs text-rose-300">{account.name} holds {formatCurrency(account.balance)} — {formatCurrency(short)} short.</p>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Date paid"><Input type="date" max={eatISODate()} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label="Notes"><Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" /></Field>
        </div>
        <p className="text-xs text-faint">Spread over the boxes received from now on as landed cost. Boxes already in stock keep the cost they came in at.</p>
      </div>
    </Modal>
  );
}

// Receive cargo — one step: what arrived goes into stock as you confirm (damaged and missing never do).
function ReceiveModal({ poId, onClose }) {
  const { data: po } = usePO(poId);
  const after = useAfterStep();
  const key = useRef(newKey());
  const [rows, setRows] = useState({}); // itemId → { received, damaged, missing, note, open }
  const [noMore, setNoMore] = useState(false);
  const [arrivedAt, setArrivedAt] = useState(eatISODate());
  const [notes, setNotes] = useState('');
  const open = (po?.items || []).filter((i) => leftOf(i) > 0);
  const get = (id) => rows[id] || {};
  const setRow = (id, patch) => setRows((r) => ({ ...r, [id]: { ...r[id], ...patch } }));
  const leftUnits = (i) => Math.floor(leftOf(i) / sizeOf(i));
  const num = (v) => Math.max(0, Math.floor(Number(v) || 0));
  const line = (i) => {
    const r = get(i.id);
    const received = num(r.received);
    const damaged = num(r.damaged);
    const missing = noMore ? Math.max(0, leftUnits(i) - received) : num(r.missing);
    let error = '';
    if (received + missing > leftUnits(i)) error = `Only ${formatNumber(leftUnits(i))} ${unitWord(i, leftUnits(i))} still to come`;
    else if (damaged > received) error = 'More damaged than arrived';
    else if (damaged > 0 && !String(r.note || '').trim()) error = 'Say what is wrong with the damaged';
    return { i, received, damaged, missing, note: String(r.note || '').trim(), error };
  };
  const lines = open.map(line);
  const entered = lines.filter((l) => l.received || l.damaged || l.missing);
  const errors = lines.filter((l) => l.error);
  const sum = (f) => lines.reduce((n, l) => n + f(l) * sizeOf(l.i), 0);
  const intoStock = sum((l) => l.received - l.damaged);
  const damagedBoxes = sum((l) => l.damaged);
  const missingBoxes = sum((l) => l.missing);
  const stillToCome = lines.reduce((n, l) => n + Math.max(0, leftOf(l.i) - (l.received + l.missing) * sizeOf(l.i)), 0);
  const done = () => { after(true); onClose(); };
  const save = useMutation({
    mutationFn: () => api.post(`/purchase-orders/${poId}/receive-cargo`, {
      clientKey: key.current,
      arrivedAt,
      notes: notes.trim() || undefined,
      items: entered.map((l) => ({ itemId: l.i.id, received: l.received, damaged: l.damaged, missing: l.missing, note: l.note || undefined })),
    }),
    onSuccess: (r) => {
      const now = r.data?.data;
      toast.success(`${formatNumber(intoStock)} ${boxWord(intoStock)} added to stock${now?.status === 'RECEIVED' ? ` — ${po.poNumber} is complete` : ''}`);
      done();
    },
    onError: (e) => { if (wentThrough(e)) { toast.success('Already received — the boxes are in stock'); done(); return; } toast.error(apiError(e), { duration: 9000 }); },
  });
  const allFine = () => setRows((r) => Object.fromEntries(open.map((i) => [i.id, { ...r[i.id], received: String(leftUnits(i)) }])));

  return (
    <Modal open onClose={onClose} size="xl" title={po ? `Receive · ${po.poNumber}` : 'Receive'}
      footer={po && (
        <>
          <div className="mr-auto hidden text-xs text-muted sm:block">
            <span className="font-semibold text-foreground">{formatNumber(intoStock)}</span> into stock
            {damagedBoxes > 0 && <> · <span className="text-amber-300">{formatNumber(damagedBoxes)} damaged</span></>}
            {missingBoxes > 0 && <> · <span className="text-rose-300">{formatNumber(missingBoxes)} missing</span></>}
            {' · '}{formatNumber(stillToCome)} still to come <span className="text-faint">(boxes)</span>
          </div>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button loading={save.isPending} disabled={!entered.length || errors.length > 0} onClick={() => save.mutate()}>
            <PackageCheck className="h-4 w-4" /> Confirm and add to stock
          </Button>
        </>
      )}>
      {!po ? <PageSpinner /> : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <p className="max-w-md text-sm text-muted">Count what arrived. Only good boxes go into stock; anything not yet here stays open for the next delivery.</p>
            <Button variant="secondary" className="px-3 py-1.5 text-xs" onClick={allFine}>Everything arrived fine</Button>
          </div>
          <ul className="divide-y divide-white/[0.06] rounded-xl ring-1 ring-white/[0.08]">
            {lines.map((l) => {
              const { i } = l;
              const r = get(i.id);
              const before = (i.receivedBase || 0) + (i.missingBase || 0);
              const left = leftUnits(i);
              return (
                <li key={i.id} className="space-y-2 px-3 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-foreground">{i.product?.name}</div>
                      <div className="text-xs text-faint">
                        {i.product?.sku && <>{i.product.sku} · </>}Bought {formatNumber(i.quantity)} {unitWord(i, i.quantity)}
                        {sizeOf(i) > 1 && <> ({formatNumber(i.baseQuantity)} boxes)</>}
                        {before > 0 && <> · {inUnit(i, before)} done before</>}
                      </div>
                    </div>
                    <Badge className="bg-amber-500/15 text-amber-300">{formatNumber(left)} {unitWord(i, left)} to come</Badge>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="flex items-center gap-2 text-xs text-muted">
                      Arrived
                      <NumberInput min="0" value={r.received ?? ''} onChange={(e) => setRow(i.id, { received: e.target.value })} className="h-10 w-24 text-right tabular-nums" aria-label={`${unitWord(i, 2)} of ${i.product?.name} that arrived`} />
                      <span>{unitWord(i, 2)}</span>
                    </label>
                    <button type="button" onClick={() => setRow(i.id, { received: String(left) })} className={clsx(changeBtn, 'min-h-[40px] px-2')}>Arrived fine</button>
                    <button type="button" onClick={() => setRow(i.id, { open: !r.open })} className={clsx(changeBtn, 'min-h-[40px] px-2')}>{r.open ? 'Hide' : 'Damaged, missing or note'}</button>
                  </div>
                  {r.open && (
                    <div className="grid grid-cols-1 gap-2 rounded-lg bg-white/[0.03] p-2 sm:grid-cols-3">
                      <Field label={`Of these, damaged or rejected (${unitWord(i, 2)})`}><NumberInput min="0" value={r.damaged ?? ''} onChange={(e) => setRow(i.id, { damaged: e.target.value })} /></Field>
                      <Field label={`Missing — will not come (${unitWord(i, 2)})`}><NumberInput min="0" disabled={noMore} value={noMore ? String(l.missing) : (r.missing ?? '')} onChange={(e) => setRow(i.id, { missing: e.target.value })} /></Field>
                      <Field label="Note"><Input value={r.note ?? ''} onChange={(e) => setRow(i.id, { note: e.target.value })} placeholder="What is wrong, and why" /></Field>
                    </div>
                  )}
                  {(l.damaged > 0 || l.missing > 0) && !r.open && (
                    <p className="text-xs text-muted">{l.damaged > 0 && <span className="text-amber-300">{l.damaged} damaged </span>}{l.missing > 0 && <span className="text-rose-300">{l.missing} missing</span>}</p>
                  )}
                  {l.error && <p className="text-xs font-medium text-rose-300">{l.error}</p>}
                </li>
              );
            })}
          </ul>
          <label className="flex cursor-pointer items-start gap-2 rounded-lg bg-white/[0.03] p-3 text-sm text-foreground ring-1 ring-white/[0.08]">
            <input type="checkbox" checked={noMore} onChange={(e) => setNoMore(e.target.checked)} className="mt-0.5 h-4 w-4 rounded accent-zinc-300" />
            <span><b>Nothing more is coming.</b> <span className="text-muted">Anything still not here is recorded as missing and the order is completed.</span></span>
          </label>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Arrived on"><Input type="date" max={eatISODate()} value={arrivedAt} onChange={(e) => setArrivedAt(e.target.value)} /></Field>
            <div className="sm:col-span-2"><Field label="Notes about this delivery"><Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" /></Field></div>
          </div>
          <p className="text-xs text-muted sm:hidden">
            {formatNumber(intoStock)} into stock · {formatNumber(damagedBoxes)} damaged · {formatNumber(missingBoxes)} missing · {formatNumber(stillToCome)} still to come (boxes)
          </p>
        </div>
      )}
    </Modal>
  );
}

// Open any order: what was bought and for how much, what came in and when, what is still to come, the money.
function PODetailModal({ poId, isAdmin, onClose, onEdit, onDelete, onStep }) {
  const { data: po, isLoading, isError, refetch } = usePO(poId);
  const boxes = po ? orderBoxes(po) : 0;
  const goods = (po?.items || []).reduce((n, i) => n + Number(i.unitCost || 0) * (i.baseQuantity || 0), 0);
  const extras = po ? Number(po.shippingCost || 0) + Number(po.clearingCost || 0) + Number(po.otherCost || 0) : 0;
  const itemName = new Map((po?.items || []).map((i) => [i.id, i]));
  const when = po && [
    po.createdAt && `Created ${formatDate(po.createdAt)}`,
    po.purchasedAt && `Purchased ${formatDate(po.purchasedAt)}${po.purchasedBy ? ` by ${po.purchasedBy}` : ''}`,
    po.dispatchedAt && `Dispatched ${formatDate(po.dispatchedAt)}`,
    po.expectedArrival && !po.receivedAt && `Expected ${formatDate(po.expectedArrival)}`,
    po.receivedAt && `Completed ${formatDate(po.receivedAt)}`,
  ].filter(Boolean).join(' · ');
  const go = (kind) => { onClose(); onStep(kind, po); };

  return (
    <Modal open onClose={onClose} size="xl" title={po?.poNumber || 'Purchase order'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Close</Button>
          {po && isAdmin && NOT_YET_BOUGHT.includes(po.status) && (
            <>
              <Button variant="secondary" onClick={() => { onClose(); onDelete(po); }}><Trash2 className="h-4 w-4" /> Delete</Button>
              <Button variant="secondary" onClick={() => { onClose(); onEdit(po); }}><Pencil className="h-4 w-4" /> Edit</Button>
              <Button onClick={() => go('purchase')}><Wallet className="h-4 w-4" /> Confirm purchase</Button>
            </>
          )}
          {po && isAdmin && po.status === 'PURCHASED' && (
            <>
              <Button variant="secondary" onClick={() => go('cost')}>Add cost</Button>
              <Button onClick={() => go('dispatch')}><Ship className="h-4 w-4" /> Dispatch</Button>
            </>
          )}
          {po && isAdmin && ARRIVING.includes(po.status) && (
            <>
              <Button variant="secondary" onClick={() => go('cost')}>Add cost</Button>
              <Button onClick={() => go('receive')}><PackageCheck className="h-4 w-4" /> Receive</Button>
            </>
          )}
        </>
      }>
      {isError && !po ? <LoadError what="this order" onRetry={refetch} /> : isLoading || !po ? <PageSpinner /> : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-white/[0.08] bg-surface px-4 py-3">
            <Badge className={PO_STATUS_META[po.status]?.cls}>{PO_STATUS_META[po.status]?.label}</Badge>
            <span className="text-sm text-foreground">{po.supplier?.name}</span>
            {po.warehouse?.name && <span className="text-xs text-faint">into {po.warehouse.name}</span>}
            <span className="text-xs text-faint sm:ml-auto">{when}</span>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {(isAdmin ? [
              { label: 'Goods', value: formatCurrency(goods), sub: `${formatNumber(boxes)} ${boxWord(boxes)} bought` },
              { label: 'Shipping & clearing', value: formatCurrency(extras), sub: 'spread over the boxes' },
              { label: 'Total cost', value: formatCurrency(po.totalCost), sub: boxes > 0 ? `${formatCurrency(Number(po.totalCost) / boxes)} a box` : '—' },
              { label: 'Paid', value: formatCurrency(paidOn(po)), sub: NOT_YET_BOUGHT.includes(po.status) ? 'nothing until you confirm' : 'in cash' },
            ] : [
              { label: 'Bought', value: formatNumber(boxes), sub: boxWord(boxes) },
              { label: 'In stock', value: formatNumber(orderInStock(po)), sub: 'good boxes received' },
              { label: 'Still to come', value: formatNumber(orderLeft(po)), sub: 'boxes' },
              { label: 'Deliveries', value: formatNumber(po.receipts?.length || 0), sub: 'received so far' },
            ]).map((c) => (
              <div key={c.label} className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">{c.label}</p>
                <p className="mt-1 text-base font-bold tabular-nums text-foreground">{c.value}</p>
                <p className="text-[10px] text-faint">{c.sub}</p>
              </div>
            ))}
          </div>

          <div>
            <div className="mb-2 text-sm font-semibold text-foreground">Products</div>
            <Table stack>
              <THead>
                <TR><TH>Product</TH><TH>Bought</TH><TH>In stock</TH><TH>Damaged</TH><TH>Missing</TH><TH>To come</TH></TR>
              </THead>
              <TBody>
                {po.items.map((i) => (
                  <TR key={i.id}>
                    <TD className="stack-full font-medium text-foreground">
                      {i.product?.name}
                      {i.product?.sku && <span className="ml-1.5 text-[11px] text-faint">{i.product.sku}</span>}
                      {/* The price paid on THIS order: the same product keeps a different price on another order. */}
                      {isAdmin && (
                        <span className="block text-[11px] font-normal tabular-nums text-muted">
                          {formatCurrency(Number(i.unitCost || 0) * sizeOf(i))} a {unitWord(i, 1)} · {formatCurrency(Number(i.unitCost || 0) * (i.baseQuantity || 0))}
                        </span>
                      )}
                    </TD>
                    <TD>{formatNumber(i.quantity)} {unitWord(i, i.quantity)}{sizeOf(i) > 1 && <span className="block text-[11px] text-faint">{formatNumber(i.baseQuantity)} boxes</span>}</TD>
                    <TD className="font-semibold tabular-nums text-foreground">{formatNumber((i.receivedBase || 0) - (i.damagedBase || 0))}</TD>
                    <TD className={i.damagedBase ? 'text-amber-300' : 'text-faint'}>{formatNumber(i.damagedBase || 0)}</TD>
                    <TD className={i.missingBase ? 'text-rose-300' : 'text-faint'}>{formatNumber(i.missingBase || 0)}</TD>
                    <TD className={leftOf(i) ? 'text-amber-300' : 'text-faint'}>{formatNumber(leftOf(i))}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <p className="mt-1.5 text-[11px] text-faint">In stock, damaged, missing and to come are in boxes.</p>
          </div>

          {po.receipts?.length > 0 && (
            <div>
              <div className="mb-2 text-sm font-semibold text-foreground">Deliveries</div>
              <ul className="space-y-2">
                {po.receipts.map((r, n) => (
                  <li key={r.id} className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3 text-sm">
                    <div className="flex flex-wrap justify-between gap-2 text-xs text-faint">
                      <span className="font-semibold text-foreground">Delivery {n + 1} · {formatDate(r.arrivedAt)}</span>
                      <span>{r.receivedBy ? `Received by ${r.receivedBy}` : ''}</span>
                    </div>
                    <ul className="mt-1.5 space-y-1">
                      {r.items.map((ri) => {
                        const it = itemName.get(ri.purchaseOrderItemId);
                        return (
                          <li key={ri.id} className="text-xs text-muted">
                            <span className="text-foreground">{it?.product?.name || 'Product'}</span>
                            {ri.receivedBase > 0 && <> · {it ? inUnit(it, ri.receivedBase) : `${ri.receivedBase} boxes`} arrived, {formatNumber(ri.acceptedBase)} into stock</>}
                            {ri.damagedBase > 0 && <span className="text-amber-300"> · {formatNumber(ri.damagedBase)} damaged</span>}
                            {ri.missingBase > 0 && <span className="text-rose-300"> · {it ? inUnit(it, ri.missingBase) : ri.missingBase} missing</span>}
                            {ri.note && <span className="text-faint"> — {ri.note}</span>}
                          </li>
                        );
                      })}
                    </ul>
                    {r.notes && <p className="mt-1.5 text-xs text-faint">{r.notes}</p>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {isAdmin && po.payments?.length > 0 && (
            <div>
              <div className="mb-2 text-sm font-semibold text-foreground">Money paid</div>
              <ul className="divide-y divide-white/[0.06] rounded-xl ring-1 ring-white/[0.08]">
                {po.payments.map((t) => (
                  <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs">
                    <span className="text-muted"><span className="font-medium text-foreground">{t.txnNumber}</span> · {t.category || 'Stock Purchase'} · {t.account}</span>
                    <span className="tabular-nums text-muted">{formatDate(t.occurredAt)} · <span className="font-semibold text-foreground">{formatCurrency(t.amount)}</span></span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {po.notes && (
            <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">Notes</p>
              <p className="mt-1 text-sm text-muted">{po.notes}</p>
            </div>
          )}

          <p className="text-[11px] leading-relaxed text-faint">
            {NOT_YET_BOUGHT.includes(po.status)
              ? 'A draft: no money has moved and nothing is in stock. Confirm the purchase once you have paid for it.'
              : po.status === 'PURCHASED'
                ? 'Paid for and locked. Dispatch it when the goods leave China.'
                : ARRIVING.includes(po.status)
                  ? 'On its way. Receive it when it arrives — in parts if it comes in parts. Only good boxes go into stock.'
                  : po.status === 'RECEIVED'
                    ? 'Completed: every box bought was received or recorded missing.'
                    : 'Cancelled.'}
          </p>
        </div>
      )}
    </Modal>
  );
}

const PO_TABS = [
  ['', 'All'], ['DRAFT', 'Drafts'], ['PURCHASED', 'Purchased'], ['IN_TRANSIT', 'In transit'],
  ['PARTLY_RECEIVED', 'Part received'], ['RECEIVED', 'Completed'],
];

function PurchaseOrders({ isAdmin }) {
  const qc = useQueryClient();
  const { data: products = [] } = useProducts();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [productId, setProductId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [open, setOpen] = useState(false);
  const params = { page, limit: 15, status: status || undefined, productId: productId || undefined, from: from || undefined, to: to || undefined };
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['purchase-orders', params],
    queryFn: async () => unwrap(await api.get('/purchase-orders', { params })),
    placeholderData: keepOnPageTurn(),
  });
  const [editing, setEditing] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [step, setStep] = useState(null); // { kind: 'purchase' | 'dispatch' | 'receive' | 'cost', po }
  const onStep = (kind, po) => setStep({ kind, po });
  const filter = (fn) => (v) => { fn(v); setPage(1); };
  const askDelete = (po) => {
    if (confirm(`Delete ${po.poNumber}? It is a draft: no money has moved and nothing is in stock.`)) del.mutate(po.id);
  };
  const del = useMutation({
    mutationFn: (id) => api.delete(`/purchase-orders/${id}`),
    onSuccess: (r) => {
      toast.success(`${r.data?.data?.poNumber || 'Order'} deleted`);
      qc.invalidateQueries({ queryKey: ['purchase-orders'] });
    },
    onError: (e) => { toast.error(apiError(e), { duration: 9000 }); qc.invalidateQueries({ queryKey: ['purchase-orders'] }); },
  });
  const otw = data?.meta?.onTheWay;
  const counts = data?.meta?.counts || {};
  const countOf = (k) => (k ? counts[k] || 0 : Object.values(counts).reduce((n, c) => n + c, 0));

  return (
    <div className="space-y-4">
      {/* Bought, not all in yet: real, paid for, coming — not inventory until it is received. */}
      {otw && (
        <div className="stat-glass p-5">
          <div className="relative flex flex-wrap items-center gap-x-8 gap-y-4">
            <div>
              <div className="flex items-center gap-2">
                <span className="rounded-full bg-sky-500/15 p-1.5 text-sky-300 ring-1 ring-inset ring-white/10"><Ship className="h-3.5 w-3.5" /></span>
                <p className="text-xs font-medium text-muted">Stock on the way</p>
              </div>
              <p className={`mt-2 text-3xl font-bold leading-none tabular-nums ${otw.boxes > 0 ? 'text-sky-300' : 'text-foreground'}`}>
                {formatNumber(otw.boxes)} <span className="text-sm font-normal text-muted">boxes</span>
              </p>
              <p className="mt-1 text-[11px] text-faint">
                {otw.orders > 0 ? `${formatNumber(otw.orders)} order${otw.orders === 1 ? '' : 's'} bought, not all in yet` : 'nothing bought that has not arrived'}
              </p>
            </div>
            {otw.orders > 0 && (
              <>
                {otw.value != null && (
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">Worth</p>
                    <p className="mt-1.5 text-xl font-bold tabular-nums text-foreground">{formatCurrency(otw.value)}</p>
                    <p className="text-[11px] text-faint">what is still to come</p>
                  </div>
                )}
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">Next arrival</p>
                  <p className="mt-1.5 text-xl font-bold tabular-nums text-foreground">{otw.nextArrival ? formatDate(otw.nextArrival) : '—'}</p>
                  <p className="text-[11px] text-faint">{otw.nextArrival ? 'expected' : 'no date set'}</p>
                </div>
              </>
            )}
            <p className="ml-auto max-w-xs text-[11px] leading-relaxed text-faint">
              These boxes are not in Inventory yet. They count when you press <b className="text-muted">Receive</b> on the order and confirm what arrived.
            </p>
          </div>
        </div>
      )}

    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4">
        <span className="text-sm font-semibold text-foreground">Purchase orders</span>
        {isAdmin && <Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> New PO</Button>}
      </div>
      <div className="space-y-3 border-b border-border p-4">
        <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1" role="tablist" aria-label="Order status">
          {PO_TABS.map(([k, label]) => (
            <button key={k || 'all'} type="button" role="tab" aria-selected={status === k} onClick={() => filter(setStatus)(k)}
              className={clsx('flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold ring-1 transition',
                status === k ? 'bg-white/[0.12] text-foreground ring-white/20' : 'text-muted ring-white/[0.08] hover:text-foreground')}>
              {label}<span className="tabular-nums text-faint">{formatNumber(countOf(k))}</span>
            </button>
          ))}
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_auto]">
          <Select value={productId} onChange={(e) => filter(setProductId)(e.target.value)} aria-label="Product">
            <option value="">All products</option>
            {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
          <Input type="date" value={from} onChange={(e) => filter(setFrom)(e.target.value)} aria-label="Created from" />
          <Input type="date" min={from || undefined} value={to} onChange={(e) => filter(setTo)(e.target.value)} aria-label="Created to" />
        </div>
      </div>
      {isLoading ? <PageSpinner /> : isError && !data ? <LoadError what="the purchase orders" onRetry={refetch} /> : !data?.data?.length ? <EmptyState title={status || productId || from || to ? 'No orders match' : 'No purchase orders'} icon={Ship} /> : (
        <>
          <Table stack="wide">
            <THead><TR><TH>PO</TH><TH>Supplier</TH><TH>Products</TH><TH>Boxes</TH>{isAdmin && <TH>Total cost</TH>}<TH>Status</TH><TH /></TR></THead>
            <TBody>
              {data.data.map((po) => {
                const boxes = orderBoxes(po);
                const left = orderLeft(po);
                const started = po.status === 'PARTLY_RECEIVED' || po.status === 'RECEIVED';
                return (
                  <TR key={po.id} className="cursor-pointer" onClick={() => setViewing(po.id)}>
                    <TD className="font-medium text-foreground">
                      {po.poNumber}
                      <span className="block text-[11px] font-normal text-faint">{formatDate(po.purchasedAt || po.createdAt)}</span>
                    </TD>
                    <TD>{po.supplier?.name}</TD>
                    <TD className="text-muted">{po.items.length}</TD>
                    <TD className="tabular-nums">
                      <span className="font-semibold text-foreground">{formatNumber(boxes)}</span>
                      {started && left > 0 && <span className="block text-[11px] text-amber-300">{formatNumber(left)} still to come</span>}
                    </TD>
                    {isAdmin && <TD>{formatCurrency(po.totalCost)}</TD>}
                    <TD><Badge className={PO_STATUS_META[po.status]?.cls}>{PO_STATUS_META[po.status]?.label}</Badge></TD>
                    <TD>
                      <div className="flex items-center justify-end gap-2">
                        <button title="Open this order" onClick={(e) => { e.stopPropagation(); setViewing(po.id); }} className="cursor-pointer text-faint transition hover:text-brand-600">
                          <Eye className="h-4 w-4" />
                        </button>
                        {isAdmin && NOT_YET_BOUGHT.includes(po.status) && (
                          <>
                            <button title="Edit this order" onClick={(e) => { e.stopPropagation(); setEditing(po); }} className="cursor-pointer text-faint transition hover:text-brand-600"><Pencil className="h-4 w-4" /></button>
                            <button title="Delete this draft" onClick={(e) => { e.stopPropagation(); askDelete(po); }} className="cursor-pointer text-faint transition hover:text-rose-400"><Trash2 className="h-4 w-4" /></button>
                            <Button variant="secondary" className="px-3 py-1 text-xs" onClick={(e) => { e.stopPropagation(); onStep('purchase', po); }}><Wallet className="h-4 w-4" /> Confirm purchase</Button>
                          </>
                        )}
                        {isAdmin && po.status === 'PURCHASED' && (
                          <Button variant="secondary" className="px-3 py-1 text-xs" onClick={(e) => { e.stopPropagation(); onStep('dispatch', po); }}><Ship className="h-4 w-4" /> Dispatch</Button>
                        )}
                        {isAdmin && ARRIVING.includes(po.status) && (
                          <Button variant="secondary" className="px-3 py-1 text-xs" onClick={(e) => { e.stopPropagation(); onStep('receive', po); }}><PackageCheck className="h-4 w-4" /> Receive</Button>
                        )}
                      </div>
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
          <Pagination page={page} totalPages={data.meta?.totalPages} total={data.meta?.total} onChange={setPage} />
        </>
      )}
      {open && <POModal onClose={() => setOpen(false)} />}
      {editing && <POModal editing={editing} onClose={() => setEditing(null)} />}
      {viewing && <PODetailModal poId={viewing} isAdmin={isAdmin} onClose={() => setViewing(null)} onEdit={setEditing} onDelete={askDelete} onStep={onStep} />}
      {step?.kind === 'purchase' && <ConfirmPurchaseModal poId={step.po.id} onClose={() => setStep(null)} />}
      {step?.kind === 'dispatch' && <DispatchModal po={step.po} onClose={() => setStep(null)} />}
      {step?.kind === 'cost' && <AddCostModal po={step.po} onClose={() => setStep(null)} />}
      {step?.kind === 'receive' && <ReceiveModal poId={step.po.id} onClose={() => setStep(null)} />}
    </Card>
    </div>
  );
}

// Every price paid for a product, order by order — the same product keeps each price on its own order.
function PriceHistory() {
  const { data: products = [] } = useProducts();
  const [productId, setProductId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const params = { productId: productId || undefined, from: from || undefined, to: to || undefined };
  const { data: lines = [], isLoading, isError, refetch } = useQuery({
    queryKey: ['purchase-orders', 'lines', params],
    queryFn: async () => unwrap(await api.get('/purchase-orders/lines', { params })).data,
  });
  return (
    <Card>
      <div className="space-y-3 border-b border-border p-4">
        <span className="text-sm font-semibold text-foreground">Price history</span>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_auto]">
          <Select value={productId} onChange={(e) => setProductId(e.target.value)} aria-label="Product">
            <option value="">All products</option>
            {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Purchased from" />
          <Input type="date" min={from || undefined} value={to} onChange={(e) => setTo(e.target.value)} aria-label="Purchased to" />
        </div>
      </div>
      {isLoading ? <PageSpinner /> : isError ? <LoadError what="the price history" onRetry={refetch} /> : !lines.length ? <EmptyState title="Nothing bought yet" icon={Ship} /> : (
        <Table stack="wide">
          <THead><TR><TH>PO</TH><TH>Product</TH><TH>Bought</TH><TH className="text-right">Price</TH><TH className="text-right">Line total</TH><TH>In stock</TH><TH>Status</TH></TR></THead>
          <TBody>
            {lines.map((l) => (
              <TR key={l.id}>
                <TD className="font-medium text-foreground">
                  {l.poNumber}
                  <span className="block text-[11px] font-normal text-faint">{formatDate(l.purchasedAt || l.createdAt)}</span>
                </TD>
                <TD className="stack-full">{l.product?.name}</TD>
                <TD>{formatNumber(l.quantity)} {l.quantity === 1 ? String(l.unit || 'box').toLowerCase() : pluralizeUnit(String(l.unit || 'box').toLowerCase())}</TD>
                <TD className="text-right tabular-nums">{formatCurrency(l.unitPrice)}<span className="block text-[11px] text-faint">a {String(l.unit || 'box').toLowerCase()}</span></TD>
                <TD className="text-right font-semibold tabular-nums">{formatCurrency(l.lineTotal)}</TD>
                <TD className="tabular-nums">
                  {formatNumber(l.accepted)}
                  {(l.damaged > 0 || l.missing > 0) && <span className="block text-[11px] text-faint">{l.damaged > 0 ? `${l.damaged} damaged ` : ''}{l.missing > 0 ? `${l.missing} missing` : ''}</span>}
                </TD>
                <TD><Badge className={PO_STATUS_META[l.status]?.cls}>{PO_STATUS_META[l.status]?.label}</Badge></TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </Card>
  );
}

function Suppliers() {
  const [modal, setModal] = useState({ open: false, editing: null });
  const [showRemoved, setShowRemoved] = useState(false);
  const { data, isLoading, isError, refetch } = useQuery({ queryKey: ['suppliers'], queryFn: async () => unwrap(await api.get('/suppliers', { params: { limit: 100 } })) });
  // Deleted suppliers are switched off, never erased (their orders stay), so they are hidden here until asked for.
  const all = data?.data || [];
  const removed = all.filter((s) => s.isActive === false);
  const rows = showRemoved ? all : all.filter((s) => s.isActive !== false);
  return (
    <Card>
      <div className="flex items-center justify-between border-b border-border p-4">
        <span className="text-sm font-semibold text-foreground">Suppliers</span>
        <Button onClick={() => setModal({ open: true, editing: null })}><Plus className="h-4 w-4" /> New supplier</Button>
      </div>
      {isLoading ? <PageSpinner /> : isError && !data ? <LoadError what="the suppliers" onRetry={refetch} /> : !data?.data?.length ? <EmptyState title="No suppliers" /> : (
        <Table stack>
          <THead><TR><TH>Name</TH><TH>Country</TH><TH>Contact</TH><TH>Phone</TH><TH>POs</TH><TH /></TR></THead>
          <TBody>{rows.map((s) => (
            <TR key={s.id}><TD className="font-medium">
              {s.name}
              {/* Switched off (a supplier with history is never deleted): said here, not hidden (money-flows-8). */}
              {s.isActive === false && <Badge className="ml-2 bg-white/[0.06] text-muted">Inactive</Badge>}
            </TD><TD>{s.country}</TD><TD>{s.contactName || '—'}</TD><TD>{s.phone || '—'}</TD><TD>{s._count?.purchaseOrders ?? 0}</TD>
              <TD><button className="btn-ghost px-2 py-1" onClick={() => setModal({ open: true, editing: s })}><Pencil className="h-4 w-4" /></button></TD></TR>
          ))}</TBody>
        </Table>
      )}
      {removed.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-3 text-xs text-faint">
          <span>{removed.length === 1 ? `1 deleted supplier (${removed[0].name}) is` : `${removed.length} deleted suppliers are`} {showRemoved ? 'shown' : 'hidden'}. Their orders stay in your records.</span>
          <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => setShowRemoved((v) => !v)}>{showRemoved ? 'Hide' : 'Show'}</button>
        </div>
      )}
      {modal.open && <SupplierModal editing={modal.editing} onClose={() => setModal({ open: false, editing: null })} />}
    </Card>
  );
}

export default function Purchases() {
  const [tab, setTab] = useState('orders');
  // Buying, paying and receiving are the admin's; other staff see the orders without prices.
  const isAdmin = useAuth().user?.role === ROLES.ADMIN;
  const tabs = [['orders', 'Purchase orders'], ...(isAdmin ? [['prices', 'Price history']] : []), ['suppliers', 'Suppliers']];
  return (
    <div>
      <PageHeader title="Imports & Purchase Orders" subtitle="Buy in China with cash, track the shipment, receive it into the warehouse." />
      <div className="mb-4 flex flex-wrap gap-2">
        {tabs.map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} className={`cursor-pointer rounded-full px-4 py-2 text-sm font-semibold ring-1 transition duration-200 ${tab === k ? 'bg-brand-500 text-white ring-brand-500' : 'bg-transparent text-muted ring-white/10 hover:bg-white/[0.05] hover:text-foreground'}`}>{label}</button>
        ))}
      </div>
      {tab === 'orders' ? <PurchaseOrders isAdmin={isAdmin} /> : tab === 'prices' && isAdmin ? <PriceHistory /> : <Suppliers />}
    </div>
  );
}
