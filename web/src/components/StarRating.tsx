import { Star } from "lucide-react";
import clsx from "clsx";

export function StarRating({ value, count, size = 14 }: { value: number; count?: number; size?: number }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="flex">
        {[1, 2, 3, 4, 5].map((i) => (
          <Star key={i} size={size} className={i <= Math.round(value) ? "fill-amber-400 text-amber-400" : "text-ink-200 dark:text-ink-700"} />
        ))}
      </span>
      {count !== undefined && <span className="text-xs text-ink-400">({count})</span>}
    </span>
  );
}

export function StarRatingInput({ value, onChange, size = 28 }: { value: number; onChange: (v: number) => void; size?: number }) {
  return (
    <span className="inline-flex gap-1">
      {[1, 2, 3, 4, 5].map((i) => (
        <button key={i} type="button" onClick={() => onChange(i)} className="p-0.5">
          <Star size={size} className={clsx("transition-colors", i <= value ? "fill-amber-400 text-amber-400" : "text-ink-200 dark:text-ink-700")} />
        </button>
      ))}
    </span>
  );
}
