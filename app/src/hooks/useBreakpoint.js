import { useWindowDimensions } from 'react-native';

/**
 * The app's layout breakpoints — two of them, on purpose.
 *
 * This hook exists because DashboardScreen.js and OrderKanbanBoard.js each
 * hardcoded their own `width >= 1100`, both carrying a comment asking whoever
 * changed one to remember the other. One hook fixes that. What it must NOT do
 * is force two unrelated questions onto one number:
 *
 *   isWide (900) — "can a strip of content run as side-by-side columns?"
 *     The Stage board's four columns switch on this. Ported from
 *     DashboardScreenV2.js, which had the only working responsive treatment in
 *     the app. Below it, the board stacks into collapsible sections.
 *
 *   isDesktop (1100) — "should a whole PAGE split into two columns?"
 *     The owner/manager dashboard's feed (flex 2) / health (flex 1) split uses
 *     this, and it needs the higher number precisely BECAUSE the board lives
 *     inside the feed column. Collapsing both onto 900 was tried and reverted:
 *     at ~901px the page split first, leaving the board about 600px, so its
 *     four columns came out near 140px each — too narrow for a card carrying an
 *     order number, customer, amount, stage badge and a 44px button.
 *
 * So: below 900 everything stacks; 900-1100 the page stays single-column and
 * the board runs four columns across the full width; above 1100 the page splits
 * as well. If you change one of these numbers, you do not automatically need to
 * change the other — that independence is the point.
 *
 * See docs/superpowers/specs/2026-09-01-dashboard-stage-ui-redesign-design.md §5.
 */
export const WIDE_BREAKPOINT = 900;
export const DESKTOP_BREAKPOINT = 1100;

export default function useBreakpoint() {
  const { width } = useWindowDimensions();
  return {
    width,
    isWide: width >= WIDE_BREAKPOINT,
    isDesktop: width >= DESKTOP_BREAKPOINT,
  };
}
