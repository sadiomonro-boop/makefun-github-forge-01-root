// GitHub REST v3: repositories, branches, commits, contents, labels, issues,
// comments, pull requests and merges. Every reply is JSON with a non-empty
// X-GitHub-Request-Id; errors are JSON {"message": ...}.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  buildTreeFromPaths,
  collectCommits,
  countLines,
  flattenTree,
  isObjectId,
  lineDiff,
  parseCommit,
  putObject,
  store,
  TRIAL_NOW_ISO,
  TRIAL_NOW_SEC,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  type Issue,
  type Label,
  type Pull,
  type Repo,
} from './store.ts';
import { nextRequestId } from './store.ts';

export interface RestContext {
  req: IncomingMessage;
  res: ServerResponse;
  segments: string[];
  query: URLSearchParams;
  body: unknown;
  origin: string;
}

export function jsonReply(ctx: RestContext, status: number, value: unknown, extraHeaders: Record<string, string> = {}): void {
  const payload = value === null ? '' : JSON.stringify(value);
  ctx.res.writeHead(status, {
    'content-type': 'application/json',
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  });
  ctx.res.end(payload);
}

export function errorReply(ctx: RestContext, status: number, message: string): void {
  jsonReply(ctx, status, { message });
}

function ownerJson(login: string): Record<string, unknown> {
  return {
    login,
    id: login === VIEWER_LOGIN ? VIEWER_ID : 1001,
    node_id: `U_${login}`,
    avatar_url: `https://avatars.githubusercontent.com/u/${login === VIEWER_LOGIN ? VIEWER_ID : 1001}`,
    gravatar_id: '',
    url: `https://api.github.com/users/${login}`,
    html_url: `https://github.com/${login}`,
    type: 'User',
    site_admin: false,
  };
}

export function repoJson(ctx: RestContext, repo: Repo): Record<string, unknown> {
  const base = `${ctx.origin}/api/v3/repos/${repo.owner}/${repo.name}`;
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: repo.fullName,
    owner: ownerJson(repo.owner),
    private: repo.private,
    html_url: `https://github.com/${repo.fullName}`,
    description: repo.description,
    fork: false,
    url: base,
    archive_url: `${base}/archive/{archive_format}{/ref}`,
    assignees_url: `${base}/assignees{/user}`,
    blobs_url: `${base}/git/blobs{/sha}`,
    branches_url: `${base}/branches{/branch}`,
    clone_url: `https://github.com/${repo.fullName}.git`,
    collaborators_url: `${base}/collaborators{/collaborator}`,
    comments_url: `${base}/comments{/number}`,
    commits_url: `${base}/commits{/sha}`,
    compare_url: `${base}/compare/{base}...{head}`,
    contents_url: `${base}/contents/{+path}`,
    contributors_url: `${base}/contributors`,
    deployments_url: `${base}/deployments`,
    downloads_url: `${base}/downloads`,
    events_url: `${base}/events`,
    forks_url: `${base}/forks`,
    git_commits_url: `${base}/git/commits{/sha}`,
    git_refs_url: `${base}/git/refs{/sha}`,
    git_tags_url: `${base}/git/tags{/sha}`,
    git_url: `git://github.com/${repo.fullName}.git`,
    issue_comment_url: `${base}/issues/comments{/number}`,
    issue_events_url: `${base}/issues/events{/number}`,
    issues_url: `${base}/issues{/number}`,
    keys_url: `${base}/keys{/key_id}`,
    labels_url: `${base}/labels{/name}`,
    languages_url: `${base}/languages`,
    merges_url: `${base}/merges`,
    milestones_url: `${base}/milestones{/number}`,
    notifications_url: `${base}/notifications{?since,all,participating}`,
    pulls_url: `${base}/pulls{/number}`,
    releases_url: `${base}/releases{/id}`,
    ssh_url: `git@github.com:${repo.fullName}.git`,
    stargazers_url: `${base}/stargazers`,
    statuses_url: `${base}/statuses/{sha}`,
    subscribers_url: `${base}/subscribers`,
    subscription_url: `${base}/subscription`,
    tags_url: `${base}/tags`,
    teams_url: `${base}/teams`,
    trees_url: `${base}/git/trees{/sha}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    mirror_url: null,
    archived: false,
    disabled: false,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    web_commit_signoff_required: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function labelJson(ctx: RestContext, repo: Repo, label: Label): Record<string, unknown> {
  return {
    id: labelIdOf(repo, label),
    node_id: `LA_${repo.id}_${label.name}`,
    url: `${ctx.origin}/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

function labelIdOf(repo: Repo, label: Label): number {
  let n = 0;
  for (const name of repo.labels.keys()) {
    n += 1;
    if (name === label.name) return 1000 + n;
  }
  return 1000;
}

function issueJson(ctx: RestContext, repo: Repo, issue: Issue): Record<string, unknown> {
  const base = `${ctx.origin}/api/v3/repos/${repo.owner}/${repo.name}`;
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    url: `${base}/issues/${issue.number}`,
    repository_url: base,
    labels_url: `${base}/issues/${issue.number}/labels{/name}`,
    comments_url: `${base}/issues/${issue.number}/comments`,
    events_url: `${base}/issues/${issue.number}/events`,
    html_url: `https://github.com/${repo.fullName}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body,
    user: ownerJson(issue.user),
    labels: issue.labels.map((l) => labelJson(ctx, repo, l)),
    assignee: null,
    assignees: [],
    locked: false,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
    state_reason: null,
  };
}

function prFileDiff(repo: Repo, pr: Pull): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
  const baseObj = repo.objects.get(pr.baseSha);
  const headObj = repo.objects.get(pr.headSha);
  if (baseObj === undefined || headObj === undefined) return [];
  const baseTree = parseCommit(baseObj.data).tree;
  const headTree = parseCommit(headObj.data).tree;
  const baseFlat = flattenTree(repo, baseTree);
  const headFlat = flattenTree(repo, headTree);
  const paths = new Set<string>([...baseFlat.keys(), ...headFlat.keys()]);
  const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
  for (const path of [...paths].sort()) {
    const b = baseFlat.get(path);
    const h = headFlat.get(path);
    if (b === h) continue;
    if (b === undefined && h !== undefined) {
      const blob = repo.objects.get(h);
      const additions = blob === undefined ? 0 : countLines(blob.data);
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (h === undefined && b !== undefined) {
      const blob = repo.objects.get(b);
      const deletions = blob === undefined ? 0 : countLines(blob.data);
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (b !== undefined && h !== undefined) {
      const oldBlob = repo.objects.get(b);
      const newBlob = repo.objects.get(h);
      const [additions, deletions] = oldBlob === undefined || newBlob === undefined ? [0, 0] : lineDiff(oldBlob.data, newBlob.data);
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}

/** Paths changed by the PR (base tree -> head tree). */
export function prChangedPaths(repo: Repo, pr: Pull): Set<string> {
  return new Set(prFileDiff(repo, pr).map((f) => f.filename));
}

/** Is the PR mergeable right now? A conflict is any file the PR changes that
 *  also changed on the default branch since the PR's base commit. */
export function prConflict(repo: Repo, pr: Pull): boolean {
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (defaultTip === undefined) return false;
  const baseObj = repo.objects.get(pr.baseSha);
  const tipObj = repo.objects.get(defaultTip);
  if (baseObj === undefined || tipObj === undefined) return false;
  const baseTree = parseCommit(baseObj.data).tree;
  const tipTree = parseCommit(tipObj.data).tree;
  const baseFlat = flattenTree(repo, baseTree);
  const tipFlat = flattenTree(repo, tipTree);
  const changedSinceBase = new Set<string>();
  for (const path of new Set([...baseFlat.keys(), ...tipFlat.keys()])) {
    if (baseFlat.get(path) !== tipFlat.get(path)) changedSinceBase.add(path);
  }
  for (const path of prChangedPaths(repo, pr)) {
    if (changedSinceBase.has(path)) return true;
  }
  return false;
}

function commitJson(ctx: RestContext, repo: Repo, sha: string): Record<string, unknown> | null {
  const obj = repo.objects.get(sha);
  if (obj === undefined || obj.type !== 'commit') return null;
  const view = parseCommit(obj.data);
  const authorLine = view.author;
  const m = authorLine.match(/^(.*) <(.*)> (\d+) ([+-]\d{4})$/);
  const authorName = m !== null ? (m[1] as string) : VIEWER_NAME;
  const authorEmail = m !== null ? (m[2] as string) : VIEWER_EMAIL;
  const ts = m !== null ? Number(m[3]) : TRIAL_NOW_SEC;
  const date = new Date(ts * 1000).toISOString();
  // GitHub's API returns the message without the trailing newline git stores.
  const message = view.message.replace(/\n+$/, '');
  const base = `${ctx.origin}/api/v3/repos/${repo.owner}/${repo.name}`;
  return {
    sha,
    node_id: `C_${sha}`,
    commit: {
      author: { name: authorName, email: authorEmail, date },
      committer: { name: authorName, email: authorEmail, date },
      message,
      tree: { sha: view.tree, url: `${base}/git/trees/${view.tree}` },
      url: `${base}/git/commits/${sha}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: `${base}/commits/${sha}`,
    html_url: `https://github.com/${repo.fullName}/commit/${sha}`,
    comments_url: `${base}/commits/${sha}/comments`,
    author: ownerJson(VIEWER_LOGIN),
    committer: ownerJson(VIEWER_LOGIN),
    parents: view.parents.map((p) => ({ sha: p, url: `${base}/commits/${p}`, html_url: `https://github.com/${repo.fullName}/commit/${p}` })),
  };
}

