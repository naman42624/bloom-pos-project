import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { Platform, Alert } from 'react-native';
import { formatDateTime, formatDate, formatCardDateTime } from './datetime';

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
    Alert.alert('Error', 'Could not generate print document');
  }
};

const buildCopyHtml = (copyTitle, showInstructions, isPickup, order, items) => {
  const shopName = 'Flower Point';
  const locationName = 'Shop no.1, plot, No.678, Mall Rd, Model Town, Jalandhar,';
  const locationAddress = 'Punjab 144003';
  const locationPhone = '+91 9915574333, 0181-5072000';
  const orderNo = order.sale_number || '';
  const date = formatDate(order.created_at);
  const customerName = isPickup 
    ? (order.customer_name || order.customer_display_name || 'Guest') 
    : (order.receiver_name || order.receiver_display_name || order.customer_name || order.customer_display_name || 'Guest');
  const customerPhone = isPickup 
    ? (order.customer_phone || order.customer_display_phone || '') 
    : (order.receiver_phone || order.receiver_display_phone || order.customer_phone || order.customer_display_phone || '');
  const address = order.delivery_address || '';
  const senderName = order.sender_name || '';
  const senderPhone = order.sender_phone || '';
  const senderMessage = order.sender_message || '';
  const orderInstructions = order.notes || order.order_special_instructions || order.special_instructions || '';
  const scheduledDate = order.scheduled_date || '';
  const scheduledTime = order.scheduled_time || '';
  
  const itemsHtml = (items || []).map((item) => {
    const itemInstruction = item.item_special_instructions || item.special_instructions || item.customization || item.note || '';
    return `
      <tr>
        <td style="padding:4px 6px;border-bottom:1px solid #ddd;">
          <div style="font-weight:600;">${item.product_name || item.item_product_name || item.name || item.display_name || 'Item'}</div>
          ${showInstructions && itemInstruction ? `<div style="font-size:9px;color:#666;margin-top:2px;">${itemInstruction}</div>` : ''}
        </td>
        <td style="padding:4px 6px;border-bottom:1px solid #ddd;text-align:center;vertical-align:top;">${item.quantity}</td>
      </tr>
    `;
  }).join('');

  // Determine amount due
  let dueAmt = 0;
  if (order.payment_status !== 'paid' && order.is_credit_sale !== 1) {
      dueAmt = Math.max((order.grand_total || 0) - (order.total_paid || order.amount_paid || 0), 0);
  }
  const codAmt = Number(dueAmt).toFixed(0);

  return `
    <div style="border:2px solid #333;border-radius:6px;padding:10px 14px;box-sizing:border-box;position:relative;overflow:hidden;page-break-inside:avoid;break-inside:avoid;flex:1;min-height:0;">
      <div style="position:absolute;top:6px;right:10px;font-size:10px;color:#999;font-weight:600;text-transform:uppercase;letter-spacing:1px;">${copyTitle}</div>
      <div style="text-align:center;margin-bottom:4px;">
        <div style="font-size:16px;font-weight:bold;color:#E91E63;line-height:1.1;">${shopName}</div>
        ${locationName ? `<div style="font-size:10px;color:#555;line-height:1.1;">${locationName}</div>` : ''}
        ${locationAddress ? `<div style="font-size:9px;color:#888;line-height:1.1;">${locationAddress}</div>` : ''}
        ${locationPhone ? `<div style="font-size:9px;color:#888;line-height:1.1;">Ph: ${locationPhone}</div>` : ''}
      </div>
      <div style="border-top:1px dashed #999;margin:5px 0;"></div>
      <div style="text-align:center;font-size:14px;font-weight:bold;text-transform:uppercase;margin-bottom:6px;letter-spacing:1px;color:#333;">
        ${isPickup ? 'PICKUP' : 'DELIVERY'} ORDER
      </div>
      <div style="display:flex;justify-content:space-between;font-size:10px;margin-bottom:3px;">
        <span><strong>Order:</strong> ${orderNo}</span>
        <span><strong>Date:</strong> ${date}</span>
      </div>
      ${scheduledDate ? `<div style="font-size:10px;margin-bottom:3px;"><strong>Scheduled:</strong> ${formatCardDateTime(scheduledDate, scheduledTime)}</div>` : ''}
      <div style="display:flex;gap:12px;font-size:10px;margin-bottom:2px;">
        <div style="flex:1;"><strong>Customer:</strong> ${customerName}${customerPhone ? ' • ' + customerPhone : ''}</div>
      </div>
      ${!isPickup && address ? `<div style="font-size:10px;margin-bottom:3px;"><strong>Address:</strong> ${address}</div>` : ''}
      ${!isPickup && (senderName || senderPhone) ? `<div style="font-size:10px;margin-bottom:2px;"><strong>Sender:</strong> ${senderName}${senderPhone ? ' • ' + senderPhone : ''}</div>` : ''}
      ${!isPickup && senderMessage ? `<div style="background:#FFF3E0;border-radius:4px;padding:3px 6px;margin:3px 0;font-size:10px;"><strong>Message:</strong> ${senderMessage}</div>` : ''}
      <table style="width:100%;border-collapse:collapse;font-size:10px;margin-top:4px;">
        <thead>
          <tr style="background:#f5f5f5;">
            <th style="padding:3px 4px;text-align:left;border-bottom:2px solid #ddd;">Item</th>
            <th style="padding:3px 4px;text-align:center;border-bottom:2px solid #ddd;">Qty</th>
          </tr>
        </thead>
        <tbody>${itemsHtml}</tbody>
      </table>
      ${showInstructions && orderInstructions ? `<div style="background:#F5F5F5;border-radius:4px;padding:3px 6px;margin:3px 0;font-size:10px;"><strong>Order Instructions:</strong> ${orderInstructions}</div>` : ''}
      <div style="border-top:1px dashed #999;margin:5px 0;"></div>
      <div style="display:flex;justify-content:space-between;font-size:11px;font-weight:bold;align-items:flex-end;">
        <div>${order.is_credit_sale === 1 ? '<span style="color:#8B5CF6;">CREDIT SALE</span>' : parseFloat(codAmt) > 0 ? `<span style="color:#E91E63;">DUE: ₹${codAmt}</span>` : '<span style="color:#4CAF50;">PREPAID</span>'}</div>
      </div>
      ${showInstructions ? `<div style="margin-top:8px;border-top:1px solid #333;padding-top:6px;font-size:10px;display:flex;justify-content:space-between;align-items:flex-end;min-height:44px;"><span>${isPickup ? "Customer's Signature" : "Receiver's Signature"}</span><span style="border-bottom:1px solid #333;display:inline-block;width:180px;height:18px;"></span></div>` : ''}
    </div>
  `;
};

