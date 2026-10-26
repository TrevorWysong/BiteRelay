// An address as its split form keeps it: the street line, and its own
// city, state and postal code fields (`components/SplitAddressFields`).

export interface SplitAddress {
  street: string;
  city: string;
  state: string;
  zip: string;
}

export const EMPTY_SPLIT_ADDRESS: SplitAddress = { street: "", city: "", state: "", zip: "" };
