// Shared framer-motion variants -- centralized so every list/page in the
// app moves with the same easing/timing "voice" instead of each screen
// inventing its own feel. A deliberately restrained set: fade+rise for
// content appearing, a short stagger for lists, and a quick fade+shift for
// route changes -- nothing bouncy or attention-seeking, consistent with
// this app's overall "calm, premium" visual register.
import type { Variants } from "framer-motion";

const EASE = [0.22, 1, 0.36, 1] as const;

export const fadeSlideUp: Variants = {
  hidden: { opacity: 0, y: 10 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.32, ease: EASE } },
};

export const staggerContainer: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.045, delayChildren: 0.02 } },
};

export const pageVariants: Variants = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.22, ease: EASE } },
  exit: { opacity: 0, y: -6, transition: { duration: 0.14, ease: EASE } },
};
