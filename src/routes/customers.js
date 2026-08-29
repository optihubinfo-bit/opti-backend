const express = require('express');
const supabase = require('../supabaseClient');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

router.get('/', asyncHandler(async (req, res) => {
  const { search } = req.query;
  let query = supabase.from('customers').select('*').order('name', { ascending: true });
  if (search && search.trim()) {
    const term = search.trim().replace(/[%,]/g, '');
    query = query.or(`name.ilike.%${term}%,phone.ilike.%${term}%,email.ilike.%${term}%`);
  }
  const { data, error } = await query;
  if (error) throw httpError(500, error.message);
  res.json(data);
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from('customers').select('*').eq('id', req.params.id).single();
  if (error) throw httpError(404, 'Customer not found');
  res.json(data);
}));

router.post('/', asyncHandler(async (req, res) => {
  const { name, phone, email, address } = req.body;
  if (!name || !name.trim()) throw httpError(400, 'Customer name is required');

  const payload = {
    name: name.trim(),
    phone: phone && String(phone).trim() ? String(phone).trim() : null,
    email: email && String(email).trim() ? String(email).trim() : null,
    address: address && String(address).trim() ? String(address).trim() : null
  };

  const { data, error } = await supabase.from('customers').insert(payload).select().single();
  if (error) throw httpError(500, error.message);
  res.status(201).json(data);
}));

router.put('/:id', asyncHandler(async (req, res) => {
  const { name, phone, email, address } = req.body;
  if (!name || !name.trim()) throw httpError(400, 'Customer name is required');

  const payload = {
    name: name.trim(),
    phone: phone && String(phone).trim() ? String(phone).trim() : null,
    email: email && String(email).trim() ? String(email).trim() : null,
    address: address && String(address).trim() ? String(address).trim() : null
  };

  const { data, error } = await supabase.from('customers').update(payload).eq('id', req.params.id).select().single();
  if (error) throw httpError(500, error.message);
  if (!data) throw httpError(404, 'Customer not found');
  res.json(data);
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const { error } = await supabase.from('customers').delete().eq('id', req.params.id);
  if (error) throw httpError(500, error.message);
  res.status(204).send();
}));

module.exports = router;
