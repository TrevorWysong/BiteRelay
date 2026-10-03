import { useRef, useState } from "react";
import { Camera, Loader2 } from "lucide-react";
import clsx from "clsx";
import { fileToResizedDataUri } from "../lib/image";
import { describeError } from "../lib/errors";

interface Props {
  value: string;
  onChange: (dataUri: string) => void;
  shape?: "circle" | "banner";
  className?: string;
}

export function PhotoInput({ value, onChange, shape = "circle", className }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      onChange(await fileToResizedDataUri(file));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  const isBanner = shape === "banner";

  return (
    <div className={clsx(isBanner && "w-full", className)}>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className={clsx(
          "group relative flex items-center justify-center overflow-hidden transition",
          isBanner
            ? clsx(
                "h-36 w-full rounded-2xl border-2",
                value
                  ? "border-transparent"
                  : "border-dashed border-ink-200 dark:border-ink-700 bg-ink-50/80 dark:bg-ink-800/50 hover:border-relay-400 hover:bg-relay-50/40 dark:hover:bg-relay-900/10",
              )
            : "h-24 w-24 rounded-full bg-ink-100 dark:bg-ink-800 hover:opacity-90",
        )}
      >
        {value ? (
          <img src={value} alt="" className="h-full w-full object-cover" />
        ) : isBanner ? (
          <span className="flex flex-col items-center gap-1.5 text-ink-400 dark:text-ink-500">
            <Camera size={26} />
            <span className="text-xs font-semibold">Add a photo</span>
            <span className="text-[11px]">Tap to upload from your device</span>
          </span>
        ) : (
          <Camera size={22} className="text-ink-400" />
        )}
        {busy && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/30">
            <Loader2 size={20} className="animate-spin text-white" />
          </div>
        )}
        {!busy && value && (
          <span className="absolute bottom-2 right-2 flex items-center gap-1 rounded-full bg-black/60 px-2 py-1 text-[10px] font-semibold text-white backdrop-blur-sm transition group-hover:bg-black/75">
            <Camera size={11} /> Change
          </span>
        )}
      </button>
      <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={(e) => handleFile(e.target.files?.[0])} />
      {error && <p className="mt-1 text-[11px] text-red-600">{error}</p>}
    </div>
  );
}
