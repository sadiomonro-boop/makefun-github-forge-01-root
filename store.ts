// The forge's in-memory store: repositories, refs, objects, issues, pulls.
// Everything deterministic: timestamps come only from MAKEFUN_TRIAL_NOW
// (a fixed RFC 3339 instant or epoch ms); ids are counters. No Date.now(),
// no Math.random(), no wall clock anywhere in any response.

import { createHash } from 'node:crypto';

export const ZERO_OID = '0000000000000000000000000000000000000000';
/** The token owner, from the sealed scenario (SCENARIO_SEED 0x6a09e667f3bcc909n,
 *  buildScenario().viewer.login). The scenario is fixed, so this login is fixed. */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
/** The identity git commits the fixture and this forge sign with. */
export const IDENTITY = 'Conformance <conformance@make.fun>';
/** The epoch the env's fixture commits carry (wire.ts SCENARIO_EPOCH_SEC). */
export const SCENARIO_EPOCH_SEC = 1735689600;

let trialNowMs = SCENARIO_EPOCH_SEC * 1000;
{
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw !== undefined && raw !== '') {
    const asNum = Number(raw);
    if (Number.isFinite(asNum) && asNum > 0) trialNowMs = Math.trunc(asNum);
    else {
      const parsed = Date.parse(raw);
      if (Number.isFinite(parsed)) trialNowMs = parsed;
    }
  }
}
export const TRIAL_NOW_MS = trialNowMs;
export const TRIAL_NOW_ISO = new Date(trialNowMs).toISOString();
export const TRIAL_NOW_SEC = Math.floor(trialNowMs / 1000);

