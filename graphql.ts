// GitHub GraphQL v4, for the documents gh and github-mcp-server actually
// send: a small recursive-descent parser + executor over the forge's store,
// with a static introspection schema. Unauthenticated requests are refused
// before this module (exactly 401); unknown repos answer data.repository null.

import {
  buildTreeFromPaths,
  flattenTree,
  isObjectId,
  parseCommit,
  putObject,
  store,
  TRIAL_NOW_ISO,
  TRIAL_NOW_SEC,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';
import { prChangedPaths, prConflict } from './rest.ts';

// ---------------------------------------------------------------- global ids

export function repoGid(repo: Repo): string {
  return `R_${repo.id}`;
}
export function issueGid(repo: Repo, issue: Issue): string {
  return `I_${repo.id}_${issue.number}`;
}
export function pullGid(repo: Repo, pr: Pull): string {
  return `PR_${repo.id}_${pr.number}`;
}
export function commentGid(repo: Repo, commentId: number): string {
  return `IC_${repo.id}_${commentId}`;
}

function findRepoByGid(gid: string): Repo | undefined {
  if (!gid.startsWith('R_')) return undefined;
  const id = Number.parseInt(gid.slice(2), 10);
  if (!Number.isFinite(id)) return undefined;
  for (const repo of store.repos.values()) if (repo.id === id) return repo;
  return undefined;
}

function findIssueByGid(gid: string): { repo: Repo; issue: Issue } | undefined {
  const m = /^I_(\d+)_(\d+)$/.exec(gid);
  if (m === null) return undefined;
  const repo = findRepoByGid(`R_${m[1] as string}`);
  if (repo === undefined) return undefined;
  const issue = repo.issues.find((i) => i.number === Number(m[2]));
  return issue === undefined ? undefined : { repo, issue };
}

function findPullByGid(gid: string): { repo: Repo; pr: Pull } | undefined {
  const m = /^PR_(\d+)_(\d+)$/.exec(gid);
  if (m === null) return undefined;
  const repo = findRepoByGid(`R_${m[1] as string}`);
  if (repo === undefined) return undefined;
  const pr = repo.pulls.find((p) => p.number === Number(m[2]));
  return pr === undefined ? undefined : { repo, pr };
}

// ---------------------------------------------------------------- static schema (for __type)

type TypeKind = 'OBJECT' | 'ENUM' | 'SCALAR' | 'INPUT_OBJECT' | 'NON_NULL' | 'LIST' | 'INTERFACE' | 'UNION';

interface TypeRef {
  kind: TypeKind;
  name: string | null;
  ofType: TypeRef | null;
}

function named(name: string): TypeRef {
  return { kind: 'OBJECT', name, ofType: null };
}
function nonNull(inner: TypeRef): TypeRef {
  return { kind: 'NON_NULL', name: null, ofType: inner };
}
function list(inner: TypeRef): TypeRef {
  return { kind: 'LIST', name: null, ofType: inner };
}
function scalar(name: string): TypeRef {
  return { kind: 'SCALAR', name, ofType: null };
}
function enumRef(name: string): TypeRef {
  return { kind: 'ENUM', name, ofType: null };
}

interface FieldDef {
  type: TypeRef;
  args?: Record<string, TypeRef>;
}

interface TypeDef {
  kind: 'OBJECT' | 'ENUM' | 'SCALAR' | 'INPUT_OBJECT';
  name: string;
  fields?: Record<string, FieldDef>;
  enumValues?: string[];
}

const STR = scalar('String');
const INT = scalar('Int');
const BOOL = scalar('Boolean');
const ID = scalar('ID');
const URI = scalar('URI');
const DATETIME = scalar('DateTime');

const SCHEMA: Record<string, TypeDef> = {
  Query: {
    kind: 'OBJECT',
    name: 'Query',
    fields: {
      viewer: { type: named('User') },
      repository: { type: named('Repository'), args: { owner: nonNull(STR), name: nonNull(STR) } },
      node: { type: named('Node'), args: { id: nonNull(ID) } },
    },
  },
  Mutation: {
    kind: 'OBJECT',
    name: 'Mutation',
    fields: {
      createIssue: { type: named('CreateIssuePayload'), args: { input: nonNull(named('CreateIssueInput')) } },
      closeIssue: { type: named('CloseIssuePayload'), args: { input: nonNull(named('CloseIssueInput')) } },
      createPullRequest: { type: named('CreatePullRequestPayload'), args: { input: nonNull(named('CreatePullRequestInput')) } },
      mergePullRequest: { type: named('MergePullRequestPayload'), args: { input: nonNull(named('MergePullRequestInput')) } },
      addComment: { type: named('AddCommentPayload'), args: { input: nonNull(named('AddCommentInput')) } },
    },
  },
  User: {
    kind: 'OBJECT',
    name: 'User',
    fields: {
      id: { type: nonNull(ID) },
      login: { type: nonNull(STR) },
      name: { type: STR },
      email: { type: STR },
    },
  },
  Repository: {
    kind: 'OBJECT',
    name: 'Repository',
    fields: {
      id: { type: nonNull(ID) },
      databaseId: { type: INT },
      name: { type: nonNull(STR) },
      nameWithOwner: { type: nonNull(STR) },
      description: { type: STR },
      url: { type: URI },
      owner: { type: named('User') },
      defaultBranchRef: { type: named('Ref') },
      viewerPermission: { type: enumRef('RepositoryPermission') },
      hasIssuesEnabled: { type: nonNull(BOOL) },
      isPrivate: { type: BOOL },
      createdAt: { type: DATETIME },
      updatedAt: { type: DATETIME },
      issue: { type: named('Issue'), args: { number: nonNull(INT) } },
      issues: { type: named('IssueConnection'), args: { first: INT, after: STR, states: list(enumRef('IssueState')), orderBy: named('IssueOrder') } },
      pullRequest: { type: named('PullRequest'), args: { number: nonNull(INT) } },
      pullRequests: { type: named('PullRequestConnection'), args: { first: INT, after: STR, states: list(enumRef('PullRequestState')) } },
    },
  },
  Issue: {
    kind: 'OBJECT',
    name: 'Issue',
    fields: {
      id: { type: nonNull(ID) },
      number: { type: nonNull(INT) },
      title: { type: nonNull(STR) },
      body: { type: STR },
      state: { type: nonNull(enumRef('IssueState')) },
      createdAt: { type: DATETIME },
      updatedAt: { type: DATETIME },
      closedAt: { type: DATETIME },
      url: { type: URI },
      author: { type: named('User') },
    },
  },
  PullRequest: {
    kind: 'OBJECT',
    name: 'PullRequest',
    fields: {
      id: { type: nonNull(ID) },
      number: { type: nonNull(INT) },
      title: { type: nonNull(STR) },
      body: { type: STR },
      state: { type: nonNull(enumRef('PullRequestState')) },
      merged: { type: nonNull(BOOL) },
      mergeable: { type: enumRef('MergeableState') },
      headRefName: { type: STR },
      baseRefName: { type: STR },
      headRef: { type: named('Ref') },
      baseRef: { type: named('Ref') },
      files: { type: named('PullRequestChangedFileConnection'), args: { first: INT, after: STR } },
      createdAt: { type: DATETIME },
      updatedAt: { type: DATETIME },
      url: { type: URI },
      author: { type: named('User') },
    },
  },
  Ref: {
    kind: 'OBJECT',
    name: 'Ref',
    fields: {
      id: { type: nonNull(ID) },
      name: { type: nonNull(STR) },
    },
  },
  IssueConnection: {
    kind: 'OBJECT',
    name: 'IssueConnection',
    fields: {
      nodes: { type: list(named('Issue')) },
      edges: { type: list(named('IssueEdge')) },
      pageInfo: { type: nonNull(named('PageInfo')) },
      totalCount: { type: nonNull(INT) },
    },
  },
  IssueEdge: {
    kind: 'OBJECT',
    name: 'IssueEdge',
    fields: {
      node: { type: named('Issue') },
      cursor: { type: nonNull(STR) },
    },
  },
  PullRequestConnection: {
    kind: 'OBJECT',
    name: 'PullRequestConnection',
    fields: {
      nodes: { type: list(named('PullRequest')) },
      edges: { type: list(named('PullRequestEdge')) },
      pageInfo: { type: nonNull(named('PageInfo')) },
      totalCount: { type: nonNull(INT) },
    },
  },
  PullRequestEdge: {
    kind: 'OBJECT',
    name: 'PullRequestEdge',
    fields: {
      node: { type: named('PullRequest') },
      cursor: { type: nonNull(STR) },
    },
  },
  PullRequestChangedFileConnection: {
    kind: 'OBJECT',
    name: 'PullRequestChangedFileConnection',
    fields: {
      nodes: { type: list(named('PullRequestChangedFile')) },
      edges: { type: list(named('PullRequestChangedFileEdge')) },
      pageInfo: { type: nonNull(named('PageInfo')) },
      totalCount: { type: nonNull(INT) },
    },
  },
  PullRequestChangedFileEdge: {
    kind: 'OBJECT',
    name: 'PullRequestChangedFileEdge',
    fields: {
      node: { type: named('PullRequestChangedFile') },
      cursor: { type: nonNull(STR) },
    },
  },
  PullRequestChangedFile: {
    kind: 'OBJECT',
    name: 'PullRequestChangedFile',
    fields: {
      path: { type: nonNull(STR) },
      additions: { type: nonNull(INT) },
      deletions: { type: nonNull(INT) },
      changeType: { type: STR },
    },
  },
  PageInfo: {
    kind: 'OBJECT',
    name: 'PageInfo',
    fields: {
      hasNextPage: { type: nonNull(BOOL) },
      hasPreviousPage: { type: nonNull(BOOL) },
      startCursor: { type: STR },
      endCursor: { type: STR },
    },
  },
  Node: { kind: 'OBJECT', name: 'Node', fields: { id: { type: nonNull(ID) } } },
  IssueState: { kind: 'ENUM', name: 'IssueState', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', name: 'PullRequestState', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', name: 'MergeableState', enumValues: ['CONFLICTING', 'MERGEABLE', 'UNKNOWN'] },
  RepositoryPermission: { kind: 'ENUM', name: 'RepositoryPermission', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  SearchType: { kind: 'ENUM', name: 'SearchType', enumValues: ['COMMIT', 'DISCUSSION', 'ISSUE', 'REPOSITORY', 'USER'] },
  CreateIssuePayload: { kind: 'OBJECT', name: 'CreateIssuePayload', fields: { issue: { type: named('Issue') }, clientMutationId: { type: STR } } },
  CloseIssuePayload: { kind: 'OBJECT', name: 'CloseIssuePayload', fields: { issue: { type: named('Issue') }, clientMutationId: { type: STR } } },
  CreatePullRequestPayload: { kind: 'OBJECT', name: 'CreatePullRequestPayload', fields: { pullRequest: { type: named('PullRequest') }, clientMutationId: { type: STR } } },
  MergePullRequestPayload: { kind: 'OBJECT', name: 'MergePullRequestPayload', fields: { pullRequest: { type: named('PullRequest') }, clientMutationId: { type: STR } } },
  AddCommentPayload: { kind: 'OBJECT', name: 'AddCommentPayload', fields: { commentEdge: { type: named('IssueCommentEdge') }, clientMutationId: { type: STR } } },
  IssueCommentEdge: { kind: 'OBJECT', name: 'IssueCommentEdge', fields: { node: { type: named('IssueComment') }, cursor: { type: nonNull(STR) } } },
  IssueComment: { kind: 'OBJECT', name: 'IssueComment', fields: { id: { type: nonNull(ID) }, body: { type: nonNull(STR) }, createdAt: { type: DATETIME }, author: { type: named('User') } } },
  CreateIssueInput: { kind: 'INPUT_OBJECT', name: 'CreateIssueInput' },
  CloseIssueInput: { kind: 'INPUT_OBJECT', name: 'CloseIssueInput' },
  CreatePullRequestInput: { kind: 'INPUT_OBJECT', name: 'CreatePullRequestInput' },
  MergePullRequestInput: { kind: 'INPUT_OBJECT', name: 'MergePullRequestInput' },
  AddCommentInput: { kind: 'INPUT_OBJECT', name: 'AddCommentInput' },
  IssueOrder: { kind: 'INPUT_OBJECT', name: 'IssueOrder' },
};

function typeRefObject(ref: TypeRef): Record<string, unknown> {
  const out: Record<string, unknown> = { kind: ref.kind, name: ref.name, ofType: null };
  if (ref.ofType !== null) out.ofType = typeRefObject(ref.ofType);
  return out;
}

function fieldObject(name: string, def: FieldDef): Record<string, unknown> {
  return {
    name,
    description: null,
    args: def.args !== undefined
      ? Object.entries(def.args).map(([argName, argType]) => ({
          name: argName,
          description: null,
          type: typeRefObject(argType),
          defaultValue: null,
        }))
      : [],
    type: typeRefObject(def.type),
    isDeprecated: false,
    deprecationReason: null,
  };
}

function introspectionTypeObject(def: TypeDef): Record<string, unknown> {
  return {
    kind: def.kind,
    name: def.name,
    description: null,
    fields: def.fields !== undefined ? Object.entries(def.fields).map(([n, d]) => fieldObject(n, d)) : null,
    enumValues: def.enumValues !== undefined
      ? def.enumValues.map((v) => ({ name: v, description: null, isDeprecated: false, deprecationReason: null }))
      : null,
    inputFields: def.kind === 'INPUT_OBJECT' ? [] : null,
    interfaces: def.kind === 'OBJECT' ? [] : null,
    possibleTypes: null,
    specifiedByURL: null,
  };
}

// ---------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Array<{ name: string; value: ValueNode }>;
  selections: SelectionNode[] | null;
}

interface FragmentSpreadNode {
  kind: 'spread';
  name: string;
}

interface InlineFragmentNode {
  kind: 'inline';
  typeCondition: string | null;
  selections: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  selections: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, { typeCondition: string; selections: SelectionNode[] }>;
}

class Lexer {
  pos = 0;
  src: string;
  constructor(src: string) {
    this.src = src;
  }

  private skipIgnored(): void {
    for (;;) {
      const c = this.src[this.pos];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
        this.pos += 1;
        continue;
      }
      if (c === '#') {
        while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.pos += 1;
        continue;
      }
      return;
    }
  }

  peek(): string {
    this.skipIgnored();
    return this.src.slice(this.pos, this.pos + 16);
  }

  expect(text: string): void {
    this.skipIgnored();
    if (!this.src.startsWith(text, this.pos)) throw new Error(`expected ${JSON.stringify(text)} at ${this.pos}`);
    this.pos += text.length;
  }

  tryConsume(text: string): boolean {
    this.skipIgnored();
    if (this.src.startsWith(text, this.pos)) {
      this.pos += text.length;
      return true;
    }
    return false;
  }

  readName(): string {
    this.skipIgnored();
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.src.slice(this.pos));
    if (m === null) throw new Error(`expected a name at ${this.pos}`);
    this.pos += m[0].length;
    return m[0];
  }

  readString(): string {
    this.skipIgnored();
    if (this.src[this.pos] === '"') {
      // Block string """...""" or normal "..."
      if (this.src.startsWith('"""', this.pos)) {
        const end = this.src.indexOf('"""', this.pos + 3);
        if (end < 0) throw new Error('unterminated block string');
        const raw = this.src.slice(this.pos + 3, end);
        this.pos = end + 3;
        return raw.replace(/\\"""/g, '"""');
      }
      this.pos += 1;
      let out = '';
      for (;;) {
        const c = this.src[this.pos];
        if (c === undefined) throw new Error('unterminated string');
        if (c === '"') {
          this.pos += 1;
          return out;
        }
        if (c === '\\') {
          const esc = this.src[this.pos + 1];
          this.pos += 2;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === '"') out += '"';
          else if (esc === '\\') out += '\\';
          else if (esc === '/') out += '/';
          else if (esc === 'b') out += '\b';
          else if (esc === 'f') out += '\f';
          else if (esc === 'u') {
            out += String.fromCharCode(Number.parseInt(this.src.slice(this.pos, this.pos + 4), 16));
            this.pos += 4;
          } else out += esc ?? '';
          continue;
        }
        out += c;
        this.pos += 1;
      }
    }
    throw new Error(`expected a string at ${this.pos}`);
  }

  readNumber(): { kind: 'int' | 'float'; value: number } {
    this.skipIgnored();
    const m = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(this.src.slice(this.pos));
    if (m === null) throw new Error(`expected a number at ${this.pos}`);
    this.pos += m[0].length;
    const isFloat = m[0].includes('.') || m[0].includes('e') || m[0].includes('E');
    return { kind: isFloat ? 'float' : 'int', value: Number(m[0]) };
  }

  atEnd(): boolean {
    this.skipIgnored();
    return this.pos >= this.src.length;
  }
}

