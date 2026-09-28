import { useRef, useState } from "react";
import { Camera, Loader2 } from "lucide-react";
import clsx from "clsx";
import { fileToResizedDataUri } from "../lib/image";

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
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const isBanner = shape === "banner";

  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className={clsx(
          "group relative flex items-center justify-center overflow-hidden bg-ink-100 dark:bg-ink-800 transition hover:opacity-90",
          isBanner ? "h-36 w-full rounded-2xl" : "h-24 w-24 rounded-full",
        )}
      >
        {value ? (
          <img src={value} alt="" className="h-full w-full object-cover" />
        ) : (
          <Camera size={isBanner ? 28 : 22} className="text-ink-400" />
        )}
        <div className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/30">
          {busy ? (
            <Loader2 size={20} className="animate-spin text-white" />
          ) : (
            <span className="text-[11px] font-semibold text-white opacity-0 group-hover:opacity-100">{value ? "Change" : "Upload"}</span>
          )}
        </div>
      </button>
      <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={(e) => handleFile(e.target.files?.[0])} />
      {error && <p className="mt-1 text-[11px] text-red-600">{error}</p>}
    </div>
  );
}
