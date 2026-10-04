const express = require('express');
const supabase = require('../supabaseClient');
const asyncHandler = require('../utils/asyncHandler');
const { requireOwner, requireStoreUser } = require('../middleware/auth');

const router = express.Router();

router.use(requireStoreUser);

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function optionalText(value, maxLen) {
  if (value === undefined || value === null) return null;
  const str = String(value).trim();
  return str ? str.slice(0, maxLen) : null;
}

function parseAge(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 130) throw httpError(400, 'Age must be a whole number between 0 and 130');
  return n;
}

// Accepts 'YYYY-MM-DD' (from <input type="date">); must be a real, non-future date.
function parseBirthDate(value) {
  if (value === undefined || value === null || value === '') return null;
  const str = String(value).trim();
  const d = new Date(`${str}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== str) {
    throw httpError(400, 'Birth date must be a valid date');
  }
  if (d.getTime() > Date.now()) throw httpError(400, 'Birth date cannot be in the future');
  if (d.getUTCFullYear() < 1900) throw httpError(400, 'Birth date must be after 1900');
  return str;
}

// GSTIN is 15 letters/digits. Spaces are stripped and it's stored in upper case.
function parseGstNumber(value) {
  const str = optionalText(value, 30);
  if (!str) return null;
  const gst = str.replace(/\s+/g, '').toUpperCase();
  if (!/^[0-9A-Z]{15}$/.test(gst)) throw httpError(400, 'Customer GST number must be 15 letters/digits');
  return gst;
}

function customerPayload(body) {
  const { name, phone, email, address, age, birth_date, gst_number } = body;
  if (!name || !String(name).trim()) throw httpError(400, 'Customer name is required');
  return {
    name: String(name).trim().slice(0, 120),
    phone: optionalText(phone, 30),
    email: optionalText(email, 120),
    address: optionalText(address, 300),
    age: parseAge(age),
    birth_date: parseBirthDate(birth_date),
    gst_number: parseGstNumber(gst_number)
  };
}

router.get('/', asyncHandler(async (req, res) => {
  const { search } = req.query;
  let query = supabase.from('customers').select('*').eq('store_id', req.storeId).order('name', { ascending: true });
  if (search && search.trim()) {
    const term = search.trim().replace(/[%,()]/g, '');
    // A plain number also matches the customer number ("Customer ID" on bills).
    const numberMatch = /^#?\d{1,9}$/.test(term) ? `,customer_number.eq.${term.replace('#', '')}` : '';
    query = query.or(`name.ilike.%${term}%,phone.ilike.%${term}%,email.ilike.%${term}%${numberMatch}`);
  }
  const { data, error } = await query;
  if (error) throw httpError(500, error.message);
  res.json(data);
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from('customers')
    .select('*')
    .eq('id', req.params.id)
    .eq('store_id', req.storeId)
    .single();
  if (error) throw httpError(404, 'Customer not found');
  res.json(data);
}));

router.post('/', asyncHandler(async (req, res) => {
  // customer_number is assigned by the database (per-store sequence), never by the client.
  const payload = { store_id: req.storeId, ...customerPayload(req.body) };

  const { data, error } = await supabase.from('customers').insert(payload).select().single();
  if (error) throw httpError(500, error.message);
  res.status(201).json(data);
}));

router.put('/:id', asyncHandler(async (req, res) => {
  const payload = customerPayload(req.body);

  const { data, error } = await supabase
    .from('customers')
    .update(payload)
    .eq('id', req.params.id)
    .eq('store_id', req.storeId)
    .select()
    .single();
  if (error) {
    if (error.code === 'PGRST116') throw httpError(404, 'Customer not found');
    throw httpError(500, error.message);
  }
  if (!data) throw httpError(404, 'Customer not found');
  res.json(data);
}));

router.delete('/:id', requireOwner, asyncHandler(async (req, res) => {
  const { error } = await supabase.from('customers').delete().eq('id', req.params.id).eq('store_id', req.storeId);
  if (error) throw httpError(500, error.message);
  res.status(204).send();
}));

module.exports = router;
