import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { GeoPoint } from "../holochain/types";

// Vanilla Leaflet, not react-leaflet -- this app already writes small,
// self-contained components (StarRating, LocationInput, ChatPanel) rather
// than pulling in wrapper libraries, and a thin imperative ref-based
// component sidesteps any react-leaflet/React-19 peer-dependency question
// entirely. Tiles come from the public OpenStreetMap raster endpoint --
// no API key, no vendor account, consistent with this project's "0
// overhead" stance on infrastructure costs (architecture plan §12). This
// is the same honest tradeoff named for `LocationInput` (raw lat/lon, no
// address autocomplete): a real live map, but the plainest version of one
// that needs no paid service to work.
const TILE_URL = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

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
    L.tileLayer(TILE_URL, { maxZoom: 19, attribution: ATTRIBUTION }).addTo(map);
    L.marker([pickup.lat, pickup.lon], { icon: PICKUP_ICON }).addTo(map).bindPopup("Pickup");
    L.marker([dropoff.lat, dropoff.lon], { icon: DROPOFF_ICON }).addTo(map).bindPopup("Dropoff");
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

  return <div ref={containerRef} className={className ?? "h-56 w-full rounded-2xl"} />;
}
