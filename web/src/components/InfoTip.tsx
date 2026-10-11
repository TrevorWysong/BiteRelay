// A subtle "i" that opens a short explanation beside what it's about --
// for terms worth knowing but not worth a paragraph on every screen. Opens
// on tap (or keyboard), closes on a second tap, Escape, or leaving it.
import { useId, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Info } from "lucide-react";

export function InfoTip({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span className="relative inline-flex" onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setOpen(false)}>
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
        className="grid h-6 w-6 place-items-center rounded-full text-ink-400 transition hover:bg-ink-100 hover:text-ink-600 dark:hover:bg-ink-800 dark:hover:text-ink-200"
      >
        <Info size={14} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            id={id}
            role="note"
            tabIndex={-1}
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.15 }}
            className="absolute right-0 top-full z-20 mt-1.5 w-72 max-w-[80vw] rounded-xl border border-ink-100 bg-white p-3 text-left text-xs font-normal normal-case leading-relaxed tracking-normal text-ink-600 shadow-[var(--shadow-card)] dark:border-ink-800 dark:bg-ink-900 dark:text-ink-300"
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </span>
  );
}
