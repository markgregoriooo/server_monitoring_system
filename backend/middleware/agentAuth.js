import agentService from "../services/agentService.js";

// Authenticates a Go agent's metric POST by its bearer token (looked up by hash in
// agent_tokens, status 'approved'). On success sets req.device. Browsers use the
// JWT authMiddleware instead.
export async function agentAuthMiddleware(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token =
    authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;

  if (!token) {
    return res.status(401).json({ error: "Access denied. No agent token provided." });
  }

  try {
    const device = await agentService.validateToken(token);
    if (!device) {
      return res.status(403).json({ error: "Invalid or unapproved agent token." });
    }
    req.device = device;
    next();
  } catch (err) {
    next(err);
  }
}
