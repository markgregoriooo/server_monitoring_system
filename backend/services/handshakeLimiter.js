// ─── Socket.IO handshake throttling ───────────────────────
// Socket.IO answers /socket.io/ itself, so the Express rate limiter never sees
// handshakes. Without this, the ESP32's DEVICE_SECRET could be guessed without
// limit, and each handshake with a JWT costs a database query.
//
// Only failed handshakes count, and a success clears the counter. A plain per-IP
// connection cap would lock everyone out, since behind nginx all browsers come from
// 127.0.0.1 and behind the campus NAT all clients share one address.

/**
 * Client address for a Socket.IO handshake, using the same `trust proxy` hop count
 * as Express: chain = [peer address, ...X-Forwarded-For reversed], take index `hops`
 * (clamped). With hops = 2, XFF "a, b, c" and peer R, the chain is [R, c, b, a] and
 * the answer is b. Entries past `hops` can be forged if port 3001 is reachable
 * directly (see audit A-03).
 *
 * @param {Record<string, unknown>} headers handshake headers
 * @param {string|undefined} address the direct peer address
 * @param {number} hops trusted proxy hops (0 = trust nothing but the peer)
 * @returns {string}
 */
export function clientIpFrom(headers, address, hops) {
  const peer = typeof address === "string" && address ? address : "unknown";
  const n = Number.isInteger(hops) && hops > 0 ? hops : 0;
  if (n === 0) return peer;

  const raw = headers?.["x-forwarded-for"];
  const list = (Array.isArray(raw) ? raw.join(",") : typeof raw === "string" ? raw : "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const chain = [peer, ...list.reverse()];
  return chain[Math.min(n, chain.length - 1)];
}

/**
 * A fixed-window budget of FAILED handshakes per key.
 *
 * @param {{ windowMs?: number, maxFailures?: number, now?: () => number, maxKeys?: number }} [opts]
 */
export function createHandshakeLimiter(opts = {}) {
  const windowMs = opts.windowMs ?? 15 * 60 * 1000;
  const maxFailures = opts.maxFailures ?? 50;
  const now = opts.now ?? Date.now;
  // Cap on tracked keys: with X-Forwarded-For trusted the key can be forged, and a
  // flood would otherwise grow the map forever. Expired entries go first.
  const maxKeys = opts.maxKeys ?? 10_000;

  /** @type {Map<string, { count: number, resetAt: number }>} */
  const buckets = new Map();

  function prune(t) {
    for (const [k, b] of buckets) if (b.resetAt <= t) buckets.delete(k);
  }

  function bucketFor(key, t) {
    const b = buckets.get(key);
    if (b && b.resetAt > t) return b;
    const fresh = { count: 0, resetAt: t + windowMs };
    if (buckets.size >= maxKeys) {
      prune(t);
      if (buckets.size >= maxKeys) buckets.clear();
    }
    buckets.set(key, fresh);
    return fresh;
  }

  return {
    /** True once this key has burned its failure budget for the current window. */
    isBlocked(key) {
      const t = now();
      const b = buckets.get(key);
      if (!b || b.resetAt <= t) return false;
      return b.count >= maxFailures;
    },

    /** Count one rejected handshake. Returns the failure count in this window. */
    recordFailure(key) {
      const t = now();
      const b = bucketFor(key, t);
      b.count += 1;
      return b.count;
    },

    /**
     * A handshake authenticated. Clear the key so a busy shared address (nginx's
     * loopback, the campus NAT) can never accumulate its way into a block.
     */
    recordSuccess(key) {
      buckets.delete(key);
    },

    /** Seconds until this key's window rolls over (0 when it is not tracked). */
    retryAfterSec(key) {
      const b = buckets.get(key);
      const t = now();
      return b && b.resetAt > t ? Math.ceil((b.resetAt - t) / 1000) : 0;
    },

    /** Test/observability seams. */
    size: () => buckets.size,
    prune: () => prune(now()),
    limits: () => ({ windowMs, maxFailures, maxKeys }),
  };
}

export default { clientIpFrom, createHandshakeLimiter };
