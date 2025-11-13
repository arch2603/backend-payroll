console.log('[authMiddleware] loaded from:', __filename);
const jwt = require("jsonwebtoken");

function sendAuthError(res, code, message) {
  // 401 for auth failures; 403 is reserved for *authorized-but-forbidden*
  return res.status(401).json({ code, error: message });
}


function authenticateToken(req, res, next) {

  const authHeader = req.headers.authorization || '';

  if (!authHeader) return sendAuthError(res, 'NO_AUTH_HEADER', 'Missing Authorization header');

  //const token = authHeader && authHeader.split(" ")[1];
  const [scheme, rawToken] = authHeader.split(/\s+/);
  if (!scheme || !/^Bearer$/i.test(scheme) || !rawToken) return sendAuthError(res, 'BAD_AUTH_SCHEME', 'Invalid Authorization Header');

  const token = rawToken.trim();

  jwt.verify(token, process.env.JWT_SECRET, { clockTolerance: 5 }, (err, payload) => {
    if (err) {
      if (err.name === 'TokenExpiredError') {
        console.warn('[auth] JWT verify failed:', err.name, err.message);
        return sendAuthError(res, 'TOKEN_EXPIRED', 'Token expired');
      }
      if (err.name === 'JsonWebTokenError') {
        console.warn('[auth] JWT verify failed:', err.name, err.message);
        return sendAuthError(res, 'TOKEN_INVALID', 'Invalid token');
      }
      console.warn('[auth] JWT verify failed:', err.name, err.message);
      return sendAuthError(res, 'TOKEN_INVALID', 'Invalid token');
    }

    req.user = payload; // { user_id, role }
    return next();
  });
}

// Role-based authorization
function authorizeRoles(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return sendAuthError(res, 'UNAUTHENTICATED', 'Unauthenticated');;
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ code: 'FORBIDDEN', error: "Forbidden: insufficient rights" });
    }
    return next();
  };
}

module.exports = { authenticateToken, authorizeRoles };
