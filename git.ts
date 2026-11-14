// Git wire formats: pkt-line framing, packfile parsing (with REF_DELTA and
// OFS_DELTA resolution) and packfile generation (plain objects, no deltas).

import { inflateSync, deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { hashObject, parseCommit, parseTree, type GitObject, type GitObjectType, type Repo } from './store.ts';

export const ZERO_OID = '0000000000000000000000000000000000000000';

/** The target of an annotated tag object's bytes, or null. */
export function tagTargetOid(tagData: Buffer): string | null {
  const m = /^object ([0-9a-f]{40})$/m.exec(tagData.toString('utf8'));
  return m === null ? null : (m[1] as string);
}

// ---------------------------------------------------------------- pkt-lines

/** Encode one pkt-line (payload without length). `flush` is the 0000 packet. */
export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

/** Split a buffer into pkt-line payloads. Returns null on malformed input.
 *  Each item is either a payload Buffer or the marker 'flush' | 'delim' | 'response-end'. */
export function parsePktLines(buf: Buffer): Array<Buffer | 'flush' | 'delim' | 'response-end'> | null {
  const out: Array<Buffer | 'flush' | 'delim' | 'response-end'> = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) return null;
    const lenHex = buf.subarray(offset, offset + 4).toString('ascii');
    const len = Number.parseInt(lenHex, 16);
    if (Number.isNaN(len)) return null;
    if (len === 0) {
      out.push('flush');
      offset += 4;
    } else if (len === 1) {
      out.push('delim');
      offset += 4;
    } else if (len === 2) {
      out.push('response-end');
      offset += 4;
    } else {
      if (offset + len > buf.length) return null;
      out.push(buf.subarray(offset + 4, offset + len));
      offset += len;
    }
  }
  return out;
}

// ---------------------------------------------------------------- pack parsing

interface PackObjectHeader {
  type: number;
  size: number;
  headerLen: number;
}

/** Read a pack object header at `offset`: varint type+size. */
function readPackHeader(buf: Buffer, offset: number): PackObjectHeader {
  let byte = buf[offset] as number;
  const type = (byte >> 4) & 0x7;
  let size = byte & 0x0f;
  let shift = 4;
  let pos = offset + 1;
  while ((byte & 0x80) !== 0) {
    byte = buf[pos] as number;
    size |= (byte & 0x7f) << shift;
    shift += 7;
    pos += 1;
  }
  return { type, size, headerLen: pos - offset };
}

/** Read an OFS_DELTA negative offset varint at `offset`. Returns [offset, bytesRead]. */
function readOfsOffset(buf: Buffer, offset: number): [number, number] {
  let byte = buf[offset] as number;
  let value = byte & 0x7f;
  let pos = offset + 1;
  while ((byte & 0x80) !== 0) {
    byte = buf[pos] as number;
    value = ((value + 1) << 7) | (byte & 0x7f);
    pos += 1;
  }
  return [value, pos - offset];
}

/** Read a delta size varint. */
function readDeltaSize(buf: Buffer, offset: number): [number, number] {
  let value = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    const byte = buf[pos] as number;
    value |= (byte & 0x7f) << shift;
    shift += 7;
    pos += 1;
    if ((byte & 0x80) === 0) break;
  }
  return [value, pos - offset];
}

/** Apply a git delta to `base`, returning the result. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const [baseSize, n1] = readDeltaSize(delta, 0);
  const [resultSize, n2] = readDeltaSize(delta, n1);
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let outLen = 0;
  let pos = n1 + n2;
  while (pos < delta.length) {
    const op = delta[pos] as number;
    pos += 1;
    if ((op & 0x80) !== 0) {
      let copyOff = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if ((op & (1 << i)) !== 0) {
          copyOff |= (delta[pos] as number) << (8 * i);
          pos += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if ((op & (0x10 << i)) !== 0) {
          copySize |= (delta[pos] as number) << (8 * i);
          pos += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOff, copyOff + copySize));
      outLen += copySize;
    } else if (op !== 0) {
      out.push(delta.subarray(pos, pos + op));
      outLen += op;
      pos += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out, outLen);
  if (result.length !== resultSize) throw new Error('delta result size mismatch');
  return result;
}

const PACK_TYPE_NAMES: Record<number, GitObjectType> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
};

/** Parse a packfile into objects. `lookup` resolves delta bases the pack does not carry
 *  (thin packs against the repo's store). Returns the objects in pack order. */