export function pullJson(ctx: RestContext, repo: Repo, pr: Pull): Record<string, unknown> {
  const base = `${ctx.origin}/api/v3/repos/${repo.owner}/${repo.name}`;
  const files = prFileDiff(repo, pr);
  const additions = files.reduce((s, f) => s + f.additions, 0);
  const deletions = files.reduce((s, f) => s + f.deletions, 0);
  const conflict = prConflict(repo, pr);
  const headCommits = collectCommits(repo, [pr.headSha]);
  const baseCommits = collectCommits(repo, [pr.baseSha]);
  let commitCount = 0;
  for (const oid of headCommits) if (!baseCommits.has(oid)) commitCount += 1;
  return {
    id: pr.id,
    node_id: `PR_${pr.id}`,
    url: `${base}/pulls/${pr.number}`,
    html_url: `https://github.com/${repo.fullName}/pull/${pr.number}`,
    diff_url: `https://github.com/${repo.fullName}/pull/${pr.number}.diff`,
    patch_url: `https://github.com/${repo.fullName}/pull/${pr.number}.patch`,
    issue_url: `${base}/issues/${pr.number}`,
    number: pr.number,
    state: pr.state,
    locked: false,
    title: pr.title,
    user: ownerJson(pr.user),
    body: pr.body,
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    closed_at: pr.state === 'closed' ? pr.updatedAt : null,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    labels: [],
    milestone: null,
    draft: false,
    commits_url: `${base}/pulls/${pr.number}/commits`,
    review_comments_url: `${base}/pulls/${pr.number}/comments`,
    review_comment_url: `${base}/pulls/comments{/number}`,
    comments_url: `${base}/issues/${pr.number}/comments`,
    statuses_url: `${base}/commits/${pr.headSha}/statuses`,
    head: {
      label: `${repo.owner}:${pr.headRef}`,
      ref: pr.headRef,
      sha: pr.headSha,
      user: ownerJson(repo.owner),
      repo: repoJson(ctx, repo),
    },
    base: {
      label: `${repo.owner}:${pr.baseRef}`,
      ref: pr.baseRef,
      sha: pr.baseSha,
      user: ownerJson(repo.owner),
      repo: repoJson(ctx, repo),
    },
    author_association: 'OWNER',
    auto_merge: null,
    active_lock_reason: null,
    merged: pr.merged,
    mergeable: pr.state === 'open' ? !conflict : null,
    mergeable_state: pr.state === 'open' ? (conflict ? 'dirty' : 'clean') : 'unknown',
    merged_by: pr.merged ? ownerJson(VIEWER_LOGIN) : null,
    comments: 0,
    review_comments: 0,
    maintainer_can_modify: false,
    commits: commitCount,
    additions,
    deletions,
    changed_files: files.length,
  };
}

