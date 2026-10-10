import { useLocation } from "react-router-dom";
import { motion } from "framer-motion";
import { getCatalog, setCatalogOpen } from "../../holochain/zomes/catalog";
import { averageRating, getRatingSummary } from "../../holochain/zomes/reputation";
import { decodeEntry, hexToBytes } from "../../holochain/decode";
import { useMerchantStores, useMyStores } from "../../store/merchantStores";
import { useResource } from "../../lib/useResource";
import { fetchMenu } from "../../lib/menu";
import { fadeSlideUp, staggerContainer } from "../../lib/motion";
import { Skeleton } from "../../components/ui";
import { StarRating } from "../../components/StarRating";
import { StoreSwitcher } from "../../components/StoreSwitcher";
import { NewStoreForm } from "./NewStore";
import { AutoAcceptCard, DeliverySubsidyCard, LeaveAtDoorCard, StoreDetailsCard } from "./catalog/StoreDetailsCard";
import { HoursCard } from "./catalog/HoursCard";
import { PromoCodesCard } from "./catalog/PromoCodesCard";
import { MenuSection } from "./catalog/MenuSection";
import { GoodieBagsSection } from "./catalog/GoodieBagsSection";
import { StoreReviews } from "./catalog/StoreReviews";
import type { MerchantCatalog as Catalog } from "../../holochain/types";

/// The Menu tab: everything about the *currently selected* store (see
/// `StoreSwitcher`/`merchantStores.ts`). Each store renders as its own keyed
/// `StoreCatalog`, so switching stores mounts fresh sections with fresh
/// state -- nothing from one store can linger on another.
export function MerchantCatalog() {
  const routerState = useLocation().state as { editDetails?: string } | null;
  const stores = useMyStores();
  const activeHex = useMerchantStores((s) => s.activeHex);

  if (stores !== null && stores.length === 0) return <NewStoreForm firstStore />;
  if (stores === null || !activeHex) return <CatalogSkeleton />;
  // `editDetails` names the store just published (NewStore.tsx) -- only that
  // store opens straight into its details editor.
  return <StoreCatalog key={activeHex} storeHex={activeHex} openDetailsOnArrival={routerState?.editDetails === activeHex} />;
}

function CatalogSkeleton() {
  return (
    <div className="px-4 pt-4">
      <Skeleton className="h-32 w-full mb-4" />
      <Skeleton className="h-6 w-1/2 mb-3" />
      <Skeleton className="h-24 w-full mb-3" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}

/// The store's profile and its whole menu -- read here because several
/// sections need them (the promo form picks items from the menu). Every
/// other section reads its own data.
async function fetchStore(catalogRef: Uint8Array) {
  const [record, items] = await Promise.all([getCatalog(catalogRef), fetchMenu(catalogRef)]);
  return { catalog: decodeEntry<Catalog>(record), items };
}

function StoreCatalog({ storeHex, openDetailsOnArrival }: { storeHex: string; openDetailsOnArrival: boolean }) {
  const loadStores = useMerchantStores((s) => s.load);
  const catalogRef = hexToBytes(storeHex);
  const { data, reload } = useResource(`store:${storeHex}`, () => fetchStore(catalogRef));
  const { data: rating } = useResource(`store-rating:${storeHex}`, () => getRatingSummary({ Store: catalogRef }));

  // The name, open state and details also show in the store switcher.
  async function reloadProfile() {
    await Promise.all([reload(), loadStores()]);
  }

  if (!data) {
    return (
      <div className="px-4 pt-4">
        <StoreSwitcher />
        <CatalogSkeleton />
      </div>
    );
  }
  const { catalog, items } = data;
  const avgRating = rating ? averageRating(rating) : null;

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="pb-8">
      <div className="px-4 pt-4">
        <StoreSwitcher />
      </div>
      {catalog.banner_data_uri && <img src={catalog.banner_data_uri} alt="" className="h-32 w-full object-cover" />}
      {/* Its own initial/animate, not inherited variants: inheriting across
          the plain banner element above left every child stuck hidden. */}
      <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="px-4 pt-4">
        <motion.div variants={fadeSlideUp} className="mb-1 flex items-center justify-between">
          <h1 className="text-xl font-black tracking-tight text-ink-900 dark:text-ink-50">{catalog.business_name}</h1>
          <motion.button
            whileTap={{ scale: 0.95 }}
            animate={{ backgroundColor: catalog.is_open ? "#1c1916" : "#ff5a2b" }}
            transition={{ duration: 0.2 }}
            onClick={async () => {
              await setCatalogOpen(catalogRef, !catalog.is_open);
              await reloadProfile();
            }}
            className="rounded-full px-3 py-1.5 text-xs font-semibold text-white"
          >
            {catalog.is_open ? "Open" : "Closed"} · toggle
          </motion.button>
        </motion.div>
        {avgRating !== null && rating && <StarRating value={avgRating} count={rating.count} />}

        <motion.div variants={fadeSlideUp}>
          <StoreDetailsCard catalog={catalog} catalogRef={catalogRef} startEditing={openDetailsOnArrival} onSaved={reloadProfile} />
        </motion.div>
        <motion.div variants={fadeSlideUp}>
          <HoursCard catalog={catalog} catalogRef={catalogRef} onSaved={reload} />
        </motion.div>
        <motion.div variants={fadeSlideUp}>
          <AutoAcceptCard catalog={catalog} catalogRef={catalogRef} onSaved={reload} />
          <LeaveAtDoorCard catalog={catalog} catalogRef={catalogRef} onSaved={reload} />
        </motion.div>
        <motion.div variants={fadeSlideUp}>
          <DeliverySubsidyCard catalog={catalog} catalogRef={catalogRef} onSaved={reload} />
        </motion.div>
        <motion.div variants={fadeSlideUp}>
          <PromoCodesCard storeHex={storeHex} catalogRef={catalogRef} items={items} />
        </motion.div>
        <MenuSection catalogRef={catalogRef} items={items} onChanged={reload} />
        <GoodieBagsSection storeHex={storeHex} catalogRef={catalogRef} />
        <motion.div variants={fadeSlideUp}>
          <StoreReviews storeHex={storeHex} catalogRef={catalogRef} />
        </motion.div>
      </motion.div>
    </motion.div>
  );
}
