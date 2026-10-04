const express = require('express');
const supabase = require('../supabaseClient');
const asyncHandler = require('../utils/asyncHandler');
const { requireStoreUser } = require('../middleware/auth');

const router = express.Router();

router.use(requireStoreUser);

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const PAYMENT_METHODS = ['cash', 'card', 'upi', 'other'];

function cleanStr(value, maxLen) {
  if (value === undefined || value === null) return '';
  return String(value).trim().slice(0, maxLen);
}

// Keeps only the known prescription fields and returns null if nothing was actually filled in.
// Shape mirrors a standard optical prescription pad: Distance + Near + Addition per eye, plus PD.
function normalizePrescription(prescription) {
  if (!prescription || typeof prescription !== 'object') return null;

  const measurement = (m) => ({
    sph: cleanStr(m?.sph, 20),
    cyl: cleanStr(m?.cyl, 20),
    axis: cleanStr(m?.axis, 20)
  });

  const eye = (e) => ({
    distance: measurement(e?.distance),
    near: measurement(e?.near),
    addition: cleanStr(e?.addition, 20),
    va: cleanStr(e?.va, 20) // visual acuity, e.g. 6/6
  });

  const result = {
    right: eye(prescription.right),
    left: eye(prescription.left),
    pdMode: prescription.pdMode === 'split' ? 'split' : 'single',
    pd: cleanStr(prescription.pd, 20),
    pdRight: cleanStr(prescription.pdRight, 20),
    pdLeft: cleanStr(prescription.pdLeft, 20),
    notes: cleanStr(prescription.notes, 500)
  };

  const hasValue = [
    result.right.distance.sph, result.right.distance.cyl, result.right.distance.axis, result.right.addition, result.right.va,
    result.right.near.sph, result.right.near.cyl, result.right.near.axis,
    result.left.distance.sph, result.left.distance.cyl, result.left.distance.axis, result.left.addition, result.left.va,
    result.left.near.sph, result.left.near.cyl, result.left.near.axis,
    result.pd, result.pdRight, result.pdLeft, result.notes
  ].some((v) => v !== '');

  return hasValue ? result : null;
}

// Store + customer fields printed on invoices. The extra fields come from
// 008_color_bill_format.sql and 009_customer_details_and_line_discount.sql; the
// LEGACY set is a fallback so invoices keep loading if those haven't been run yet
// (the Color/Classic bills just show fewer details).
const FIELDS = {
  store: 'name, phone, address, gst_number, email, shop_timing, open_days, bill_terms, bill_note',
  customer: 'id, name, phone, email, address, age, birth_date, gst_number, customer_number'
};
const LEGACY_FIELDS = {
  store: 'name, phone, address, gst_number',
  customer: 'id, name, phone, email, address'
};

const invoiceSelect = (f) => `*, customers(${f.customer}), stores(${f.store})`;

// Postgres "undefined_column" — raised when 008/009 haven't been applied yet.
function isMissingColumn(error) {
  return !!error && (error.code === '42703' || /column .* does not exist/i.test(error.message || ''));
}

// Runs buildQuery(fields) with the full field lists, retrying with the
// legacy lists if the new columns don't exist yet.
async function withFields(buildQuery) {
  const result = await buildQuery(FIELDS);
  if (isMissingColumn(result.error)) return buildQuery(LEGACY_FIELDS);
  return result;
}

async function fetchStore(storeId) {
  const { data } = await withFields((f) =>
    supabase.from('stores').select(f.store).eq('id', storeId).single()
  );
  return data;
}

async function fetchCustomer(customerId, storeId) {
  if (!customerId) return null;
  const { data } = await withFields((f) =>
    supabase.from('customers').select(f.customer).eq('id', customerId).eq('store_id', storeId).single()
  );
  return data;
}

// Item discount % for a cart line: blank -> 0, otherwise 0..100.
function parseLineDiscount(value) {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(value);
  if (Number.isNaN(n) || n < 0 || n > 100) throw httpError(400, 'Item discount must be between 0 and 100 percent');
  return Math.round(n * 100) / 100;
}

