// Raw lat/lon editing, not a real address lookup -- there is no geocoding
// anywhere in this app (even onboarding just hardcodes a starting
// coordinate), so this is honestly scoped to match that, not a from-scratch
// address autocomplete. Still a real fix for "I can't deliver anywhere but
// my onboarding location": every order can now point at different
// coordinates, not just the one set once at signup.
import { Input } from "./ui";
import type { GeoPoint } from "../holochain/types";

export function LocationInput({ value, onChange, label = "Delivery location" }: { value: GeoPoint; onChange: (v: GeoPoint) => void; label?: string }) {
  return (
    <div>
      <p className="mb-1 text-xs font-semibold text-ink-500">{label}</p>
      <div className="flex gap-2">
        <label className="flex-1 text-xs text-ink-400">
          Latitude
          <Input type="number" step="any" value={value.lat} onChange={(e) => onChange({ ...value, lat: Number(e.target.value) })} className="mt-1" />
        </label>
        <label className="flex-1 text-xs text-ink-400">
          Longitude
          <Input type="number" step="any" value={value.lon} onChange={(e) => onChange({ ...value, lon: Number(e.target.value) })} className="mt-1" />
        </label>
      </div>
    </div>
  );
}
