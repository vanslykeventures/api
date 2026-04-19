const fs = require('fs');
const path = require('path');

const FILES_ROOT = path.resolve(process.cwd(), 'files');
const PUBLIC_ROOT = path.join(FILES_ROOT, 'Bats');

const MIME_TYPES = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

const normalizeSegments = (rawPath) =>
  rawPath
    .split('/')
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));

const resolvePathCaseInsensitive = async (segments) => {
  let currentDir = PUBLIC_ROOT;

  for (const segment of segments) {
    const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
    const exact = entries.find((entry) => entry.name === segment);
    const matched =
      exact ||
      entries.find((entry) => entry.name.toLowerCase() === segment.toLowerCase());

    if (!matched) {
      return null;
    }

    currentDir = path.join(currentDir, matched.name);
  }

  return currentDir;
};

const isPathInsideRoot = (candidatePath) => {
  const relative = path.relative(PUBLIC_ROOT, candidatePath);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (!['GET', 'HEAD'].includes(req.method)) {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  try {
    const rawPath = Array.isArray(req.query.path)
      ? req.query.path.join('/')
      : req.query.path || '';
    const segments = normalizeSegments(rawPath);

    if (segments.length === 0 || segments.some((segment) => segment === '.' || segment === '..')) {
      res.status(400).json({ error: 'Invalid file path.' });
      return;
    }

    if (segments.length !== 1) {
      res.status(403).json({ error: 'Forbidden.' });
      return;
    }

    const filePath = await resolvePathCaseInsensitive(segments);

    if (!filePath || !isPathInsideRoot(filePath)) {
      res.status(404).json({ error: 'File not found.' });
      return;
    }

    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) {
      res.status(404).json({ error: 'File not found.' });
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    if (extension !== '.pdf') {
      res.status(403).json({ error: 'Forbidden.' });
      return;
    }
    const contentType = MIME_TYPES[extension] || 'application/octet-stream';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Cache-Control', 'public, max-age=300');
    if (extension === '.pdf') {
      res.setHeader('Content-Disposition', 'inline');
    }

    if (req.method === 'HEAD') {
      res.status(200).end();
      return;
    }

    const buffer = await fs.promises.readFile(filePath);
    res.status(200).send(buffer);
  } catch (error) {
    res.status(500).json({ error: `File route error: ${error.message}` });
  }
};
