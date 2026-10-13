'use client';

import * as React from 'react';
import { AnimatePresence, motion, type HTMLMotionProps, type Variants } from 'framer-motion';
import { cn } from '@/lib/utils';

/**
 * One motion for every dropdown panel on the platform, in both directions.
 *
 * Enter and exit share the same curve and distance, so a panel opens and closes
 * the same way wherever it appears. The exit is the enter reversed and a little
 * faster, which keeps closing responsive.
 */
export const DROPDOWN_EASE = [0.16, 1, 0.3, 1] as const;

export const dropdownPanelVariants: Variants = {
  hidden: { opacity: 0, y: -6, scale: 0.97 },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: { duration: 0.22, ease: DROPDOWN_EASE },
  },
  exit: {
    opacity: 0,
    y: -6,
    scale: 0.97,
    transition: { duration: 0.16, ease: DROPDOWN_EASE },
  },
};

/**
 * Reduced motion keeps the fade and drops the movement. Framer Motion runs in
 * JavaScript, so the global CSS rule in `globals.css` does not reach it. This
 * variant set is what replaces it.
 */
const reducedDropdownPanelVariants: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: 0.01 } },
  exit: { opacity: 0, transition: { duration: 0.01 } },
};

/**
 * True when motion should be reduced. It follows the project's own `data-motion`
 * setting first (`reduced` / `full`), and falls back to the OS preference when the
 * setting is `system`. Same source of truth as the rest of the app.
 */
function useReducedDropdownMotion(): boolean {
  const [reduced, setReduced] = React.useState(false);

  React.useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');

    const compute = () => {
      const setting = root.getAttribute('data-motion');
      setReduced(setting === 'reduced' || (setting !== 'full' && media.matches));
    };

    compute();
    const observer = new MutationObserver(compute);
    observer.observe(root, { attributes: true, attributeFilter: ['data-motion'] });
    media.addEventListener?.('change', compute);

    return () => {
      observer.disconnect();
      media.removeEventListener?.('change', compute);
    };
  }, []);

  return reduced;
}

export interface DropdownPanelProps extends Omit<HTMLMotionProps<'div'>, 'ref'> {
  /** Whether the panel is shown. Exit animates before the node is removed. */
  open: boolean;
}

/**
 * Animated container for any dropdown or popover panel.
 *
 * Use it in place of `{open && <div className="...">}`. It keeps the node mounted
 * until the exit animation finishes, so closing animates too. `style` is merged, so
 * a caller's inline styles are kept alongside the shared transform origin.
 */
export const DropdownPanel = React.forwardRef<HTMLDivElement, DropdownPanelProps>(
  ({ open, className, style, children, ...props }, ref) => {
    const reduced = useReducedDropdownMotion();

    return (
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            ref={ref}
            key="dropdown-panel"
            variants={reduced ? reducedDropdownPanelVariants : dropdownPanelVariants}
            initial="hidden"
            animate="visible"
            exit="exit"
            style={{ transformOrigin: 'top', ...style }}
            className={cn(className)}
            {...props}
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    );
  },
);
DropdownPanel.displayName = 'DropdownPanel';
