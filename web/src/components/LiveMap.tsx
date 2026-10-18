import { useEffect, useRef } from "react";
import L from "leaflet";
import { networkServices } from "../store/network";
import "leaflet/dist/leaflet.css";
import { PresenceDot } from "./ui";
import type { GeoPoint } from "../holochain/types";

// Vanilla Leaflet, not react-leaflet -- this app already writes small,
// self-contained components (StarRating, AddressSearch, ChatPanel) rather
// than pulling in wrapper libraries, and a thin imperative ref-based
// component sidesteps any react-leaflet/React-19 peer-dependency question
// entirely. Tiles come from the public OpenStreetMap raster endpoint --
// no API key, no vendor account, consistent with this project's "0
// overhead" stance on infrastructure costs (architecture plan §12) --
// the same provider `AddressSearch`'s Nominatim-backed geocoding uses.

function emojiIcon(emoji: string): L.DivIcon {
  return L.divIcon({
    html: `<div style="font-size:22px;line-height:1;transform:translate(-50%,-50%);">${emoji}</div>`,
    className: "",
    iconSize: [0, 0],
  });
}

const PICKUP_ICON = emojiIcon("🏪");
const DROPOFF_ICON = emojiIcon("🏁");
const DRIVER_ICON = emojiIcon("🛵");

interface Props {
  pickup: GeoPoint;
  dropoff: GeoPoint;
  /// `null` means the driver hasn't broadcast a position yet (or never
  /// will -- browser geolocation permission is denied/unavailable, a real,
  /// named limitation rather than a hidden one).
  driver: GeoPoint | null;
  className?: string;
}

export function LiveMap({ pickup, dropoff, driver, className }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const driverMarkerRef = useRef<L.Marker | null>(null);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, { zoomControl: false, attributionControl: true, scrollWheelZoom: false });
    const services = networkServices();
    L.tileLayer(services.map_tiles_url, { maxZoom: 19, attribution: services.map_attribution }).addTo(map);
    L.marker([pickup.lat, pickup.lon], { icon: PICKUP_ICON }).addTo(map).bindPopup("Pickup");
    L.marker([dropoff.lat, dropoff.lon], { icon: DROPOFF_ICON }).addTo(map).bindPopup("Dropoff");
    // A themed, dashed connector rather than a bare pair of pins -- gives
    // the route a visual through-line in the brand color without claiming
    // to be a real routed path (it's a straight line, not turn-by-turn).
    L.polyline(
      [
        [pickup.lat, pickup.lon],
        [dropoff.lat, dropoff.lon],
      ],
      { color: "#ff5a2b", weight: 3, opacity: 0.55, dashArray: "6 8" },
    ).addTo(map);
    const bounds = L.latLngBounds([
      [pickup.lat, pickup.lon],
      [dropoff.lat, dropoff.lon],
    ]);
    map.fitBounds(bounds, { padding: [32, 32], maxZoom: 16 });
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      driverMarkerRef.current = null;
    };
    // Pickup/dropoff are fixed for a given order -- the map is created
    // once, not torn down and rebuilt as the driver's position streams in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !driver) return;
    if (!driverMarkerRef.current) {
      driverMarkerRef.current = L.marker([driver.lat, driver.lon], { icon: DRIVER_ICON }).addTo(map);
    } else {
      driverMarkerRef.current.setLatLng([driver.lat, driver.lon]);
    }
  }, [driver]);

  return (
    <div className="relative overflow-hidden rounded-2xl border border-ink-100 dark:border-ink-800 shadow-[var(--shadow-card)]">
      <div ref={containerRef} className={className ?? "h-56 w-full"} />
      {driver && (
        <div className="pointer-events-none absolute left-2 top-2 flex items-center gap-1.5 rounded-full bg-white/90 dark:bg-ink-900/90 px-2.5 py-1 text-[10px] font-bold text-ink-700 dark:text-ink-200 shadow backdrop-blur-sm">
          <PresenceDot />
          Live
        </div>
      )}
    </div>
  );
}