/** A deterministic counter-based request id (non-empty, as the protocol checks need). */
let requestCounter = 0;
export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(36)}-${requestCounter}`;
}

// ---------------------------------------------------------------- git objects

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export function hashObject(type: GitObjectType, data: Buffer): string {
  const h = createHash('sha1');
  h.update(`${type} ${data.length}\0`, 'utf8');
  h.update(data);
  return h.digest('hex');
}

export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry truncated');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(fields: {
  tree: string;
  parents?: string[];
  message: string;
  timestamp?: number;
  author?: string;
  committer?: string;
}): Buffer {
  const timestamp = fields.timestamp ?? TRIAL_NOW_SEC;
  const who = `${fields.author ?? IDENTITY} ${timestamp} +0000`;
  const committer = `${fields.committer ?? IDENTITY} ${timestamp} +0000`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

// ---------------------------------------------------------------- store

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: IssueComment[];
  user: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  user: string;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  nextIssue: number;
  nextPull: number;
  nextCommentId: number;
}

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 1000;
  nextIssueId = 10000;
  nextPullId = 20000;
  nextLabelId = 1;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(owner: string, name: string, opts: { private?: boolean; description?: string; defaultBranch?: string }): Repo {
    const id = this.nextRepoId;
    this.nextRepoId += 1;
    const repo: Repo = {
      id,
      owner,
      name,
      fullName: `${owner}/${name}`,
      description: opts.description ?? '',
      private: opts.private ?? false,
      defaultBranch: opts.defaultBranch ?? 'main',
      createdAt: TRIAL_NOW_ISO,
      updatedAt: TRIAL_NOW_ISO,
      refs: new Map(),
      objects: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextIssue: 1,
      nextPull: 1,
      nextCommentId: 1,
    };
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  /** Repos owned by `owner`, in creation (id) order. */
  reposOf(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.id - b.id);
    return out;
  }
}

export const store = new Store();

// ---------------------------------------------------------------- git helpers on a repo

/** Walk commit ancestry from `tip`, collecting reachable commit oids (bounded). */
export function collectCommits(repo: Repo, tips: readonly string[], maxDepth = -1): Set<string> {
  const seen = new Set<string>();
  const stack: Array<{ oid: string; depth: number }> = tips.map((oid) => ({ oid, depth: 0 }));
  while (stack.length > 0) {
    const item = stack.pop() as { oid: string; depth: number };
    if (seen.has(item.oid)) continue;
    if (maxDepth >= 0 && item.depth > maxDepth) continue;
    const obj = repo.objects.get(item.oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    seen.add(item.oid);
    const view = parseCommit(obj.data);
    for (const parent of view.parents) stack.push({ oid: parent, depth: item.depth + 1 });
  }
  return seen;
}

/** All objects reachable from `tips` (commits + their trees + blobs), with a depth cap on commits. */
export function collectReachable(repo: Repo, tips: readonly string[], maxCommitDepth = -1): Map<string, GitObject> {
  const commits = collectCommits(repo, tips, maxCommitDepth);
  const out = new Map<string, GitObject>();
  const treeQueue: string[] = [];
  for (const oid of commits) {
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    out.set(oid, obj);
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

/** Is `ancestor` reachable from `tip` (following parents)? */
export function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  return collectCommits(repo, [tip]).has(ancestor);
}

/** Flat map of path -> blob oid for the tree at `treeOid` (recursive). */
export function flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  const obj = repo.objects.get(treeOid);
  if (obj === undefined || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      for (const [p, o] of flattenTree(repo, entry.oid, path)) out.set(p, o);
    } else {
      out.set(path, entry.oid);
    }
  }
  return out;
}

/** Build a tree object from a flat path->oid map, creating intermediate trees. Returns the root tree oid. */
export function buildTreeFromPaths(repo: Repo, flat: Map<string, string>): string {
  // Group paths by first segment.
  const byFirst = new Map<string, Array<{ rest: string; oid: string; isDir: boolean }>>();
  for (const [path, oid] of flat) {
    const slash = path.indexOf('/');
    if (slash < 0) {
      const list = byFirst.get(path) ?? [];
      list.push({ rest: '', oid, isDir: false });
      byFirst.set(path, list);
    } else {
      const first = path.slice(0, slash);
      const rest = path.slice(slash + 1);
      const list = byFirst.get(first) ?? [];
      list.push({ rest, oid, isDir: true });
      byFirst.set(first, list);
    }
  }
  const entries: TreeEntry[] = [];
  for (const [name, items] of byFirst) {
    if (items.length === 1 && !items[0]?.isDir) {
      entries.push({ mode: '100644', name, oid: items[0]?.oid as string });
    } else {
      const sub = new Map<string, string>();
      for (const item of items) sub.set(item.rest, item.oid);
      const childOid = buildTreeFromPaths(repo, sub);
      entries.push({ mode: '40000', name, oid: childOid });
    }
  }
  const data = buildTree(entries);
  const oid = hashObject('tree', data);
  repo.objects.set(oid, { type: 'tree', data });
  return oid;
}

/** Store an object, returning its oid. */
export function putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  repo.objects.set(oid, { type, data });
  return oid;
}

/** Count lines of a buffer's UTF-8 text. */
export function countLines(data: Buffer): number {
  const text = data.toString('utf8');
  if (text === '') return 0;
  const parts = text.split('\n');
  return text.endsWith('\n') ? parts.length - 1 : parts.length;
}

/** A tiny LCS line diff: returns [additions, deletions]. Files here are small. */
export function lineDiff(oldData: Buffer, newData: Buffer): [number, number] {
  const a = oldData.toString('utf8').split('\n');
  const b = newData.toString('utf8').split('\n');
  if (a.length > 0 && a[a.length - 1] === '') a.pop();
  if (b.length > 0 && b[b.length - 1] === '') b.pop();
  const n = a.length;
  const m = b.length;
  // LCS via DP on rows; cap the matrix to keep it cheap (files are small in this suite).
  const dp: number[][] = [];
  for (let i = 0; i <= n; i += 1) dp.push(new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? (dp[i + 1]![j + 1] ?? 0) + 1 : Math.max(dp[i + 1]![j] ?? 0, dp[i]![j + 1] ?? 0);
    }
  }
  const lcs = dp[0]?.[0] ?? 0;
  return [m - lcs, n - lcs];
}
