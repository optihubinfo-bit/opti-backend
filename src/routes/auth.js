const express = require('express');
const supabase = require('../supabaseClient');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth } = require('../middleware/auth');
const rateLimit = require('../middleware/rateLimit');

const router = express.Router();

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// role/store_id are set via app_metadata (raw_app_meta_data), never user_metadata —
// only the service-role Admin API used here can set app_metadata; a client calling
// supabase.auth.signUp()/updateUser() directly with the public anon key cannot touch
// it. The database trigger (handle_new_user, see supabase/006_security_hardening.sql)
// reads role/store_id from app_metadata for exactly this reason: it closes off
// self-signup privilege escalation to owner/super_admin.
const accountCreationLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, name: 'account-creation' });

// Public: tells the frontend whether to show "create super admin account" or "sign in".
router.get('/bootstrap-status', asyncHandler(async (req, res) => {
  const { count, error } = await supabase
    .from('profiles')
    .select('id', { count: 'exact', head: true })
    .eq('role', 'super_admin');
  if (error) throw httpError(500, error.message);
  res.json({ superAdminExists: (count || 0) > 0 });
}));

// Public, but only works once: creates the platform's one super admin account.
router.post('/bootstrap', accountCreationLimiter, asyncHandler(async (req, res) => {
  const { email, password, full_name } = req.body;
  if (!email || !email.trim()) throw httpError(400, 'Email is required');
  if (!password || password.length < 8) throw httpError(400, 'Password must be at least 8 characters');

  const { count, error: countError } = await supabase
    .from('profiles')
    .select('id', { count: 'exact', head: true })
    .eq('role', 'super_admin');
  if (countError) throw httpError(500, countError.message);
  if ((count || 0) > 0) throw httpError(403, 'A super admin account already exists. Please sign in instead.');

  const { data, error } = await supabase.auth.admin.createUser({
    email: email.trim(),
    password,
    email_confirm: true,
    user_metadata: {
      full_name: full_name && full_name.trim() ? full_name.trim() : null
    },
    app_metadata: {
      role: 'super_admin',
      store_id: null
    }
  });
  if (error) throw httpError(400, error.message);

  res.status(201).json({ id: data.user.id, email: data.user.email });
}));

// Public: lets a store owner sign themselves up without a super admin creating the
// store first. Creates a brand-new store + its owner account in one step — same
// shape as POST /api/stores (super-admin-only), just without that gate, since a
// self-registering owner can only ever create their OWN new store/account, never
// touch an existing one.
router.post('/register-store', accountCreationLimiter, asyncHandler(async (req, res) => {
  const { store_name, email, password, full_name } = req.body;
  if (!store_name || !store_name.trim()) throw httpError(400, 'Store name is required');
  if (!email || !email.trim()) throw httpError(400, 'Email is required');
  if (!password || password.length < 8) throw httpError(400, 'Password must be at least 8 characters');

  const { data: store, error: storeError } = await supabase
    .from('stores')
    .insert({ name: store_name.trim() })
    .select()
    .single();
  if (storeError) throw httpError(500, storeError.message);

  const { data: authUser, error: authError } = await supabase.auth.admin.createUser({
    email: email.trim(),
    password,
    email_confirm: true,
    user_metadata: {
      full_name: full_name && full_name.trim() ? full_name.trim() : null
    },
    app_metadata: {
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

router.get('/me', requireAuth, asyncHandler(async (req, res) => {
  res.json(req.user);
}));

module.exports = router;
