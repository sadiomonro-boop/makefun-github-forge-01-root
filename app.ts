// The forge's HTTP server: health probe, git smart HTTP, REST v3, GraphQL v4
// and MCP. Every API route needs Authorization: Bearer $MAKEFUN_SHOP_TOKEN;
// /healthz takes none. Unknown routes answer a JSON 404, never HTML.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { advertisementV2, handleInfoRefs, handleReceivePack, handleUploadPack } from './gitproto.ts';
import { pktLine, PKT_FLUSH } from './git.ts';
import { nextRequestId, store } from './store.ts';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const MAX_BODY_BYTES = 128 * 1024 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  });
  res.end(text);
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function decodeSegment(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** The bearer token on the request, or null. */
function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers['authorization'];
  if (typeof header !== 'string') return null;
  const m = /^Bearer\s+(.+)$/.exec(header.trim());
  return m === null ? null : (m[1] as string);
}

/** True when the request carries the shop token. With no token configured
 *  (local runs), any non-empty bearer passes; a missing bearer never does. */
function authorized(req: IncomingMessage): boolean {
  const token = bearerToken(req);
  if (token === null || token === '') return false;
  if (TOKEN === '') return true;
  return token === TOKEN;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        failed = true;
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (!failed) {
        failed = true;
        reject(err);
      }
    });
  });
}

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        await handle(req, res);
      } catch (err) {
        // Never crash the server on a bad request: answer 500 and stay up.
        try {
          sendJson(res, 500, { message: 'Internal Server Error' });
        } catch {
          // The socket is gone; nothing more to do.
        }
        void err;
      }
    })();
  });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = pathOf(req);
  const method = req.method ?? 'GET';
  const segments = path.split('/').filter((s) => s !== '').map(decodeSegment);

  // The env's boot check calls this twice: 200 {"ok": true}, no auth.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // REST v3.
  if (segments[0] === 'api' && segments[1] === 'v3') {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const rawBody = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
    let body: unknown = null;
    if (rawBody.length > 0) {
      try {
        body = JSON.parse(rawBody.toString('utf8'));
      } catch {
        sendJson(res, 400, { message: 'Malformed JSON in request body' });
        return;
      }
    }
    const origin = `http://${req.headers.host ?? '127.0.0.1'}`;
    await handleRest({
      req,
      res,
      segments: segments.slice(2),
      query: queryOf(req),
      body,
      origin,
    });
    return;
  }

  // GraphQL v4.
  if (segments[0] === 'api' && segments[1] === 'graphql' && segments.length === 2) {
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const rawBody = await readBody(req);
    let body: unknown;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      sendJson(res, 400, { message: 'Malformed JSON in request body' });
      return;
    }
    const result = handleGraphQL(body);
    sendJson(res, 200, result);
    return;
  }

  // MCP.
  if (segments[0] === 'mcp' && segments.length === 1) {
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const rawBody = await readBody(req);
    handleMcp(req, res, rawBody);
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  if (segments.length >= 2 && segments[1]?.endsWith('.git') === true) {
    const owner = segments[0] as string;
    const repoName = (segments[1] as string).slice(0, -4);
    const rest = segments.slice(2);
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (method === 'GET' && rest[0] === 'info' && rest[1] === 'refs') {
      const service = queryOf(req).get('service');
      const protocol = req.headers['git-protocol'];
      if (service === 'git-upload-pack' && typeof protocol === 'string' && protocol.includes('version=2')) {
        // Protocol v2 advertisement: the service preamble, then "version 2".
        // pktLine/PKT_FLUSH come from the static import above (no per-request import).
        const preamble = Buffer.concat([
          pktLine('# service=git-upload-pack\n'),
          PKT_FLUSH,
          advertisementV2(),
        ]);
        res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement' });
        res.end(preamble);
        return;
      }
      handleInfoRefs(repo, service, res);
      return;
    }
    if (method === 'POST' && rest[0] === 'git-upload-pack') {
      const rawBody = await readBody(req);
      handleUploadPack(repo, req, rawBody, res);
      return;
    }
    if (method === 'POST' && rest[0] === 'git-receive-pack') {
      const rawBody = await readBody(req);
      handleReceivePack(repo, rawBody, res);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // Everything else: GitHub's JSON 404.
  sendJson(res, 404, { message: 'Not Found' });
}