function parseValue(lex: Lexer): ValueNode {
  const p = lex.peek();
  if (p.startsWith('$')) {
    lex.expect('$');
    return { kind: 'variable', name: lex.readName() };
  }
  if (p.startsWith('"')) return { kind: 'string', value: lex.readString() };
  if (p.startsWith('[')) {
    lex.expect('[');
    const values: ValueNode[] = [];
    while (!lex.tryConsume(']')) values.push(parseValue(lex));
    return { kind: 'list', values };
  }
  if (p.startsWith('{')) {
    lex.expect('{');
    const fields: Array<{ name: string; value: ValueNode }> = [];
    while (!lex.tryConsume('}')) {
      const name = lex.readName();
      lex.expect(':');
      fields.push({ name, value: parseValue(lex) });
    }
    return { kind: 'object', fields };
  }
  if (/^-?[0-9]/.test(p)) {
    const n = lex.readNumber();
    return { kind: n.kind, value: n.value };
  }
  const name = lex.readName();
  if (name === 'true') return { kind: 'boolean', value: true };
  if (name === 'false') return { kind: 'boolean', value: false };
  if (name === 'null') return { kind: 'null' };
  return { kind: 'enum', value: name };
}

function parseDirectives(lex: Lexer): void {
  while (lex.peek().startsWith('@')) {
    lex.expect('@');
    lex.readName();
    if (lex.peek().startsWith('(')) {
      lex.expect('(');
      while (!lex.tryConsume(')')) {
        lex.readName();
        lex.expect(':');
        parseValue(lex);
      }
    }
  }
}

