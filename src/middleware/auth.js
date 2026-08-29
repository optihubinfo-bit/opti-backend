const supabase = require('../supabaseClient');

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw httpError(401, 'Missing authentication token');

    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) throw httpError(401, 'Invalid or expired session');

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id, email, full_name, role, store_id')
      .eq('id', data.user.id)
      .single();
    if (profileError || !profile) throw httpError(401, 'No profile found for this account');

    req.user = profile;
    next();
  } catch (err) {
    next(err);
  }
}

function requireOwner(req, res, next) {
  if (!req.user || req.user.role !== 'owner') {
    return next(httpError(403, 'Owner access required'));
  }
  next();
}

function requireSuperAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'super_admin') {
    return next(httpError(403, 'Super admin access required'));
  }
  next();
}

// Ensures the caller is an owner/staff member of an active store, and attaches
// req.storeId so route handlers always scope their queries to it.
async function requireStoreUser(req, res, next) {
  try {
    if (!req.user || (req.user.role !== 'owner' && req.user.role !== 'staff') || !req.user.store_id) {
      throw httpError(403, 'This action requires a store account');
    }
    const { data: store, error } = await supabase
      .from('stores')
      .select('id, is_active')
      .eq('id', req.user.store_id)
      .single();
    if (error || !store) throw httpError(403, 'Store not found');
    if (!store.is_active) throw httpError(403, 'This store has been suspended');

    req.storeId = store.id;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { requireAuth, requireOwner, requireSuperAdmin, requireStoreUser };
