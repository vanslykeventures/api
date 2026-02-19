module.exports = async (_req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (_req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (_req.method !== 'GET') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  res.status(200).json({
    message: 'Hi, this is just an API.',
    endpoints: ['/api/ping', '/api/umpbot'],
  });
};