/** Parse a packfile synchronously (inflateSync with { info: true } reports
 *  engine.bytesRead, the number of compressed bytes one object consumed).
 *  `lookup` resolves delta bases the pack does not carry (thin packs). */
export function parsePackSync(pack: Buffer, lookup: (oid: string) => GitObject | undefined): GitObject[] {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const objects: GitObject[] = [];
  const byOffset = new Map<number, { type: GitObjectType; data: Buffer; oid: string }>();
  const byOid = new Map<string, { type: GitObjectType; data: Buffer; oid: string }>();
  let pos = 12;
  for (let i = 0; i < count; i += 1) {
    const start = pos;
    const header = readPackHeader(pack, pos);
    pos += header.headerLen;
    let baseObj: { type: GitObjectType; data: Buffer; oid: string } | undefined;
    if (header.type === 6) {
      const [negOff, n] = readOfsOffset(pack, pos);
      pos += n;
      baseObj = byOffset.get(start - negOff);
      if (baseObj === undefined) throw new Error('ofs-delta base not in pack');
    } else if (header.type === 7) {
      const baseOid = pack.subarray(pos, pos + 20).toString('hex');
      pos += 20;
      baseObj = byOid.get(baseOid) ?? lookupOidAsResolved(baseOid, lookup);
      if (baseObj === undefined) throw new Error(`ref-delta base ${baseOid} not found`);
    }
    const inflated = inflateWithLength(pack, pos);
    const data = inflated.data;
    pos = inflated.next;
    if (data.length !== header.size) throw new Error(`object size mismatch: got ${data.length}, want ${header.size}`);
    let type: GitObjectType;
    let finalData: Buffer = data;
    if (header.type === 6 || header.type === 7) {
      if (baseObj === undefined) throw new Error('delta without base');
      type = baseObj.type;
      finalData = applyDelta(baseObj.data, data);
    } else {
      type = PACK_TYPE_NAMES[header.type] as GitObjectType;
      if (type === undefined) throw new Error(`unknown pack object type ${header.type}`);
    }
    const oid = hashObject(type, finalData);
    const resolved = { type, data: finalData, oid };
    objects.push(resolved);
    byOffset.set(start, resolved);
    byOid.set(oid, resolved);
  }
  return objects;
}

function lookupOidAsResolved(
  oid: string,
  lookup: (oid: string) => GitObject | undefined,
): { type: GitObjectType; data: Buffer; oid: string } | undefined {
  const obj = lookup(oid);
  if (obj === undefined) return undefined;
  return { type: obj.type, data: obj.data, oid };
}