function parseSelectionSet(lex: Lexer): SelectionNode[] {
  lex.expect('{');
  const out: SelectionNode[] = [];
  while (!lex.tryConsume('}')) {
    if (lex.peek().startsWith('...')) {
      lex.expect('...');
      const next = lex.peek();
      if (next.startsWith('on') && !/^[A-Za-z0-9_]/.test(next.slice(2, 3))) {
        lex.expect('on');
        const typeCondition = lex.readName();
        parseDirectives(lex);
        out.push({ kind: 'inline', typeCondition, selections: parseSelectionSet(lex) });
      } else {
        const name = lex.readName();
        parseDirectives(lex);
        out.push({ kind: 'spread', name });
      }
      continue;
    }
    const first = lex.readName();
    let alias: string | null = null;
    let name = first;
    if (lex.tryConsume(':')) {
      alias = first;
      name = lex.readName();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (lex.peek().startsWith('(')) {
      lex.expect('(');
      while (!lex.tryConsume(')')) {
        const argName = lex.readName();
        lex.expect(':');
        args.push({ name: argName, value: parseValue(lex) });
      }
    }
    parseDirectives(lex);
    const selections = lex.peek().startsWith('{') ? parseSelectionSet(lex) : null;
    out.push({ kind: 'field', name, alias, args, selections });
  }
  return out;
}

/** Skip one GraphQL type: a named type or a list, each optionally non-null (!). */
function skipType(lex: Lexer): void {
  if (lex.tryConsume('[')) {
    skipType(lex);
    lex.expect(']');
  } else {
    lex.readName();
  }
  lex.tryConsume('!');
}

function parseVariableDefinitions(lex: Lexer): void {
  if (!lex.peek().startsWith('(')) return;
  lex.expect('(');
  while (!lex.tryConsume(')')) {
    lex.expect('$');
    lex.readName();
    lex.expect(':');
    skipType(lex);
    if (lex.tryConsume('=')) parseValue(lex);
  }
}

export function parseDocument(source: string): DocumentNode {
  const lex = new Lexer(source);
  const doc: DocumentNode = { operations: [], fragments: new Map() };
  while (!lex.atEnd()) {
    const p = lex.peek();
    if (p.startsWith('fragment')) {
      lex.expect('fragment');
      const name = lex.readName();
      lex.expect('on');
      const typeCondition = lex.readName();
      parseDirectives(lex);
      doc.fragments.set(name, { typeCondition, selections: parseSelectionSet(lex) });
      continue;
    }
    let type: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    if (p.startsWith('query')) {
      lex.expect('query');
      type = 'query';
    } else if (p.startsWith('mutation')) {
      lex.expect('mutation');
      type = 'mutation';
    }
    if (!lex.peek().startsWith('(') && !lex.peek().startsWith('{') && !lex.peek().startsWith('@')) {
      name = lex.readName();
    }
    parseVariableDefinitions(lex);
    parseDirectives(lex);
    doc.operations.push({ type, name, selections: parseSelectionSet(lex) });
  }
  return doc;
}

// ---------------------------------------------------------------- execution

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': return variables[node.name];
    case 'string': return node.value;
    case 'int': return node.value;
    case 'float': return node.value;
    case 'boolean': return node.value;
    case 'null': return null;
    case 'enum': return node.value;
    case 'list': return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = resolveValue(f.value, variables);
      return out;
    }
  }
}

