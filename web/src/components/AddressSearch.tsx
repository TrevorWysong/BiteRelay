import { useEffect, useRef, useState } from "react";
import { MapPin, Search } from "lucide-react";
import clsx from "clsx";
import { Input, Spinner } from "./ui";
import { searchAddress, reverseGeocode } from "../lib/geocoding";
import type { GeoPoint } from "../holochain/types";
import type { GeocodeResult } from "../lib/geocoding";

const DEBOUNCE_MS = 500;

export function AddressSearch({ value, onChange, label = "Delivery location" }: { value: GeoPoint; onChange: (v: GeoPoint) => void; label?: string }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GeocodeResult[]>([]);
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [manual, setManual] = useState(false);
  // Tracks whether `query` (what's visibly typed) actually corresponds to
  // `value` (what gets submitted) -- typing without ever picking a result
  // leaves `value` at whatever it was before, which is the safe behavior,
  // but silently: the box can show garbage text while the real location
  // underneath is still the old, valid one. Surfaced so that's not hidden.
  const [confirmed, setConfirmed] = useState(true);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resolvedForRef = useRef<string | null>(null);

  // If we already have coordinates (editing an existing address) but no
  // label yet, look one up once so the field doesn't just show blank next
  // to a real location.
  useEffect(() => {
    const key = `${value.lat},${value.lon}`;
    if (query || resolvedForRef.current === key) return;
    resolvedForRef.current = key;
    const controller = new AbortController();
    reverseGeocode(value, controller.signal)
      .then((label) => {
        if (label) setQuery(label);
      })
      .catch(() => {});
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleInput(text: string) {
    setQuery(text);
    setConfirmed(false);
    setSearchError(false);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    abortRef.current?.abort();
    if (!text.trim()) {
      setResults([]);
      setOpen(false);
      return;
    }
    debounceRef.current = setTimeout(() => {
      const controller = new AbortController();
      abortRef.current = controller;
      setSearching(true);
      searchAddress(text, controller.signal)
        .then((rows) => {
          setResults(rows);
          setOpen(true);
        })
        .catch((err) => {
          if (err?.name !== "AbortError") setSearchError(true);
        })
        .finally(() => setSearching(false));
    }, DEBOUNCE_MS);
  }

  function selectResult(result: GeocodeResult) {
    onChange(result.point);
    setQuery(result.label);
    setConfirmed(true);
    setOpen(false);
    setResults([]);
  }

  return (
    <div>
      <p className="mb-1 text-xs font-semibold text-ink-500">{label}</p>
      {!manual ? (
        <div className="relative">
          <div className="relative flex items-center">
            <Search size={15} className="pointer-events-none absolute left-3.5 text-ink-400" />
            <Input
              value={query}
              onChange={(e) => handleInput(e.target.value)}
              onFocus={() => results.length > 0 && setOpen(true)}
              onBlur={() => setTimeout(() => setOpen(false), 150)}
              placeholder="Search for an address…"
              className="pl-9 pr-9"
            />
            {searching && <Spinner className="pointer-events-none absolute right-3 h-4 w-4 text-ink-400" />}
          </div>
          {!confirmed && !open && query.trim() && (
            <p className="mt-1.5 text-[11px] text-amber-600 dark:text-amber-400">Pick an address below to update the location -- your previous one is still in use until you do.</p>
          )}
          {open && (
            <div className="absolute z-10 mt-1 w-full overflow-hidden rounded-xl border border-ink-200/70 dark:border-ink-700/70 bg-white dark:bg-ink-900 shadow-lg">
              {results.length === 0 && !searching && (
                <p className="px-3.5 py-2.5 text-xs text-ink-400">{searchError ? "Couldn't search right now -- try again" : "No matches"}</p>
              )}
              {results.map((result, i) => (
                <button
                  key={i}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => selectResult(result)}
                  className={clsx(
                    "flex w-full items-start gap-2 px-3.5 py-2.5 text-left text-xs text-ink-700 dark:text-ink-200 hover:bg-ink-50 dark:hover:bg-ink-800",
                    i > 0 && "border-t border-ink-100 dark:border-ink-800",
                  )}
                >
                  <MapPin size={14} className="mt-0.5 shrink-0 text-relay-500" />
                  <span>{result.label}</span>
                </button>
              ))}
            </div>
          )}
          <button type="button" onClick={() => setManual(true)} className="mt-1.5 text-[11px] font-medium text-ink-400 underline-offset-2 hover:text-relay-600 hover:underline">
            Enter coordinates manually
          </button>
        </div>
      ) : (
        <div>
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
          <button type="button" onClick={() => setManual(false)} className="mt-1.5 text-[11px] font-medium text-ink-400 underline-offset-2 hover:text-relay-600 hover:underline">
            Search by address instead
          </button>
        </div>
      )}
    </div>
  );
}
