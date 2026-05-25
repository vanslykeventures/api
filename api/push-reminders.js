const { handlePushReminderWorker } = require('./controllers/push-reminder-worker-controller');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Cron-Secret');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  try {
    await handlePushReminderWorker(req, res);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
};
