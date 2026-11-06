// Where an order came from: icons and words shared by every screen that shows
// it (Quick Checkout chips, Sale Details badge, Orders inbox). 'other_app' is
// an order from a delivery app; sale.channel_detail holds the app's name.
export const CHANNEL_ICONS = {
  whatsapp: 'logo-whatsapp',
  email: 'mail',
  website: 'globe',
  walk_in: 'walk',
  phone: 'call',
  other_app: 'apps',
};

const CHANNEL_WORDS = {
  whatsapp: 'WhatsApp',
  email: 'Email',
  website: 'Website',
  walk_in: 'Walk-in',
  phone: 'Phone',
  other_app: 'Other app',
};

/** "WhatsApp", "Swiggy" (an other_app order with its app name), "Other app". */
export function channelLabel(channel, detail) {
  if (!channel) return '';
  if (channel === 'other_app' && detail && String(detail).trim()) return String(detail).trim();
  return CHANNEL_WORDS[channel] || String(channel).replace(/_/g, ' ');
}
