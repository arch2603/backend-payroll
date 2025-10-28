console.log('[authMiddleware] loaded from:', __filename);
const jwt = require("jsonwebtoken");

// Verify JWT
function authenticateToken(req, res, next) {
  // console.log('authMiddleWare,js Line6 ... Authorization header seen by server:', JSON.stringify(req.headers.authorization));
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({message: 'Missing Authorization header'});
  
  //const token = authHeader && authHeader.split(" ")[1];
  const [scheme, rawToken] = authHeader.split(/\s+/);
  if(!scheme || !/^Bearer$/i.test(scheme) || !rawToken) return res.status(401).json({message: 'Invalid Authorization Header'});

  const token = rawToken.trim();

  jwt.verify(token, process.env.JWT_SECRET, { clockTolerance: 5 }, (err, payload) => {
    if (err) {
        console.warn('[auth] JWT verify failed:', err.name, err.message);
        return res.status(403).json({message: 'Invalid or expired token'});
    }
    // console.log('[auth] OK user:', payload?.username, 'role:', payload?.role, 'exp:', payload?.exp);
    req.user = payload; // { user_id, role }
    next();
  });
}

// Role-based authorization
function authorizeRoles(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user ) {
      return res.status(403).json({ message: "Unauthenticated" });
    }

    if(!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ message: "Forbidden: insufficient rights" });
    }
    next();
  };
}

module.exports = { authenticateToken, authorizeRoles };
