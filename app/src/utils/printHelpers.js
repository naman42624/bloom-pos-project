import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';
import api from '../services/api';
import { showAlert } from './alert';
import { formatDate, formatCardDateTime } from './datetime';

export const printHtmlOnWeb = (markup, title) => {
  const frame = document.createElement('iframe');
  frame.style.position = 'fixed';
  frame.style.right = '0';
  frame.style.bottom = '0';
  frame.style.width = '0';
  frame.style.height = '0';
  frame.style.border = 'none';
  document.body.appendChild(frame);

  const frameDoc = frame.contentWindow?.document;
  if (!frameDoc) {
    document.body.removeChild(frame);
    throw new Error('Unable to open print frame');
  }

  frameDoc.open();
  frameDoc.write(`<html><head><title>${title}</title></head><body>${markup}</body></html>`);
  frameDoc.close();

  setTimeout(() => {
    try {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
    } finally {
      setTimeout(() => {
        if (frame.parentNode) frame.parentNode.removeChild(frame);
      }, 500);
    }
  }, 250);
};

export const printHtml = async (html, title) => {
  try {
    if (Platform.OS === 'web') {
      printHtmlOnWeb(html, title);
      return;
    }
    const { uri } = await Print.printToFileAsync({ html, width: 595 }); // A4 width approx for slips
    await Sharing.shareAsync(uri, { mimeType: 'application/pdf', dialogTitle: title });
  } catch (err) {
    showAlert('Could not print', 'The slip could not be printed. Check the printer is on and try again.');
  }
};

// ─── Delivery challan / pickup slip ──────────────────────────
// ONE generator for every place the app prints an order slip (Delivery
// Details, Sale Details, dashboard cards, Orders Inbox, the dashboard order
// popup, Dashboard V2). Before 2026-10-24 there were two diverging copies: one
// read a `total_paid` field `sales` doesn't have (so a part-paid order printed
// its FULL total as due) and hard-coded one location's address.

const FALLBACK_SHOP_NAME = 'Flower Point';

// Everything printed here can be customer-typed (card message, address,
// notes, a custom item's name) and lands in a same-origin iframe on web.
const esc = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const rupees = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

const METHOD_LABELS = { cash: 'Cash', upi: 'UPI', card: 'Card', bank_transfer: 'Bank', credit: 'Credit' };

// Same rule SaleDetailScreen shows on screen: paid = sum of payment rows
// (a rider's COD collection is recorded as one too), balance = total − paid.
export const computeSlipMoney = (sale) => {
  const total = Number(sale.grand_total || 0);
  const payments = sale.payments || [];
  const paid = payments.reduce((s, p) => s + Number(p.amount || 0), 0);
  const balance = Math.max(total - paid, 0);
  const byMethod = {};
  payments.forEach((p) => {
    const amt = Number(p.amount || 0);
    if (!amt) return;
    const key = METHOD_LABELS[p.method] || p.method || 'Other';
    byMethod[key] = (byMethod[key] || 0) + amt;
  });
  const state = balance <= 0.01 ? 'paid' : (sale.is_credit_sale ? 'credit' : 'due');
  return { total, paid, balance, byMethod, state };
};

// Shop copy: the money state is the first thing on the slip and impossible to
// miss — the person handing the order over must know at a glance whether to
// collect anything, and how much.
const shopMoneyBlock = (money, isDelivery) => {
  const breakdown = Object.entries(money.byMethod).map(([m, a]) => `${esc(m)} ${rupees(a)}`).join(' · ');
  if (money.state === 'paid') {
    return `
      <div style="border:3px solid #2E7D32;background:#E8F5E9;border-radius:8px;padding:8px 12px;margin:6px 0 8px;display:flex;justify-content:space-between;align-items:center;">
        <div>
          <div style="font-size:22px;font-weight:800;color:#2E7D32;letter-spacing:1px;">PAID IN FULL</div>
          <div style="font-size:11px;color:#2E7D32;font-weight:600;">Nothing to collect${breakdown ? ` · ${breakdown}` : ''}</div>
        </div>
        <div style="font-size:20px;font-weight:800;color:#2E7D32;">${rupees(money.total)}</div>
      </div>`;
  }
  if (money.state === 'credit') {
    return `
      <div style="border:3px solid #6A1B9A;background:#F3E5F5;border-radius:8px;padding:8px 12px;margin:6px 0 8px;">
        <div style="font-size:20px;font-weight:800;color:#6A1B9A;letter-spacing:1px;">CREDIT SALE — DO NOT COLLECT</div>
        <div style="font-size:12px;color:#4A148C;font-weight:600;margin-top:2px;">
          ${rupees(money.balance)} goes on the customer's account · Total ${rupees(money.total)} · Paid ${rupees(money.paid)}${breakdown ? ` (${breakdown})` : ''}
        </div>
      </div>`;
  }
  return `
    <div style="border:3px solid #C62828;background:#FFEBEE;border-radius:8px;padding:8px 12px;margin:6px 0 8px;display:flex;justify-content:space-between;align-items:center;">
      <div>
        <div style="font-size:13px;font-weight:800;color:#C62828;letter-spacing:1px;">${isDelivery ? 'COLLECT ON DELIVERY' : 'COLLECT AT PICKUP'}</div>
        <div style="font-size:11px;color:#B71C1C;font-weight:600;margin-top:2px;">
          Total ${rupees(money.total)} · Paid ${rupees(money.paid)}${breakdown ? ` (${breakdown})` : ''}
        </div>
      </div>
      <div style="text-align:right;">
        <div style="font-size:10px;font-weight:700;color:#C62828;">BALANCE DUE</div>
        <div style="font-size:26px;font-weight:900;color:#C62828;line-height:1;">${rupees(money.balance)}</div>
      </div>
    </div>`;
};

