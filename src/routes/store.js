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

router.get('/', asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from('stores')
    .select('id, name, gst_number, is_active')
    .eq('id', req.storeId)
    .single();
  if (error) throw httpError(500, error.message);
  res.json(data);
}));

router.put('/', requireOwner, asyncHandler(async (req, res) => {
  const { gst_number } = req.body;
  const payload = {
    gst_number: gst_number && String(gst_number).trim() ? String(gst_number).trim().toUpperCase() : null
  };

  const { data, error } = await supabase
    .from('stores')
    .update(payload)
    .eq('id', req.storeId)
    .select('id, name, gst_number, is_active')
    .single();
  if (error) throw httpError(500, error.message);
  res.json(data);
}));

module.exports = router;