// Accepts 'YYYY-MM-DD' (from <input type="date">); anything else -> null.
function parseDeliveryDate(value) {
  if (value === undefined || value === null || value === '') return null;
  const str = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) throw httpError(400, 'Delivery date must be a valid date');
  const d = new Date(`${str}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== str) {
    throw httpError(400, 'Delivery date must be a valid date');
  }
  return str;
}

router.get('/', asyncHandler(async (req, res) => {
  const { search } = req.query;
  const { data, error } = await withFields((f) => {
    let query = supabase
      .from('invoices')
      .select(invoiceSelect(f))
      .eq('store_id', req.storeId)
      .order('created_at', { ascending: false });
    if (search && search.trim()) {
      query = query.ilike('invoice_number', `%${search.trim()}%`);
    }
    return query;
  });
  if (error) throw httpError(500, error.message);
  res.json(data);
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const { data: invoice, error } = await withFields((f) =>
    supabase
      .from('invoices')
      .select(invoiceSelect(f))
      .eq('id', req.params.id)
      .eq('store_id', req.storeId)
      .single()
  );
  if (error) throw httpError(404, 'Invoice not found');

  const { data: items, error: itemsError } = await supabase
    .from('invoice_items')
    .select('*')
    .eq('invoice_id', req.params.id);
  if (itemsError) throw httpError(500, itemsError.message);

  const { data: payments, error: paymentsError } = await supabase
    .from('invoice_payments')
    .select('*')
    .eq('invoice_id', req.params.id)
    .order('created_at', { ascending: true });
  if (paymentsError) throw httpError(500, paymentsError.message);

  res.json({ ...invoice, items, payments });
}));

router.post('/', asyncHandler(async (req, res) => {
  const { customer_id, items, discount, tax_percent, payment_method, amount_paid, is_gst_invoice, prescription, delivery_date } = req.body;
  const deliveryDate = parseDeliveryDate(delivery_date);

  if (!Array.isArray(items) || items.length === 0) {
    throw httpError(400, 'Invoice must include at least one item');
  }
  for (const item of items) {
    if (!item.product_id) throw httpError(400, 'Each item requires a product_id');
    if (!item.quantity || Number(item.quantity) <= 0) throw httpError(400, 'Each item requires a valid quantity');
  }

  const method = PAYMENT_METHODS.includes(payment_method) ? payment_method : 'cash';
  const applyGst = is_gst_invoice === true;

  const discountNum = discount !== undefined && discount !== null && discount !== '' ? Number(discount) : 0;
  if (Number.isNaN(discountNum) || discountNum < 0) {
    throw httpError(400, 'Discount must be a valid non-negative number');
  }
  const taxPercentNum = tax_percent !== undefined && tax_percent !== null && tax_percent !== '' ? Number(tax_percent) : 0;
  if (Number.isNaN(taxPercentNum) || taxPercentNum < 0) {
    throw httpError(400, 'GST/tax percent must be a valid non-negative number');
  }

  let amountPaid = null; // null = paid in full
  if (amount_paid !== undefined && amount_paid !== null && amount_paid !== '') {
    amountPaid = Number(amount_paid);
    if (Number.isNaN(amountPaid) || amountPaid < 0) {
      throw httpError(400, 'Amount paid must be a valid non-negative number');
    }
  }
  // Whether a deposit below the (server-computed) total requires a customer is enforced
  // by the create_invoice function itself, which is the only place that knows the total.

  const { data, error } = await supabase.rpc('create_invoice', {
    p_store_id: req.storeId,
    p_customer_id: customer_id || null,
    p_items: items.map((i) => ({
      product_id: i.product_id,
      quantity: Number(i.quantity),
      discount_percent: parseLineDiscount(i.discount_percent)
    })),
    p_discount: discountNum,
    p_tax_percent: applyGst ? taxPercentNum : 0,
    p_payment_method: method,
    p_amount_paid: amountPaid,
    p_is_gst_invoice: applyGst,
    p_prescription: normalizePrescription(prescription)
  });

  if (error) throw httpError(400, error.message);

  // delivery_date is set right after creation (rather than via create_invoice) so the
  // RPC signature stays unchanged. Store-scoped; a failure here doesn't undo the sale.
  let invoiceRow = data;
  if (deliveryDate) {
    const { data: updated, error: deliveryError } = await supabase
      .from('invoices')
      .update({ delivery_date: deliveryDate })
      .eq('id', data.id)
      .eq('store_id', req.storeId)
      .select('*')
      .single();
    if (deliveryError) {
      console.error('Failed to set delivery_date on invoice', data.id, deliveryError.message);
    } else if (updated) {
      invoiceRow = updated;
    }
  }

  const { data: fullItems } = await supabase.from('invoice_items').select('*').eq('invoice_id', data.id);
  const customer = await fetchCustomer(data.customer_id, req.storeId);
  const store = await fetchStore(req.storeId);

  res.status(201).json({ ...invoiceRow, items: fullItems || [], customers: customer, stores: store });
}));

router.post('/:id/payments', asyncHandler(async (req, res) => {
  const { amount, method, note } = req.body;
  if (amount === undefined || amount === null || Number.isNaN(Number(amount)) || Number(amount) <= 0) {
    throw httpError(400, 'Valid payment amount is required');
  }
  const cleanMethod = PAYMENT_METHODS.includes(method) ? method : 'cash';

  const { data, error } = await supabase.rpc('record_invoice_payment', {
    p_store_id: req.storeId,
    p_invoice_id: req.params.id,
    p_amount: Number(amount),
    p_method: cleanMethod,
    p_note: note ? cleanStr(note, 300) : null
  });
  if (error) throw httpError(400, error.message);

  const { data: fullItems } = await supabase.from('invoice_items').select('*').eq('invoice_id', req.params.id);
  const { data: payments } = await supabase
    .from('invoice_payments')
    .select('*')
    .eq('invoice_id', req.params.id)
    .order('created_at', { ascending: true });
  const customer = await fetchCustomer(data.customer_id, req.storeId);
  const store = await fetchStore(req.storeId);

  res.json({ ...data, items: fullItems || [], payments: payments || [], customers: customer, stores: store });
}));

module.exports = router;