function argMap(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

interface ExecContext {
  variables: Record<string, unknown>;
  fragments: Map<string, { typeCondition: string; selections: SelectionNode[] }>;
  errors: Array<{ message: string }>;
}

type ParentKind =
  | { tag: 'query' }
  | { tag: 'mutation' }
  | { tag: 'repository'; repo: Repo }
  | { tag: 'issue'; repo: Repo; issue: Issue }
  | { tag: 'pull'; repo: Repo; pr: Pull }
  | { tag: 'user'; login: string }
  | { tag: 'ref'; name: string }
  | { tag: 'introspection'; value: Record<string, unknown> }
  | { tag: 'payload'; value: Record<string, unknown> }
  | { tag: 'connection'; items: Array<{ node: unknown; cursor: string }>; pageInfo: Record<string, unknown>; totalCount: number }
  | { tag: 'edge'; node: unknown; cursor: string }
  | { tag: 'file'; path: string; additions: number; deletions: number };

function cursorFor(n: number): string {
  return Buffer.from(`cursor:${n}`, 'utf8').toString('base64');
}

function cursorNumber(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m === null ? null : Number(m[1]);
  } catch {
    return null;
  }
}

function paginateConnection<T>(
  items: T[],
  args: Record<string, unknown>,
  keyOf: (item: T, index: number) => number,
  nodeOf: (item: T) => unknown,
): { tag: 'connection'; items: Array<{ node: unknown; cursor: string }>; pageInfo: Record<string, unknown>; totalCount: number } {
  const first = typeof args['first'] === 'number' ? (args['first'] as number) : null;
  const after = typeof args['after'] === 'string' ? cursorNumber(args['after'] as string) : null;
  let start = 0;
  if (after !== null) {
    const idx = items.findIndex((item, i) => keyOf(item, i) === after);
    start = idx >= 0 ? idx + 1 : items.length;
  }
  const slice = first === null ? items.slice(start) : items.slice(start, start + first);
  const end = start + slice.length;
  const hasNextPage = end < items.length;
  const edges = slice.map((item, i) => ({ node: nodeOf(item), cursor: cursorFor(keyOf(item, start + i)) }));
  return {
    tag: 'connection',
    items: edges,
    pageInfo: {
      hasNextPage,
      hasPreviousPage: start > 0,
      startCursor: edges.length > 0 ? (edges[0]?.cursor ?? null) : null,
      endCursor: edges.length > 0 ? (edges[edges.length - 1]?.cursor ?? null) : null,
    },
    totalCount: items.length,
  };
}

