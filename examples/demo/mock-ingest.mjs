/**
 * Mock server for the SDK demo. It fakes the two backend surfaces the real
 * system splits across the dashboard and the ingest API:
 *
 *   POST /v1/sessions          -> mints { session_id, session_jwt }   (dashboard's job)
 *   POST /v1/ingest/events     -> accepts a batch of proctoring events (ingest API)
 *   POST /v1/ingest/frames     -> accepts a keyframe, writes it to .captures/ (ingest API)
 *
 * It also serves the built SDK (/dist) and the demo host page (/). Bind to
 * 0.0.0.0 so the page loads from http://localhost:PORT while the enclave iframe
 * loads from http://127.0.0.1:PORT — two origins, exercising cross-origin
 * postMessage exactly like production.
 *
 * NOT production code: the JWT is unsigned, there is no auth, no persistence
 * beyond dumped frames. It exists only to make the demo run end-to-end.
 */
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const CAPTURES = join(__dirname, '.captures');
const PORT = process.env.PORT ? Number(process.env.PORT) : 4599;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json', '.json': 'application/json' };

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}
function fakeJwt(sessionId) {
  // Unsigned, demo-only. Real JWTs are signed by the dashboard.
  const header = b64url({ alg: 'none', typ: 'JWT' });
  const payload = b64url({ sid: sessionId, exp: Math.floor(Date.now() / 1000) + 3600 });
  return `${header}.${payload}.`;
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

function cors(res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type,authorization');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
}

let frameCount = 0;
let eventCount = 0;

const server = createServer(async (req, res) => {
  cors(res);
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  // --- mock dashboard: mint a session ---
  if (req.method === 'POST' && path === '/v1/sessions') {
    const sessionId = randomUUID();
    res.writeHead(201, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ session_id: sessionId, session_jwt: fakeJwt(sessionId) }));
  }

  // --- mock ingest: events ---
  if (req.method === 'POST' && path === '/v1/ingest/events') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const n = body.events?.length ?? 0;
    eventCount += n;
    console.log(`[ingest] +${n} events (total ${eventCount})  ${(body.events || []).map((e) => e.type).join(', ')}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, accepted: n }));
  }

  // --- mock ingest: frames (written to .captures for the "share images later" story) ---
  if (req.method === 'POST' && path === '/v1/ingest/frames') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const m = /^data:image\/\w+;base64,(.+)$/.exec(body.image || '');
    if (m) {
      await mkdir(CAPTURES, { recursive: true });
      const file = join(CAPTURES, `${body.sessionId}_${String(body.seq).padStart(4, '0')}.jpg`);
      await writeFile(file, Buffer.from(m[1], 'base64'));
      frameCount++;
      console.log(`[ingest] frame #${body.seq} -> ${file}`);
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  // --- static files (demo host page + built SDK) ---
  let rel = path === '/' ? '/examples/demo/host.html' : path;
  const filePath = normalize(join(ROOT, rel));
  if (!filePath.startsWith(ROOT) || !existsSync(filePath)) {
    res.writeHead(404); return res.end('not found');
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'content-type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(500); res.end('error');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\nProctorLink demo running:`);
  console.log(`  host page : http://localhost:${PORT}/`);
  console.log(`  enclave   : http://127.0.0.1:${PORT}/dist/enclave/enclave.html`);
  console.log(`  frames    -> ${CAPTURES}\n`);
});
