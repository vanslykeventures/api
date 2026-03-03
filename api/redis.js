const {
  redisPing,
  redisGet,
  redisSet,
  redisDel,
  withPrefix,
} = require('./controllers/redis-controller');

const readRequestBody = (req) =>
  new Promise((resolve) => {
    if (req.method === 'GET' || req.method === 'HEAD') {
      resolve(undefined);
      return;
    }

    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(undefined));
  });

const parseJsonBody = (body) => {
  if (!body || body.length === 0) {
    return {};
  }

  try {
    return JSON.parse(body.toString('utf8'));
  } catch (_error) {
    return {};
  }
};

const parsePayload = async (req) => {
  if (req.body && typeof req.body === 'object') {
    return req.body;
  }

  const body = await readRequestBody(req);
  return parseJsonBody(body);
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  try {
    if (req.method === 'GET') {
      const pong = await redisPing();
      res.status(200).json({ ok: true, redis_ping: pong });
      return;
    }

    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method Not Allowed' });
      return;
    }

    const payload = await parsePayload(req);
    const { action, key, value, ttl_seconds } = payload;

    if (action === 'get') {
      if (!key) {
        res.status(400).json({ error: 'Missing key.' });
        return;
      }
      const result = await redisGet(key);
      res.status(200).json({ ok: true, key: withPrefix(key), value: result });
      return;
    }

    if (action === 'set') {
      if (!key || typeof value !== 'string') {
        res.status(400).json({ error: 'Missing key or string value.' });
        return;
      }
      const ttl = Number.isInteger(ttl_seconds) ? ttl_seconds : undefined;
      const result = await redisSet(key, value, ttl);
      res.status(200).json({ ok: true, key: withPrefix(key), result });
      return;
    }

    if (action === 'del') {
      if (!key) {
        res.status(400).json({ error: 'Missing key.' });
        return;
      }
      const deleted = await redisDel(key);
      res.status(200).json({ ok: true, key: withPrefix(key), deleted });
      return;
    }

    res.status(400).json({
      error: 'Unsupported action.',
      supported_actions: ['get', 'set', 'del'],
    });
  } catch (error) {
    res.status(500).json({ error: `Redis route error: ${error.message}` });
  }
};
