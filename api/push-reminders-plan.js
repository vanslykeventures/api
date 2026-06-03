const { handlePushReminderWorker } = require('./controllers/push-reminder-worker-controller');

module.exports = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'OPTIONS') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  try {
    req.url = '/api/push-reminders?mode=plan&write=true';
    await handlePushReminderWorker(req, res);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
};
