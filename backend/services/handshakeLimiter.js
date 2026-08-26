// ─── Socket.IO handshake throttling — PURE, import-free ───────────────────────
//
// **The Express rate limiter does not cover the handshake.** `new Server(httpServer)`
// installs its own `request` listener on the Node HTTP server and answers anything
// under `/socket.io/` itself; the Express app — and therefore `globalLimiter` in
// src/server.js — is never called for those requests. So the one endpoint that
// accepts the ESP32's shared secret (`DEVICE_SECRET`) had **no attempt limit at all**,
// while every HTTP credential path (sign-in, agent enrollment, metric ingest) has one.
//
// Two things that buys an attacker, both unmetered:
//   - unlimited guesses at DEVICE_SECRET, which is a single static shared secret with
//     no rotation and no lockout;
//   - a connection flood where each attempt carrying a well-formed JWT costs one
//     `fetchSessionRow` query out of a MySQL pool of 10 shared with the pollers, the
//     agent POSTs and every dashboard request.
//
// ── Why it counts FAILURES only ──────────────────────────────────────────────
// A plain per-IP connection cap would be a self-inflicted outage here, for the same
// reason CLAUDE.md documents for the global limiter: behind nginx every browser
// socket arrives from 127.0.0.1, and behind the campus NAT every off-server client
// shares one address. One shared bucket means the first person to reload locks out
// the rest. Counting only REJECTED handshakes avoids that completely — a working
// dashboard, a working agent and a correctly-flashed ESP32 never fail one, and a
// success CLEARS the counter for that address.

/**
 * Resolve the client address from a Socket.IO handshake, honouring the same
 * `trust proxy` hop count Express uses.
 *
 * Express's numeric `trust proxy` semantics, reproduced exactly: build the address
 * chain as `[socket address, ...X-Forwarded-For reversed]` and take index `hops`,
 * clamped to the end of the chain. With `hops = 2`, `XFF: "a, b, c"` and a peer of
 * `R`, the chain is `[R, c, b, a]` and the answer is `b`.
 *
 * ⚠️ Anything at or beyond index `hops` is attacker-controlled on a deployment where
 * the backend port is reachable directly — see the audit's A-03. Getting the hop
 * count right is what makes this value mean anything.
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
  // A cap on tracked keys, because the key is attacker-chosen when X-Forwarded-For is
  // trusted: without it, a spoofing flood turns this defence into a memory leak.
  // Expired entries are dropped first; only if that is not enough do we clear.
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
