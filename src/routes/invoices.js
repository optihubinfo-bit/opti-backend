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
const PAYMENT_STATUSES = ['paid', 'unpaid'];

router.get('/', asyncHandler(async (req, res) => {
  const { search } = req.query;
  let query = supabase
    .from('invoices')
    .select('*, customers(name, phone)')
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
    .select('*, customers(id, name, phone, email, address)')
    .eq('id', req.params.id)
    .eq('store_id', req.storeId)
    .single();
  if (error) throw httpError(404, 'Invoice not found');

  const { data: items, error: itemsError } = await supabase
    .from('invoice_items')
    .select('*')
    .eq('invoice_id', req.params.id);
  if (itemsError) throw httpError(500, itemsError.message);

  res.json({ ...invoice, items });
}));

router.post('/', asyncHandler(async (req, res) => {
  const { customer_id, items, discount, tax_percent, payment_method, payment_status } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    throw httpError(400, 'Invoice must include at least one item');
  }
  for (const item of items) {
    if (!item.product_id) throw httpError(400, 'Each item requires a product_id');
    if (!item.quantity || Number(item.quantity) <= 0) throw httpError(400, 'Each item requires a valid quantity');
  }

  const method = PAYMENT_METHODS.includes(payment_method) ? payment_method : 'cash';
  const status = PAYMENT_STATUSES.includes(payment_status) ? payment_status : 'paid';

  if (status === 'unpaid' && !customer_id) {
    throw httpError(400, 'A customer must be selected for unpaid (credit) invoices');
  }

  const { data, error } = await supabase.rpc('create_invoice', {
    p_store_id: req.storeId,
    p_customer_id: customer_id || null,
    p_items: items.map((i) => ({ product_id: i.product_id, quantity: Number(i.quantity) })),
    p_discount: discount ? Number(discount) : 0,
    p_tax_percent: tax_percent ? Number(tax_percent) : 0,
    p_payment_method: method,
    p_payment_status: status
  });

  if (error) throw httpError(400, error.message);

  const invoiceRow = Array.isArray(data) ? data[0] : data;
  if (!invoiceRow) throw httpError(500, 'Invoice creation returned no data');

  const { data: fullItems } = await supabase.from('invoice_items').select('*').eq('invoice_id', invoiceRow.id);
  const { data: customer } = customer_id
    ? await supabase.from('customers').select('id, name, phone, email, address').eq('id', customer_id).single()
    : { data: null };

  res.status(201).json({ ...invoiceRow, items: fullItems || [], customers: customer });
}));

module.exports = router;
