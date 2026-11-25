const sameId = (left, right) => Boolean(left && right && String(left) === String(right));

const requireKioskGymOwner = (req, res, next) => {
  if (!req.kiosk) {
    return res.status(401).json({
      success: false,
      code: 'KIOSK_AUTH_REQUIRED',
      message: 'Kiosk authorization is required.'
    });
  }

  if (
    !req.owner ||
    req.owner.role !== 'owner' ||
    !sameId(req.owner.tenantId, req.tenantId)
  ) {
    return res.status(403).json({
      success: false,
      code: 'STAFF_AUTH_REQUIRED',
      message: 'A gym administrator must be signed in to register a face.'
    });
  }

  if (
    !sameId(req.owner.tenantId, req.kiosk.tenantId) ||
    !sameId(req.owner.businessId, req.kiosk.businessId)
  ) {
    return res.status(403).json({
      success: false,
      code: 'STAFF_GYM_MISMATCH',
      message: 'This administrator account does not belong to this gym.'
    });
  }

  return next();
};

module.exports = requireKioskGymOwner;
