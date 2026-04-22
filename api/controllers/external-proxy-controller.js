const { URL } = require('url');

const TARGET_BASE = process.env.EWYBSL_SOURCE_BASE_URL || 'https://api.example.com';
const API_KEY = process.env.EWYBSL_SOURCE_API_KEY || '';

const readRequestBody = (req) =>
  new Promise((resolve) => {
    if (req.body !== undefined) {
      if (Buffer.isBuffer(req.body)) {
        resolve(req.body);
        return;
      }
      if (typeof req.body === 'string') {
        resolve(Buffer.from(req.body));
        return;
      }
      if (typeof req.body === 'object' && req.body !== null) {
        resolve(Buffer.from(JSON.stringify(req.body)));
        return;
      }
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      resolve(undefined);
      return;
    }

    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(undefined));
  });

const readHeaderValue = (value) => {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (Array.isArray(value) && value.length > 0) {
    return String(value[0]).trim();
  }
  return '';
};

const resolveTokenHeader = (reqHeaders) => {
  const directToken = readHeaderValue(reqHeaders.token);
  if (directToken) {
    return directToken;
  }

  const explicitToken = readHeaderValue(reqHeaders.Token);
  if (explicitToken) {
    return explicitToken;
  }

  const authorization = readHeaderValue(reqHeaders.authorization);
  if (authorization.toLowerCase().startsWith('bearer ')) {
    return authorization.slice(7).trim();
  }

  return '';
};

const resolveImpersonateHeader = (reqHeaders) => {
  const directImpersonate = readHeaderValue(reqHeaders.impersonate);
  if (directImpersonate) {
    return directImpersonate;
  }

  const explicitImpersonate = readHeaderValue(reqHeaders.Impersonate);
  if (explicitImpersonate) {
    return explicitImpersonate;
  }

  return '';
};

const buildTargetUrl = (req) => {
  const incomingUrl = new URL(req.url || '/', 'http://localhost');
  const pathnamePath = incomingUrl.pathname.replace(/^\/api\/external\/?/, '').replace(/^\/+/, '');
  const queryPath = incomingUrl.searchParams.get('path')?.replace(/^\/+|\/+$/g, '') || '';
  const relativePath = pathnamePath || queryPath;
  const targetUrl = new URL(`${TARGET_BASE.replace(/\/+$/, '')}/api/${relativePath}`);

  incomingUrl.searchParams.delete('path');
  for (const [key, value] of incomingUrl.searchParams.entries()) {
    targetUrl.searchParams.append(key, value);
  }

  return { relativePath, targetUrl };
};

const isSessionsRequest = (relativePath, targetUrl) =>
  relativePath === 'sessions' || targetUrl.pathname.endsWith('/sessions');

const handleExternalProxyRequest = async (req, res) => {
  if (!API_KEY) {
    res.status(500).json({ error: 'Missing EWYBSL_SOURCE_API_KEY.' });
    return;
  }

  const { relativePath, targetUrl } = buildTargetUrl(req);
  const sessionsRequest = isSessionsRequest(relativePath, targetUrl);

  if (!targetUrl.searchParams.has('apikey')) {
    targetUrl.searchParams.set('apikey', API_KEY);
  }

  if (sessionsRequest) {
    const userid = readHeaderValue(req.headers.userid);
    const password = readHeaderValue(req.headers.password);

    if (userid && !targetUrl.searchParams.has('userid')) {
      targetUrl.searchParams.set('userid', userid);
    }

    if (password && !targetUrl.searchParams.has('password')) {
      targetUrl.searchParams.set('password', password);
    }
  }

  const headers = {
    Accept: 'application/json',
  };

  const token = resolveTokenHeader(req.headers);
  const impersonate = resolveImpersonateHeader(req.headers);
  if (!sessionsRequest && token) {
    headers.Token = token;
  }
  if (!sessionsRequest && impersonate) {
    headers.Impersonate = impersonate;
  }

  const requestBody = await readRequestBody(req);
  const requestInit = {
    method: req.method,
    headers,
  };

  if (req.method !== 'GET' && req.method !== 'HEAD' && requestBody !== undefined) {
    requestInit.body = requestBody;
  }

  console.log('[external-proxy] forwarding request', {
    method: req.method,
    relativePath,
    targetUrl: targetUrl.toString(),
    sessionsRequest,
  });

  const response = await fetch(targetUrl, requestInit);

  const body = await response.text();
  res.setHeader('X-External-Proxy-Method', req.method);
  res.setHeader('X-External-Proxy-Path', relativePath || '<root>');
  res.setHeader('X-External-Proxy-Target', targetUrl.toString());
  res.setHeader('X-External-Proxy-Upstream-Status', String(response.status));
  res
    .status(response.status)
    .setHeader('Content-Type', response.headers.get('content-type') || 'application/json');
  res.send(body);
};

module.exports = { handleExternalProxyRequest };
