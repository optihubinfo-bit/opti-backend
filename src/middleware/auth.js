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
      .select('id, email, full_name, role')
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

module.exports = { requireAuth, requireOwner };
