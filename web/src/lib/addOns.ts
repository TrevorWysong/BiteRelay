// Which open orders a driver is offered, as the big delivery apps do it:
// everything nearby while they have nothing on; while they're delivering,
// only add-ons -- orders from a store they've still to collect from, or
// going near one of their remaining drop-offs -- and never more than the
// network allows at once, nor anything alongside a priority order. The
// network enforces the limits (`dispatch_types::InHand`); the add-on rule
// keeps what's offered on the driver's way.
import type { DeliveryOrder, GeoPoint, InHand } from "../holochain/types";
import { bytesToHex } from "../holochain/decode";
import { distanceKm, geohashCenter } from "./geohash";
import { carryRefusal, type CarryRefusal } from "./driverLoad";

/// One of the driver's deliveries, as far as offering more goes.
export interface Commitment {
  order: DeliveryOrder;
  /// Where it's going, as precisely as the driver knows it.
  dropoff: GeoPoint;
}

/// The statuses before a driver has collected an order.
const NOT_YET_COLLECTED: DeliveryOrder["status"][] = ["BidAccepted", "DriverEnRouteToMerchant", "MerchantConfirmed", "DriverAtStore"];

/// What a driver has taken on.
function loadOf(commitments: Commitment[]): InHand {
  return { orders: commitments.length, priority: commitments.some((c) => c.order.priority) };
}

/// What decides a driver's offers: the network's limits, narrowed by the
/// driver's own.
export interface OfferRules {
  /// The most orders at once: the network's, or the driver's own if lower.
  maxAtOnce: number;
  /// How near a remaining drop-off an add-on may go.
  detourKm: number;
  /// Whether the driver takes priority orders.
  takePriority: boolean;
  /// The lowest fee cap the driver wants to see, in minor units.
  minFeeCents: number;
}

export function offerRules(
  terms: { max_concurrent_deliveries: number; add_on_detour_km: number },
  own: { maxAtOnce: number | null; takePriority: boolean; minFeeCents: number },
): OfferRules {
  return {
    maxAtOnce: Math.min(terms.max_concurrent_deliveries, own.maxAtOnce ?? terms.max_concurrent_deliveries),
    detourKm: terms.add_on_detour_km,
    takePriority: own.takePriority,
    minFeeCents: own.minFeeCents,
  };
}

/// Why a driver with `commitments` is offered nothing more -- `null` if
/// they're offered something.
export function offerRefusal(commitments: Commitment[], rules: OfferRules): CarryRefusal | null {
  // A standard order is the easiest to add: if even that can't be, nothing can.
  return carryRefusal(loadOf(commitments), false, rules.maxAtOnce);
}

/// Whether `order` is on the way for a driver already delivering
/// `commitments`: from a store they've still to collect from, or going
/// within `detourKm` of one of their drop-offs.
function onTheWay(order: DeliveryOrder, commitments: Commitment[], detourKm: number): boolean {
  const store = bytesToHex(order.catalog_ref);
  const area = geohashCenter(order.dropoff_geohash);
  return commitments.some(
    (c) => (NOT_YET_COLLECTED.includes(c.order.status) && bytesToHex(c.order.catalog_ref) === store) || distanceKm(area, c.dropoff) <= detourKm,
  );
}

/// Whether an order pays enough for the driver: its fee cap, if it has one,
/// reaches their minimum.
function paysEnough(order: DeliveryOrder, minFeeCents: number): boolean {
  return order.max_delivery_fee === null || order.max_delivery_fee >= minFeeCents;
}

/// The open orders a driver with `commitments` is offered.
export function offerable<T extends { order: DeliveryOrder }>(open: T[], commitments: Commitment[], rules: OfferRules): T[] {
  const load = loadOf(commitments);
  return open.filter(
    ({ order }) =>
      (rules.takePriority || !order.priority) &&
      paysEnough(order, rules.minFeeCents) &&
      carryRefusal(load, order.priority, rules.maxAtOnce) === null &&
      (commitments.length === 0 || onTheWay(order, commitments, rules.detourKm)),
  );
}
