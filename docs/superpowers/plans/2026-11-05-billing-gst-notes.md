# Phase 2 notes: GST bill (built 2026-11-05, branch fix/cash-register-safety)

User answers (2026-11-05): regular GST (tax invoice, CGST + SGST); shelf prices include GST; delivery charges carry GST at an owner-set rate; owner sets a default HSN and GST rate for custom items and quick tags; invoice number series per financial year, with an option for one series per shop; buyer GSTIN on the bill when the customer has one; credit notes for refunds after a bill; everything per Indian GST rules; printed on a 3-inch (80 mm) thermal roll, not A4; round-off to the nearest rupee.

Fields seen on the two reference invoices the user shared (Blinkit and Zepto tax invoices; their personal details are not copied here):
- Heading "Tax Invoice" (Zepto: "TAX INVOICE/BILL OF SUPPLY").
- Seller: legal name, address with PIN, GSTIN, FSSAI number, optional PAN and CIN.
- Invoice number, order number, invoice date, place of supply as state name and state code (e.g. "PUNJAB (3)").
- Bill to (name, address, state) and ship to.
- One line per item: Sr no, item description, HSN, MRP, discount (amount or %), qty, rate, taxable value, CGST % and amount, SGST % and amount, cess (0), line total.
- Delivery / handling charges as their own taxed line (Blinkit: own line at 5%; Zepto: "inclusive of taxes", tax apportioned by taxable value in an annexure).
- Totals row: taxable value, CGST, SGST, grand total; "Amount in words".
- "Whether tax is payable on reverse charge - No".
- Authorised signatory, terms and conditions, a QR code.

Thermal layout idea (80 mm): seller block, invoice meta, bill-to, then each item on two lines (name + HSN; qty × rate, taxable, GST %, amount), a tax summary grouped by rate (taxable, CGST, SGST), totals, round-off, amount in words, payment, footer.

## Decisions (2026-11-05)
- Layout: two lines per item on the 80 mm roll (owner chose this over the wide table). Item name, qty, rate, amount; then HSN, GST %, line discount; then taxable value, CGST, SGST. Delivery prints as its own line with its SAC (setting `gst_delivery_sac`, default 9968). Totals: Items, Discount, Delivery, Round off, TOTAL, amount in words, rate-wise GST table, "Prices include GST. Reverse charge: No", payments, terms, footer.
- Maths (built, utils/gst.js): discount off the GST-inclusive price, shared over the lines by value; GST worked out on what is left. Stored identity for every sale: grand_total = subtotal - discount_amount + tax_total + delivery_charges + round_off (on GST sales subtotal = items taxable value + discount; tax_total = items GST only; delivery GST in sales.delivery_tax).
- Round-off: setting `bill_round_off`, seeded off; never applied to quick sale, close top-up or helper sales (the sale must equal the money taken).
- Older sales (bill_version NULL) keep their own maths on edit and print as a plain bill, not a tax invoice.
- HSN: on the product form (`products.hsn_code`, 4-8 digits or empty). At Quick Checkout every line shows an HSN box pre-filled from the product, or the owner default (`gst_default_hsn`) for custom items; a changed value is saved on that line only (`sale_items.hsn_code`), never on the product.
- Buyer GSTIN: Quick Checkout "Business bill? Add GSTIN" (one tap deep), 15 characters, checked on the server.
- Shop bill details on the shop form: GSTIN, state, state code (filled from the GSTIN), FSSAI (14 digits), bill number start (up to 5 letters/numbers, unique across shops).
- Owner Settings -> Bill and GST (`BillSettingsScreen`): legal name, PAN, terms, thank-you line, delivery GST % and SAC, custom item GST % and HSN, round-off, bill number start, credit note start, one series for all shops, what prints on the bill. Every value is checked by `PUT /settings` with a plain message.
- Credit notes: a refund on a sale with an invoice number gets a credit note number (`refunds.credit_note_number`, series `credit_note:...`, taken inside the refund transaction). `GET /sales/:id/credit-note` shares the refund over the bill's GST rates by value and splits each share into taxable, CGST, SGST. Sale Details -> Refund box -> "Print credit note" (or "Print refund receipt" for older bills).
- Edit Sale money rules (fixed during the edit-bill check): each payment must be cash/card/UPI above 0 and the total can't be more than the bill; when the paid total changes (Sale Details "mark paid"), status, customer dues and COD follow the money; a status typed alone that the payments don't show is refused ("To take more money use Add Payment. To give money back use Refund."). Before this, marking an unpaid order paid never lowered the customer's dues, and Rs 300 could be recorded on a Rs 236 bill.
- Tests: verify-gst 11/11, verify-gst-sales 21/21, and every earlier suite green. Not checked on screen: the new screens (owner Bill and GST, shop form fields, product HSN, Quick Checkout HSN/GSTIN, credit note print). The browser could not be signed in as a throwaway owner this session.
