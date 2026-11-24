const configureProxyTrust = (app, nodeEnv) => {
  app.set('trust proxy', nodeEnv === 'production' ? 1 : false);
  app.use((req, res, next) => {
    delete req.headers.forwarded;
    next();
  });
};

module.exports = { configureProxyTrust };