// Customer copy travels with the order — often a gift — so it never shows the
// order total or what was paid, only whether the recipient has to pay.
const customerMoneyLine = (money) => {
  if (money.state === 'due') {
    return `<div style="font-size:14px;font-weight:800;color:#C62828;">Amount to pay: ${rupees(money.balance)}</div>`;
  }
  if (money.state === 'paid') {
    return '<div style="font-size:13px;font-weight:800;color:#2E7D32;">PREPAID</div>';
  }
  return '';
};

const buildCopyHtml = ({ sale, shopName, isDelivery, money, isShopCopy }) => {
  const recipientName = isDelivery
    ? (sale.receiver_name || sale.receiver_display_name || sale.customer_name || sale.customer_display_name || 'Guest')
    : (sale.customer_name || sale.customer_display_name || 'Guest');
  const recipientPhone = isDelivery
    ? (sale.receiver_phone || sale.receiver_display_phone || sale.customer_phone || sale.customer_display_phone || '')
    : (sale.customer_phone || sale.customer_display_phone || '');
  const orderInstructions = sale.special_instructions || sale.customer_notes || '';

  const itemsHtml = (sale.items || []).map((item) => {
    const name = item.display_name || item.product_name || 'Item';
    const instruction = item.special_instructions || '';
    return `
      <tr>
        <td style="padding:4px 6px;border-bottom:1px solid #ddd;">
          <div style="font-weight:600;">${esc(name)}</div>
          ${isShopCopy && instruction ? `<div style="font-size:9px;color:#666;margin-top:2px;">${esc(instruction)}</div>` : ''}
        </td>
        <td style="padding:4px 6px;border-bottom:1px solid #ddd;text-align:center;vertical-align:top;">${esc(item.quantity)}</td>
      </tr>`;
  }).join('');

  return `
    <div style="border:2px solid #333;border-radius:6px;padding:10px 14px;box-sizing:border-box;position:relative;overflow:hidden;page-break-inside:avoid;break-inside:avoid;flex:1;min-height:0;">
      <div style="position:absolute;top:6px;right:10px;font-size:10px;color:#999;font-weight:600;text-transform:uppercase;letter-spacing:1px;">${isShopCopy ? 'Shop Copy' : 'Customer Copy'}</div>
      <div style="text-align:center;margin-bottom:4px;">
        <div style="font-size:16px;font-weight:bold;color:#E91E63;line-height:1.1;">${esc(shopName)}</div>
        ${sale.location_name ? `<div style="font-size:10px;color:#555;line-height:1.1;">${esc(sale.location_name)}</div>` : ''}
        ${sale.location_address ? `<div style="font-size:9px;color:#888;line-height:1.1;">${esc(sale.location_address)}</div>` : ''}
        ${sale.location_phone ? `<div style="font-size:9px;color:#888;line-height:1.1;">Ph: ${esc(sale.location_phone)}</div>` : ''}
      </div>
      <div style="border-top:1px dashed #999;margin:5px 0;"></div>
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:3px;">
        <span style="font-size:14px;font-weight:bold;text-transform:uppercase;letter-spacing:1px;color:#333;">${isDelivery ? 'Delivery Challan' : 'Pickup Slip'}</span>
        <span style="font-size:10px;"><strong>Order:</strong> ${esc(sale.sale_number)} &nbsp; <strong>Date:</strong> ${esc(formatDate(sale.created_at))}</span>
      </div>
      ${isShopCopy ? shopMoneyBlock(money, isDelivery) : ''}
      ${sale.scheduled_date ? `<div style="font-size:11px;margin-bottom:3px;"><strong>${isDelivery ? 'Deliver' : 'Pickup'}:</strong> ${esc(formatCardDateTime(sale.scheduled_date, sale.scheduled_time))}</div>` : ''}
      <div style="font-size:11px;margin-bottom:2px;"><strong>${isDelivery ? 'Recipient' : 'Customer'}:</strong> ${esc(recipientName)}${recipientPhone ? ` • ${esc(recipientPhone)}` : ''}</div>
      ${isDelivery && sale.delivery_address ? `<div style="font-size:11px;margin-bottom:3px;"><strong>Address:</strong> ${esc(sale.delivery_address)}</div>` : ''}
      ${isDelivery && (sale.sender_name || sale.sender_phone) ? `<div style="font-size:10px;margin-bottom:2px;"><strong>Sender:</strong> ${esc(sale.sender_name)}${sale.sender_phone ? ` • ${esc(sale.sender_phone)}` : ''}</div>` : ''}
      ${isDelivery && sale.sender_message ? `<div style="background:#FFF3E0;border-radius:4px;padding:3px 6px;margin:3px 0;font-size:10px;"><strong>Message:</strong> ${esc(sale.sender_message)}</div>` : ''}
      <table style="width:100%;border-collapse:collapse;font-size:10px;margin-top:4px;">
        <thead>
          <tr style="background:#f5f5f5;">
            <th style="padding:3px 4px;text-align:left;border-bottom:2px solid #ddd;">Item</th>
            <th style="padding:3px 4px;text-align:center;border-bottom:2px solid #ddd;">Qty</th>
          </tr>
        </thead>
        <tbody>${itemsHtml}</tbody>
      </table>
      ${isShopCopy && orderInstructions ? `<div style="background:#F5F5F5;border-radius:4px;padding:3px 6px;margin:3px 0;font-size:10px;"><strong>Order Instructions:</strong> ${esc(orderInstructions)}</div>` : ''}
      ${!isShopCopy && customerMoneyLine(money) ? `<div style="border-top:1px dashed #999;margin:5px 0;"></div>${customerMoneyLine(money)}` : ''}
      ${isShopCopy ? `<div style="margin-top:8px;border-top:1px solid #333;padding-top:6px;font-size:10px;display:flex;justify-content:space-between;align-items:flex-end;min-height:44px;"><span>${isDelivery ? "Receiver's Signature" : "Customer's Signature"}</span><span style="border-bottom:1px solid #333;display:inline-block;width:180px;height:18px;"></span></div>` : ''}
    </div>`;
};

