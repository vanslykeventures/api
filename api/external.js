const { handleExternalProxyRequest } = require('./controllers/external-proxy-controller');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-API-Key, token, userid, password, impersonate'
  );
  res.setHeader('X-External-Route-Method', req.method || '<unknown>');
  res.setHeader('X-External-Route-Url', req.url || '<unknown>');

  if (req.method === 'OPTIONS') {
    console.log('[external-route] preflight request', {
      method: req.method,
      url: req.url,
      origin: req.headers.origin,
      requestMethod: req.headers['access-control-request-method'],
      requestHeaders: req.headers['access-control-request-headers'],
    });
    res.status(204).end();
    return;
  }

  try {
    await handleExternalProxyRequest(req, res);
  } catch (error) {
    console.error('[external-route] proxy error', {
      method: req.method,
      url: req.url,
      message: error.message,
    });
    res.status(502).json({ error: `External proxy error: ${error.message}` });
  }
};
