const Owner = require('../models/Owner');
const OwnerSession = require('../models/OwnerSession');
const {
  SESSION_IDLE_TIMEOUT_MS,
  getSessionToken,
  hashSessionToken,
  isSessionIdle
} = require('../utils/ownerSession');

const reject = (res, code, message) => res.status(401).json({
  success: false,
  code,
  message
});

const protectOwner = async (req, res, next) => {
  const token = getSessionToken(req.headers.cookie);
  if (!token) {
    return reject(res, 'SESSION_REQUIRED', 'Please log in to continue.');
  }

  try {
    const now = new Date();
    const tokenHash = hashSessionToken(token);
    const session = await OwnerSession.findOne({
      $or: [
        { tokenHash },
        {
          previousTokenHash: tokenHash,
          previousTokenValidUntil: { $gt: now }
        }
      ]
    }).select('+tokenHash +previousTokenHash +previousTokenValidUntil');

    if (!session) {
      return reject(res, 'SESSION_INVALID', 'This session is invalid. Please log in again.');
    }

    if (session.revokedAt) {
      return reject(res, 'SESSION_REVOKED', 'This session was revoked. Please log in again.');
    }

    if (session.expiresAt <= now || isSessionIdle(session.lastActivityAt, now)) {
      await OwnerSession.updateOne({
        _id: session._id,
        revokedAt: null
      }, {
        $set: { revokedAt: now, revokedReason: 'expired' }
      });
      return reject(res, 'SESSION_EXPIRED', 'Your session has expired. Please log in again.');
    }

    const owner = await Owner.findOne({
      _id: session.ownerId,
      tenantId: session.tenantId,
      businessId: session.businessId,
      isActive: true
    }).select('_id name email phone tenantId businessId role isActive').lean();

    if (!owner) {
      await OwnerSession.updateOne({
        _id: session._id,
        revokedAt: null
      }, {
        $set: { revokedAt: now, revokedReason: 'revoked' }
      });
      return reject(res, 'SESSION_REVOKED', 'This account is unavailable. Please log in again.');
    }

    req.owner = owner;
    req.tenantId = owner.tenantId;
    req.session = session;
    req.sessionId = session._id;
    next();
  } catch (error) {
    console.error('Owner session verification error:', error.message);
    return res.status(503).json({
      success: false,
      code: 'SESSION_CHECK_UNAVAILABLE',
      message: 'Session verification is temporarily unavailable.'
    });
  }
};

module.exports = { protectOwner };