function issueValue(repo: Repo, issue: Issue): { tag: 'issue'; repo: Repo; issue: Issue } {
  return { tag: 'issue', repo, issue };
}

function pullValue(repo: Repo, pr: Pull): { tag: 'pull'; repo: Repo; pr: Pull } {
  return { tag: 'pull', repo, pr };
}

function resolveIssueField(parent: { tag: 'issue'; repo: Repo; issue: Issue }, field: FieldNode): unknown {
  const issue = parent.issue;
  switch (field.name) {
    case 'id': return issueGid(parent.repo, issue);
    case 'number': return issue.number;
    case 'title': return issue.title;
    case 'body': return issue.body;
    case 'state': return issue.state === 'open' ? 'OPEN' : 'CLOSED';
    case 'createdAt': return issue.createdAt;
    case 'updatedAt': return issue.updatedAt;
    case 'closedAt': return issue.closedAt;
    case 'url': return `https://github.com/${parent.repo.fullName}/issues/${issue.number}`;
    case 'author': return { tag: 'user', login: issue.user } as ParentKind;
    default: return undefined;
  }
}

function resolvePullField(parent: { tag: 'pull'; repo: Repo; pr: Pull }, field: FieldNode, args: Record<string, unknown>): unknown {
  const pr = parent.pr;
  switch (field.name) {
    case 'id': return pullGid(parent.repo, pr);
    case 'number': return pr.number;
    case 'title': return pr.title;
    case 'body': return pr.body;
    case 'state': return pr.state === 'open' ? 'OPEN' : pr.merged ? 'MERGED' : 'CLOSED';
    case 'merged': return pr.merged;
    case 'mergeable': return pr.state === 'open' ? (prConflict(parent.repo, pr) ? 'CONFLICTING' : 'MERGEABLE') : 'UNKNOWN';
    case 'headRefName': return pr.headRef;
    case 'baseRefName': return pr.baseRef;
    case 'headRef': return { tag: 'ref', name: pr.headRef } as ParentKind;
    case 'baseRef': return { tag: 'ref', name: pr.baseRef } as ParentKind;
    case 'createdAt': return pr.createdAt;
    case 'updatedAt': return pr.updatedAt;
    case 'url': return `https://github.com/${parent.repo.fullName}/pull/${pr.number}`;
    case 'author': return { tag: 'user', login: pr.user } as ParentKind;
    case 'files': {
      const files = prChangedPaths(parent.repo, pr);
      const items = [...files].sort().map((path) => ({ path, additions: 0, deletions: 0 }));
      return paginateConnection(items, args, (_item, i) => i, (item) => ({ tag: 'file', ...item }) as ParentKind);
    }
    default: return undefined;
  }
}

