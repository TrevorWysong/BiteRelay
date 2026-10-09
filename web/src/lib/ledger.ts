// How the ledger's payment legs read, wherever money is shown.
import type { PaymentLeg } from "../holochain/types";

export const PAYMENT_LEG_LABEL: Record<PaymentLeg, string> = {
  OrderTotal: "Order payment",
  DeliveryFeeCustomerShare: "Delivery fee (customer's share)",
  DeliveryFeeStoreShare: "Delivery fee (store's share)",
  Tip: "Tip",
  CollateralReturn: "Driver's collateral returned",
};
