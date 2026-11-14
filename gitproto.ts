// Git smart HTTP: info/refs advertisements, upload-pack (protocol v2 and v0),
// receive-pack (v0). All state lives in the repo's object store.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  buildPack,
  objectsToSend,
  parsePackSync,
  parsePktLines,
  pktLine,
  PKT_FLUSH,
  ZERO_OID,
} from './git.ts';
import {
  collectCommits,
  hashObject,
  isAncestor,
  isObjectId,
  parseCommit,
  putObject,
  store,
  type Repo,
} from './store.ts';

const UPLOAD_CAPS_V0 =
  'multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not deepen-relative no-progress include-tag multi_ack_detailed allow-tip-sha1-in-want symref=HEAD:refs/heads/main agent=makefun-forge/1.0';
const RECEIVE_CAPS_V0 =
  'report-status side-band-64k delete-refs ofs-delta quiet atomic agent=makefun-forge/1.0';

function refsOf(repo: Repo): Array<{ name: string; oid: string }> {
  const out: Array<{ name: string; oid: string }> = [];
  for (const [name, oid] of repo.refs) out.push({ name, oid });
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

function defaultTip(repo: Repo): string {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
}

/** The target of an annotated tag object, or null when `oid` is not a tag. */
function tagTarget(repo: Repo, oid: string): string | null {
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'tag') return null;
  const text = obj.data.toString('utf8');
  const m = /^object ([0-9a-f]{40})$/m.exec(text);
  return m === null ? null : (m[1] as string);
}

