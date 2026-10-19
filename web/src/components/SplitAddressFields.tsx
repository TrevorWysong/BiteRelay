import { Field, Input } from "./ui";
import { AddressSearch } from "./AddressSearch";
import type { GeoPoint } from "../holochain/types";
import { MAX_PLACE_CHARS, MAX_POSTAL_CODE_CHARS } from "../holochain/types";
import { useT } from "../i18n";

export interface SplitAddress {
  street: string;
  city: string;
  state: string;
  zip: string;
}

export const EMPTY_SPLIT_ADDRESS: SplitAddress = { street: "", city: "", state: "", zip: "" };

/// One live search box for the street line (fills every field below in
/// one tap) plus plain, directly-editable City/State/Postal code fields --
/// the same pattern Stripe/Shopify/Google Pay's own address forms use.
/// Shared by every "enter an address" moment in the app (user
/// registration, a merchant's own pickup location, editing a storefront's
/// details afterward) so this looks and behaves identically everywhere,
/// rather than three screens each inventing their own address UI.
///
/// Works for any country out of the box: the free search underneath
/// (Nominatim/OSM) isn't US-only, and State/ZIP are always plain text
/// here, never a hardcoded "pick from 50 US states" dropdown -- that's
/// the thing that would actually break outside the US.
export function SplitAddressFields({
  point,
  onPointChange,
  address,
  onAddressChange,
  pointIsEditable = true,
  streetLabel,
}: {
  point: GeoPoint;
  onPointChange: (p: GeoPoint) => void;
  address: SplitAddress;
  onAddressChange: (a: SplitAddress) => void;
  /// Off when `point` is immutable and editing it here wouldn't do
  /// anything real -- e.g. a merchant's storefront pickup location, fixed
  /// forever at publish time. Turns off AddressSearch's own "enter
  /// coordinates manually" escape hatch and its "update the location"
  /// warning, neither of which would make sense on a box that isn't
  /// actually driving a real, saved coordinate.
  pointIsEditable?: boolean;
  streetLabel?: string;
}) {
  const t = useT();
  return (
    <>
      <AddressSearch
        value={point}
        onChange={onPointChange}
        onSelectComponents={(c) => onAddressChange({ street: c.street, city: c.city, state: c.state, zip: c.zip })}
        label={streetLabel ?? t("address.street")}
        placeholder={t("address.search")}
        displayAfterSelect="street"
        allowManualCoordinates={pointIsEditable}
        showLocationWarning={pointIsEditable}
        initialQuery={address.street}
      />
      <Field label={t("address.city")}>
        <Input maxLength={MAX_PLACE_CHARS} value={address.city} onChange={(e) => onAddressChange({ ...address, city: e.target.value })} />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label={t("address.region")}>
          <Input maxLength={MAX_PLACE_CHARS} value={address.state} onChange={(e) => onAddressChange({ ...address, state: e.target.value })} />
        </Field>
        <Field label={t("address.postalCode")}>
          <Input maxLength={MAX_POSTAL_CODE_CHARS} value={address.zip} onChange={(e) => onAddressChange({ ...address, zip: e.target.value })} />
        </Field>
      </div>
    </>
  );
}
