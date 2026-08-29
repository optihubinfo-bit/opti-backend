const express = require('express');
const supabase = require('../supabaseClient');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requireSuperAdmin } = require('../middleware/auth');

const router = express.Router();

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

router.use(requireAuth, requireSuperAdmin);

router.get('/', asyncHandler(async (req, res) => {
  const { data: stores, error } = await supabase
    .from('stores')
    .select('id, name, is_active, created_at')
    .order('created_at', { ascending: true });
  if (error) throw httpError(500, error.message);

  const storeIds = stores.map((s) => s.id);
  let owners = [];
  const productCounts = {};
  const invoiceCounts = {};

  if (storeIds.length > 0) {
    const { data: ownerRows } = await supabase
      .from('profiles')
      .select('id, email, full_name, store_id')
      .eq('role', 'owner')
      .in('store_id', storeIds);
    owners = ownerRows || [];

    const { data: products } = await supabase.from('products').select('store_id').in('store_id', storeIds);
    (products || []).forEach((p) => {
      productCounts[p.store_id] = (productCounts[p.store_id] || 0) + 1;
    });

    const { data: invoices } = await supabase.from('invoices').select('store_id').in('store_id', storeIds);
    (invoices || []).forEach((i) => {
      invoiceCounts[i.store_id] = (invoiceCounts[i.store_id] || 0) + 1;
    });
  }

  const result = stores.map((s) => ({
    ...s,
    owner: owners.find((o) => o.store_id === s.id) || null,
    productCount: productCounts[s.id] || 0,
    invoiceCount: invoiceCounts[s.id] || 0
  }));

  res.json(result);
}));

router.post('/', asyncHandler(async (req, res) => {
  const { name, owner_email, owner_password, owner_full_name } = req.body;
  if (!name || !name.trim()) throw httpError(400, 'Store name is required');
  if (!owner_email || !owner_email.trim()) throw httpError(400, 'Owner email is required');
  if (!owner_password || owner_password.length < 8) throw httpError(400, 'Owner password must be at least 8 characters');

  const { data: store, error: storeError } = await supabase
    .from('stores')
    .insert({ name: name.trim() })
    .select()
    .single();
  if (storeError) throw httpError(500, storeError.message);

  const { data: authUser, error: authError } = await supabase.auth.admin.createUser({
    email: owner_email.trim(),
    password: owner_password,
    email_confirm: true,
    user_metadata: {
      full_name: owner_full_name && owner_full_name.trim() ? owner_full_name.trim() : null,
      role: 'owner',
      store_id: store.id
    }
  });
  if (authError) {
    // Don't leave an orphaned store with no owner if account creation fails.
    await supabase.from('stores').delete().eq('id', store.id);
    if (authError.message && authError.message.toLowerCase().includes('already')) {
      throw httpError(409, 'A user with this email already exists');
    }
    throw httpError(400, authError.message);
  }

  res.status(201).json({ store, owner: { id: authUser.user.id, email: authUser.user.email } });
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const { is_active } = req.body;
  if (typeof is_active !== 'boolean') throw httpError(400, 'is_active must be true or false');

  const { data, error } = await supabase
    .from('stores')
    .update({ is_active })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) throw httpError(500, error.message);
  if (!data) throw httpError(404, 'Store not found');
  res.json(data);
}));

module.exports = router;