function parsePagination(ctx: RestContext): { perPage: number; page: number } {
  const perPageRaw = Number.parseInt(ctx.query.get('per_page') ?? '30', 10);
  const pageRaw = Number.parseInt(ctx.query.get('page') ?? '1', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  return { perPage, page };
}

function paginate<T>(ctx: RestContext, items: T[], path: string): { page: T[]; link: string | null } {
  const { perPage, page } = parsePagination(ctx);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const lastPage = Math.max(1, Math.ceil(items.length / perPage));
  let link: string | null = null;
  if (page < lastPage) {
    const next = `${ctx.origin}${path}?per_page=${perPage}&page=${page + 1}`;
    const last = `${ctx.origin}${path}?per_page=${perPage}&page=${lastPage}`;
    link = `<${next}>; rel="next", <${last}>; rel="last"`;
  }
  return { page: slice, link };
}

function bodyObject(ctx: RestContext): Record<string, unknown> | null {
  if (ctx.body !== null && typeof ctx.body === 'object' && !Array.isArray(ctx.body)) {
    return ctx.body as Record<string, unknown>;
  }
  return null;
}

function strField(body: Record<string, unknown> | null, key: string): string | undefined {
  if (body === null) return undefined;
  const v = body[key];
  return typeof v === 'string' ? v : undefined;
}

function boolField(body: Record<string, unknown> | null, key: string): boolean | undefined {
  if (body === null) return undefined;
  const v = body[key];
  return typeof v === 'boolean' ? v : undefined;
}

function resolveRef(repo: Repo, ref: string): string | undefined {
  // A branch name, a full ref, or a commit sha.
  if (isObjectId(ref) && repo.objects.has(ref)) return ref;
  if (ref.startsWith('refs/')) return repo.refs.get(ref);
  return repo.refs.get(`refs/heads/${ref}`);
}

function resolveBranchTip(repo: Repo, ref: string): string | undefined {
  if (ref.startsWith('refs/')) return repo.refs.get(ref);
  return repo.refs.get(`refs/heads/${ref}`);
}

/** Create a commit on `branch` that sets `path` to `blobOid` (or removes it when null). */
export function commitFileChange(
  repo: Repo,
  branch: string,
  path: string,
  blobOid: string | null,
  message: string,
): { commitSha: string; treeSha: string } {
  const refName = `refs/heads/${branch}`;
  const tip = repo.refs.get(refName);
  const flat = new Map<string, string>();
  let parents: string[] = [];
  if (tip !== undefined) {
    const tipObj = repo.objects.get(tip);
    if (tipObj !== undefined && tipObj.type === 'commit') {
      parents = [tip];
      for (const [p, o] of flattenTree(repo, parseCommit(tipObj.data).tree)) flat.set(p, o);
    }
  }
  if (blobOid === null) flat.delete(path);
  else flat.set(path, blobOid);
  const treeSha = buildTreeFromPaths(repo, flat);
  const commitData = putObject(repo, 'commit', buildCommitData(treeSha, parents, message));
  repo.refs.set(refName, commitData);
  return { commitSha: commitData, treeSha };
}

function buildCommitData(treeSha: string, parents: string[], message: string): Buffer {
  const lines = [`tree ${treeSha}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${IDENTITY} ${TRIAL_NOW_SEC} +0000`, `committer ${IDENTITY} ${TRIAL_NOW_SEC} +0000`, '');
  return Buffer.from(`${lines.join('\n')}\n${message}\n`, 'utf8');
}

const IDENTITY = 'Conformance <conformance@make.fun>';

export async function handleRest(ctx: RestContext): Promise<void> {
  const s = ctx.segments;
  // GET /api/v3/ (root)
  if (s.length === 0) {
    jsonReply(ctx, 200, {
      current_user_url: `${ctx.origin}/api/v3/user`,
      authorizations_url: `${ctx.origin}/api/v3/authorizations`,
      code_search_url: `${ctx.origin}/api/v3/search/code?q={query}`,
      commit_search_url: `${ctx.origin}/api/v3/search/commits?q={query}`,
      emails_url: `${ctx.origin}/api/v3/user/emails`,
      emojis_url: `${ctx.origin}/api/v3/emojis`,
      events_url: `${ctx.origin}/api/v3/events`,
      feeds_url: `${ctx.origin}/api/v3/feeds`,
      followers_url: `${ctx.origin}/api/v3/user/followers`,
      following_url: `${ctx.origin}/api/v3/user/following{/other_user}`,
      gists_url: `${ctx.origin}/api/v3/gists{/gist_id}`,
      hub_url: `${ctx.origin}/api/v3/hub`,
      issue_search_url: `${ctx.origin}/api/v3/search/issues?q={query}`,
      issues_url: `${ctx.origin}/api/v3/issues`,
      keys_url: `${ctx.origin}/api/v3/user/keys`,
      labels_url: `${ctx.origin}/api/v3/repos/{owner}/{repo}/labels{/name}`,
      notifications_url: `${ctx.origin}/api/v3/notifications{?since,all,participating}`,
      organization_repositories_url: `${ctx.origin}/api/v3/orgs/{org}/repos{?type,page,per_page,sort}`,
      organization_url: `${ctx.origin}/api/v3/orgs/{org}`,
      public_gists_url: `${ctx.origin}/api/v3/gists/public`,
      rate_limit_url: `${ctx.origin}/api/v3/rate_limit`,
      repository_url: `${ctx.origin}/api/v3/repos/{owner}/{repo}`,
      repository_search_url: `${ctx.origin}/api/v3/search/repositories?q={query}`,
      current_user_repositories_url: `${ctx.origin}/api/v3/user/repos{?type,page,per_page,sort}`,
      starred_url: `${ctx.origin}/api/v3/user/starred{/owner}{/repo}`,
      starred_gists_url: `${ctx.origin}/api/v3/gists/starred`,
      user_url: `${ctx.origin}/api/v3/users/{user}`,
      user_organizations_url: `${ctx.origin}/api/v3/user/orgs`,
      user_repositories_url: `${ctx.origin}/api/v3/users/{user}/repos{?type,page,per_page,sort}`,
      user_search_url: `${ctx.origin}/api/v3/search/users?q={query}`,
    }, { 'x-oauth-scopes': 'repo, read:org', 'x-accepted-oauth-scopes': 'repo, read:org' });
    return;
  }
  const method = ctx.req.method ?? 'GET';
  // GET /api/v3/meta
  if (s[0] === 'meta' && s.length === 1) {
    if (method !== 'GET') { errorReply(ctx, 405, 'Method Not Allowed'); return; }
    jsonReply(ctx, 200, { installed_version: '1.0.0', verifiable_password_authentication: true });
    return;
  }
  // /api/v3/user
  if (s[0] === 'user' && s.length === 1) {
    if (method !== 'GET') { errorReply(ctx, 405, 'Method Not Allowed'); return; }
    jsonReply(ctx, 200, {
      ...ownerJson(VIEWER_LOGIN),
      name: VIEWER_NAME,
      email: VIEWER_EMAIL,
      bio: null,
      company: null,
      blog: '',
      location: null,
      hireable: null,
      public_repos: store.reposOf(VIEWER_LOGIN).length,
      public_gists: 0,
      followers: 0,
      following: 0,
      created_at: TRIAL_NOW_ISO,
      updated_at: TRIAL_NOW_ISO,
    });
    return;
  }
  // /api/v3/user/repos
  if (s[0] === 'user' && s[1] === 'repos' && s.length === 2) {
    if (method === 'GET') {
      const repos = store.reposOf(VIEWER_LOGIN);
      const { page, link } = paginate(ctx, repos, '/api/v3/user/repos');
      jsonReply(ctx, 200, page.map((r) => repoJson(ctx, r)), link !== null ? { link } : {});
      return;
    }
    if (method === 'POST') {
      const body = bodyObject(ctx);
      const name = strField(body, 'name');
      if (name === undefined || name === '') { errorReply(ctx, 422, 'name is required'); return; }
      if (store.getRepo(VIEWER_LOGIN, name) !== undefined) {
        errorReply(ctx, 422, 'Repository creation failed: name already exists on this account');
        return;
      }
      const repo = store.createRepo(VIEWER_LOGIN, name, {
        private: boolField(body, 'private') ?? false,
        description: strField(body, 'description') ?? '',
        defaultBranch: strField(body, 'default_branch'),
      });
      jsonReply(ctx, 201, repoJson(ctx, repo));
      return;
    }
    errorReply(ctx, 405, 'Method Not Allowed');
    return;
  }
  // /api/v3/repos/{owner}/{repo}[...]
  if (s[0] === 'repos' && s.length >= 3) {
    const owner = s[1] as string;
    const name = s[2] as string;
    const rest = s.slice(3);
    await handleRepoRoutes(ctx, owner, name, rest);
    return;
  }
  errorReply(ctx, 404, 'Not Found');
}

async function handleRepoRoutes(ctx: RestContext, owner: string, name: string, rest: string[]): Promise<void> {
  const method = ctx.req.method ?? 'GET';
  const repo = store.getRepo(owner, name);
  if (rest.length === 0) {
    if (repo === undefined) { errorReply(ctx, 404, 'Not Found'); return; }
    if (method === 'GET') { jsonReply(ctx, 200, repoJson(ctx, repo)); return; }
    if (method === 'PATCH') {
      const body = bodyObject(ctx);
      const desc = strField(body, 'description');
      if (desc !== undefined) repo.description = desc;
      const priv = boolField(body, 'private');
      if (priv !== undefined) repo.private = priv;
      const branch = strField(body, 'default_branch');
      if (branch !== undefined) repo.defaultBranch = branch;
      const newName = strField(body, 'name');
      if (newName !== undefined && newName !== '' && newName !== repo.name) {
        if (store.getRepo(owner, newName) !== undefined) { errorReply(ctx, 422, 'Repository name already exists'); return; }
        store.deleteRepo(owner, repo.name);
        repo.name = newName;
        repo.fullName = `${owner}/${newName}`;
        store.repos.set(store.key(owner, newName), repo);
      }
      repo.updatedAt = TRIAL_NOW_ISO;
      jsonReply(ctx, 200, repoJson(ctx, repo));
      return;
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, name);
      jsonReply(ctx, 204, null);
      return;
    }
    errorReply(ctx, 405, 'Method Not Allowed');
    return;
  }
  if (repo === undefined) { errorReply(ctx, 404, 'Not Found'); return; }
  const head = rest[0] as string;
  // branches
  if (head === 'branches') {
    if (rest.length === 1) {
      if (method !== 'GET') { errorReply(ctx, 405, 'Method Not Allowed'); return; }
      const list = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({
          name: ref.slice('refs/heads/'.length),
          commit: { sha, url: `${ctx.origin}/api/v3/repos/${owner}/${name}/commits/${sha}` },
          protected: false,
        }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      jsonReply(ctx, 200, list);
      return;
    }
    const branch = rest.slice(1).join('/');
    const sha = resolveBranchTip(repo, branch);
    if (sha === undefined) { errorReply(ctx, 404, 'Branch not found'); return; }
    if (method !== 'GET') { errorReply(ctx, 405, 'Method Not Allowed'); return; }
    jsonReply(ctx, 200, {
      name: branch,
      commit: { sha, url: `${ctx.origin}/api/v3/repos/${owner}/${name}/commits/${sha}` },
      protected: false,
      protection: { enabled: false, required_status_checks: { enforcement_level: 'off', contexts: [] } },
    });
    return;
  }
  // commits
  if (head === 'commits') {
    if (method !== 'GET') { errorReply(ctx, 405, 'Method Not Allowed'); return; }
    if (rest.length === 2) {
      const one = commitJson(ctx, repo, rest[1] as string);
      if (one === null) { errorReply(ctx, 404, 'Not Found'); return; }
      jsonReply(ctx, 200, one);
      return;
    }
    const shaParam = ctx.query.get('sha');
    const tip = shaParam !== null ? resolveRef(repo, shaParam) : repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (tip === undefined) { jsonReply(ctx, 200, []); return; }
    const ordered: string[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      ordered.push(oid);
      const view = parseCommit(obj.data);
      for (let i = view.parents.length - 1; i >= 0; i -= 1) stack.push(view.parents[i] as string);
    }
    const { page, link } = paginate(ctx, ordered, `/api/v3/repos/${owner}/${name}/commits`);
    const items = page.map((oid) => commitJson(ctx, repo, oid)).filter((x) => x !== null);
    jsonReply(ctx, 200, items, link !== null ? { link } : {});
    return;
  }
  // git/refs
  if (head === 'git' && rest[1] === 'refs') {
    if (rest.length === 2) {
      if (method === 'GET') {
        const list = [...repo.refs.entries()].map(([ref, sha]) => ({
          ref,
          node_id: `REF_${repo.id}_${ref}`,
          url: `${ctx.origin}/api/v3/repos/${owner}/${name}/git/refs/${ref.replace(/^refs\//, '')}`,
          object: { sha, type: 'commit', url: `${ctx.origin}/api/v3/repos/${owner}/${name}/git/commits/${sha}` },
        }));
        jsonReply(ctx, 200, list);
        return;
      }
      if (method === 'POST') {
        const body = bodyObject(ctx);
        const ref = strField(body, 'ref');
        const sha = strField(body, 'sha');
        if (ref === undefined || sha === undefined) { errorReply(ctx, 422, 'ref and sha are required'); return; }
        if (!ref.startsWith('refs/')) { errorReply(ctx, 422, 'ref must start with refs/'); return; }
        if (!isObjectId(sha) || !repo.objects.has(sha)) { errorReply(ctx, 422, 'Invalid SHA'); return; }
        if (repo.refs.has(ref)) { errorReply(ctx, 422, 'Reference already exists'); return; }
        repo.refs.set(ref, sha);
        jsonReply(ctx, 201, {
          ref,
          node_id: `REF_${repo.id}_${ref}`,
          url: `${ctx.origin}/api/v3/repos/${owner}/${name}/git/refs/${ref.replace(/^refs\//, '')}`,
          object: { sha, type: 'commit', url: `${ctx.origin}/api/v3/repos/${owner}/${name}/git/commits/${sha}` },
        });
        return;
      }
      errorReply(ctx, 405, 'Method Not Allowed');
      return;
    }
    const refPath = rest.slice(2).join('/');
    if (method === 'GET') {
      const fullRef = refPath.startsWith('refs/') ? refPath : `refs/${refPath}`;
      const sha = repo.refs.get(fullRef);
      if (sha === undefined) { errorReply(ctx, 404, 'Not Found'); return; }
      jsonReply(ctx, 200, {
        ref: fullRef,
        node_id: `REF_${repo.id}_${fullRef}`,
        url: `${ctx.origin}/api/v3/repos/${owner}/${name}/git/refs/${refPath}`,
        object: { sha, type: 'commit', url: `${ctx.origin}/api/v3/repos/${owner}/${name}/git/commits/${sha}` },
      });
      return;
    }
    errorReply(ctx, 404, 'Not Found');
    return;
  }
  // contents
  if (head === 'contents') {
    const path = rest.slice(1).join('/');
    await handleContents(ctx, repo, path);
    return;
  }
  // labels
  if (head === 'labels') {
    if (rest.length === 1) {
      if (method === 'GET') {
        jsonReply(ctx, 200, [...repo.labels.values()].map((l) => labelJson(ctx, repo, l)));
        return;
      }
      if (method === 'POST') {
        const body = bodyObject(ctx);
        const labelName = strField(body, 'name');
        const color = strField(body, 'color') ?? 'ededed';
        if (labelName === undefined || labelName === '') { errorReply(ctx, 422, 'name is required'); return; }
        if (repo.labels.has(labelName)) { errorReply(ctx, 422, 'Label already exists'); return; }
        const label: Label = { name: labelName, color: color.replace(/^#/, ''), description: strField(body, 'description') ?? '' };
        repo.labels.set(labelName, label);
        jsonReply(ctx, 201, labelJson(ctx, repo, label));
        return;
      }
      errorReply(ctx, 405, 'Method Not Allowed');
      return;
    }
    errorReply(ctx, 404, 'Not Found');
    return;
  }
  // issues
  if (head === 'issues') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = ctx.query.get('state') ?? 'open';
        let list = repo.issues;
        if (state === 'open') list = list.filter((i) => i.state === 'open');
        else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
        const sort = ctx.query.get('sort') ?? 'created';
        const direction = ctx.query.get('direction') ?? 'desc';
        const sorted = [...list];
        if (sort === 'created') {
          sorted.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
        }
        const { page, link } = paginate(ctx, sorted, `/api/v3/repos/${owner}/${name}/issues`);
        jsonReply(ctx, 200, page.map((i) => issueJson(ctx, repo, i)), link !== null ? { link } : {});
        return;
      }
      if (method === 'POST') {
        const body = bodyObject(ctx);
        const title = strField(body, 'title');
        if (title === undefined || title === '') { errorReply(ctx, 422, 'title is required'); return; }
        const rawLabels = body !== null && Array.isArray(body['labels']) ? (body['labels'] as unknown[]) : [];
        const labels: Label[] = [];
        for (const raw of rawLabels) {
          const labelName = typeof raw === 'string' ? raw : typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>)['name'] : undefined;
          if (typeof labelName !== 'string') continue;
          const label = repo.labels.get(labelName);
          if (label === undefined) { errorReply(ctx, 422, `Label '${labelName}' does not exist`); return; }
          labels.push(label);
        }
        const issue: Issue = {
          id: store.nextIssueId,
          number: repo.nextIssue,
          title,
          body: strField(body, 'body') ?? '',
          state: 'open',
          labels,
          comments: [],
          user: VIEWER_LOGIN,
          createdAt: TRIAL_NOW_ISO,
          updatedAt: TRIAL_NOW_ISO,
          closedAt: null,
        };
        store.nextIssueId += 1;
        repo.nextIssue += 1;
        repo.issues.push(issue);
        jsonReply(ctx, 201, issueJson(ctx, repo, issue));
        return;
      }
      errorReply(ctx, 405, 'Method Not Allowed');
      return;
    }
    const number = Number.parseInt(rest[1] as string, 10);
    const issue = repo.issues.find((i) => i.number === number);
    if (issue === undefined) { errorReply(ctx, 404, 'Not Found'); return; }
    if (rest.length === 2) {
      if (method === 'GET') { jsonReply(ctx, 200, issueJson(ctx, repo, issue)); return; }
      if (method === 'PATCH') {
        const body = bodyObject(ctx);
        const title = strField(body, 'title');
        if (title !== undefined) issue.title = title;
        const bodyText = strField(body, 'body');
        if (bodyText !== undefined) issue.body = bodyText;
        const state = strField(body, 'state');
        if (state === 'closed' || state === 'open') {
          issue.state = state;
          issue.closedAt = state === 'closed' ? TRIAL_NOW_ISO : null;
        }
        issue.updatedAt = TRIAL_NOW_ISO;
        jsonReply(ctx, 200, issueJson(ctx, repo, issue));
        return;
      }
      errorReply(ctx, 405, 'Method Not Allowed');
      return;
    }
    if (rest[2] === 'comments') {
      if (method === 'GET') {
        const items = issue.comments.map((c) => ({
          id: c.id,
          node_id: `IC_${c.id}`,
          url: `${ctx.origin}/api/v3/repos/${owner}/${name}/issues/comments/${c.id}`,
          html_url: `https://github.com/${repo.fullName}/issues/${issue.number}#issuecomment-${c.id}`,
          body: c.body,
          user: ownerJson(c.user),
          created_at: c.createdAt,
          updated_at: c.updatedAt,
          author_association: 'OWNER',
        }));
        jsonReply(ctx, 200, items);
        return;
      }
      if (method === 'POST') {
        const body = bodyObject(ctx);
        const text = strField(body, 'body');
        if (text === undefined) { errorReply(ctx, 422, 'body is required'); return; }
        const comment = {
          id: repo.nextCommentId,
          body: text,
          user: VIEWER_LOGIN,
          createdAt: TRIAL_NOW_ISO,
          updatedAt: TRIAL_NOW_ISO,
        };
        repo.nextCommentId += 1;
        issue.comments.push(comment);
        jsonReply(ctx, 201, {
          id: comment.id,
          node_id: `IC_${comment.id}`,
          url: `${ctx.origin}/api/v3/repos/${owner}/${name}/issues/comments/${comment.id}`,
          html_url: `https://github.com/${repo.fullName}/issues/${issue.number}#issuecomment-${comment.id}`,
          body: comment.body,
          user: ownerJson(comment.user),
          created_at: comment.createdAt,
          updated_at: comment.updatedAt,
          author_association: 'OWNER',
        });
        return;
      }
      errorReply(ctx, 405, 'Method Not Allowed');
      return;
    }
    errorReply(ctx, 404, 'Not Found');
    return;
  }
  // pulls
  if (head === 'pulls') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = ctx.query.get('state') ?? 'open';
        let list = repo.pulls;
        if (state === 'open') list = list.filter((p) => p.state === 'open');
        else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
        const sorted = [...list].sort((a, b) => b.number - a.number);
        const { page, link } = paginate(ctx, sorted, `/api/v3/repos/${owner}/${name}/pulls`);
        jsonReply(ctx, 200, page.map((p) => pullJson(ctx, repo, p)), link !== null ? { link } : {});
        return;
      }
      if (method === 'POST') {
        const body = bodyObject(ctx);
        const title = strField(body, 'title');
        const headRef = strField(body, 'head');
        const baseRef = strField(body, 'base');
        if (title === undefined || headRef === undefined || baseRef === undefined) {
          errorReply(ctx, 422, 'title, head and base are required');
          return;
        }
        const headBranch = headRef.includes(':') ? (headRef.split(':')[1] as string) : headRef;
        const baseBranch = baseRef.includes(':') ? (baseRef.split(':')[1] as string) : baseRef;
        const headSha = resolveBranchTip(repo, headBranch);
        const baseSha = resolveBranchTip(repo, baseBranch);
        if (headSha === undefined || baseSha === undefined) {
          errorReply(ctx, 422, 'Head or base branch does not exist');
          return;
        }
        const pr: Pull = {
          id: store.nextPullId,
          number: repo.nextPull,
          title,
          body: strField(body, 'body') ?? '',
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
        jsonReply(ctx, 201, pullJson(ctx, repo, pr));
        return;
      }
      errorReply(ctx, 405, 'Method Not Allowed');
      return;
    }
    const number = Number.parseInt(rest[1] as string, 10);
    const pr = repo.pulls.find((p) => p.number === number);
    if (pr === undefined) { errorReply(ctx, 404, 'Not Found'); return; }
    if (rest.length === 2) {
      if (method === 'GET') { jsonReply(ctx, 200, pullJson(ctx, repo, pr)); return; }
      errorReply(ctx, 405, 'Method Not Allowed');
      return;
    }
    if (rest[2] === 'files') {
      if (method !== 'GET') { errorReply(ctx, 405, 'Method Not Allowed'); return; }
      const files = prFileDiff(repo, pr).map((f) => ({
        sha: '',
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        changes: f.changes,
        blob_url: `https://github.com/${repo.fullName}/blob/${pr.headSha}/${f.filename}`,
        raw_url: `https://github.com/${repo.fullName}/raw/${pr.headSha}/${f.filename}`,
        contents_url: `${ctx.origin}/api/v3/repos/${owner}/${name}/contents/${f.filename}?ref=${pr.headSha}`,
      }));
      jsonReply(ctx, 200, files);
      return;
    }
    if (rest[2] === 'merge') {
      if (method !== 'PUT') { errorReply(ctx, 405, 'Method Not Allowed'); return; }
      if (pr.state !== 'open') { errorReply(ctx, 405, 'Pull request is already closed'); return; }
      if (prConflict(repo, pr)) { errorReply(ctx, 405, 'Merge conflict'); return; }
      const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (defaultTip === undefined) { errorReply(ctx, 422, 'Default branch has no commits'); return; }
      // Squash: default tip tree + the PR's file changes.
      const defaultObj = repo.objects.get(defaultTip);
      const headObj = repo.objects.get(pr.headSha);
      if (defaultObj === undefined || headObj === undefined) { errorReply(ctx, 422, 'Missing commit'); return; }
      const flat = flattenTree(repo, parseCommit(defaultObj.data).tree);
      const headFlat = flattenTree(repo, parseCommit(headObj.data).tree);
      for (const path of prChangedPaths(repo, pr)) {
        const oid = headFlat.get(path);
        if (oid === undefined) flat.delete(path);
        else flat.set(path, oid);
      }
      const treeSha = buildTreeFromPaths(repo, flat);
      const commitData = buildCommitData(treeSha, [defaultTip], `${pr.title} (#${pr.number})`);
      const mergeSha = putObject(repo, 'commit', commitData);
      repo.refs.set(`refs/heads/${repo.defaultBranch}`, mergeSha);
      pr.state = 'closed';
      pr.merged = true;
      pr.mergedAt = TRIAL_NOW_ISO;
      pr.mergeCommitSha = mergeSha;
      pr.updatedAt = TRIAL_NOW_ISO;
      jsonReply(ctx, 200, { sha: mergeSha, merged: true, message: `Pull request #${pr.number} merged` });
      return;
    }
    errorReply(ctx, 404, 'Not Found');
    return;
  }
  errorReply(ctx, 404, 'Not Found');
}

