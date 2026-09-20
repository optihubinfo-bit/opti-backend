const express = require('express');
const supabase = require('../supabaseClient');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requireOwner, requireStoreUser } = require('../middleware/auth');

const router = express.Router();

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

router.use(requireAuth, requireStoreUser);

const INVOICE_LAYOUTS = ['a4', 'compact', 'thermal'];
const STORE_FIELDS = 'id, name, phone, address, gst_number, default_invoice_layout, is_active';

router.get('/', asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from('stores')
    .select(STORE_FIELDS)
    .eq('id', req.storeId)
    .single();
  if (error) throw httpError(500, error.message);
  res.json(data);
}));

router.put('/', requireOwner, asyncHandler(async (req, res) => {
  const { gst_number, phone, address, default_invoice_layout } = req.body;
  if (default_invoice_layout !== undefined && !INVOICE_LAYOUTS.includes(default_invoice_layout)) {
    throw httpError(400, `Invoice layout must be one of: ${INVOICE_LAYOUTS.join(', ')}`);
  }

  const payload = {
    gst_number: gst_number && String(gst_number).trim() ? String(gst_number).trim().toUpperCase() : null,
    phone: phone && String(phone).trim() ? String(phone).trim().slice(0, 30) : null,
    address: address && String(address).trim() ? String(address).trim().slice(0, 300) : null
  };
  if (default_invoice_layout !== undefined) {
    payload.default_invoice_layout = default_invoice_layout;
  }

  const { data, error } = await supabase
    .from('stores')
    .update(payload)
    .eq('id', req.storeId)
    .select(STORE_FIELDS)
    .single();
  if (error) throw httpError(500, error.message);
  res.json(data);
}));

module.exports = router;
