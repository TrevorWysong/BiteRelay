import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { ArrowLeft, Store } from "lucide-react";
import { publishCatalog } from "../../holochain/zomes/catalog";
import { actionHash, bytesToHex } from "../../holochain/decode";
import { useSession } from "../../store/session";
import { useMerchantStores } from "../../store/merchantStores";
import { Button, Card, Field, Input } from "../../components/ui";
import { SplitAddressFields } from "../../components/SplitAddressFields";
import { describeError } from "../../lib/errors";
import { MAX_NAME_CHARS } from "../../holochain/types";
import { formatCents } from "../../lib/format";
import { useTerms } from "../../store/network";

/// Publishing a storefront -- the same form whether it's a merchant's very
/// first store (rendered inline by Catalog.tsx when they have none yet) or
/// one more location added later from the store switcher (the
/// `/merchant/stores/new` route). Each publish is a fully independent
/// store: its own menu, promos, goodie bags, order queue and ratings.
export function NewStoreForm({ firstStore }: { firstStore: boolean }) {
  const stake = useTerms().store_listing_stake;
  const navigate = useNavigate();
  const location = useSession((s) => s.location);
  const setLocation = useSession((s) => s.setLocation);
  const loadStores = useMerchantStores((s) => s.load);
  const [businessName, setBusinessName] = useState("");
  const [pickupLocation, setPickupLocation] = useState(location);
  // Populated by AddressSearch's own `onSelectComponents` -- captured here
  // so `publish()` can hand all four straight to `publishCatalog`,
  // prefilling the new store's split address fields at creation time
  // instead of leaving them blank until the merchant re-types the same
  // address in "Storefront details."
  const [addressDraft, setAddressDraft] = useState({ address_street: "", address_city: "", address_state: "", address_zip: "" });
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function publish() {
    if (!businessName.trim()) return;
    setPublishing(true);
    setError(null);
    try {
      const record = await publishCatalog({ business_name: businessName.trim(), location: pickupLocation, ...addressDraft });
      // Only a merchant's *first* store moves their browsing location --
      // that's "where I am" for someone just setting up. Adding a second
      // location across town shouldn't silently change where their own
      // customer-mode browsing is centered.
      if (firstStore) setLocation(pickupLocation);
      const hex = bytesToHex(actionHash(record));
      await loadStores(hex);
      // Straight into "fill in the rest" (photo, description, cuisine,
      // phone, hours) -- a freshly published store has nothing but a name
      // and a pin, so this reads as one continuous setup flow. Names the
      // store so only *it* opens in edit mode (see Catalog.tsx).
      navigate("/merchant/catalog", { state: { editDetails: hex } });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setPublishing(false);
    }
  }

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="px-4 pt-8">
      {!firstStore && (
        <button onClick={() => navigate(-1)} className="mb-4 flex items-center gap-1 text-xs font-semibold text-ink-400 hover:text-ink-700">
          <ArrowLeft size={14} /> Back
        </button>
      )}
      <div className="mb-5 flex flex-col items-center gap-2 text-center">
        <div className="grid h-12 w-12 place-items-center rounded-2xl bg-relay-100 dark:bg-relay-900/30 text-relay-600">
          <Store size={22} />
        </div>
        <h1 className="text-lg font-black text-ink-900 dark:text-ink-50">{firstStore ? "Publish your storefront" : "Add another store"}</h1>
        <p className="text-xs text-ink-400">
          {firstStore
            ? "This creates your restaurant's storefront, visible to customers near your current location right away."
            : "A separate storefront with its own menu, orders and ratings. You can switch between stores at any time."}
        </p>
      </div>
      <Card className="flex flex-col gap-3 p-5">
        <Field label="Business name">
          <Input maxLength={MAX_NAME_CHARS} value={businessName} onChange={(e) => setBusinessName(e.target.value)} placeholder={firstStore ? "Cara's Kitchen" : "Cara's Kitchen – Downtown"} />
        </Field>
        <SplitAddressFields
          point={pickupLocation}
          onPointChange={setPickupLocation}
          address={{ street: addressDraft.address_street, city: addressDraft.address_city, state: addressDraft.address_state, zip: addressDraft.address_zip }}
          onAddressChange={(a) => setAddressDraft({ address_street: a.street, address_city: a.city, address_state: a.state, address_zip: a.zip })}
          streetLabel="Pickup location"
        />
        {stake > 0 && (
          <p className="text-xs leading-relaxed text-ink-400">
            Listing a store sets aside a {formatCents(stake)} deposit from your balance, returned when you close it. It keeps the neighbourhood's listings real.
          </p>
        )}
        {error && <p className="rounded-lg bg-red-50 dark:bg-red-900/20 px-3 py-2 text-xs text-red-700 dark:text-red-300">{error}</p>}
        <Button loading={publishing} disabled={!businessName.trim()} onClick={publish}>
          {firstStore ? "Publish catalog" : "Publish store"}
        </Button>
      </Card>
    </motion.div>
  );
}

export function NewStore() {
  return <NewStoreForm firstStore={false} />;
}
