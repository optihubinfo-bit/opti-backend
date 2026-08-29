const express = require('express');
const supabase = require('../supabaseClient');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

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
// Store owners are never created here — only the super admin creates those, via /api/stores.
router.post('/bootstrap', asyncHandler(async (req, res) => {
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
      full_name: full_name && full_name.trim() ? full_name.trim() : null,
      role: 'super_admin',
      store_id: null
    }
  });
  if (error) throw httpError(400, error.message);

  res.status(201).json({ id: data.user.id, email: data.user.email });
}));

router.get('/me', requireAuth, asyncHandler(async (req, res) => {
  res.json(req.user);
}));

module.exports = router;