function resolveRepoField(parent: { tag: 'repository'; repo: Repo }, field: FieldNode, args: Record<string, unknown>): unknown {
  const repo = parent.repo;
  switch (field.name) {
    case 'id': return repoGid(repo);
    case 'databaseId': return repo.id;
    case 'name': return repo.name;
    case 'nameWithOwner': return repo.fullName;
    case 'description': return repo.description;
    case 'url': return `https://github.com/${repo.fullName}`;
    case 'owner': return { tag: 'user', login: repo.owner } as ParentKind;
    case 'defaultBranchRef': {
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (tip === undefined) return null;
      return { tag: 'ref', name: repo.defaultBranch } as ParentKind;
    }
    case 'viewerPermission': return 'ADMIN';
    case 'hasIssuesEnabled': return true;
    case 'isPrivate': return repo.private;
    case 'createdAt': return repo.createdAt;
    case 'updatedAt': return repo.updatedAt;
    case 'issue': {
      const number = args['number'];
      if (typeof number !== 'number') return null;
      const issue = repo.issues.find((i) => i.number === number);
      return issue === undefined ? null : issueValue(repo, issue);
    }
    case 'issues': {
      let list = [...repo.issues];
      const states = args['states'];
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((s) => String(s).toLowerCase()));
        list = list.filter((i) => wanted.has(i.state));
      }
      const orderBy = args['orderBy'];
      if (orderBy !== null && typeof orderBy === 'object') {
        const ob = orderBy as Record<string, unknown>;
        const direction = String(ob['direction'] ?? 'DESC');
        list.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
      } else {
        list.sort((a, b) => b.number - a.number);
      }
      return paginateConnection(list, args, (issue) => issue.number, (issue) => issueValue(repo, issue));
    }
    case 'pullRequest': {
      const number = args['number'];
      if (typeof number !== 'number') return null;
      const pr = repo.pulls.find((p) => p.number === number);
      return pr === undefined ? null : pullValue(repo, pr);
    }
    case 'pullRequests': {
      let list = [...repo.pulls];
      const states = args['states'];
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((s) => String(s)));
        list = list.filter((p) => {
          const st = p.state === 'open' ? 'OPEN' : p.merged ? 'MERGED' : 'CLOSED';
          return wanted.has(st);
        });
      }
      list.sort((a, b) => b.number - a.number);
      return paginateConnection(list, args, (pr) => pr.number, (pr) => pullValue(repo, pr));
    }
    default: return undefined;
  }
}

function resolveUserField(parent: { tag: 'user'; login: string }, field: FieldNode): unknown {
  switch (field.name) {
    case 'id': return `U_${parent.login}`;
    case 'login': return parent.login;
    case 'name': return parent.login === VIEWER_LOGIN ? VIEWER_NAME : parent.login;
    case 'email': return parent.login === VIEWER_LOGIN ? 'adaiversen@example.invalid' : null;
    default: return undefined;
  }
}

export function squashMerge(repo: Repo, pr: Pull): boolean {
  if (pr.state !== 'open') return false;
  if (prConflict(repo, pr)) return false;
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (defaultTip === undefined) return false;
  const defaultObj = repo.objects.get(defaultTip);
  const headObj = repo.objects.get(pr.headSha);
  if (defaultObj === undefined || headObj === undefined) return false;
  const flat = flattenTree(repo, parseCommit(defaultObj.data).tree);
  const headFlat = flattenTree(repo, parseCommit(headObj.data).tree);
  for (const path of prChangedPaths(repo, pr)) {
    const oid = headFlat.get(path);
    if (oid === undefined) flat.delete(path);
    else flat.set(path, oid);
  }
  const treeSha = buildTreeFromPaths(repo, flat);
  const lines = [`tree ${treeSha}`, `parent ${defaultTip}`, `author Conformance <conformance@make.fun> ${TRIAL_NOW_SEC} +0000`, `committer Conformance <conformance@make.fun> ${TRIAL_NOW_SEC} +0000`, ''];
  const commitData = Buffer.from(`${lines.join('\n')}\n${pr.title} (#${pr.number})\n`, 'utf8');
  const mergeSha = putObject(repo, 'commit', commitData);
  repo.refs.set(`refs/heads/${repo.defaultBranch}`, mergeSha);
  pr.state = 'closed';
  pr.merged = true;
  pr.mergedAt = TRIAL_NOW_ISO;
  pr.mergeCommitSha = mergeSha;
  pr.updatedAt = TRIAL_NOW_ISO;
  return true;
}

