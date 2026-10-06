/**
 * The smallest backend that can run a ProctorLink session.
 *
 *   PROCTORLINK_ACCESS_TOKEN=… PROCTORLINK_SECRET_TOKEN=… node server.mjs
 *   → http://localhost:4300
 *
 * It does two things: serve index.html, and mint sessions. Minting lives here
 * because it needs the API key, and the API key must never reach the browser.
 *
 * No dependencies. Node 20+.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || 4300);
const API = process.env.PROCTORLINK_API_URL || 'https://api.proctorlink.com';
const ACCESS = process.env.PROCTORLINK_ACCESS_TOKEN;
const SECRET = process.env.PROCTORLINK_SECRET_TOKEN;
const ORIGIN = process.env.APP_ORIGIN || `http://localhost:${PORT}`;

if (!ACCESS || !SECRET) {
  console.error('Set PROCTORLINK_ACCESS_TOKEN and PROCTORLINK_SECRET_TOKEN.');
  console.error('Create a pair in the dashboard under Developers -> SDK applications.');
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));

const readBody = async (req) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
};

const server = createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/api/session') {
    const body = JSON.parse((await readBody(req)) || '{}');

    // A real implementation authenticates the candidate first and takes the
    // identifiers from its own attempt record, never from the request body.
    const upstream = await fetch(`${API}/v1/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'access-token': ACCESS,
        'secret-token': SECRET,
      },
      body: JSON.stringify({
        external_user_id: body.external_user_id,
        exam_id: body.exam_id,
        // Same attempt_id on a later mint resumes this session rather than
        // starting a second one.
        attempt_id: body.attempt_id,
        // Must list the origin the exam page is served from, or ingest fails CORS.
        allowed_origins: [ORIGIN],
      }),
    });

    const text = await upstream.text();
    if (!upstream.ok) console.error('[mint] failed', upstream.status, text);
    res.writeHead(upstream.status, { 'content-type': 'application/json' });
    return res.end(text); // { session_id, session_jwt } passed straight through
  }

  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    const html = await readFile(resolve(here, 'index.html'));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  res.writeHead(404).end('not found');
});

server.listen(PORT, () => {
  console.log(`exam page   http://localhost:${PORT}`);
  console.log(`minting via ${API}/v1/sessions`);
});
