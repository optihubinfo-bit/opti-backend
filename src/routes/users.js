const express = require('express');
const supabase = require('../supabaseClient');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requireOwner } = require('../middleware/auth');

const router = express.Router();

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

router.use(requireAuth, requireOwner);

router.get('/', asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, email, full_name, role, created_at')
    .order('created_at', { ascending: true });
  if (error) throw httpError(500, error.message);
  res.json(data);
}));

router.post('/', asyncHandler(async (req, res) => {
  const { email, password, full_name, role } = req.body;
  if (!email || !email.trim()) throw httpError(400, 'Email is required');
  if (!password || password.length < 8) throw httpError(400, 'Password must be at least 8 characters');
  const assignedRole = role === 'owner' ? 'owner' : 'staff';

  const { data, error } = await supabase.auth.admin.createUser({
    email: email.trim(),
    password,
    email_confirm: true,
    user_metadata: { full_name: full_name && full_name.trim() ? full_name.trim() : null }
  });
  if (error) {
    if (error.message && error.message.toLowerCase().includes('already')) {
      throw httpError(409, 'A user with this email already exists');
    }
    throw httpError(400, error.message);
  }

  if (assignedRole === 'owner') {
    await supabase.from('profiles').update({ role: 'owner' }).eq('id', data.user.id);
  }

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('id, email, full_name, role, created_at')
    .eq('id', data.user.id)
    .single();
  if (profileError) throw httpError(500, profileError.message);

  res.status(201).json(profile);
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  if (req.params.id === req.user.id) throw httpError(400, "You can't remove your own account");

  const { data: target } = await supabase.from('profiles').select('role').eq('id', req.params.id).single();
  if (target?.role === 'owner') throw httpError(400, 'Cannot remove an owner account');

  const { error } = await supabase.auth.admin.deleteUser(req.params.id);
  if (error) throw httpError(500, error.message);
  res.status(204).send();
}));

module.exports = router;