/** Inflate one zlib stream at `offset` and report the offset just past it. */
function inflateWithLength(pack: Buffer, offset: number): { data: Buffer; next: number } {
  // Node's sync inflate with { info: true } returns { engine, buffer };
  // engine.bytesWritten is the number of compressed input bytes consumed
  // (the stream stops at the end of one zlib stream and ignores the rest).
  const result = (inflateSync as unknown as (buf: Buffer, opts: { info: boolean }) => { engine: { bytesWritten: number }; buffer: Buffer })(
    pack.subarray(offset),
    { info: true },
  );
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

// ---------------------------------------------------------------- pack generation

/** Build a packfile (version 2, plain objects, no deltas) from `objects`. */
export function buildPack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    const typeNum = obj.type === 'commit' ? 1 : obj.type === 'tree' ? 2 : obj.type === 'blob' ? 3 : 4;
    // varint: low 4 bits of size in first byte, type in bits 4-6, continuation bit 7.
    let size = obj.data.length;
    const first = (typeNum << 4) | (size & 0x0f);
    size >>= 4;
    const headerBytes: number[] = [size > 0 ? first | 0x80 : first];
    while (size > 0) {
      const byte = size & 0x7f;
      size >>= 7;
      headerBytes.push(size > 0 ? byte | 0x80 : byte);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------- reachability helpers

/** Objects to send for `wants`, excluding anything reachable from `haves`.
 *  With `depth`, only commits up to that depth (1 = tips only) are included;
 *  the depth boundary commits are the new `shallow` list, and a client
 *  shallow boundary whose parents are now delivered is `unshallow`. */
export function objectsToSend(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  depth: number | null,
  clientShallow: readonly string[] = [],
): { objects: GitObject[]; shallow: string[]; unshallow: string[] } {
  const wanted = new Map<string, GitObject>();
  // For a full (depth-less) fetch the client's haves define what it already
  // holds. For a depth-limited fetch they do not: the deepen request names
  // the shallow tip itself as a have, and the whole point is to deliver the
  // ancestors up to the new depth, so the depth window alone decides.
  const haveSet = new Set<string>();
  if (depth === null && haves.length > 0) {
    for (const [oid] of collectReachableFull(repo, haves)) haveSet.add(oid);
  }
  const commits = new Set<string>();
  const tags = new Set<string>();
  // BFS so every commit is first visited at its shallowest depth.
  const bfs: Array<{ oid: string; d: number }> = wants.map((oid) => ({ oid, d: 0 }));
  let head = 0;
  const shallow: string[] = [];
  while (head < bfs.length) {
    const item = bfs[head] as { oid: string; d: number };
    head += 1;
    if (commits.has(item.oid) || tags.has(item.oid)) continue;
    const obj = repo.objects.get(item.oid);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      // An annotated tag: include the tag object and follow its target at
      // the same depth (a clone must carry the tag object itself).
      tags.add(item.oid);
      const target = tagTargetOid(obj.data);
      if (target !== null) bfs.push({ oid: target, d: item.d });
      continue;
    }
    if (obj.type !== 'commit') continue;
    commits.add(item.oid);
    const view = parseCommit(obj.data);
    if (depth !== null && item.d === depth - 1) {
      // Boundary: this commit is delivered but its parents are not.
      shallow.push(item.oid);
    } else {
      for (const parent of view.parents) bfs.push({ oid: parent, d: item.d + 1 });
    }
  }
  const unshallow: string[] = [];
  for (const boundary of clientShallow) {
    if (!commits.has(boundary)) continue;
    const obj = repo.objects.get(boundary);
    if (obj === undefined || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.every((p) => commits.has(p))) unshallow.push(boundary);
  }
  // Collect trees/blobs for the included commits, plus the tag objects.
  const queue: string[] = [];
  for (const oid of commits) {
    const obj = repo.objects.get(oid) as GitObject;
    wanted.set(oid, obj);
    queue.push(parseCommit(obj.data).tree);
  }
  for (const oid of tags) {
    const obj = repo.objects.get(oid) as GitObject;
    wanted.set(oid, obj);
  }
  while (queue.length > 0) {
    const treeOid = queue.pop() as string;
    if (wanted.has(treeOid)) continue;
    const obj = repo.objects.get(treeOid);
    if (obj === undefined || obj.type !== 'tree') continue;
    wanted.set(treeOid, obj);
    for (const entry of parseTree(obj.data)) {
      if (entry.mode === '40000') queue.push(entry.oid);
      else {
        const blob = repo.objects.get(entry.oid);
        if (blob !== undefined) wanted.set(entry.oid, blob);
      }
    }
  }
  // Remove anything the client already has.
  for (const oid of haveSet) wanted.delete(oid);
  const objects = [...wanted.values()];
  return { objects, shallow: [...new Set(shallow)], unshallow };
}

function collectReachableFull(repo: Repo, tips: readonly string[]): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const stack = [...tips];
  const seenCommits = new Set<string>();
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seenCommits.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      // A tag have: the tag object and its target are both held.
      out.set(oid, obj);
      const target = tagTargetOid(obj.data);
      if (target !== null) stack.push(target);
      continue;
    }
    if (obj.type !== 'commit') continue;
    seenCommits.add(oid);
    out.set(oid, obj);
    stack.push(...parseCommit(obj.data).parents);
  }
  const treeQueue: string[] = [];
  for (const oid of seenCommits) {
    const obj = repo.objects.get(oid) as GitObject;
    treeQueue.push(parseCommit(obj.data).tree);
  }
  while (treeQueue.length > 0) {
    const treeOid = treeQueue.pop() as string;
    if (out.has(treeOid)) continue;
    const obj = repo.objects.get(treeOid);
    if (obj === undefined || obj.type !== 'tree') continue;
    out.set(treeOid, obj);
    for (const entry of parseTree(obj.data)) {
      if (entry.mode === '40000') treeQueue.push(entry.oid);
      else {
        const blob = repo.objects.get(entry.oid);
        if (blob !== undefined) out.set(entry.oid, blob);
      }
    }
  }
  return out;
}
