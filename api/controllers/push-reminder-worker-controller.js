const { redisGet, redisSet, withPrefix } = require('./redis-controller');
const { createPushAudienceResolver } = require('../services/push-audience-service');

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_FUNCTION_KEY = process.env.SUPABASE_FUNCTION_KEY || process.env.SUPABASE_ANON_KEY || process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET || process.env.PUSH_REMINDER_CRON_SECRET || '';
const SOURCE_BASE_URL = process.env.EWYBSL_SOURCE_BASE_URL || '';
const SOURCE_API_KEY = process.env.EWYBSL_SOURCE_API_KEY || '';
const SOURCE_TOKEN = process.env.EWYBSL_SOURCE_TOKEN || '';
const PLAN_KEY_PREFIX = 'push:plans';
const DEFAULT_WINDOW_MINUTES = 10;
const PLAN_TTL_SECONDS = 2 * 24 * 60 * 60;
const EARLIEST_SEND_TIME = process.env.PUSH_REMINDER_EARLIEST_SEND_TIME || '08:00';
const LATEST_SEND_TIME = process.env.PUSH_REMINDER_LATEST_SEND_TIME || '21:30';

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

const formatEasternDate = (date) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
};

const addDaysToDateString = (dateString, days) => {
  const [year, month, day] = String(dateString).split('-').map(Number);
  if (!year || !month || !day) return dateString;
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
};

const getTimeZoneOffsetMinutes = (date, timeZone) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const asUtc = Date.UTC(
    Number(byType.year),
    Number(byType.month) - 1,
    Number(byType.day),
    Number(byType.hour),
    Number(byType.minute),
    Number(byType.second)
  );
  return (asUtc - date.getTime()) / 60000;
};

const easternWallTimeToDate = (dateString, timeString) => {
  const [year, month, day] = String(dateString).split('-').map(Number);
  const [hour = 0, minute = 0, second = 0] = String(timeString || '00:00:00').split(':').map(Number);
  if (!year || !month || !day) return null;
  const wallTimeAsUtc = Date.UTC(year, month - 1, day, hour || 0, minute || 0, second || 0);
  const offset = getTimeZoneOffsetMinutes(new Date(wallTimeAsUtc), 'America/New_York');
  return new Date(wallTimeAsUtc - offset * 60000);
};

const formatEasternTime = (date) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);

const formatEasternDateTime = (date) => `${formatEasternDate(date)} ${formatEasternTime(date)} ET`;

const normalizeEasternClockTime = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const match = raw.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!match) return null;

  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  const meridiem = match[3]?.toLowerCase();
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || minute < 0 || minute > 59) return null;

  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === 'pm' && hour !== 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
  } else if (hour < 0 || hour > 23) {
    return null;
  }

  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;
};

const parseNowOption = (value, date) => {
  if (value === undefined || value === null || value === '') return new Date();
  const easternClockTime = normalizeEasternClockTime(value);
  if (easternClockTime) {
    return easternWallTimeToDate(date, easternClockTime) || new Date('');
  }
  return new Date(value);
};

const getEarliestSendForDate = (date) =>
  easternWallTimeToDate(date, normalizeEasternClockTime(EARLIEST_SEND_TIME) || '08:00:00') || new Date('');

const getLatestSendForDate = (date) =>
  easternWallTimeToDate(date, normalizeEasternClockTime(LATEST_SEND_TIME) || '21:30:00') || new Date('');

const extractTeamsFromInfo = (info) => {
  const value = typeof info === 'string' ? info : '';
  const [away, home] = value.split(/\s+@\s+/);
  return {
    away: away?.trim() || '',
    home: home?.trim() || '',
  };
};

const compact = (values) => values.filter((value) => value !== null && value !== undefined && value !== '');

const replaceTemplate = (template, values) =>
  String(template || '').replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, key) =>
    values[key] === null || values[key] === undefined ? '' : String(values[key])
  );

const requireSupabaseConfig = () => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
  }
};

const requireSourceConfig = () => {
  if (!SOURCE_BASE_URL || !SOURCE_API_KEY) {
    throw new Error('Missing EWYBSL_SOURCE_BASE_URL or EWYBSL_SOURCE_API_KEY.');
  }
};