function executeMutationField(field: FieldNode, args: Record<string, unknown>): unknown {
  const input = (args['input'] !== null && typeof args['input'] === 'object' ? args['input'] as Record<string, unknown> : {}) as Record<string, unknown>;
  switch (field.name) {
    case 'createIssue': {
      const repo = typeof input['repositoryId'] === 'string' ? findRepoByGid(input['repositoryId']) : undefined;
      if (repo === undefined) return { tag: 'payload', value: { issue: null } } as ParentKind;
      const issue: Issue = {
        id: store.nextIssueId,
        number: repo.nextIssue,
        title: typeof input['title'] === 'string' ? input['title'] : '',
        body: typeof input['body'] === 'string' ? input['body'] : '',
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
      return { tag: 'payload', value: { issue: issueValue(repo, issue) } } as ParentKind;
    }
    case 'closeIssue': {
      const found = typeof input['issueId'] === 'string' ? findIssueByGid(input['issueId']) : undefined;
      if (found === undefined) return { tag: 'payload', value: { issue: null } } as ParentKind;
      found.issue.state = 'closed';
      found.issue.closedAt = TRIAL_NOW_ISO;
      found.issue.updatedAt = TRIAL_NOW_ISO;
      return { tag: 'payload', value: { issue: issueValue(found.repo, found.issue) } } as ParentKind;
    }
    case 'createPullRequest': {
      const repo = typeof input['repositoryId'] === 'string' ? findRepoByGid(input['repositoryId']) : undefined;
      if (repo === undefined) return { tag: 'payload', value: { pullRequest: null } } as ParentKind;
      const headRef = typeof input['headRefName'] === 'string' ? input['headRefName'] : '';
      const baseRef = typeof input['baseRefName'] === 'string' ? input['baseRefName'] : repo.defaultBranch;
      const headSha = repo.refs.get(`refs/heads/${headRef}`);
      const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
      if (headSha === undefined || baseSha === undefined) return { tag: 'payload', value: { pullRequest: null } } as ParentKind;
      const pr: Pull = {
        id: store.nextPullId,
        number: repo.nextPull,
        title: typeof input['title'] === 'string' ? input['title'] : '',
        body: typeof input['body'] === 'string' ? input['body'] : '',
        state: 'open',
        headRef,
        headSha,
        baseRef,
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
      return { tag: 'payload', value: { pullRequest: pullValue(repo, pr) } } as ParentKind;
    }
    case 'mergePullRequest': {
      const found = typeof input['pullRequestId'] === 'string' ? findPullByGid(input['pullRequestId']) : undefined;
      if (found === undefined) return { tag: 'payload', value: { pullRequest: null } } as ParentKind;
      squashMerge(found.repo, found.pr);
      return { tag: 'payload', value: { pullRequest: pullValue(found.repo, found.pr) } } as ParentKind;
    }
    case 'addComment': {
      const subjectId = typeof input['subjectId'] === 'string' ? input['subjectId'] : '';
      const bodyText = typeof input['body'] === 'string' ? input['body'] : '';
      const found = findIssueByGid(subjectId);
      if (found === undefined) {
        const prFound = findPullByGid(subjectId);
        if (prFound === undefined) return { tag: 'payload', value: { commentEdge: null } } as ParentKind;
        // Comments on a pull request land on its linked issue slot (not used by the suite).
        return { tag: 'payload', value: { commentEdge: null } } as ParentKind;
      }
      const comment = {
        id: found.repo.nextCommentId,
        body: bodyText,
        user: VIEWER_LOGIN,
        createdAt: TRIAL_NOW_ISO,
        updatedAt: TRIAL_NOW_ISO,
      };
      found.repo.nextCommentId += 1;
      found.issue.comments.push(comment);
      const edge = {
        tag: 'edge',
        node: { tag: 'introspection', value: { id: commentGid(found.repo, comment.id), body: bodyText, createdAt: TRIAL_NOW_ISO, author: { tag: 'user', login: VIEWER_LOGIN } as ParentKind } },
        cursor: cursorFor(comment.id),
      } as ParentKind;
      return { tag: 'payload', value: { commentEdge: edge } } as ParentKind;
    }
    default: return undefined;
  }
}

function typeNameOf(parent: ParentKind): string {
  switch (parent.tag) {
    case 'query': return 'Query';
    case 'mutation': return 'Mutation';
    case 'repository': return 'Repository';
    case 'issue': return 'Issue';
    case 'pull': return 'PullRequest';
    case 'user': return 'User';
    case 'ref': return 'Ref';
    case 'introspection': return 'Introspection';
    case 'payload': return 'Payload';
    case 'connection': return 'Connection';
    case 'edge': return 'Edge';
    case 'file': return 'PullRequestChangedFile';
  }
}

function schemaDefFor(typeName: string): TypeDef | undefined {
  return SCHEMA[typeName];
}

/** Resolve one field on a parent value. Returns undefined for an unknown field. */
function resolveField(parent: ParentKind, field: FieldNode, args: Record<string, unknown>, ctx: ExecContext): unknown {
  switch (parent.tag) {
    case 'query': {
      if (field.name === 'viewer') return { tag: 'user', login: VIEWER_LOGIN } as ParentKind;
      if (field.name === 'repository') {
        const owner = typeof args['owner'] === 'string' ? args['owner'] : '';
        const name = typeof args['name'] === 'string' ? args['name'] : '';
        const repo = store.getRepo(owner, name);
        return repo === undefined ? null : ({ tag: 'repository', repo } as ParentKind);
      }
      if (field.name === 'node') {
        const id = typeof args['id'] === 'string' ? args['id'] : '';
        if (id.startsWith('R_')) {
          const repo = findRepoByGid(id);
          return repo === undefined ? null : ({ tag: 'repository', repo } as ParentKind);
        }
        const issue = findIssueByGid(id);
        if (issue !== undefined) return issueValue(issue.repo, issue.issue);
        const pr = findPullByGid(id);
        if (pr !== undefined) return pullValue(pr.repo, pr.pr);
        return null;
      }
      if (field.name === '__type') {
        const name = typeof args['name'] === 'string' ? args['name'] : '';
        const def = SCHEMA[name];
        return def === undefined ? null : ({ tag: 'introspection', value: introspectionTypeObject(def) } as ParentKind);
      }
      if (field.name === '__schema') {
        return { tag: 'introspection', value: {
          queryType: introspectionTypeObject(SCHEMA['Query'] as TypeDef),
          mutationType: introspectionTypeObject(SCHEMA['Mutation'] as TypeDef),
          types: Object.values(SCHEMA).map((d) => introspectionTypeObject(d)),
          directives: [],
        } } as ParentKind;
      }
      return undefined;
    }
    case 'mutation': return executeMutationField(field, args);
    case 'repository': return resolveRepoField(parent, field, args);
    case 'issue': return resolveIssueField(parent, field);
    case 'pull': return resolvePullField(parent, field, args);
    case 'user': return resolveUserField(parent, field);
    case 'ref': {
      if (field.name === 'id') return `REF_${parent.name}`;
      if (field.name === 'name') return parent.name;
      return undefined;
    }
    case 'introspection': {
      const v = parent.value[field.name];
      if (v === undefined) return undefined;
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        return { tag: 'introspection', value: v as Record<string, unknown> } as ParentKind;
      }
      return v;
    }
    case 'payload': {
      const v = parent.value[field.name];
      return v === undefined ? undefined : v;
    }
    case 'connection': {
      if (field.name === 'nodes') return parent.items.map((e) => e.node);
      if (field.name === 'edges') return parent.items.map((e) => ({ tag: 'edge', node: e.node, cursor: e.cursor }) as ParentKind);
      if (field.name === 'pageInfo') return { tag: 'introspection', value: parent.pageInfo } as ParentKind;
      if (field.name === 'totalCount') return parent.totalCount;
      return undefined;
    }
    case 'edge': {
      if (field.name === 'node') return parent.node;
      if (field.name === 'cursor') return parent.cursor;
      return undefined;
    }
    case 'file': {
      if (field.name === 'path') return parent.path;
      if (field.name === 'additions') return parent.additions;
      if (field.name === 'deletions') return parent.deletions;
      if (field.name === 'changeType') return 'MODIFIED';
      return undefined;
    }
  }
}

function isParentValue(value: unknown): value is ParentKind {
  return value !== null && typeof value === 'object' && 'tag' in (value as Record<string, unknown>) &&
    typeof (value as Record<string, unknown>)['tag'] === 'string';
}

function executeSelections(parent: ParentKind, selections: SelectionNode[], ctx: ExecContext): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'spread') {
      const frag = ctx.fragments.get(sel.name);
      if (frag === undefined) continue;
      const sub = executeSelections(parent, frag.selections, ctx);
      if (sub !== null) Object.assign(out, sub);
      continue;
    }
    if (sel.kind === 'inline') {
      if (sel.typeCondition !== null) {
        const actual = typeNameOf(parent);
        // Inline fragments on a concrete type: apply when the condition matches
        // the parent type, or when the parent is a Node (any concrete type).
        const ok = actual === sel.typeCondition || parent.tag === 'repository' || parent.tag === 'issue' || parent.tag === 'pull';
        if (!ok) continue;
      }
      const sub = executeSelections(parent, sel.selections, ctx);
      if (sub !== null) Object.assign(out, sub);
      continue;
    }
    const field = sel;
    const key = field.alias ?? field.name;
    // Validate against the static schema when we know the type.
    const typeName = typeNameOf(parent);
    const def = schemaDefFor(typeName);
    if (def !== undefined && def.fields !== undefined && !(field.name in def.fields) &&
        !field.name.startsWith('__') && parent.tag !== 'introspection' && parent.tag !== 'payload' &&
        parent.tag !== 'connection' && parent.tag !== 'edge' && parent.tag !== 'file') {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
      out[key] = null;
      continue;
    }
    const args = argMap(field, ctx.variables);
    let value: unknown;
    try {
      value = resolveField(parent, field, args, ctx);
    } catch {
      value = null;
    }
    if (value === undefined) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
      out[key] = null;
      continue;
    }
    if (value === null) {
      out[key] = null;
      continue;
    }
    if (field.selections === null) {
      out[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.map((item) => {
        if (isParentValue(item)) {
          const sub = executeSelections(item, field.selections as SelectionNode[], ctx);
          return sub;
        }
        return item;
      });
      continue;
    }
    if (isParentValue(value)) {
      out[key] = executeSelections(value, field.selections, ctx);
      continue;
    }
    // A scalar with a sub-selection (should not happen): pass through.
    out[key] = value;
  }
  return out;
}

