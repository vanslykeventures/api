const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const CRON_SECRET = process.env.PUSH_REMINDER_CRON_SECRET || '';

const readRequestBody = (req) =>
  new Promise((resolve) => {
    if (req.body !== undefined) {
      resolve(req.body);
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      resolve({});
      return;
    }

    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (_error) {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });

const parseRequestBody = async (req) => {
  const body = await readRequestBody(req);
  if (Buffer.isBuffer(body)) {
    try {
      return JSON.parse(body.toString('utf8'));
    } catch (_error) {
      return {};
    }
  }
  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch (_error) {
      return {};
    }
  }
  return body && typeof body === 'object' ? body : {};
};

const addMinutes = (date, minutes) => new Date(date.getTime() + minutes * 60 * 1000);

const requireSupabaseConfig = () => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
  }
};

const supabaseRest = async (path, init = {}) => {
  requireSupabaseConfig();
  const response = await fetch(`${SUPABASE_URL.replace(/\/+$/, '')}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Accept: 'application/json',
      ...(init.headers || {}),
    },
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`Supabase REST failed (${response.status}): ${text}`);
  }
  return payload;
};

const getPushNotificationsEnabled = async () => {
  const rows = await supabaseRest('app_settings?select=value&key=eq.push_notifications_enabled&limit=1');
  const value = Array.isArray(rows) ? rows[0]?.value : undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() !== 'false';
  return true;
};

const listReminderSettings = async () => {
  const rows = await supabaseRest(
    'push_notification_settings?select=key,label,enabled,offset_minutes,message_template&order=key.asc'
  );
  return Array.isArray(rows) ? rows : [];
};

const assertCronAllowed = (req) => {
  if (!CRON_SECRET) return;
  const header = req.headers['x-cron-secret'];
  const value = Array.isArray(header) ? header[0] : header;
  if (value !== CRON_SECRET) {
    const error = new Error('Unauthorized cron request.');
    error.statusCode = 401;
    throw error;
  }
};

const handlePushReminderWorker = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  assertCronAllowed(req);

  const body = req.method === 'POST' ? await parseRequestBody(req) : {};
  const dryRun = body.dryRun !== false;
  const now = body.now ? new Date(body.now) : new Date();
  const windowMinutes = Number.isFinite(body.windowMinutes) ? Number(body.windowMinutes) : 10;

  if (Number.isNaN(now.getTime())) {
    res.status(400).json({ error: 'Invalid now value.' });
    return;
  }

  const pushEnabled = await getPushNotificationsEnabled();
  const settings = await listReminderSettings();
  const windowStart = addMinutes(now, -windowMinutes);
  const windowEnd = now;

  const enabledReminderTypes = settings
    .filter((setting) => setting.enabled)
    .map((setting) => ({
      key: setting.key,
      label: setting.label,
      offsetMinutes: setting.offset_minutes,
      messageTemplate: setting.message_template,
    }));

  res.status(200).json({
    dryRun,
    active: false,
    pushEnabled,
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    windowMinutes,
    enabledReminderTypes,
    plannedWork: [],
    note: 'API worker scaffold only. It reads Supabase settings and computes the check window, but it does not resolve games or send pushes yet.',
  });
};

module.exports = { handlePushReminderWorker };