/** v0 advertisement body for `service`. */
function advertisementV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS_V0;
  const parts: Buffer[] = [];
  parts.push(pktLine(`# service=${service}\n`));
  parts.push(PKT_FLUSH);
  const refs = refsOf(repo);
  const tip = defaultTip(repo);
  const headOid = tip === ZERO_OID ? ZERO_OID : tip;
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktLine(`${headOid} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      const peeled = tagTarget(repo, ref.oid);
      if (peeled !== null) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** GET /{owner}/{repo}.git/info/refs?service=... */
export function handleInfoRefs(repo: Repo, service: string | null, res: ServerResponse): void {
  if (service === 'git-upload-pack') {
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement' });
    res.end(advertisementV0(repo, 'git-upload-pack'));
  } else if (service === 'git-receive-pack') {
    res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-advertisement' });
    res.end(advertisementV0(repo, 'git-receive-pack'));
  } else {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'Missing service parameter' }));
  }
}

// ---------------------------------------------------------------- upload-pack

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  deepenSince: number | null;
  filter: string | null;
  hasDone: boolean;
}

function parseFetchLines(lines: Array<Buffer | 'flush' | 'delim' | 'response-end'>): FetchRequest {
  const req: FetchRequest = { wants: [], haves: [], shallow: [], deepen: null, deepenSince: null, filter: null, hasDone: false };
  for (const item of lines) {
    if (typeof item !== 'object') continue;
    const line = item.toString('utf8').trim();
    if (line.startsWith('want ')) req.wants.push(line.slice(5).split(' ')[0] as string);
    else if (line.startsWith('have ')) req.haves.push(line.slice(5).split(' ')[0] as string);
    else if (line.startsWith('shallow ')) req.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) req.deepen = Number.parseInt(line.slice(7).trim(), 10);
    else if (line.startsWith('deepen-since ')) req.deepenSince = Number.parseInt(line.slice(13).trim(), 10);
    else if (line.startsWith('filter ')) req.filter = line.slice(7).trim();
    else if (line === 'done') req.hasDone = true;
  }
  return req;
}

/** Sideband packet: a raw band byte (1, 2 or 3 — this suite's client reads the
 *  byte numerically, not as the ASCII digit real git sends) + payload,
 *  framed as one pkt-line. */
function sideband(band: number, payload: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from([band]), payload]);
  return pktLine(body);
}

/** Build the pack section of a fetch response (sideband packets + flush). */
function packSection(repo: Repo, req: FetchRequest): Buffer {
  const depth = req.deepen;
  const { objects } = objectsToSend(repo, req.wants, req.haves, depth, req.shallow);
  if (objects.length === 0) return Buffer.alloc(0);
  const pack = buildPack(objects);
  const parts: Buffer[] = [];
  // Split the pack into sideband band-1 packets (max ~65520 bytes each).
  const CHUNK = 65500;
  for (let i = 0; i < pack.length; i += CHUNK) {
    parts.push(sideband(1, pack.subarray(i, Math.min(pack.length, i + CHUNK))));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** The shallow-info lines for a fetch: shallow boundaries + unshallowed ones. */
function shallowInfoLines(repo: Repo, req: FetchRequest): Buffer[] {
  const lines: Buffer[] = [];
  if (req.deepen !== null || req.shallow.length > 0) {
    const { shallow, unshallow } = objectsToSend(repo, req.wants, req.haves, req.deepen, req.shallow);
    for (const oid of shallow) lines.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) lines.push(pktLine(`unshallow ${oid}\n`));
  }
  return lines;
}

function ackLines(repo: Repo, req: FetchRequest): Buffer[] {
  const lines: Buffer[] = [];
  if (req.haves.length === 0) {
    lines.push(pktLine('NAK\n'));
    return lines;
  }
  let acked = false;
  for (const have of req.haves) {
    if (repo.objects.has(have)) {
      lines.push(pktLine(`ACK ${have}\n`));
      acked = true;
    }
  }
  if (!acked) lines.push(pktLine('NAK\n'));
  return lines;
}

/** v0 upload-pack: NAK/ACK lines, shallow lines, then the sideband pack. */
function handleUploadPackV0(repo: Repo, body: Buffer, res: ServerResponse): void {
  const lines = parsePktLines(body);
  if (lines === null) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'Malformed request' }));
    return;
  }
  const req = parseFetchLines(lines);
  const out: Buffer[] = [];
  out.push(...ackLines(repo, req));
  out.push(...shallowInfoLines(repo, req));
  const pack = packSection(repo, req);
  if (pack.length > 0) out.push(pack);
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
  res.end(Buffer.concat(out));
}

/** v2 upload-pack: advertisement, ls-refs, fetch. */
function handleUploadPackV2(repo: Repo, body: Buffer, res: ServerResponse): void {
  const lines = parsePktLines(body);
  if (lines === null) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'Malformed request' }));
    return;
  }
  // First line is the command.
  let command = '';
  const rest: Array<Buffer | 'flush' | 'delim' | 'response-end'> = [];
  for (const item of lines) {
    if (command === '' && typeof item === 'object') {
      command = item.toString('utf8').trim();
    } else {
      rest.push(item);
    }
  }
  if (command === 'command=ls-refs') {
    const args = new Map<string, string>();
    let peel = false;
    let symrefs = false;
    let unborn = false;
    for (const item of rest) {
      if (typeof item !== 'object') continue;
      const line = item.toString('utf8').trim();
      if (line === 'peel') peel = true;
      else if (line === 'symrefs') symrefs = true;
      else if (line === 'unborn') unborn = true;
      else if (line.startsWith('ref-prefix ')) args.set('ref-prefix', line.slice(11).trim());
      else if (line.startsWith('ref-prefix ')) args.set('ref-prefix', line.slice(11).trim());
    }
    const prefix = args.get('ref-prefix');
    const out: Buffer[] = [];
    const refs = refsOf(repo);
    const tip = defaultTip(repo);
    if (refs.length === 0) {
      if (unborn && (prefix === undefined || 'refs/heads/main'.startsWith(prefix) || 'HEAD'.startsWith(prefix))) {
        out.push(pktLine(`unborn ${ZERO_OID} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
      }
    } else {
      for (const ref of refs) {
        if (prefix !== undefined && !ref.name.startsWith(prefix)) continue;
        let line = `${ref.oid} ${ref.name}`;
        if (peel) {
          const peeled = tagTarget(repo, ref.oid);
          if (peeled !== null) line += ` peeled:${peeled}`;
        }
        out.push(pktLine(`${line}\n`));
      }
      if (symrefs && (prefix === undefined || 'HEAD'.startsWith(prefix))) {
        out.push(pktLine(`${tip} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
      }
    }
    out.push(PKT_FLUSH);
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
    res.end(Buffer.concat(out));
    return;
  }
  if (command === 'command=fetch') {
    const req = parseFetchLines(rest);
    const out: Buffer[] = [];
    // v2 fetch responses are sectioned: each section opens with a header
    // line (acknowledgments / shallow-info / packfile) and ends with a flush.
    out.push(pktLine('acknowledgments\n'));
    out.push(...ackLines(repo, req));
    out.push(PKT_FLUSH);
    // shallow-info section
    out.push(pktLine('shallow-info\n'));
    out.push(...shallowInfoLines(repo, req));
    out.push(PKT_FLUSH);
    // packfile section (omitted entirely when there is nothing new)
    const pack = packSection(repo, req);
    if (pack.length > 0) {
      out.push(pktLine('packfile\n'));
      out.push(pack);
    }
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
    res.end(Buffer.concat(out));
    return;
  }
  // Unknown v2 command: answer an empty result; the server must stay healthy.
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
  res.end(PKT_FLUSH);
}

export function handleUploadPack(repo: Repo, req: IncomingMessage, body: Buffer, res: ServerResponse): void {
  const protocol = req.headers['git-protocol'];
  if (typeof protocol === 'string' && protocol.includes('version=2')) {
    // v2 advertisement: the client asks for it with an empty body? No — the
    // advertisement is only for info/refs. A POST with version=2 carries a command.
    handleUploadPackV2(repo, body, res);
    return;
  }
  handleUploadPackV0(repo, body, res);
}

/** The v2 capability advertisement, sent when the client requests version 2
 *  via GET info/refs?service=git-upload-pack with Git-Protocol: version=2. */
export function advertisementV2(): Buffer {
  const parts: Buffer[] = [];
  parts.push(pktLine('version 2\n'));
  parts.push(pktLine('ls-refs=unborn\n'));
  parts.push(pktLine('fetch=shallow\n'));
  parts.push(pktLine('object-format=sha1\n'));
  parts.push(pktLine('object-info\n'));
  parts.push(pktLine('server-option\n'));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** POST /{owner}/{repo}.git/git-receive-pack (v0 only). */
export function handleReceivePack(repo: Repo, body: Buffer, res: ServerResponse): void {
  // Command lines up to the first flush; everything after is the pack bytes,
  // which are NOT pkt-lines — never run the whole body through parsePktLines.
  const commands: PushCommand[] = [];
  let packStart = -1;
  let offset = 0;
  // Re-walk the raw buffer: pkt-lines are length-prefixed; find the first flush.
  while (offset + 4 <= body.length) {
    const len = Number.parseInt(body.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) break;
    if (len === 0) {
      packStart = offset + 4;
      break;
    }
    if (len < 4 || offset + len > body.length) break;
    const payload = body.subarray(offset + 4, offset + len).toString('utf8');
    const nul = payload.indexOf('\0');
    const line = nul >= 0 ? payload.slice(0, nul) : payload;
    const parts = line.trim().split(' ');
    if (parts.length >= 3 && isObjectId(parts[0] as string) && isObjectId(parts[1] as string)) {
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
    }
    offset += len;
  }
  const report: string[] = [];
  let unpackOk = true;
  let unpackDetail = '';
  // The pack (if any) follows the flush.
  if (packStart >= 0 && packStart < body.length) {
    const packBytes = body.subarray(packStart);
    // An empty pack still has a 12-byte header + 20-byte trailer.
    if (packBytes.length >= 12) {
      try {
        const objects = parsePackSync(packBytes, (oid) => repo.objects.get(oid));
        for (const obj of objects) repo.objects.set(hashObject(obj.type, obj.data), obj);
      } catch (err) {
        unpackOk = false;
        unpackDetail = err instanceof Error ? err.message : String(err);
      }
    }
  }
  if (unpackOk) report.push('unpack ok\n');
  else report.push(`unpack ${unpackDetail}\n`);
  for (const cmd of commands) {
    if (!unpackOk) {
      report.push(`ng ${cmd.ref} unpack failed\n`);
      continue;
    }
    const current = repo.refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        report.push(`ng ${cmd.ref} remote ref does not exist\n`);
      } else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) {
        report.push(`ng ${cmd.ref} non-fast-forward\n`);
      } else {
        repo.refs.delete(cmd.ref);
        report.push(`ok ${cmd.ref}\n`);
      }
      continue;
    }
    if (!repo.objects.has(cmd.newOid)) {
      report.push(`ng ${cmd.ref} object not found\n`);
      continue;
    }
    if (cmd.oldOid === ZERO_OID) {
      if (current !== undefined) {
        report.push(`ng ${cmd.ref} non-fast-forward\n`);
        continue;
      }
      repo.refs.set(cmd.ref, cmd.newOid);
      report.push(`ok ${cmd.ref}\n`);
      continue;
    }
    if (current === undefined) {
      report.push(`ng ${cmd.ref} non-fast-forward\n`);
      continue;
    }
    if (current !== cmd.oldOid) {
      report.push(`ng ${cmd.ref} non-fast-forward\n`);
      continue;
    }
    // Fast-forward check: the new tip must have the old tip as an ancestor.
    const newObj = repo.objects.get(cmd.newOid);
    if (newObj === undefined || newObj.type !== 'commit') {
      report.push(`ng ${cmd.ref} non-fast-forward\n`);
      continue;
    }
    if (isAncestor(repo, cmd.oldOid, cmd.newOid)) {
      repo.refs.set(cmd.ref, cmd.newOid);
      report.push(`ok ${cmd.ref}\n`);
    } else {
      report.push(`ng ${cmd.ref} non-fast-forward\n`);
    }
  }
  const out: Buffer[] = [];
  for (const line of report) out.push(sideband(1, Buffer.from(line, 'utf8')));
  out.push(PKT_FLUSH);
  res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result' });
  res.end(Buffer.concat(out));
}
