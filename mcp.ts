// Model Context Protocol over Streamable HTTP (JSON-RPC 2.0): server/discover
// (2026-07-28 era), initialize, tools/list, tools/call. The tools share the
// forge's store with REST, so a repo or issue made over MCP reads back over
// REST with the same ids.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  store,
  TRIAL_NOW_ISO,
  VIEWER_LOGIN,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';
import { squashMerge } from './graphql.ts';

export const SERVER_NAME = 'makefun-forge';
export const SERVER_VERSION = '1.0.0';
export const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

/** A fixed constant: two tools/list calls must be byte-identical. */
export const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function toolResult(value: Record<string, unknown>): Record<string, unknown> {
  const text = JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value, isError: false };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Pick the first present synonym, as github-mcp-server's documented args map. */
function pick(args: Record<string, unknown>, names: string[]): unknown {
  for (const name of names) {
    if (args[name] !== undefined && args[name] !== null) return args[name];
  }
  return undefined;
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: `https://github.com/${repo.fullName}`,
    clone_url: `https://github.com/${repo.fullName}.git`,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `I_${repo.id}_${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => ({ name: l.name, color: l.color })),
    user: { login: issue.user },
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    url: `https://github.com/${repo.fullName}/issues/${issue.number}`,
    html_url: `https://github.com/${repo.fullName}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pr: Pull): Record<string, unknown> {
  return {
    id: pr.id,
    node_id: `PR_${repo.id}_${pr.number}`,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    head: { ref: pr.headRef, sha: pr.headSha },
    base: { ref: pr.baseRef, sha: pr.baseSha },
    user: { login: pr.user },
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    url: `https://github.com/${repo.fullName}/pull/${pr.number}`,
    html_url: `https://github.com/${repo.fullName}/pull/${pr.number}`,
  };
}

function dispatchTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const lower = name.toLowerCase();
  const base = lower.includes('create_repo') || lower.endsWith('create_repo') ? 'create_repo'
    : lower.includes('get_repo') ? 'get_repo'
    : lower.includes('create_issue') ? 'create_issue'
    : lower.includes('list_issues') ? 'list_issues'
    : lower.includes('create_pull_request') ? 'create_pull_request'
    : lower.includes('merge_pull_request') ? 'merge_pull_request'
    : null;
  if (base === null) return { __rpcError: -32601, __message: `Unknown tool: ${name}` };
  if (base === 'create_repo') {
    const repoName = pick(args, ['name', 'repo_name', 'repository']) as string | undefined;
    if (typeof repoName !== 'string' || repoName === '') return toolError('Missing required argument: name');
    if (store.getRepo(VIEWER_LOGIN, repoName) !== undefined) return toolError(`Repository ${VIEWER_LOGIN}/${repoName} already exists`);
    const description = pick(args, ['description', 'body']) as string | undefined;
    const isPrivate = pick(args, ['private']) as boolean | undefined;
    const repo = store.createRepo(VIEWER_LOGIN, repoName, {
      description: typeof description === 'string' ? description : '',
      private: typeof isPrivate === 'boolean' ? isPrivate : false,
    });
    return toolResult({ ...repoJson(repo), full_name: repo.fullName });
  }
  const owner = pick(args, ['owner', 'owner_login', 'org', 'user', 'login']) as string | undefined;
  let repoName = pick(args, ['repo', 'repository', 'repo_name', 'name']) as string | undefined;
  const fullName = pick(args, ['full_name', 'repo_full_name', 'fullName']) as string | undefined;
  if (typeof fullName === 'string' && fullName.includes('/')) {
    const [o, r] = fullName.split('/');
    if (owner === undefined && o !== undefined) {
      // owner is const-bound above; fall through to the full_name split below.
      void o;
      void r;
    }
  }
  if (repoName === undefined && typeof fullName === 'string') {
    const parts = fullName.split('/');
    repoName = parts[1] ?? parts[0];
  }
  const repoOwner = owner ?? (typeof fullName === 'string' && fullName.includes('/') ? fullName.split('/')[0] : VIEWER_LOGIN);
  if (base === 'get_repo') {
    if (repoOwner === undefined || repoName === undefined) return toolError('Missing required arguments: owner, repo');
    const repo = store.getRepo(repoOwner, repoName);
    if (repo === undefined) return toolError(`Repository ${repoOwner}/${repoName} not found`);
    return toolResult(repoJson(repo));
  }
  if (base === 'create_issue') {
    const title = pick(args, ['title']) as string | undefined;
    if (repoOwner === undefined || repoName === undefined || typeof title !== 'string' || title === '') {
      return toolError('Missing required arguments: owner, repo, title');
    }
    const repo = store.getRepo(repoOwner, repoName);
    if (repo === undefined) return toolError(`Repository ${repoOwner}/${repoName} not found`);
    const body = pick(args, ['body', 'description']) as string | undefined;
    const issue: Issue = {
      id: store.nextIssueId,
      number: repo.nextIssue,
      title,
      body: typeof body === 'string' ? body : '',
      state: 'open',
      labels: [],
      comments: [],
      user: VIEWER_LOGIN,
      createdAt: TRIAL_NOW_ISO,
      updatedAt: TRIAL_NOW_ISO,
      closedAt: null,
    };
    store.nextIssueId += 1;
    repo.nextIssue += 1;
    repo.issues.push(issue);
    return toolResult(issueJson(repo, issue));
  }
  if (base === 'list_issues') {
    if (repoOwner === undefined || repoName === undefined) return toolError('Missing required arguments: owner, repo');
    const repo = store.getRepo(repoOwner, repoName);
    if (repo === undefined) return toolError(`Repository ${repoOwner}/${repoName} not found`);
    const state = pick(args, ['state']) as string | undefined;
    let list = repo.issues;
    if (state === 'open') list = list.filter((i) => i.state === 'open');
    else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
    return toolResult({ issues: list.map((i) => issueJson(repo, i)) });
  }
  if (base === 'create_pull_request') {
    const title = pick(args, ['title']) as string | undefined;
    const head = pick(args, ['head', 'head_ref', 'head_branch', 'source', 'from', 'branch']) as string | undefined;
    const baseRef = pick(args, ['base', 'base_ref', 'target', 'into']) as string | undefined;
    if (repoOwner === undefined || repoName === undefined || typeof title !== 'string' || typeof head !== 'string' || typeof baseRef !== 'string') {
      return toolError('Missing required arguments: owner, repo, title, head, base');
    }
    const repo = store.getRepo(repoOwner, repoName);
    if (repo === undefined) return toolError(`Repository ${repoOwner}/${repoName} not found`);
    const headBranch = head.includes(':') ? (head.split(':')[1] as string) : head;
    const baseBranch = baseRef.includes(':') ? (baseRef.split(':')[1] as string) : baseRef;
    const headSha = repo.refs.get(`refs/heads/${headBranch}`);
    const baseSha = repo.refs.get(`refs/heads/${baseBranch}`);
    if (headSha === undefined || baseSha === undefined) return toolError('Head or base branch does not exist');
    const body = pick(args, ['body', 'description']) as string | undefined;
    const pr: Pull = {
      id: store.nextPullId,
      number: repo.nextPull,
      title,
      body: typeof body === 'string' ? body : '',
      state: 'open',
      headRef: headBranch,
      headSha,
      baseRef: baseBranch,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      user: VIEWER_LOGIN,
      createdAt: TRIAL_NOW_ISO,
      updatedAt: TRIAL_NOW_ISO,
    };
    store.nextPullId += 1;
    repo.nextPull += 1;
    repo.pulls.push(pr);
    return toolResult(pullJson(repo, pr));
  }
  if (base === 'merge_pull_request') {
    const pullNumber = pick(args, ['pull_number', 'pull_request_number', 'number']) as number | undefined;
    if (repoOwner === undefined || repoName === undefined || typeof pullNumber !== 'number') {
      return toolError('Missing required arguments: owner, repo, pull_number');
    }
    const repo = store.getRepo(repoOwner, repoName);
    if (repo === undefined) return toolError(`Repository ${repoOwner}/${repoName} not found`);
    const pr = repo.pulls.find((p) => p.number === pullNumber);
    if (pr === undefined) return toolError(`Pull request #${pullNumber} not found`);
    if (pr.state !== 'open') return toolError(`Pull request #${pullNumber} is already closed`);
    const ok = squashMerge(repo, pr);
    if (!ok) return toolError(`Pull request #${pullNumber} has merge conflicts`);
    return toolResult({ ...pullJson(repo, pr), merged: true, sha: pr.mergeCommitSha });
  }
  return { __rpcError: -32601, __message: `Unknown tool: ${name}` };
}

