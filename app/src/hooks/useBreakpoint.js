import { useWindowDimensions } from 'react-native';

/**
 * The app's one layout breakpoint.
 *
 * Replaces two independent `width >= 1100` computations that DashboardScreen.js
 * and OrderKanbanBoard.js each maintained, both carrying a comment asking
 * whoever changed one to remember the other. 900 (not 1100) is the threshold,
 * ported from DashboardScreenV2.js which had the only working responsive
 * treatment in the app.
 *
 * See docs/superpowers/specs/2026-09-01-dashboard-stage-ui-redesign-design.md §5.
 */
export const WIDE_BREAKPOINT = 900;

export default function useBreakpoint() {
  const { width } = useWindowDimensions();
  return { width, isWide: width >= WIDE_BREAKPOINT };
}
