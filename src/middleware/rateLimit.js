// Minimal in-memory rate limiter for public, account-creating endpoints
// (bootstrap / store self-registration). No extra dependency, single-process
// is fine for this app's scale (Render free tier runs one instance).
//
// Keyed by IP + route name; a sliding window of `windowMs` allows at most
// `max` requests before returning 429.

const buckets = new Map();

function cleanup(now) {
  for (const [key, entry] of buckets) {
    if (now - entry.start > entry.windowMs) buckets.delete(key);
  }
}

function rateLimit({ windowMs = 15 * 60 * 1000, max = 10, name = 'default' } = {}) {
  return (req, res, next) => {
    const now = Date.now();
    if (buckets.size > 10000) cleanup(now);

    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
    const key = `${name}:${ip}`;
    let entry = buckets.get(key);

    if (!entry || now - entry.start > windowMs) {
      entry = { start: now, count: 0, windowMs };
      buckets.set(key, entry);
    }

    entry.count += 1;
    if (entry.count > max) {
      res.setHeader('Retry-After', Math.ceil((entry.start + windowMs - now) / 1000));
      return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }
    next();
  };
}

module.exports = rateLimit;
