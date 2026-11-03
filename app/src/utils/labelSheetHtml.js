// Printable label sheets. Pure JS, no React Native imports, so it loads in plain node.

export const LAYOUTS = {
  stickers: { cols: 3, rows: 8 },
  bucket: { cols: 2, rows: 3 },
  price_card: { cols: 1, rows: 4 },
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const formatLabelDate = (date) => {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
};

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export const perPage = (layout) => {
  const l = LAYOUTS[layout] || LAYOUTS.stickers;
  return l.cols * l.rows;
};

const priceText = (item) => {
  if (item.price_mode === 'open') return item.price_hint ? esc(item.price_hint) : '';
  if (item.price == null || item.price === '') return '';
  const n = Number(item.price);
  if (!isFinite(n)) return '';
  return `₹${n.toFixed(2)}`;
};

const cellHtml = (item, showPrice, dateLine) => {
  const p = showPrice ? priceText(item) : '';
  const priceBlock = p
    ? `<div class="price">${p}</div><div class="asof">${esc(dateLine)}</div>`
    : '';
  const img = item.qr_data_url ? `<img class="qr" src="${esc(item.qr_data_url)}" />` : '';
  return `<div class="cell"><div class="name">${esc(item.name)}</div>${img}${priceBlock}</div>`;
};

export const buildLabelSheetHtml = ({ layout = 'stickers', items = [], showPrice = false, date = new Date() } = {}) => {
  const key = LAYOUTS[layout] ? layout : 'stickers';
  const { cols, rows } = LAYOUTS[key];
  const size = cols * rows;
  const dateLine = `price on ${formatLabelDate(date)}`;

  const cells = [];
  for (const it of items) {
    const n = Math.max(1, Math.min(48, parseInt(it.count, 10) || 1));
    for (let i = 0; i < n; i += 1) cells.push(it);
  }

  const pages = [];
  for (let i = 0; i < cells.length; i += size) {
    const chunk = cells.slice(i, i + size).map((c) => cellHtml(c, showPrice, dateLine)).join('');
    pages.push(`<div class="page">${chunk}</div>`);
  }

  const css = `
    @page { size: A4; margin: 8mm; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: #000; }
    .page { width: 194mm; height: 281mm; display: grid; grid-template-columns: repeat(${cols}, 1fr); grid-template-rows: repeat(${rows}, 1fr); page-break-after: always; break-after: page; overflow: hidden; }
    .page:last-child { page-break-after: auto; break-after: auto; }
    .cell { display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 2mm; border: 0.2mm dashed #bbb; overflow: hidden; }
    .name { font-weight: bold; line-height: 1.15; margin-bottom: 1.5mm; max-width: 100%; word-break: break-word; }
    .qr { image-rendering: pixelated; }
    .price { font-weight: bold; margin-top: 1.5mm; }
    .asof { color: #444; }
    ${key === 'stickers' ? '.name{font-size:9pt}.qr{width:20mm;height:20mm}.price{font-size:10pt}.asof{font-size:6.5pt}' : ''}
    ${key === 'bucket' ? '.name{font-size:26pt}.qr{width:60mm;height:60mm}.price{font-size:30pt}.asof{font-size:11pt}' : ''}
    ${key === 'price_card' ? '.cell{flex-direction:row;justify-content:space-between;gap:8mm;padding:6mm 10mm;text-align:left}.name{font-size:22pt;margin:0;flex:1}.qr{width:45mm;height:45mm}.price{font-size:24pt;margin:0 4mm}.asof{font-size:9pt}' : ''}
  `;

  return `<!doctype html><html><head><meta charset="utf-8"><title>Labels</title><style>${css}</style></head><body>${pages.join('')}</body></html>`;
};
