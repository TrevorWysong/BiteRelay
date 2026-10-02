import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Minus, Plus, Trash2, ArrowLeft } from "lucide-react";
import { Button } from "../../components/ui";
import { useCart } from "../../store/cart";
import { useSession } from "../../store/session";
import { requestDelivery } from "../../holochain/zomes/dispatch";
import { getCatalog } from "../../holochain/zomes/catalog";
import { actionHash, bytesToHex, decodeEntry } from "../../holochain/decode";
import { formatCents } from "../../lib/format";
import type { MerchantCatalog } from "../../holochain/types";

const TIP_PRESETS_PERCENT = [0, 10, 15, 20];
// A driver's bid can be anywhere up to this cap (validate_new_bid rejects
// anything higher) -- letting the customer set it, rather than hardcoding
// `max_delivery_fee: null`, is what actually gives them cost certainty at
// checkout instead of an unbounded "set by driver bid" placeholder.
const DELIVERY_FEE_PRESETS_CENTS = [400, 600, 900, 1200];

export function Cart() {
  const cart = useCart();
  const location = useSession((s) => s.location);
  const navigate = useNavigate();
  const [placing, setPlacing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [instructions, setInstructions] = useState("");
  const [tipPercent, setTipPercent] = useState<number | null>(15);
  const [customTip, setCustomTip] = useState("");
  const [feePreset, setFeePreset] = useState<number | null>(DELIVERY_FEE_PRESETS_CENTS[1]);
  const [customFee, setCustomFee] = useState("");
  const [subsidyPercent, setSubsidyPercent] = useState(0);

  useEffect(() => {
    if (!cart.catalogRef) return;
    getCatalog(cart.catalogRef)
      .then((record) => setSubsidyPercent(decodeEntry<MerchantCatalog>(record).delivery_subsidy_percent))
      .catch(() => setSubsidyPercent(0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tipCents = tipPercent !== null ? Math.round((cart.total() * tipPercent) / 100) : Math.round(Number(customTip || 0) * 100);
  const maxFeeCents = feePreset !== null ? feePreset : Math.round(Number(customFee || 0) * 100);
  // Worst case (a winning bid right at the cap): mirrors the settlement
  // formula in dispatch::settle_delivery_fee exactly (architecture plan
  // §12) -- merchant_share floor-rounded, customer absorbs the remainder.
  const customerFeeShareCents = maxFeeCents - Math.floor((maxFeeCents * subsidyPercent) / 100);

  if (cart.lines.length === 0) {
    return (
      <div className="px-6 py-20 text-center">
        <p className="text-sm text-ink-400">Your cart is empty.</p>
        <Button variant="ghost" className="mt-4" onClick={() => navigate("/customer")}>
          Browse restaurants
        </Button>
      </div>
    );
  }

  async function placeOrder() {
    if (!cart.catalogRef || !cart.merchant) return;
    setPlacing(true);
    setError(null);
    try {
      const record = await requestDelivery({
        merchant: cart.merchant,
        catalog_ref: cart.catalogRef,
        item_refs: cart.lines.map((l) => l.itemRef),
        order_total: cart.total(),
        dropoff: { lat: location.lat, lon: location.lon },
        max_delivery_fee: maxFeeCents,
        special_instructions: instructions.trim(),
        tip_cents: tipCents,
      });
      const orderRef = actionHash(record);
      cart.clear();
      navigate(`/customer/orders/${bytesToHex(orderRef)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlacing(false);
    }
  }

  return (
    <div className="px-4 pb-28 pt-4">
      <button onClick={() => navigate(-1)} className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-ink-500">
        <ArrowLeft size={16} /> Back
      </button>
      <h1 className="text-xl font-black text-ink-900 dark:text-ink-50">Your order</h1>
      <p className="mb-4 text-xs text-ink-400">from {cart.merchantName}</p>

      <div className="flex flex-col divide-y divide-ink-100 dark:divide-ink-800 rounded-2xl border border-ink-100 dark:border-ink-800 bg-white dark:bg-ink-900">
        {cart.lines.map((line) => {
          const key = bytesToHex(line.itemRef);
          return (
            <div key={key} className="flex items-center gap-3 p-4">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-ink-900 dark:text-ink-50">{line.name}</p>
                <p className="text-xs text-ink-400">{formatCents(line.priceCents)} each</p>
              </div>
              <div className="flex items-center gap-2 rounded-full bg-ink-100 dark:bg-ink-800 px-1.5 py-1">
                <button onClick={() => cart.setQuantity(key, line.quantity - 1)} className="grid h-6 w-6 place-items-center rounded-full hover:bg-ink-200 dark:hover:bg-ink-700">
                  {line.quantity === 1 ? <Trash2 size={14} className="text-ink-400" /> : <Minus size={14} className="text-ink-400" />}
                </button>
                <span className="w-4 text-center text-sm font-semibold">{line.quantity}</span>
                <button onClick={() => cart.setQuantity(key, line.quantity + 1)} className="grid h-6 w-6 place-items-center rounded-full hover:bg-ink-200 dark:hover:bg-ink-700">
                  <Plus size={14} className="text-ink-400" />
                </button>
              </div>
              <span className="w-16 text-right text-sm font-bold">{formatCents(line.priceCents * line.quantity)}</span>
            </div>
          );
        })}
      </div>

      <div className="mt-4 rounded-2xl border border-ink-100 dark:border-ink-800 bg-white dark:bg-ink-900 p-4">
        <p className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-400">Delivery notes</p>
        <textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          rows={2}
          placeholder="Leave at the door, gate code, etc."
          className="w-full resize-none rounded-lg border border-ink-200 dark:border-ink-700 bg-transparent px-3 py-2 text-sm outline-none focus:border-relay-400"
        />
      </div>

      <div className="mt-4 rounded-2xl border border-ink-100 dark:border-ink-800 bg-white dark:bg-ink-900 p-4">
        <p className="mb-1 text-xs font-bold uppercase tracking-wide text-ink-400">Delivery fee cap</p>
        <p className="mb-2 text-xs text-ink-400">Drivers bid to deliver your order, up to this amount — you're only ever charged what the winning bid actually offers, never more.</p>
        <div className="flex flex-wrap gap-2">
          {DELIVERY_FEE_PRESETS_CENTS.map((cents) => (
            <button
              key={cents}
              onClick={() => {
                setFeePreset(cents);
                setCustomFee("");
              }}
              className={`rounded-full px-3 py-1.5 text-xs font-semibold ${feePreset === cents ? "bg-relay-500 text-white" : "bg-ink-100 dark:bg-ink-800 text-ink-500"}`}
            >
              {formatCents(cents)}
            </button>
          ))}
          <input
            type="number"
            min={0}
            step={0.5}
            value={customFee}
            onChange={(e) => {
              setCustomFee(e.target.value);
              setFeePreset(null);
            }}
            placeholder="Custom $"
            className="w-24 rounded-full border border-ink-200 dark:border-ink-700 bg-transparent px-3 py-1.5 text-xs outline-none focus:border-relay-400"
          />
        </div>
      </div>

      <div className="mt-4 rounded-2xl border border-ink-100 dark:border-ink-800 bg-white dark:bg-ink-900 p-4">
        <p className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-400">Tip your driver</p>
        <div className="flex flex-wrap gap-2">
          {TIP_PRESETS_PERCENT.map((p) => (
            <button
              key={p}
              onClick={() => {
                setTipPercent(p);
                setCustomTip("");
              }}
              className={`rounded-full px-3 py-1.5 text-xs font-semibold ${tipPercent === p ? "bg-relay-500 text-white" : "bg-ink-100 dark:bg-ink-800 text-ink-500"}`}
            >
              {p === 0 ? "No tip" : `${p}%`}
            </button>
          ))}
          <input
            type="number"
            min={0}
            step={0.5}
            value={customTip}
            onChange={(e) => {
              setCustomTip(e.target.value);
              setTipPercent(null);
            }}
            placeholder="Custom $"
            className="w-24 rounded-full border border-ink-200 dark:border-ink-700 bg-transparent px-3 py-1.5 text-xs outline-none focus:border-relay-400"
          />
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-1.5 rounded-2xl border border-ink-100 dark:border-ink-800 bg-white dark:bg-ink-900 p-4 text-sm">
        <div className="flex justify-between text-ink-400">
          <span>Subtotal</span>
          <span>{formatCents(cart.total())}</span>
        </div>
        <div className="flex justify-between text-ink-400">
          <span>Delivery fee{subsidyPercent > 0 && <span className="text-presence-600"> (merchant covers {subsidyPercent}%)</span>}</span>
          <span>up to {formatCents(customerFeeShareCents)}</span>
        </div>
        <div className="flex justify-between text-ink-400">
          <span>Tip</span>
          <span>{formatCents(tipCents)}</span>
        </div>
        <div className="mt-1 flex justify-between border-t border-ink-100 dark:border-ink-800 pt-2 text-base font-bold text-ink-900 dark:text-ink-50">
          <span>Estimated total</span>
          <span>up to {formatCents(cart.total() + tipCents + customerFeeShareCents)}</span>
        </div>
      </div>

      <div className="mt-4 rounded-2xl bg-ink-100/60 dark:bg-ink-800/60 p-4 text-xs text-ink-500 dark:text-ink-400">
        Placing this order publishes it to your local geohash cell — nearby drivers are notified directly, with a background poll
        as a backstop in case the direct notification doesn't land (it's fire-and-forget by design; see HOLOCHAIN_ISSUES.md #1).
      </div>

      {error && <p className="mt-4 rounded-lg bg-red-50 dark:bg-red-900/20 px-3 py-2 text-xs text-red-700 dark:text-red-300">{error}</p>}

      <div className="fixed inset-x-0 bottom-20 z-20 mx-auto flex max-w-md justify-center px-4">
        <Button className="w-full" loading={placing} disabled={maxFeeCents <= 0} onClick={placeOrder}>
          Place order · up to {formatCents(cart.total() + tipCents + customerFeeShareCents)}
        </Button>
      </div>
    </div>
  );
}
