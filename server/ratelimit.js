/* ============================================================
   EVER NOVA LIFE — tiny in-memory rate limiter
   No new dependency: a fixed-window counter kept in a Map, keyed
   by client IP + whatever the caller names the bucket.

   Deliberately small and honest about its limits:
     · the counts live in this process, so two instances count
       separately. With one Render instance that is the whole
       picture; if the service is ever scaled out, this becomes a
       per-instance limit rather than a global one.
     · state is dropped on restart. A restart is a free pass —
       acceptable for the things guarded here (a lookup form),
       not a substitute for account lockout.

   Used by the public order-status lookup so order references
   can't be walked by a script.
   ============================================================ */

const buckets = new Map();     // key → { count, resetAt }
const MAX_KEYS = 10000;        // hard cap so a spray of IPs can't grow this forever

/* The caller's address, preferring the proxy header only when Express has
   been told to trust a proxy (app.set('trust proxy')). req.ip already
   reflects that setting, so use it and fall back to the raw socket. */
function clientKey(req) {
  return String(req.ip || (req.connection && req.connection.remoteAddress) || 'unknown');
}

function sweep(now) {
  for (const [k, v] of buckets) {
    if (v.resetAt <= now) buckets.delete(k);
  }
}

/* Build an Express middleware. `max` requests per `windowMs` per IP.
   `name` separates buckets so two limited routes don't share a budget. */
function limit({ name = 'default', windowMs = 60000, max = 10, message } = {}) {
  return function rateLimiter(req, res, next) {
    const now = Date.now();
    const key = name + '|' + clientKey(req);
    let entry = buckets.get(key);

    if (!entry || entry.resetAt <= now) {
      if (buckets.size >= MAX_KEYS) sweep(now);
      // Still full after a sweep: every bucket is live, so stop tracking new
      // keys rather than growing without bound. Letting the request through is
      // the right failure mode for a convenience endpoint.
      if (buckets.size >= MAX_KEYS) return next();
      entry = { count: 0, resetAt: now + windowMs };
      buckets.set(key, entry);
    }

    entry.count += 1;

    const remaining = Math.max(0, max - entry.count);
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    res.set('X-RateLimit-Limit', String(max));
    res.set('X-RateLimit-Remaining', String(remaining));

    if (entry.count > max) {
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({
        error: message || `Too many attempts. Try again in ${retryAfter} second${retryAfter === 1 ? '' : 's'}.`,
        retryAfter
      });
    }
    return next();
  };
}

/* Test seam — lets a test start from a clean slate. */
function reset() {
  buckets.clear();
}

module.exports = { limit, reset, clientKey };
