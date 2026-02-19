const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const { createClient } = require('redis');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const REDIS_URL = process.env.REDIS_URL || '';
const PDF_ROOT =
  process.env.UMPBOT_PDF_ROOT ||
  path.resolve(__dirname, '../files/UmpBot');

let redisClient;

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

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const ensureRedisClient = async () => {
  if (!REDIS_URL) {
    return null;
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

const buildTaskFromFields = ({
  season,
  sport,
  age_range,
  teeball_level,
  question,
  message,
}) => {
  if (season && sport && (age_range || teeball_level || question)) {
    const parts = [`Season: ${season}`, `Sport: ${sport}`];
    if (age_range) {
      parts.push(`Age Range: ${age_range}`);
    }
    if (teeball_level) {
      parts.push(`Tee Ball Level: ${teeball_level}`);
    }
    if (question) {
      parts.push(`Question: ${question}`);
    }
    return parts.join(', ');
  }

  return message || '';
};

const extractField = (task, label) => {
  const match = task.match(new RegExp(`${escapeRegExp(label)}:\\s*([^,]+)`, 'i'));
  return match ? match[1].trim() : null;
};

const normalizeAgeRange = (value) => {
  if (!value) {
    return null;
  }

  const direct = value.match(/u?\d{1,2}/i);
  if (!direct) {
    return null;
  }

  const num = direct[0].replace(/[^0-9]/g, '');
  return `U${num}`;
};

const normalizeTeeballLevel = (value) => {
  if (!value) {
    return null;
  }
  if (/2|ii/i.test(value)) {
    return 'II';
  }
  if (/1|i/i.test(value)) {
    return 'I';
  }
  return null;
};

const normalizeSeason = (value) => {
  if (!value) {
    return null;
  }
  return value.toString().trim().replace(/^\w/, (char) => char.toUpperCase());
};

const normalizeSport = (value) => {
  if (!value) {
    return null;
  }
  const normalized = value.toString().trim().toLowerCase();
  if (normalized.includes('tee')) {
    return 'Teeball';
  }
  if (normalized.includes('soft')) {
    return 'Softball';
  }
  if (normalized.includes('base')) {
    return 'Baseball';
  }
  return null;
};

const extractContext = (task) => ({
  season: extractField(task, 'Season'),
  sport: extractField(task, 'Sport'),
  age_range: normalizeAgeRange(extractField(task, 'Age Range')),
  teeball_level: normalizeTeeballLevel(extractField(task, 'Tee Ball Level')),
  question: extractField(task, 'Question'),
});

const listPdfFiles = async (root) => {
  const entries = await fs.promises.readdir(root, { withFileTypes: true });
  const results = [];

  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await listPdfFiles(fullPath)));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.pdf')) {
      results.push(fullPath);
    }
  }

  return results;
};

const relativePosix = (filePath, root) =>
  path.relative(root, filePath).split(path.sep).join('/');

const allLeagueRules = (filePath) => /ALL-LEAGUE-RULES/i.test(filePath);

const selectPdfFiles = async (context) => {
  const season = normalizeSeason(context.season);
  const sport = normalizeSport(context.sport);
  const ageRange = context.age_range;
  const teeballLevel = context.teeball_level;

  const allFiles = await listPdfFiles(PDF_ROOT);
  const rootFiles = allFiles.filter((file) => !relativePosix(file, PDF_ROOT).includes('/'));
  const selected = new Set(rootFiles);

  if (season) {
    allFiles
      .filter((file) => relativePosix(file, PDF_ROOT).startsWith(`${season}/`))
      .forEach((file) => selected.add(file));

    if (sport) {
      allFiles
        .filter((file) => relativePosix(file, PDF_ROOT).startsWith(`${season}/${sport}/`))
        .forEach((file) => selected.add(file));
    }
  } else {
    allFiles.forEach((file) => selected.add(file));
  }

  let results = Array.from(selected);

  if (ageRange) {
    const ageRegex = new RegExp(escapeRegExp(ageRange), 'i');
    results = results.filter((file) => ageRegex.test(file) || allLeagueRules(file));
  }

  if (sport === 'Teeball' && teeballLevel) {
    const levelRegex = new RegExp(`Tee-?Ball-?${escapeRegExp(teeballLevel)}`, 'i');
    const teeRegex = /Tee-?Ball/i;
    results = results.filter((file) => levelRegex.test(file) || !teeRegex.test(file));
  }

  const alwaysInclude = [
    path.join(PDF_ROOT, 'Weather-Policy-rev-Feb-2023.pdf'),
    path.join(PDF_ROOT, 'TieBreakerS2013.pdf'),
  ];

  alwaysInclude.forEach((file) => {
    if (fs.existsSync(file)) {
      results.push(file);
    }
  });

  if (season) {
    allFiles
      .filter((file) => {
        const relative = relativePosix(file, PDF_ROOT);
        return relative.startsWith(`${season}/`) && allLeagueRules(path.basename(file));
      })
      .forEach((file) => results.push(file));
  }

  return Array.from(new Set(results));
};

const fetchPdfText = async (filePath, redis) => {
  const stat = await fs.promises.stat(filePath);
  const relative = relativePosix(filePath, PDF_ROOT);
  const cacheKey = `umpbot:pdf:${relative}:${Math.floor(stat.mtimeMs / 1000)}`;

  if (redis) {
    const cached = await redis.get(cacheKey);
    if (cached) {
      return cached;
    }
  }

  const buffer = await fs.promises.readFile(filePath);
  const parsed = await pdfParse(buffer);
  const text = parsed.text || '';

  if (redis) {
    await redis.set(cacheKey, text);
  }

  return text;
};

const readTextBrain = async () => {
  const entries = await fs.promises.readdir(PDF_ROOT, { withFileTypes: true });
  const textFiles = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.txt'))
    .map((entry) => path.join(PDF_ROOT, entry.name));

  const texts = await Promise.all(textFiles.map((file) => fs.promises.readFile(file, 'utf8')));
  return texts.join('');
};

const buildPrompt = (task, textBrain, pdfBrain) => `
Use the following data only. Use no external knowledge, even things that may sound common or assumed.

${textBrain}
${pdfBrain}

Only respond in regards to the 'task' statement. No others.
${task}
Organize your response in the format of "The provided statement is true or false because of 'reason' . Always include and attribute to the referenced rule."
`;

const generateModelResponse = async (prompt) => {
  if (!GEMINI_API_KEY) {
    throw new Error('Missing GEMINI_API_KEY.');
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
      }),
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`UmpBot API error (${response.status}): ${body}`);
  }

  const data = await response.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
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
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  try {
    if (!fs.existsSync(PDF_ROOT)) {
      res.status(500).json({ error: `PDF root not found: ${PDF_ROOT}` });
      return;
    }

    const payload = await parsePayload(req);
    const task = buildTaskFromFields(payload);

    if (!task) {
      res.status(400).json({ error: 'Missing task payload.' });
      return;
    }

    let redis = null;
    try {
      redis = await ensureRedisClient();
    } catch (error) {
      console.error('Redis init failed, continuing without cache:', error.message);
    }

    const context = extractContext(task);
    const pdfFiles = await selectPdfFiles(context);
    const textBrain = await readTextBrain();

    let pdfBrain = '';
    for (const filePath of pdfFiles) {
      pdfBrain += await fetchPdfText(filePath, redis);
    }

    const prompt = buildPrompt(task, textBrain, pdfBrain);
    const text = await generateModelResponse(prompt);

    res.status(200).json({ text });
  } catch (error) {
    res.status(500).json({ error: `UmpBot error: ${error.message}` });
  }
};