async function handleContents(ctx: RestContext, repo: Repo, path: string): Promise<void> {
  const method = ctx.req.method ?? 'GET';
  const body = bodyObject(ctx);
  const refParam = ctx.query.get('ref') ?? (method === 'GET' ? undefined : strField(body, 'branch'));
  const branch = refParam ?? repo.defaultBranch;
  const tip = resolveRef(repo, branch);
  if (method === 'GET') {
    if (tip === undefined) { errorReply(ctx, 404, 'Not Found'); return; }
    const tipObj = repo.objects.get(tip);
    if (tipObj === undefined || tipObj.type !== 'commit') { errorReply(ctx, 404, 'Not Found'); return; }
    const rootTree = parseCommit(tipObj.data).tree;
    const flat = flattenTree(repo, rootTree);
    if (path === '') {
      // Root directory listing.
      const entries = new Map<string, { type: string; oid: string }>();
      for (const [p, oid] of flat) {
        const slash = p.indexOf('/');
        if (slash < 0) entries.set(p, { type: 'file', oid });
        else entries.set(p.slice(0, slash), { type: 'dir', oid: '' });
      }
      const list = [...entries.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([p, e]) => ({
        type: e.type,
        size: e.type === 'file' ? (repo.objects.get(e.oid)?.data.length ?? 0) : 0,
        name: p,
        path: p,
        sha: e.oid,
        url: `${ctx.origin}/api/v3/repos/${repo.owner}/${repo.name}/contents/${p}`,
        git_url: `${ctx.origin}/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${e.oid}`,
        html_url: `https://github.com/${repo.fullName}/tree/${branch}/${p}`,
        download_url: e.type === 'file' ? `https://raw.githubusercontent.com/${repo.fullName}/${branch}/${p}` : null,
        _links: { self: `${ctx.origin}/api/v3/repos/${repo.owner}/${repo.name}/contents/${p}`, git: `${ctx.origin}/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${e.oid}`, html: `https://github.com/${repo.fullName}/tree/${branch}/${p}` },
      }));
      jsonReply(ctx, 200, list);
      return;
    }
    const blobOid = flat.get(path);
    if (blobOid !== undefined) {
      const blob = repo.objects.get(blobOid);
      const data = blob === undefined ? Buffer.alloc(0) : blob.data;
      jsonReply(ctx, 200, {
        type: 'file',
        encoding: 'base64',
        size: data.length,
        name: path.split('/').pop() ?? path,
        path,
        content: data.toString('base64'),
        sha: blobOid,
        url: `${ctx.origin}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
        git_url: `${ctx.origin}/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${blobOid}`,
        html_url: `https://github.com/${repo.fullName}/blob/${branch}/${path}`,
        download_url: `https://raw.githubusercontent.com/${repo.fullName}/${branch}/${path}`,
        _links: { self: `${ctx.origin}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`, git: `${ctx.origin}/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${blobOid}`, html: `https://github.com/${repo.fullName}/blob/${branch}/${path}` },
      });
      return;
    }
    // A directory?
    const prefix = `${path}/`;
    const children = new Map<string, { type: string; oid: string }>();
    for (const [p, oid] of flat) {
      if (!p.startsWith(prefix)) continue;
      const restPath = p.slice(prefix.length);
      const slash = restPath.indexOf('/');
      if (slash < 0) children.set(restPath, { type: 'file', oid });
      else children.set(restPath.slice(0, slash), { type: 'dir', oid: '' });
    }
    if (children.size === 0) { errorReply(ctx, 404, 'Not Found'); return; }
    const list = [...children.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([p, e]) => ({
      type: e.type,
      size: e.type === 'file' ? (repo.objects.get(e.oid)?.data.length ?? 0) : 0,
      name: p,
      path: `${path}/${p}`,
      sha: e.oid,
      url: `${ctx.origin}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}/${p}`,
      git_url: `${ctx.origin}/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${e.oid}`,
      html_url: `https://github.com/${repo.fullName}/tree/${branch}/${path}/${p}`,
      download_url: e.type === 'file' ? `https://raw.githubusercontent.com/${repo.fullName}/${branch}/${path}/${p}` : null,
      _links: { self: `${ctx.origin}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}/${p}`, git: `${ctx.origin}/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${e.oid}`, html: `https://github.com/${repo.fullName}/tree/${branch}/${path}/${p}` },
    }));
    jsonReply(ctx, 200, list);
    return;
  }
  if (method === 'PUT') {
    const contentB64 = strField(body, 'content');
    const message = strField(body, 'message') ?? `Update ${path}`;
    if (contentB64 === undefined) { errorReply(ctx, 422, 'content is required'); return; }
    let content: Buffer;
    try {
      content = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
    } catch {
      errorReply(ctx, 422, 'content is not valid base64');
      return;
    }
    if (tip === undefined) {
      // No branch yet: create the first commit on the branch.
      const blobOid = putObject(repo, 'blob', content);
      const { commitSha } = commitFileChange(repo, branch, path, blobOid, message);
      jsonReply(ctx, 201, {
        content: {
          name: path.split('/').pop() ?? path,
          path,
          sha: blobOid,
          size: content.length,
          url: `${ctx.origin}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
          html_url: `https://github.com/${repo.fullName}/blob/${branch}/${path}`,
          git_url: `${ctx.origin}/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${blobOid}`,
          download_url: `https://raw.githubusercontent.com/${repo.fullName}/${branch}/${path}`,
          type: 'file',
          encoding: 'base64',
          content: contentB64,
          _links: { self: `${ctx.origin}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`, git: `${ctx.origin}/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${blobOid}`, html: `https://github.com/${repo.fullName}/blob/${branch}/${path}` },
        },
        commit: { sha: commitSha, message, author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: TRIAL_NOW_ISO }, committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: TRIAL_NOW_ISO } },
      });
      return;
    }
    const tipObj = repo.objects.get(tip);
    if (tipObj === undefined || tipObj.type !== 'commit') { errorReply(ctx, 404, 'Not Found'); return; }
    const flat = flattenTree(repo, parseCommit(tipObj.data).tree);
    const current = flat.get(path);
    const givenSha = strField(body, 'sha');
    if (current !== undefined) {
      if (givenSha === undefined) { errorReply(ctx, 409, 'sha is required to update a file'); return; }
      if (givenSha !== current) { errorReply(ctx, 409, 'sha does not match the current file'); return; }
    }
    const blobOid = putObject(repo, 'blob', content);
    const { commitSha } = commitFileChange(repo, branch, path, blobOid, message);
    jsonReply(ctx, current === undefined ? 201 : 200, {
      content: {
        name: path.split('/').pop() ?? path,
        path,
        sha: blobOid,
        size: content.length,
        url: `${ctx.origin}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
        html_url: `https://github.com/${repo.fullName}/blob/${branch}/${path}`,
        git_url: `${ctx.origin}/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${blobOid}`,
        download_url: `https://raw.githubusercontent.com/${repo.fullName}/${branch}/${path}`,
        type: 'file',
        encoding: 'base64',
        content: contentB64,
        _links: { self: `${ctx.origin}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`, git: `${ctx.origin}/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${blobOid}`, html: `https://github.com/${repo.fullName}/blob/${branch}/${path}` },
      },
      commit: { sha: commitSha, message, author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: TRIAL_NOW_ISO }, committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: TRIAL_NOW_ISO } },
    });
    return;
  }
  if (method === 'DELETE') {
    if (tip === undefined) { errorReply(ctx, 404, 'Not Found'); return; }
    const tipObj = repo.objects.get(tip);
    if (tipObj === undefined || tipObj.type !== 'commit') { errorReply(ctx, 404, 'Not Found'); return; }
    const flat = flattenTree(repo, parseCommit(tipObj.data).tree);
    const current = flat.get(path);
    if (current === undefined) { errorReply(ctx, 404, 'Not Found'); return; }
    const givenSha = strField(body, 'sha');
    if (givenSha === undefined) { errorReply(ctx, 409, 'sha is required to delete a file'); return; }
    if (givenSha !== current) { errorReply(ctx, 409, 'sha does not match the current file'); return; }
    const message = strField(body, 'message') ?? `Delete ${path}`;
    const { commitSha } = commitFileChange(repo, branch, path, null, message);
    jsonReply(ctx, 200, {
      commit: { sha: commitSha, message, author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: TRIAL_NOW_ISO }, committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: TRIAL_NOW_ISO } },
    });
    return;
  }
  errorReply(ctx, 405, 'Method Not Allowed');
}
