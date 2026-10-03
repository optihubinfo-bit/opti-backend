module.exports = function errorHandler(err, req, res, next) {
  console.error(err);
  const status = err.status || 500;
  // 4xx messages are hand-written by route handlers (httpError(...)) and are safe to
  // show as-is. 5xx here is almost always a raw Postgres/Supabase error passed through
  // via error.message — that can include schema/column/constraint names, which is
  // internal detail an API consumer shouldn't see. Log the real error above, return a
  // generic message to the client instead.
  const message = status >= 500 ? 'Something went wrong. Please try again.' : (err.message || 'Request failed');
  res.status(status).json({ error: message });
};
