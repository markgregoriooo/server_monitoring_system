import agentService from "../services/agentService.js";

// Authenticates a Go agent's metric POST via its permanent bearer token.
// Validates against agent_tokens.approved_token WHERE status='approved' and,
// on success, attaches req.device = { device_id, device_name, ip_address,
// location, os }. This is separate from the JWT authMiddleware used by browsers.
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