export const generateDeliverySlip = async (order, tasksOrItems) => {
  const title = `Delivery Slip - ${order.sale_number}`;
  const html = `
    <html><head><meta charset="utf-8">
    <style>
      @page { size: A4 portrait; margin: 8mm; }
      html, body { margin: 0; padding: 0; }
      body { font-family: Arial, Helvetica, sans-serif; display: flex; flex-direction: column; gap: 8px; min-height: 100vh; }
    </style></head>
    <body>
      ${buildCopyHtml('Shop Copy', true, false, order, tasksOrItems)}
      ${buildCopyHtml('Customer Copy', false, false, order, tasksOrItems)}
    </body></html>
  `;
  await printHtml(html, title);
};

export const generatePickupSlip = async (order, tasksOrItems) => {
  const title = `Pickup Slip - ${order.sale_number}`;
  const html = `
    <html><head><meta charset="utf-8">
    <style>
      @page { size: A4 portrait; margin: 8mm; }
      html, body { margin: 0; padding: 0; }
      body { font-family: Arial, Helvetica, sans-serif; display: flex; flex-direction: column; gap: 8px; min-height: 100vh; }
    </style></head>
    <body>
      ${buildCopyHtml('Shop Copy', true, true, order, tasksOrItems)}
      ${buildCopyHtml('Customer Copy', false, true, order, tasksOrItems)}
    </body></html>
  `;
  await printHtml(html, title);
};
