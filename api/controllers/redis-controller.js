const { createClient } = require('redis');

const REDIS_URL = process.env.REDIS_URL || '';
const REDIS_KEY_PREFIX = process.env.REDIS_KEY_PREFIX || 'api:dev:';

let redisClient;

const withPrefix = (key) => `${REDIS_KEY_PREFIX}${key}`;

const getRedisClient = async () => {
  if (!REDIS_URL) {
    throw new Error('Missing REDIS_URL.');
  }

  if (!redisClient) {
    redisClient = createClient({ url: REDIS_URL });
    redisClient.on('error', (error) => {
      console.error('Redis error:', error.message);
    });
    await redisClient.connect();
  }

  return redisClient;
};

const redisPing = async () => {
  const client = await getRedisClient();
  return client.ping();
};

const redisGet = async (key) => {
  const client = await getRedisClient();
  return client.get(withPrefix(key));
};

const redisSet = async (key, value, ttlSeconds) => {
  const client = await getRedisClient();
  const cacheKey = withPrefix(key);

  if (Number.isInteger(ttlSeconds) && ttlSeconds > 0) {
    await client.set(cacheKey, value, { EX: ttlSeconds });
    return 'OK';
  }

  await client.set(cacheKey, value);
  return 'OK';
};

const redisDel = async (key) => {
  const client = await getRedisClient();
  return client.del(withPrefix(key));
};

module.exports = {
  getRedisClient,
  redisPing,
  redisGet,
  redisSet,
  redisDel,
  withPrefix,
};
