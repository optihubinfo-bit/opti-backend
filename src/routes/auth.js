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

// Public: tells the frontend whether to show "create owner account" or "sign in".
router.get('/bootstrap-status', asyncHandler(async (req, res) => {
  const { count, error } = await supabase.from('profiles').select('id', { count: 'exact', head: true });
  if (error) throw httpError(500, error.message);
  res.json({ ownerExists: (count || 0) > 0 });
}));

// Public, but only works once: creates the first (owner) account for a fresh deployment.
router.post('/bootstrap', asyncHandler(async (req, res) => {
  const { email, password, full_name } = req.body;
  if (!email || !email.trim()) throw httpError(400, 'Email is required');
  if (!password || password.length < 8) throw httpError(400, 'Password must be at least 8 characters');

  const { count, error: countError } = await supabase.from('profiles').select('id', { count: 'exact', head: true });
  if (countError) throw httpError(500, countError.message);
  if ((count || 0) > 0) throw httpError(403, 'An owner account already exists. Please sign in instead.');

  const { data, error } = await supabase.auth.admin.createUser({
    email: email.trim(),
    password,
    email_confirm: true,
    user_metadata: { full_name: full_name && full_name.trim() ? full_name.trim() : null }
  });
  if (error) throw httpError(400, error.message);

  res.status(201).json({ id: data.user.id, email: data.user.email });
}));

router.get('/me', requireAuth, asyncHandler(async (req, res) => {
  res.json(req.user);
}));

module.exports = router;
