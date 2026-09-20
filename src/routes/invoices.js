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
    addition: cleanStr(e?.addition, 20)
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
    result.right.distance.sph, result.right.distance.cyl, result.right.distance.axis, result.right.addition,
    result.right.near.sph, result.right.near.cyl, result.right.near.axis,
    result.left.distance.sph, result.left.distance.cyl, result.left.distance.axis, result.left.addition,
    result.left.near.sph, result.left.near.cyl, result.left.near.axis,
    result.pd, result.pdRight, result.pdLeft, result.notes
  ].some((v) => v !== '');

  return hasValue ? result : null;
}

const INVOICE_SELECT = '*, customers(name, phone), stores(name, phone, address)';
const INVOICE_DETAIL_SELECT = '*, customers(id, name, phone, email, address), stores(name, phone, address)';

router.get('/', asyncHandler(async (req, res) => {
  const { search } = req.query;
  let query = supabase
    .from('invoices')
    .select(INVOICE_SELECT)
    .eq('store_id', req.storeId)
    .order('created_at', { ascending: false });
  if (search && search.trim()) {
    query = query.ilike('invoice_number', `%${search.trim()}%`);
  }
  const { data, error } = await query;
  if (error) throw httpError(500, error.message);
  res.json(data);
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const { data: invoice, error } = await supabase
    .from('invoices')
    .select(INVOICE_DETAIL_SELECT)
    .eq('id', req.params.id)
    .eq('store_id', req.storeId)
    .single();
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
  const { customer_id, items, discount, tax_percent, payment_method, amount_paid, is_gst_invoice, prescription } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    throw httpError(400, 'Invoice must include at least one item');
  }
  for (const item of items) {
    if (!item.product_id) throw httpError(400, 'Each item requires a product_id');
    if (!item.quantity || Number(item.quantity) <= 0) throw httpError(400, 'Each item requires a valid quantity');
  }

  const method = PAYMENT_METHODS.includes(payment_method) ? payment_method : 'cash';
  const applyGst = is_gst_invoice === true;

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
    p_items: items.map((i) => ({ product_id: i.product_id, quantity: Number(i.quantity) })),
    p_discount: discount ? Number(discount) : 0,
    p_tax_percent: applyGst && tax_percent ? Number(tax_percent) : 0,
    p_payment_method: method,
    p_amount_paid: amountPaid,
    p_is_gst_invoice: applyGst,
    p_prescription: normalizePrescription(prescription)
  });

  if (error) throw httpError(400, error.message);

  const { data: fullItems } = await supabase.from('invoice_items').select('*').eq('invoice_id', data.id);
  const { data: customer } = data.customer_id
    ? await supabase.from('customers').select('id, name, phone, email, address').eq('id', data.customer_id).single()
    : { data: null };
  const { data: store } = await supabase.from('stores').select('name, phone, address').eq('id', req.storeId).single();

  res.status(201).json({ ...data, items: fullItems || [], customers: customer, stores: store });
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
  const { data: customer } = data.customer_id
    ? await supabase.from('customers').select('id, name, phone, email, address').eq('id', data.customer_id).single()
    : { data: null };
  const { data: store } = await supabase.from('stores').select('name, phone, address').eq('id', req.storeId).single();

  res.json({ ...data, items: fullItems || [], payments: payments || [], customers: customer, stores: store });
}));

module.exports = router;
