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

const INVOICE_LAYOUTS = ['a4', 'compact', 'thermal', 'color', 'classic'];
const STORE_FIELDS = 'id, name, phone, address, gst_number, email, shop_timing, open_days, bill_terms, bill_note, invoice_prefix, default_invoice_layout, is_active';

const LEGACY_STORE_FIELDS = 'id, name, phone, address, gst_number, default_invoice_layout, is_active';
const MIGRATION_HINT = 'Database update needed: run supabase/008_color_bill_format.sql and supabase/009_customer_details_and_line_discount.sql in Supabase.';

// Postgres "undefined_column" — 008 not applied yet.
function isMissingColumn(error) {
  return !!error && (error.code === '42703' || /column .* does not exist/i.test(error.message || ''));
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PREFIX_RE = /^[A-Za-z0-9_/-]{0,10}$/;

// Trims a single-line text field; empty -> null.
function cleanLine(value, maxLen) {
  if (value === undefined || value === null) return null;
  const v = String(value).replace(/\s+/g, ' ').trim().slice(0, maxLen);
  return v || null;
}

// Multiline terms: trims each line, drops blank lines, caps line count/length.
function cleanTerms(value) {
  if (value === undefined || value === null) return null;
  const lines = String(value)
    .split(/\r?\n/)
    .map((l) => l.trim().slice(0, 200))
    .filter(Boolean)
    .slice(0, 12);
  return lines.length ? lines.join('\n') : null;
}

router.get('/', asyncHandler(async (req, res) => {
  let { data, error } = await supabase
    .from('stores')
    .select(STORE_FIELDS)
    .eq('id', req.storeId)
    .single();
  if (isMissingColumn(error)) {
    ({ data, error } = await supabase
      .from('stores')
      .select(LEGACY_STORE_FIELDS)
      .eq('id', req.storeId)
      .single());
  }
  if (error) throw httpError(500, error.message);
  res.json(data);
}));

router.put('/', requireOwner, asyncHandler(async (req, res) => {
  const {
    gst_number, phone, address, default_invoice_layout,
    email, shop_timing, open_days, bill_terms, bill_note, invoice_prefix
  } = req.body;
  if (default_invoice_layout !== undefined && !INVOICE_LAYOUTS.includes(default_invoice_layout)) {
    throw httpError(400, `Invoice layout must be one of: ${INVOICE_LAYOUTS.join(', ')}`);
  }
  const cleanEmail = cleanLine(email, 120);
  if (cleanEmail && !EMAIL_RE.test(cleanEmail)) {
    throw httpError(400, 'Please enter a valid shop email address');
  }

  let cleanPrefix;
  if (invoice_prefix !== undefined) {
    cleanPrefix = String(invoice_prefix ?? '').trim();
    if (!PREFIX_RE.test(cleanPrefix)) {
      throw httpError(400, 'Bill number prefix can be up to 10 letters, digits, "-", "_" or "/"');
    }
  }

  const payload = {
    gst_number: gst_number && String(gst_number).trim() ? String(gst_number).trim().toUpperCase() : null,
    phone: phone && String(phone).trim() ? String(phone).trim().slice(0, 30) : null,
    address: address && String(address).trim() ? String(address).trim().slice(0, 300) : null
  };
  // Bill-format fields are only touched when sent, so older clients can't wipe them.
  if (email !== undefined) payload.email = cleanEmail;
  if (shop_timing !== undefined) payload.shop_timing = cleanLine(shop_timing, 80);
  if (open_days !== undefined) payload.open_days = cleanLine(open_days, 80);
  if (bill_terms !== undefined) payload.bill_terms = cleanTerms(bill_terms);
  if (bill_note !== undefined) payload.bill_note = cleanLine(bill_note, 300);
  if (invoice_prefix !== undefined) payload.invoice_prefix = cleanPrefix;
  if (default_invoice_layout !== undefined) {
    payload.default_invoice_layout = default_invoice_layout;
  }

  const { data, error } = await supabase
    .from('stores')
    .update(payload)
    .eq('id', req.storeId)
    .select(STORE_FIELDS)
    .single();
  if (isMissingColumn(error) || (error && error.code === '23514' && /invoice_layout|invoice_prefix/.test(error.message || ''))) {
    throw httpError(500, MIGRATION_HINT);
  }
  if (error) throw httpError(500, error.message);
  res.json(data);
}));

module.exports = router;
