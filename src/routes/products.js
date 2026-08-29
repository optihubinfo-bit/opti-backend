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
  let query = supabase.from('products').select('*').order('name', { ascending: true });
  if (search && search.trim()) {
    const term = search.trim().replace(/[%,]/g, '');
    query = query.or(`name.ilike.%${term}%,sku.ilike.%${term}%`);
  }
  const { data, error } = await query;
  if (error) throw httpError(500, error.message);
  res.json(data);
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from('products').select('*').eq('id', req.params.id).single();
  if (error) throw httpError(404, 'Product not found');
  res.json(data);
}));

router.post('/', asyncHandler(async (req, res) => {
  const { name, sku, category, unit, price, cost, quantity, low_stock_threshold } = req.body;
  if (!name || !name.trim()) throw httpError(400, 'Product name is required');
  if (price === undefined || price === null || Number.isNaN(Number(price)) || Number(price) < 0) {
    throw httpError(400, 'Valid price is required');
  }
  if (quantity === undefined || quantity === null || Number.isNaN(Number(quantity)) || Number(quantity) < 0) {
    throw httpError(400, 'Valid quantity is required');
  }

  const payload = {
    name: name.trim(),
    sku: sku && String(sku).trim() ? String(sku).trim() : null,
    category: category && String(category).trim() ? String(category).trim() : null,
    unit: unit && String(unit).trim() ? String(unit).trim() : 'pcs',
    price: Number(price),
    cost: cost ? Number(cost) : 0,
    quantity: Number(quantity),
    low_stock_threshold: low_stock_threshold !== undefined && low_stock_threshold !== null && low_stock_threshold !== ''
      ? Number(low_stock_threshold)
      : 5
  };

  const { data, error } = await supabase.from('products').insert(payload).select().single();
  if (error) {
    if (error.code === '23505') throw httpError(409, 'A product with this SKU already exists');
    throw httpError(500, error.message);
  }
  res.status(201).json(data);
}));

router.put('/:id', asyncHandler(async (req, res) => {
  const { name, sku, category, unit, price, cost, quantity, low_stock_threshold } = req.body;
  if (!name || !name.trim()) throw httpError(400, 'Product name is required');
  if (price === undefined || price === null || Number.isNaN(Number(price)) || Number(price) < 0) {
    throw httpError(400, 'Valid price is required');
  }
  if (quantity === undefined || quantity === null || Number.isNaN(Number(quantity)) || Number(quantity) < 0) {
    throw httpError(400, 'Valid quantity is required');
  }

  const payload = {
    name: name.trim(),
    sku: sku && String(sku).trim() ? String(sku).trim() : null,
    category: category && String(category).trim() ? String(category).trim() : null,
    unit: unit && String(unit).trim() ? String(unit).trim() : 'pcs',
    price: Number(price),
    cost: cost ? Number(cost) : 0,
    quantity: Number(quantity),
    low_stock_threshold: low_stock_threshold !== undefined && low_stock_threshold !== null && low_stock_threshold !== ''
      ? Number(low_stock_threshold)
      : 5,
    updated_at: new Date().toISOString()
  };

  const { data, error } = await supabase.from('products').update(payload).eq('id', req.params.id).select().single();
  if (error) {
    if (error.code === '23505') throw httpError(409, 'A product with this SKU already exists');
    throw httpError(500, error.message);
  }
  if (!data) throw httpError(404, 'Product not found');
  res.json(data);
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const { error } = await supabase.from('products').delete().eq('id', req.params.id);
  if (error) throw httpError(500, error.message);
  res.status(204).send();
}));

module.exports = router;
