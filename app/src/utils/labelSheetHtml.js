// Printable label sheets. Pure JS, no React Native imports, so it loads in plain node.

export const LAYOUTS = {
  stickers: { cols: 3, rows: 8 },
  bucket: { cols: 2, rows: 3 },
  price_card: { cols: 1, rows: 11 },
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
  if (!isFinite(n) || n === 0) return '';
  const whole = Math.abs(n - Math.round(n)) < 0.005;
  return `\u20B9${n.toLocaleString('en-IN', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 })}`;
};

const isHint = (item) => item.price_mode === 'open';

const cellHtml = (item, showPrice, dateLine) => {
  const p = showPrice ? priceText(item) : '';
  const priceBlock = p
    ? `<div class="price${isHint(item) ? ' hint' : ''}">${p}</div><div class="asof">${esc(dateLine)}</div>`
    : '';
  const img = item.qr_data_url ? `<img class="qr" src="${esc(item.qr_data_url)}" />` : '';
  return `<div class="cell${p ? ' withprice' : ''}"><div class="name">${esc(item.name)}</div>${img}${priceBlock}</div>`;
};

// One row of the price card: name, price (always shown), small QR.
const rowHtml = (item, dateLine) => {
  const p = priceText(item) || 'Ask at the counter';
  const img = item.qr_data_url ? `<img class="qr" src="${esc(item.qr_data_url)}" />` : '';
  return `<div class="cell"><div class="name">${esc(item.name)}</div><div class="priceblock"><div class="price${isHint(item) ? ' hint' : ''}">${p}</div><div class="asof">${esc(dateLine)}</div></div>${img}</div>`;
};

export const buildLabelSheetHtml = ({ layout = 'stickers', items = [], showPrice = false, date = new Date() } = {}) => {
  const key = LAYOUTS[layout] ? layout : 'stickers';
  const { cols, rows } = LAYOUTS[key];
  const size = cols * rows;
  const dateLine = `price on ${formatLabelDate(date)}`;

  let cells = [];
  if (key === 'price_card') {
    cells = items.slice();
  } else {
    for (const it of items) {
      const n = Math.max(1, Math.min(48, parseInt(it.count, 10) || 1));
      for (let i = 0; i < n; i += 1) cells.push(it);
    }
  }

  const pages = [];
  for (let i = 0; i < cells.length; i += size) {
    const chunk = cells.slice(i, i + size)
      .map((c) => (key === 'price_card' ? rowHtml(c, dateLine) : cellHtml(c, showPrice, dateLine))).join('');
    pages.push(`<div class="page">${chunk}</div>`);
  }

  // Size budget (mm). Page area 194 x 280 (A4 minus 8mm margins, 1.0mm spare for rounding).
  // Sticker cell 64.7 x 35, padding 1 -> 33 tall: name 2 lines 8pt ~7 + 1 gap + QR 20 (no price) = 28;
  //   with price: 7 + 1 + QR 16 + 1 + price 10pt ~4.2 + date 6.5pt ~2.8 = 32.
  // Bucket cell 97 x 93, padding 2 -> 89 tall: name 2 lines 22pt ~18.6 + 1.5 + QR 60 (no price) = 80;
  //   with price: 18.6 + 1.5 + QR 48 + 1.5 + price 30pt ~12.7 + date 11pt ~4.7 = 87.
  // Price card row 194 x 25.4: QR 18, text beside it.
  const css = `
    @page { size: A4; margin: 8mm; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: #000; }
    .page { width: 194mm; height: 280mm; display: grid; grid-template-columns: repeat(${cols}, 1fr); grid-template-rows: repeat(${rows}, 1fr); page-break-after: always; break-after: page; overflow: hidden; }
    .page:last-child { page-break-after: auto; break-after: auto; }
    .cell { display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 1mm; border: 0.2mm dashed #bbb; overflow: hidden; }
    .name { font-weight: bold; line-height: 1.15; margin-bottom: 1mm; max-width: 100%; word-break: break-word; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .qr { image-rendering: pixelated; }
    .price { font-weight: bold; margin-top: 1mm; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
    .asof { color: #444; }
    ${key === 'stickers' ? '.name{font-size:8pt}.qr{width:20mm;height:20mm}.withprice .qr{width:16mm;height:16mm}.price{font-size:10pt}.price.hint{font-size:6pt}.asof{font-size:6.5pt}' : ''}
    ${key === 'bucket' ? '.cell{padding:2mm}.name{font-size:22pt;margin-bottom:1.5mm}.qr{width:60mm;height:60mm}.withprice .qr{width:48mm;height:48mm}.price{font-size:30pt;margin-top:1.5mm}.price.hint{font-size:18pt}.asof{font-size:11pt}' : ''}
    ${key === 'price_card' ? '.cell{flex-direction:row;justify-content:space-between;gap:6mm;padding:2mm 8mm;text-align:left;border-style:solid}.name{font-size:16pt;margin:0;flex:1}.priceblock{text-align:right}.price{font-size:18pt;margin:0;white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}.price.hint{font-size:11pt}.asof{font-size:8pt}.qr{width:18mm;height:18mm}' : ''}
  `;

  return `<!doctype html><html><head><meta charset="utf-8"><title>Labels</title><style>${css}</style></head><body>${pages.join('')}</body></html>`;
};