export const buildOrderSlipHtml = (sale, shopName = FALLBACK_SHOP_NAME) => {
  // A pre_order fulfilled by delivery has a delivery row but order_type
  // 'pre_order' — the delivery row is the reliable signal.
  const isDelivery = !!sale.delivery || sale.order_type === 'delivery';
  const money = computeSlipMoney(sale);
  const copy = (isShopCopy) => buildCopyHtml({ sale, shopName, isDelivery, money, isShopCopy });
  return `
    <html><head><meta charset="utf-8">
    <style>
      @page { size: A4 portrait; margin: 8mm; }
      html, body { margin: 0; padding: 0; }
      body { font-family: Arial, Helvetica, sans-serif; display: flex; flex-direction: column; gap: 8px; min-height: 100vh; }
    </style></head>
    <body>
      ${copy(true)}
      ${copy(false)}
    </body></html>`;
};

// Fetches the order fresh (never trusts a list row, which lacks items and
// payments) plus the shop name, and prints. Safe to call from any screen.
export const printOrderSlip = async (saleId) => {
  let sale;
  let shopName = FALLBACK_SHOP_NAME;
  try {
    const [saleRes, shopRes] = await Promise.all([
      api.getSale(saleId),
      api.getShopInfo().catch(() => null),
    ]);
    sale = saleRes?.data;
    shopName = shopRes?.data?.shop_name || FALLBACK_SHOP_NAME;
  } catch {
    sale = null;
  }
  if (!sale) {
    showAlert('Could not print', "Couldn't load this order. Check the internet connection and try again.");
    return;
  }
  const isDelivery = !!sale.delivery || sale.order_type === 'delivery';
  await printHtml(buildOrderSlipHtml(sale, shopName), `${isDelivery ? 'Delivery Challan' : 'Pickup Slip'} ${sale.sale_number || ''}`.trim());
};

// Which orders get a print button: anything handed over later (delivery,
// pickup, or a pre_order). A walk_in leaves with the customer — no slip.
export const canPrintOrderSlip = (order) => !!order && order.order_type !== 'walk_in';
