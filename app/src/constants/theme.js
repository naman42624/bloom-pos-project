/**
 * BloomCart POS — shared color palette, spacing, sizing, and shadows.
 * Design principle: "A 5-year-old can navigate."
 */
export const Colors = {
  primary: '#E91E63',       // Keep brand rose pink
  primaryDark: '#BE185D',
  primaryLight: '#FBCFE8',
  primaryGlow: '#FDF2F8',

  secondary: '#10B981',     // Elegant minimal green
  secondaryDark: '#059669',
  secondaryLight: '#D1FAE5',

  background: '#FAFAFA',    // Clean minimal background
  surface: '#FFFFFF',
  surfaceAlt: '#F9FAFB',    // High-end soft gray vs pink tint
  surfaceElevated: '#FFFFFF',

  text: '#111827',          // Crisp black/gray
  textSecondary: '#4B5563',
  textLight: '#9CA3AF',
  textOnPrimary: '#FFFFFF',

  border: '#E5E7EB',        // Clean light border
  borderFocus: '#E91E63',

  error: '#EF4444',
  danger: '#EF4444',
  errorLight: '#FEE2E2',
  warning: '#F59E0B',
  warningLight: '#FEF3C7',
  success: '#4CAF50',
  successLight: '#E8F5E9',
  info: '#3B82F6',
  infoLight: '#DBEAFE',

  white: '#FFFFFF',
  black: '#000000',
  transparent: 'transparent',

  // Role badge colors
  roleOwner: '#9C27B0',
  roleManager: '#2196F3',
  roleEmployee: '#FF9800',
  roleDelivery: '#00BCD4',
  roleCustomer: '#795548',

  // Gradient-ready accent colors
  accent1: '#FF6B9D',
  accent2: '#C084FC',
  accent3: '#67E8F9',
};

export const Spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
};

export const FontSize = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 20,       // bumped from 18 for better readability
  xl: 26,       // bumped from 24
  xxl: 34,      // bumped from 32
  hero: 42,     // new — for large dashboard numbers
};

export const BorderRadius = {
  sm: 8,        // bumped from 6
  md: 12,       // bumped from 10
  lg: 18,       // bumped from 16
  xl: 26,       // bumped from 24
  full: 9999,
};

// Consistent shadow presets for cards/surfaces
export const Shadows = {
  sm: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.03, // softer
    shadowRadius: 2,
    elevation: 1,
  },
  md: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05, // softer
    shadowRadius: 6,
    elevation: 2,
  },
  lg: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08, // softer
    shadowRadius: 12,
    elevation: 4,
  },
  glow: (color) => ({
    shadowColor: color || Colors.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2, // softer glow
    shadowRadius: 8,
    elevation: 4,
  }),
};

// Minimum touch target sizes for child-friendly UI
export const TouchTarget = {
  minHeight: 48,
  minWidth: 48,
};