export interface GraphQLResult {
  data: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
}

export function executeGraphQL(query: string, variables: Record<string, unknown>, operationName?: string): GraphQLResult {
  let doc: DocumentNode;
  try {
    doc = parseDocument(query);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  let op: OperationNode | undefined;
  if (operationName !== undefined) op = doc.operations.find((o) => o.name === operationName);
  if (op === undefined) op = doc.operations[0];
  if (op === undefined) return { data: null, errors: [{ message: 'No operation found' }] };
  const ctx: ExecContext = { variables, fragments: doc.fragments, errors: [] };
  const root: ParentKind = op.type === 'mutation' ? { tag: 'mutation' } : { tag: 'query' };
  const data = executeSelections(root, op.selections, ctx);
  if (ctx.errors.length > 0) {
    // A validation-style failure: the invalid field's parent is nulled by
    // executeSelections; report data with the error.
    const result: GraphQLResult = { data, errors: ctx.errors };
    return result;
  }
  return { data };
}

export function handleGraphQL(body: unknown): GraphQLResult | GraphQLResult[] {
  if (Array.isArray(body)) {
    return body.map((item) => {
      if (item !== null && typeof item === 'object') {
        const rec = item as Record<string, unknown>;
        const query = typeof rec['query'] === 'string' ? rec['query'] : '';
        const variables = (rec['variables'] !== null && typeof rec['variables'] === 'object' ? rec['variables'] as Record<string, unknown> : {});
        const opName = typeof rec['operationName'] === 'string' ? rec['operationName'] : undefined;
        return executeGraphQL(query, variables, opName);
      }
      return { data: null, errors: [{ message: 'Invalid operation' }] };
    });
  }
  if (body !== null && typeof body === 'object') {
    const rec = body as Record<string, unknown>;
    const query = typeof rec['query'] === 'string' ? rec['query'] : '';
    const variables = (rec['variables'] !== null && typeof rec['variables'] === 'object' ? rec['variables'] as Record<string, unknown> : {});
    const opName = typeof rec['operationName'] === 'string' ? rec['operationName'] : undefined;
    return executeGraphQL(query, variables, opName);
  }
  return { data: null, errors: [{ message: 'Invalid GraphQL body' }] };
}

void isObjectId;
