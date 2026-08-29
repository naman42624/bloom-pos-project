/* eslint-disable no-console */
require('dotenv').config();

const BASE_URL = process.env.API_BASE_URL || 'http://localhost:3001';
const OWNER_PHONE = process.env.SMOKE_OWNER_PHONE || '9876453210';
const OWNER_PASSWORD = process.env.SMOKE_OWNER_PASSWORD || 'naman1234';

async function request(method, path, { token, body, formData } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (!formData) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: formData || (body ? JSON.stringify(body) : undefined),
  });
  let data;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}

const results = [];
function assert(label, condition) {
  results.push({ label, ok: !!condition });
  if (!condition) console.error(`FAIL: ${label}`);
  else console.log(`PASS: ${label}`);
}

async function main() {
  const loginRes = await request('POST', '/api/auth/login', { body: { phone: OWNER_PHONE, password: OWNER_PASSWORD } });
  const token = loginRes?.data?.data?.token;
  if (!token) throw new Error('Could not login owner user to continue tests');

  // ─── Task 1: schema columns exist and accept expected values ───
  const locRes = await request('GET', '/api/locations', { token });
  const locationId = locRes?.data?.data?.locations?.[0]?.id;
  assert('Task 1: at least one location exists to test against', !!locationId);

  // ─── Task 2: attachment upload + list ───
  const draftSaleRes = await request('GET', '/api/sales?limit=1', { token });
  const anySaleId = draftSaleRes?.data?.data?.sales?.[0]?.id;
  assert('Task 2: at least one sale exists to attach to', !!anySaleId);

  if (anySaleId) {
    const fd = new FormData();
    fd.append('type', 'voice_note');
    fd.append('duration_seconds', '12');
    fd.append('file', new Blob(['fake-audio-bytes'], { type: 'audio/m4a' }), 'note.m4a');
    const uploadRes = await request('POST', `/api/sales/${anySaleId}/attachments`, { token, formData: fd });
    assert('Task 2: attachment upload succeeds', uploadRes.status === 201 && uploadRes.data?.data?.type === 'voice_note');

    const listRes = await request('GET', `/api/sales/${anySaleId}/attachments`, { token });
    assert('Task 2: attachment list includes the uploaded note', listRes.status === 200 && listRes.data?.data?.some((a) => a.type === 'voice_note'));
  }

  // ─── Task 3: channel/priority on sale creation ───
  const productsRes = await request('GET', '/api/products?limit=1', { token });
  const anyProductId = productsRes?.data?.data?.[0]?.id;
  if (anyProductId && locationId) {
    const createRes = await request('POST', '/api/sales', {
      token,
      body: {
        location_id: locationId,
        order_type: 'pickup',
        channel: 'whatsapp',
        priority: 'rush',
        items: [{ product_id: anyProductId, quantity: 1, unit_price: 100 }],
      },
    });
    assert('Task 3: sale creation accepts channel + priority', createRes.status === 201);
    assert('Task 3: created sale echoes channel=whatsapp', createRes.data?.data?.channel === 'whatsapp');
    assert('Task 3: created sale echoes priority=rush', createRes.data?.data?.priority === 'rush');
  }

  // ─── Task 4: list filtering by channel/priority ───
  const byChannelRes = await request('GET', '/api/sales?channel=whatsapp', { token });
  assert('Task 4: channel filter returns only whatsapp sales', byChannelRes.status === 200 &&
    byChannelRes.data?.data?.sales?.length > 0 &&
    byChannelRes.data.data.sales.every((s) => s.channel === 'whatsapp'));

  const byPriorityRes = await request('GET', '/api/sales?priority=rush', { token });
  assert('Task 4: priority filter returns only rush sales', byPriorityRes.status === 200 &&
    byPriorityRes.data?.data?.sales?.length > 0 &&
    byPriorityRes.data.data.sales.every((s) => s.priority === 'rush'));

  // ─── Task 5: sale detail includes attachments ───
  if (anySaleId) {
    const detailRes = await request('GET', `/api/sales/${anySaleId}`, { token });
    assert('Task 5: sale detail includes attachments array', Array.isArray(detailRes.data?.data?.attachments) && detailRes.data.data.attachments.length > 0);
  }

  // ─── Task 6: edit history covers item price changes ───
  // Uses a disposable sale created just for this check (not an arbitrary pre-existing
  // sale from the list endpoint) so the check never mutates a real order's price.
  if (anyProductId && locationId) {
    const disposableSaleRes = await request('POST', '/api/sales', {
      token,
      body: {
        location_id: locationId,
        order_type: 'pickup',
        items: [{ product_id: anyProductId, quantity: 1, unit_price: 100 }],
      },
    });
    const disposableSaleId = disposableSaleRes?.data?.data?.id;
    const firstItem = disposableSaleRes?.data?.data?.items?.[0];
    assert('Task 6: disposable sale created for edit test', disposableSaleRes.status === 201 && !!disposableSaleId && !!firstItem);

    if (disposableSaleId && firstItem) {
      const newPrice = Number(firstItem.unit_price) + 5;
      const editRes = await request('PUT', `/api/sales/${disposableSaleId}`, {
        token,
        body: { items: [{ id: firstItem.id, unit_price: newPrice }] },
      });
      assert('Task 6: item price edit accepted', editRes.status === 200);

      const auditRes = await request('GET', `/api/sales/${disposableSaleId}/audit-logs`, { token });
      const latest = auditRes.data?.data?.[0];
      assert('Task 6: audit log captured item change', !!latest && JSON.stringify(latest.new_state).includes(String(newPrice)));
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