const sourceApiGet = async (path, params = {}) => {
  requireSourceConfig();
  const url = new URL(`${SOURCE_BASE_URL.replace(/\/+$/, '')}/api/${String(path).replace(/^\/+/, '')}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  });
  url.searchParams.set('apikey', SOURCE_API_KEY);

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      ...(SOURCE_TOKEN ? { Token: SOURCE_TOKEN } : {}),
    },
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`Source API failed (${response.status}): ${text}`);
  }
  return payload;
};

const supabaseRest = async (path, init = {}) => {
  requireSupabaseConfig();
  const response = await fetch(`${SUPABASE_URL.replace(/\/+$/, '')}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ` + SUPABASE_SERVICE_ROLE_KEY,
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
  const cronHeader = req.headers['x-cron-secret'];
  const authHeader = req.headers.authorization;
  const cronValue = Array.isArray(cronHeader) ? cronHeader[0] : cronHeader;
  const authValue = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  const bearerValue = typeof authValue === 'string' && authValue.toLowerCase().startsWith('bearer ')
    ? authValue.slice(7).trim()
    : '';
  if (cronValue !== CRON_SECRET && bearerValue !== CRON_SECRET) {
    const error = new Error('Unauthorized cron request.');
    error.statusCode = 401;
    throw error;
  }
};

const readQueryParam = (req, key) => {
  const url = new URL(req.url || '/', 'http://localhost');
  return url.searchParams.get(key) || '';
};

const readFirstDefined = (...values) => values.find((value) => value !== undefined && value !== null && value !== '');

const parseBooleanOption = (value, defaultValue) => {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const normalized = String(value).trim().toLowerCase();
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  return defaultValue;
};

const getRequestOptions = async (req) => {
  const body = req.method === 'POST' ? await parseRequestBody(req) : {};
  const queryMode = readQueryParam(req, 'mode');
  const queryDate = readQueryParam(req, 'date');
  const queryDryRun = readFirstDefined(readQueryParam(req, 'dryRun'), readQueryParam(req, 'dry_run'));
  const queryWrite = readQueryParam(req, 'write');
  const queryIncludePlannedWork = readQueryParam(req, 'includePlannedWork');
  const queryWindowMinutes = readQueryParam(req, 'windowMinutes');
  const queryNow = readQueryParam(req, 'now');
  const queryIgnoreSendWindow = readFirstDefined(
    readQueryParam(req, 'ignoreSendWindow'),
    readQueryParam(req, 'ignore_send_window')
  );
  const queryTestTeamId = readFirstDefined(
    readQueryParam(req, 'testTeamId'),
    readQueryParam(req, 'test_team_id')
  );

  const date = body.date || queryDate || formatEasternDate(new Date());
  const now = parseNowOption(readFirstDefined(body.now, queryNow), date);
  const windowMinutesValue = body.windowMinutes ?? (queryWindowMinutes ? Number(queryWindowMinutes) : undefined);
  const windowMinutes = Number.isFinite(windowMinutesValue) ? Number(windowMinutesValue) : DEFAULT_WINDOW_MINUTES;
  const dryRun = parseBooleanOption(readFirstDefined(body.dryRun, body.dry_run, queryDryRun), true);
  const write = body.write !== undefined
    ? body.write === true
    : queryWrite
      ? queryWrite === 'true'
      : false;
  const includePlannedWork = body.includePlannedWork !== undefined
    ? body.includePlannedWork === true
    : queryIncludePlannedWork
      ? queryIncludePlannedWork === 'true'
      : false;

  return {
    mode: body.mode || queryMode || 'dispatch',
    date,
    dryRun,
    write,
    includePlannedWork,
    now,
    windowMinutes,
    ignoreSendWindow: parseBooleanOption(
      readFirstDefined(body.ignoreSendWindow, body.ignore_send_window, queryIgnoreSendWindow),
      false
    ),
    testTeamId: readFirstDefined(body.testTeamId, body.test_team_id, queryTestTeamId) || null,
  };
};

const normalizePlan = (rawPlan, date, redisKey) => {
  if (!rawPlan) {
    return {
      found: false,
      date,
      redisKey,
      createdAt: null,
      items: [],
    };
  }

  const parsed = JSON.parse(rawPlan);
  const items = Array.isArray(parsed) ? parsed : Array.isArray(parsed.items) ? parsed.items : [];
  return {
    found: true,
    date: parsed.date || date,
    redisKey,
    createdAt: parsed.createdAt || null,
    items: items.filter((item) => item && typeof item === 'object'),
  };
};

const getPlanItemScheduledFor = (item) => {
  const value = item.scheduledFor || item.scheduled_for;
  if (typeof value !== 'string') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const getPlanItemIdentity = (item) => ({
  category: String(item.category || ''),
  eventId: item.eventId ?? item.event_id ?? item.gameId ?? item.game_id ?? null,
  teamId: item.teamId ?? item.team_id ?? null,
});

const asArray = (value) => {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return [];
  return [value];
};

const uniqueStrings = (values) =>
  Array.from(new Set(values.flatMap(asArray).map((value) => String(value)).filter(Boolean)));

const getPlanItemTeamIds = (item) => {
  const explicitTeamIds = uniqueStrings([
    item.teamId,
    item.team_id,
    item.teamIds,
    item.team_ids,
    item.audience?.teamId,
    item.audience?.team_id,
    item.audience?.teamIds,
    item.audience?.team_ids,
  ]);

  if (explicitTeamIds.length > 0) {
    return explicitTeamIds;
  }

  return uniqueStrings([
    item.source?.awayTeamId,
    item.source?.homeTeamId,
  ]);
};

const buildTestTeamDispatchItem = (item, testTeamId) => {
  if (!testTeamId) return item;

  const normalizedTestTeamId = String(testTeamId);
  const itemTeamIds = getPlanItemTeamIds(item);
  if (!itemTeamIds.includes(normalizedTestTeamId)) {
    return null;
  }

  const originalAudience = item.audience && typeof item.audience === 'object'
    ? item.audience
    : {};
  const recipientRoles = originalAudience.recipientRoles ?? originalAudience.recipient_roles ?? ['parent', 'coach'];

  return {
    ...item,
    teamId: normalizedTestTeamId,
    teamIds: [normalizedTestTeamId],
    audience: {
      ...originalAudience,
      type: 'teams',
      teamIds: [normalizedTestTeamId],
      recipientRoles,
    },
    data: {
      ...(item.data || {}),
      teamId: normalizedTestTeamId,
      teamIds: [normalizedTestTeamId],
      testTeamId: normalizedTestTeamId,
    },
    testMode: {
      enabled: true,
      teamId: normalizedTestTeamId,
      originalTeamIds: itemTeamIds,
    },
  };
};

const encodeEq = (value) => `eq.${encodeURIComponent(String(value))}`;

const findExistingRun = async (item) => {
  const { category, eventId, teamId } = getPlanItemIdentity(item);
  if (!category) return null;

  const params = [
    'select=id,category,event_id,team_id,sent_at,metadata',
    `category=${encodeEq(category)}`,
    eventId === null || eventId === undefined
      ? 'event_id=is.null'
      : `event_id=${encodeEq(eventId)}`,
    teamId === null || teamId === undefined
      ? 'team_id=is.null'
      : `team_id=${encodeEq(teamId)}`,
    'limit=1',
  ];
  const rows = await supabaseRest(`push_notification_runs?${params.join('&')}`);
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
};

const postSupabaseFunction = async (functionName, payload) => {
  requireSupabaseConfig();
  const response = await fetch(`${SUPABASE_URL.replace(/\/+$/, '')}/functions/v1/${functionName}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_FUNCTION_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`Supabase function ${functionName} failed (${response.status}): ${text}`);
  }
  return parsed;
};