export function handleMcp(req: IncomingMessage, res: ServerResponse, rawBody: Buffer): void {
  const respond = (status: number, value: unknown): void => {
    if (value === null) {
      res.writeHead(status);
      res.end();
      return;
    }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  let body: unknown;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    respond(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    respond(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  const msg = body as Record<string, unknown>;
  const id = msg['id'];
  const method = typeof msg['method'] === 'string' ? msg['method'] : '';
  // A notification (no id) is answered 202 with an empty body.
  if (id === undefined) {
    respond(202, null);
    return;
  }
  const params = (msg['params'] !== null && typeof msg['params'] === 'object' ? msg['params'] as Record<string, unknown> : {}) as Record<string, unknown>;
  if (method === 'server/discover') {
    respond(200, {
      jsonrpc: '2.0',
      id,
      result: {
        supportedVersions: SUPPORTED_VERSIONS,
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        capabilities: { tools: {} },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
      },
    });
    return;
  }
  if (method === 'initialize') {
    const requested = typeof params['protocolVersion'] === 'string' ? params['protocolVersion'] : '';
    const version = SUPPORTED_VERSIONS.includes(requested) ? requested : '2026-07-28';
    respond(200, {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      },
    });
    return;
  }
  if (method === 'ping') {
    respond(200, { jsonrpc: '2.0', id, result: {} });
    return;
  }
  if (method === 'tools/list') {
    respond(200, { jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }
  if (method === 'tools/call') {
    const name = typeof params['name'] === 'string' ? params['name'] : '';
    const args = (params['arguments'] !== null && typeof params['arguments'] === 'object' ? params['arguments'] as Record<string, unknown> : {}) as Record<string, unknown>;
    const out = dispatchTool(name, args);
    if ('__rpcError' in out) {
      respond(200, { jsonrpc: '2.0', id, error: { code: out['__rpcError'] as number, message: out['__message'] as string } });
      return;
    }
    respond(200, { jsonrpc: '2.0', id, result: out });
    return;
  }
  respond(200, { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
}
