# Phase 2 notes: GST bill (reference only, not built yet)

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
