// A bottom sheet: slides up over a dimmed page, closes on the backdrop, the
// close button or Escape. Content scrolls; `footer` stays pinned below it
// for the sheet's primary action.
import type { ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";

export function Sheet({ open, onClose, title, subtitle, children, footer }: { open: boolean; onClose: () => void; title: string; subtitle?: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 backdrop-blur-[2px] sm:items-center"
          onClick={onClose}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={title}
            // Focus lands in the sheet, so Escape reaches it.
            ref={(node) => node?.focus()}
            tabIndex={-1}
            onKeyDown={(e) => e.key === "Escape" && onClose()}
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", damping: 30, stiffness: 320 }}
            onClick={(e) => e.stopPropagation()}
            className="flex max-h-[92dvh] w-full max-w-md flex-col overflow-hidden rounded-t-3xl bg-white shadow-2xl outline-none sm:rounded-3xl dark:bg-ink-900"
          >
            <div className="mx-auto mt-2.5 h-1 w-10 shrink-0 rounded-full bg-ink-200 sm:hidden dark:bg-ink-700" />
            <div className="flex items-start justify-between gap-3 px-5 pt-3 pb-1">
              <div>
                <h2 className="text-lg font-black tracking-tight text-ink-900 dark:text-ink-50">{title}</h2>
                {subtitle && <p className="mt-0.5 text-sm text-ink-500 dark:text-ink-400">{subtitle}</p>}
              </div>
              <button onClick={onClose} aria-label="Close" className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-ink-100 text-ink-500 transition hover:bg-ink-200 dark:bg-ink-800 dark:hover:bg-ink-700">
                <X size={18} />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-3 pb-5">{children}</div>
            {footer && <div className="border-t border-ink-100 px-5 pt-3 pb-[max(1.25rem,env(safe-area-inset-bottom))] dark:border-ink-800">{footer}</div>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