const insertRunRecord = async (item, status, metadata = {}, existingRun = null) => {
  const { category, eventId, teamId } = getPlanItemIdentity(item);
  if (!category) return null;

  const scheduledFor = getPlanItemScheduledFor(item);
  const body = JSON.stringify({
    category,
    event_id: eventId === null || eventId === undefined ? null : String(eventId),
    team_id: teamId === null || teamId === undefined ? null : String(teamId),
    scheduled_for: scheduledFor ? scheduledFor.toISOString() : null,
    sent_at: new Date().toISOString(),
    metadata: {
      ...metadata,
      status,
    },
  });

  if (existingRun?.id) {
    return supabaseRest(`push_notification_runs?id=eq.${encodeURIComponent(String(existingRun.id))}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body,
    });
  }

  return supabaseRest('push_notification_runs', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body,
  });
};

const archivePlanRecord = async ({ date, redisKey, plan }) =>
  supabaseRest('push_notification_plan_archives?on_conflict=plan_date', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify({
      plan_date: date,
      redis_key: withPrefix(redisKey),
      fetch_range: plan.fetchRange || {},
      source_game_count: Number(plan.sourceGameCount || 0),
      planned_item_count: Array.isArray(plan.items) ? plan.items.length : 0,
      payload: plan,
    }),
  });

const buildSendPushPayload = async (item, audienceResolver) => {
  const audienceResolution = await audienceResolver.resolveAudience(item.audience || { type: 'all' });

  return {
    payload: {
      title: item.title || 'WYBSL',
      body: item.message || item.body || '',
      message: item.message || item.body || '',
      category: item.category || 'scheduled_reminder',
      audience: audienceResolution.audience,
      data: item.data || {},
    },
    audienceResolution: audienceResolution.resolution,
  };
};

const getSetting = (settingsByKey, key) => {
  const setting = settingsByKey.get(key);
  if (!setting || !setting.enabled) return null;
  return setting;
};

const normalizeScheduleGames = (schedulePayload) => {
  const rows = Array.isArray(schedulePayload?.results)
    ? schedulePayload.results
    : Array.isArray(schedulePayload)
      ? schedulePayload
      : [];

  return rows
    .filter((item) => (item.type ?? '').toLowerCase() === 'game')
    .map((item) => {
      const gameId = item.game_id ?? item.event_id ?? item.id;
      const date = item.date;
      const startTime = item.start_time || item.time || '';
      const homeTeamId = item.home_team_id ? String(item.home_team_id) : '';
      const awayTeamId = item.away_team_id ? String(item.away_team_id) : '';
      const startsAt = date && startTime ? easternWallTimeToDate(date, startTime) : null;
      const teams = extractTeamsFromInfo(item.info);
      if (!gameId || !date || !startsAt || !homeTeamId || !awayTeamId) return null;

      return {
        gameId: String(gameId),
        date,
        startTime,
        startsAt,
        field: item.field || item.location || '',
        leagueName: item.league_name || item.league || item.leagueName || '',
        title: item.info || `${teams.away || `Team ${awayTeamId}`} @ ${teams.home || `Team ${homeTeamId}`}`,
        awayTeamId,
        homeTeamId,
        awayName: teams.away || item.away_team || item.away_team_name || `Team ${awayTeamId}`,
        homeName: teams.home || item.home_team || item.home_team_name || `Team ${homeTeamId}`,
        raw: item,
      };
    })
    .filter(Boolean);
};

const getTemplateValues = (game, teamId) => {
  const isAway = teamId && teamId === game.awayTeamId;
  const isHome = teamId && teamId === game.homeTeamId;
  const teamName = isAway ? game.awayName : isHome ? game.homeName : '';
  const opponentName = isAway ? game.homeName : isHome ? game.awayName : '';
  const gameTimeText = formatEasternTime(game.startsAt);

  return {
    gameId: game.gameId,
    gameTitle: game.title,
    title: game.title,
    teamId: teamId || '',
    teamName,
    opponentName,
    gameDate: game.date,
    gameTime: gameTimeText,
    gameTimeText,
    fieldName: game.field,
    fieldText: game.field ? ` at ${game.field}` : '',
    leagueName: game.leagueName,
  };
};

const buildReminderItem = ({ setting, game, teamId, teamIds, scheduledFor, audience, route, fallbackMessage }) => {
  const values = getTemplateValues(game, teamId);
  const message = replaceTemplate(setting.message_template || fallbackMessage, values) || fallbackMessage;
  const itemTeamIds = compact(teamIds || (teamId ? [teamId] : [game.awayTeamId, game.homeTeamId]));

  return {
    id: compact([setting.key, game.gameId, teamId || 'game']).join(':'),
    category: setting.key,
    eventId: game.gameId,
    gameId: game.gameId,
    teamId: teamId || null,
    teamIds: itemTeamIds,
    scheduledFor: scheduledFor.toISOString(),
    title: setting.label || 'WYBSL Reminder',
    message,
    audience,
    data: {
      route,
      gameId: game.gameId,
      teamId: teamId || undefined,
      teamIds: itemTeamIds,
      date: game.date,
      category: setting.key,
    },
    source: {
      gameTitle: game.title,
      gameDate: game.date,
      gameTime: values.gameTimeText,
      field: game.field,
      leagueName: game.leagueName,
      awayTeamId: game.awayTeamId,
      homeTeamId: game.homeTeamId,
    },
  };
};

const buildPlanItemsForGame = (game, settingsByKey) => {
  const items = [];

  const gameReminder = getSetting(settingsByKey, 'game_24_hour_reminder');
  if (gameReminder) {
    const scheduledFor = addMinutes(game.startsAt, Number(gameReminder.offset_minutes || 0));
    items.push(buildReminderItem({
      setting: gameReminder,
      game,
      teamId: null,
      scheduledFor,
      audience: {
        type: 'teams',
        teamIds: [game.awayTeamId, game.homeTeamId],
        recipientRoles: ['parent', 'coach'],
      },
      route: '/tabs/schedule',
      fallbackMessage: `${game.title} is scheduled for ${formatEasternTime(game.startsAt)}${game.field ? ` at ${game.field}` : ''}.`,
    }));
  }

  const lineupReminder = getSetting(settingsByKey, 'lineup_reminder');
  if (lineupReminder) {
    const teamIds = [game.awayTeamId, game.homeTeamId];
    const scheduledFor = addMinutes(game.startsAt, Number(lineupReminder.offset_minutes || 0));
    items.push(buildReminderItem({
      setting: lineupReminder,
      game,
      teamId: null,
      teamIds,
      scheduledFor,
      audience: {
        type: 'teams',
        teamIds,
        recipientRoles: ['coach'],
      },
      route: '/tabs/setGameLineup',
      fallbackMessage: `Reminder: set your lineup for ${game.title}.`,
    }));
  }

  const scoreReminder = getSetting(settingsByKey, 'score_submission_reminder');
  if (scoreReminder) {
    const teamIds = [game.awayTeamId, game.homeTeamId];
    const scheduledFor = addMinutes(game.startsAt, Number(scoreReminder.offset_minutes || 0));
    items.push(buildReminderItem({
      setting: scoreReminder,
      game,
      teamId: null,
      teamIds,
      scheduledFor,
      audience: {
        type: 'teams',
        teamIds,
        recipientRoles: ['coach'],
      },
      route: '/tabs/scorekeeping',
      fallbackMessage: `Reminder: submit the score for ${game.title}.`,
    }));
  }

  const attendanceReminder = getSetting(settingsByKey, 'attendance_reminder');
  if (attendanceReminder) {
    [game.awayTeamId, game.homeTeamId].forEach((teamId) => {
      const scheduledFor = addMinutes(game.startsAt, Number(attendanceReminder.offset_minutes || 0));
      items.push(buildReminderItem({
        setting: attendanceReminder,
        game,
        teamId,
        scheduledFor,
        audience: {
          type: 'teams',
          teamIds: [teamId],
          recipientRoles: ['parent'],
        },
        route: '/tabs/schedule',
        fallbackMessage: `Please update attendance for ${game.title}.`,
      }));
    });
  }

  return items;
};

const groupPlannedWork = (items) =>
  items.reduce((groups, item) => {
    const key = item.category || 'unknown';
    if (!groups[key]) {
      groups[key] = [];
    }
    groups[key].push(item);
    return groups;
  }, {});

const planDailyReminders = async ({ date, write, includePlannedWork }) => {
  const settings = await listReminderSettings();
  const settingsByKey = new Map(settings.map((setting) => [setting.key, setting]));
  const fetchStart = addDaysToDateString(date, -1);
  const fetchEnd = addDaysToDateString(date, 1);
  const schedulePayload = await sourceApiGet('schedules', { start: fetchStart, end: fetchEnd });
  const games = normalizeScheduleGames(schedulePayload);

  const items = games
    .flatMap((game) => buildPlanItemsForGame(game, settingsByKey))
    .filter((item) => {
      const scheduledFor = getPlanItemScheduledFor(item);
      return scheduledFor && formatEasternDate(scheduledFor) === date;
    })
    .sort((a, b) => String(a.scheduledFor).localeCompare(String(b.scheduledFor)));

  const redisKey = `${PLAN_KEY_PREFIX}:${date}`;
  const plan = {
    date,
    createdAt: new Date().toISOString(),
    fetchRange: {
      start: fetchStart,
      end: fetchEnd,
    },
    ttlSeconds: PLAN_TTL_SECONDS,
    settings: settings.map((setting) => ({
      key: setting.key,
      enabled: setting.enabled,
      offsetMinutes: setting.offset_minutes,
    })),
    sourceGameCount: games.length,
    items,
  };

  if (write) {
    await redisSet(redisKey, JSON.stringify(plan), PLAN_TTL_SECONDS);
    await archivePlanRecord({ date, redisKey, plan });
  }

  const response = {
    mode: 'plan',
    write,
    includePlannedWork,
    redisKey,
    redisStorageKey: withPrefix(redisKey),
    ttlSeconds: PLAN_TTL_SECONDS,
    date,
    fetchRange: plan.fetchRange,
    sourceGameCount: games.length,
    plannedItemCount: items.length,
    items,
  };

  if (includePlannedWork) {
    response.plannedWork = groupPlannedWork(items);
  }

  return response;
};

const dispatchDueItems = async ({ date, dryRun, now, windowMinutes, ignoreSendWindow, testTeamId }) => {
  if (Number.isNaN(now.getTime())) {
    const error = new Error('Invalid now value.');
    error.statusCode = 400;
    throw error;
  }

  const pushEnabled = await getPushNotificationsEnabled();
  const redisKey = `${PLAN_KEY_PREFIX}:${date}`;
  const rawPlan = await redisGet(redisKey);
  const plan = normalizePlan(rawPlan, date, redisKey);
  const earliestSendForDate = getEarliestSendForDate(date);
  const latestSendForDate = getLatestSendForDate(date);
  const dispatchLockedUntilEarliest = !ignoreSendWindow && now < earliestSendForDate;
  const dispatchLockedAfterLatest = !ignoreSendWindow && now > latestSendForDate;
  const normalWindowStart = addMinutes(now, -windowMinutes);
  const windowStart = dispatchLockedUntilEarliest
    ? now
    : !ignoreSendWindow && normalWindowStart < earliestSendForDate
      ? easternWallTimeToDate(date, '00:00:00') || normalWindowStart
      : normalWindowStart;
  const windowEnd = now;

  const dueCandidates = plan.items
    .map((item) => ({ item, scheduledFor: getPlanItemScheduledFor(item) }))
    .filter(({ scheduledFor }) =>
      scheduledFor &&
      !dispatchLockedUntilEarliest &&
      !dispatchLockedAfterLatest &&
      scheduledFor > windowStart &&
      scheduledFor <= windowEnd
    );
  const dispatchCandidates = dryRun
    ? plan.items
      .map((item) => ({ item, scheduledFor: getPlanItemScheduledFor(item) }))
      .filter(({ scheduledFor }) => Boolean(scheduledFor))
    : dueCandidates;

  const results = [];
  const dispatchedTestItemKeys = new Set();
  const audienceResolver = createPushAudienceResolver({ sourceApiGet });
  for (const { item, scheduledFor } of dispatchCandidates) {
    const inWindow = scheduledFor > windowStart && scheduledFor <= windowEnd;
    const dispatchItem = buildTestTeamDispatchItem(item, testTeamId);

    if (!dispatchItem) {
      continue;
    }

    if (testTeamId) {
      const { category, eventId, teamId } = getPlanItemIdentity(dispatchItem);
      const testItemKey = [category, eventId, teamId].map((value) => String(value ?? '')).join(':');
      if (dispatchedTestItemKeys.has(testItemKey)) {
        continue;
      }
      dispatchedTestItemKeys.add(testItemKey);
    }

    const existingRun = testTeamId ? null : await findExistingRun(dispatchItem);
    const existingRunStatus = existingRun?.metadata?.status;
    const canRetryExistingRun = ['failed', 'failed_audience_resolution'].includes(existingRunStatus);
    if (existingRun && !canRetryExistingRun) {
      results.push({
        status: 'skipped_existing_run',
        item: dispatchItem,
        scheduledFor: formatEasternDateTime(scheduledFor),
        inWindow,
        existingRun,
      });
      continue;
    }

    if (!pushEnabled) {
      results.push({
        status: dryRun ? 'would_skip_push_disabled' : 'skipped_push_disabled',
        item: dispatchItem,
        scheduledFor: formatEasternDateTime(scheduledFor),
        inWindow,
        testTeamId,
      });
      if (!dryRun && !testTeamId) {
        await insertRunRecord(dispatchItem, 'skipped_push_disabled', {}, existingRun);
      }
      continue;
    }

    let payloadResult;
    try {
      payloadResult = await buildSendPushPayload(dispatchItem, audienceResolver);
    } catch (error) {
      results.push({
        status: dryRun ? 'would_fail_audience_resolution' : 'failed_audience_resolution',
        item: dispatchItem,
        scheduledFor: formatEasternDateTime(scheduledFor),
        inWindow,
        testTeamId,
        error: error.message,
      });
      if (!dryRun && !testTeamId) {
        await insertRunRecord(dispatchItem, 'failed_audience_resolution', { error: error.message }, existingRun);
      }
      continue;
    }

    if (dryRun) {
      results.push({
        status: inWindow ? 'would_send' : 'would_not_send_outside_window',
        item: dispatchItem,
        scheduledFor: formatEasternDateTime(scheduledFor),
        inWindow,
        testTeamId,
        payload: payloadResult.payload,
        audienceResolution: payloadResult.audienceResolution,
      });
      continue;
    }

    try {
      const sendResult = await postSupabaseFunction('send-push', payloadResult.payload);
      if (!testTeamId) {
        await insertRunRecord(dispatchItem, 'sent', {
          sendResult,
          audienceResolution: payloadResult.audienceResolution,
        }, existingRun);
      }
      results.push({
        status: testTeamId ? 'sent_test_team' : 'sent',
        item: dispatchItem,
        scheduledFor: formatEasternDateTime(scheduledFor),
        inWindow,
        testTeamId,
        sendResult,
        audienceResolution: payloadResult.audienceResolution,
      });
    } catch (error) {
      if (!testTeamId) {
        await insertRunRecord(dispatchItem, 'failed', { error: error.message }, existingRun);
      }
      results.push({
        status: testTeamId ? 'failed_test_team' : 'failed',
        item: dispatchItem,
        scheduledFor: formatEasternDateTime(scheduledFor),
        inWindow,
        testTeamId,
        error: error.message,
      });
    }
  }

  return {
    mode: 'dispatch',
    dryRun,
    active: !dryRun,
    ignoreSendWindow,
    testMode: Boolean(testTeamId),
    testTeamId: testTeamId || null,
    pushEnabled,
    date,
    redisKey,
    redisStorageKey: withPrefix(redisKey),
    planFound: plan.found,
    planCreatedAt: plan.createdAt,
    totalPlannedItems: plan.items.length,
    earliestSendTime: formatEasternTime(earliestSendForDate),
    latestSendTime: formatEasternTime(latestSendForDate),
    dispatchLockedUntilEarliest,
    dispatchLockedAfterLatest,
    windowStart: formatEasternDateTime(windowStart),
    windowEnd: formatEasternDateTime(windowEnd),
    windowMinutes,
    dueCount: dueCandidates.length,
    resultCount: results.length,
    results,
  };
};

const getStatus = async ({ dryRun, now, windowMinutes }) => {
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

  return {
    mode: 'status',
    dryRun,
    active: false,
    pushEnabled,
    windowStart: formatEasternDateTime(windowStart),
    windowEnd: formatEasternDateTime(windowEnd),
    windowMinutes,
    enabledReminderTypes,
    plannedWork: [],
    note: 'Status mode only. Use mode=plan to build the Redis daily plan, then mode=dispatch to find due items.',
  };
};

const handlePushReminderWorker = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  assertCronAllowed(req);

  const options = await getRequestOptions(req);
  if (options.mode === 'status') {
    res.status(200).json(await getStatus(options));
    return;
  }

  if (options.mode === 'plan') {
    res.status(200).json(await planDailyReminders(options));
    return;
  }

  if (options.mode !== 'dispatch') {
    res.status(400).json({ error: `Unsupported mode: ${options.mode}`, supportedModes: ['status', 'plan', 'dispatch'] });
    return;
  }

  res.status(200).json(await dispatchDueItems(options));
};

module.exports = { handlePushReminderWorker };
