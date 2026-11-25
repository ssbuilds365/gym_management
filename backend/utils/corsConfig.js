const buildCorsOptions = (allowedOrigins) => {
  const origins = new Set(allowedOrigins);

  return {
    origin: (origin, callback) => {
      if (!origin || origins.has(origin)) {
        return callback(null, true);
      }
      return callback(null, false);
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Idempotency-Key', 'X-Kiosk-Request'],
    credentials: true
  };
};

module.exports = { buildCorsOptions };
