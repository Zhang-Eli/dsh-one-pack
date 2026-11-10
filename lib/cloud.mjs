// 远端仓库访问层：把 GitHub 的 Git Data API 包装成 DESIGN.md §5 约定的 CloudRepo。
// 只依赖 Node 内置模块 + lib/vendor/github.mjs（MIT 改造，见 NOTICE）。
import { createHash } from 'node:crypto';
import { GitHubClient, GitHubError, parseRepo as parseRepoInput } from './vendor/github.mjs';

export { GitHubError };

/**
 * 解析仓库地址：'owner/repo'、https://github.com/owner/repo、git@github.com:owner/repo.git
 * 返回 { owner, repo, name }；非法输入抛错。
 */
export function parseRepo(input) {
  const { owner, repo } = parseRepoInput(input);
  return { owner, repo, name: repo };
}

/** Git 的 blob sha1；用来判断某路径的内容是否和远端完全一致（省掉重复上传） */
function gitBlobSha(buf) {
  const hash = createHash('sha1');
  hash.update(`blob ${buf.length}\0`);
  hash.update(buf);
  return hash.digest('hex');
}

function toBuffer(content) {
  if (Buffer.isBuffer(content)) return content;
  if (typeof content === 'string') return Buffer.from(content, 'utf8');
  if (content instanceof Uint8Array) return Buffer.from(content);
  throw new Error(`不支持的文件内容类型：${Object.prototype.toString.call(content)}`);
}

function snapshotFiles(snapshot) {
  if (!snapshot || !(snapshot.files instanceof Map)) return null;
  return snapshot.files;
}

export class CloudRepo {
  /**
   * @param {{token?: string, repo: string, branch?: string, userAgent?: string,
   *          signal?: AbortSignal|null, client?: object}} options
   *   client 仅用于测试注入（不传时自行构造 GitHubClient）。
   */
  constructor({ token = null, repo, branch = 'main', userAgent = 'dsh-one-pack', signal = null, client = null } = {}) {
    const parsed = parseRepo(repo);
    if (!client && !token) throw new Error('缺少 GitHub token');
    this.owner = parsed.owner;
    this.repo = parsed.repo;
    this.branch = branch || 'main';
    this.slug = `${this.owner}/${this.repo}`;
    this.client = client ?? new GitHubClient({
      token,
      repo: this.slug,
      branch: this.branch,
      userAgent,
      signal,
    });
    this.userAgent = userAgent;
    this.signal = signal;
    /** @type {Map<string, Buffer>} blob sha → Buffer（内容寻址，可安全复用） */
    this.blobCache = new Map();
    this.repoInfoCache = null;
    this.snapshot = null;
  }

  /** 仓库元信息（含 private 标记，用于安全校验）；缓存一次 */
  async repoInfo() {
    if (!this.repoInfoCache) this.repoInfoCache = await this.client.repoInfo();
    return this.repoInfoCache;
  }

  /**
   * 远端当前提交的全树索引。
   * @returns {Promise<{empty: boolean, commitSha: string|null, treeSha: string|null,
   *           files: Map<string, {path: string, sha: string, size: number}>}>}
   */
  async state() {
    const listed = await this.client.listFiles();
    const files = new Map();
    for (const [path, entry] of listed.map ?? []) {
      files.set(path, { path, sha: entry.sha, size: entry.size ?? 0 });
    }
    const snapshot = {
      empty: Boolean(listed.empty),
      commitSha: listed.commitSha ?? null,
      treeSha: listed.treeSha ?? null,
      files,
    };
    this.snapshot = snapshot;
    return snapshot;
  }

  /**
   * 读一个文件。pathOrEntry 可以是远端路径字符串，也可以是
   * {path, sha} / Map 里的条目；snapshot 省略时现取一次全树。
   * @returns {Promise<Buffer|null>}
   */
  async readFile(pathOrEntry, snapshot = null) {
    let path = null;
    let sha = null;
    if (typeof pathOrEntry === 'string') {
      path = pathOrEntry;
      const files = snapshotFiles(snapshot) ?? snapshotFiles(this.snapshot) ?? (await this.state()).files;
      const hit = files.get(path);
      if (!hit) return null;
      sha = hit.sha ?? hit;
    } else if (pathOrEntry && typeof pathOrEntry === 'object') {
      path = typeof pathOrEntry.path === 'string' ? pathOrEntry.path : null;
      sha = typeof pathOrEntry.sha === 'string' ? pathOrEntry.sha : null;
      if (!sha && path) {
        const files = snapshotFiles(snapshot) ?? snapshotFiles(this.snapshot);
        const hit = files?.get(path);
        if (!hit) return null;
        sha = hit.sha ?? hit;
      }
    }
    if (!sha) throw new Error(`无法定位远端文件：${path ?? JSON.stringify(pathOrEntry)}`);
    const cached = this.blobCache.get(sha);
    if (cached) return cached;
    const blob = await this.client.getBlob(sha);
    const buf = Buffer.from(blob.content ?? '', blob.encoding === 'base64' ? 'base64' : 'utf8');
    this.blobCache.set(sha, buf);
    return buf;
  }

  /** @returns {Promise<string|null>} */
  async readText(pathOrEntry, snapshot = null) {
    const buf = await this.readFile(pathOrEntry, snapshot);
    return buf ? buf.toString('utf8') : null;
  }

  /** 远端 JSON；文件不存在返回 null，内容损坏则抛错（不能静默当成"没有"） */
  async readJson(pathOrEntry, snapshot = null) {
    const text = await this.readText(pathOrEntry, snapshot);
    if (text === null) return null;
    try {
      return JSON.parse(text);
    } catch (err) {
      const name = typeof pathOrEntry === 'string' ? pathOrEntry : pathOrEntry?.path;
      throw new Error(`远端文件不是合法 JSON：${name}（${err.message}）`);
    }
  }

  /**
   * 一次原子提交。内容未变化的文件（与 snapshot 里 blob sha 相同）会被跳过。
   * @param {{writes: Array<{path: string, content: string|Buffer}>, deletes?: string[],
   *          message: string, snapshot?: object|null}} changes
   * @returns {Promise<{commitSha: string, files: number, firstCommit: boolean,
   *           treeSha?: string, seeded?: boolean, unchanged?: boolean}>}
   */
  async commit({ writes = [], deletes = [], message, snapshot = null }) {
    if (!Array.isArray(writes)) throw new Error('commit.writes 必须是数组');
    const base = snapshotFiles(snapshot) ?? snapshotFiles(this.snapshot);
    const skip = new Set();
    const files = [];
    for (const write of writes) {
      if (!write || typeof write.path !== 'string' || !write.path) {
        throw new Error('commit.writes 里存在缺少 path 的条目');
      }
      const content = toBuffer(write.content);
      const previous = base?.get(write.path);
      if (previous && previous.sha === gitBlobSha(content)) {
        skip.add(write.path);
        continue;
      }
      files.push({ path: write.path, content });
    }

    if (files.length === 0) {
      // 没有内容差异（可能只有删除，或有待删但无需新建 blob 的情况）
      if (!deletes.length) {
        return {
          commitSha: snapshot?.commitSha ?? this.snapshot?.commitSha ?? null,
          files: 0,
          firstCommit: false,
          unchanged: true,
        };
      }
    }

    const removals = deletes.filter((p) => typeof p === 'string' && p);
    // commitBatch 至少要有一个待上传文件；只有删除时自己走一次 Git Data API
    const result = files.length === 0
      ? await this.#commitDeletionsOnly(removals, message)
      : await this.client.commitBatch({
        files,
        deletions: removals,
        message,
        skipPaths: () => skip,
      });
    // 提交后树已变化，旧 snapshot 不能再用于"跳过"判断
    this.snapshot = null;
    return {
      commitSha: result.commitSha,
      treeSha: result.treeSha,
      files: result.files,
      firstCommit: Boolean(result.firstCommit),
      seeded: Boolean(result.seeded),
    };
  }

  /** 只删文件、不新增内容的提交（commitBatch 要求至少一个上传文件，这里单独走一遍） */
  async #commitDeletionsOnly(deletions, message) {
    const ref = await this.client.getRefOrNull();
    if (!ref) return { commitSha: null, files: 0, firstCommit: false, unchanged: true };
    const baseSha = ref.object.sha;
    const baseCommit = await this.client.getCommit(baseSha);
    const entries = deletions.map((path) => ({ path, mode: '100644', type: 'blob', sha: null }));
    const tree = await this.client.createTree(baseCommit.tree.sha, entries);
    const commit = await this.client.createCommit({ message, tree: tree.sha, parents: [baseSha] });
    await this.client.updateRef(commit.sha);
    return { commitSha: commit.sha, treeSha: tree.sha, files: 0, firstCommit: false };
  }
}

/** One Pack 首次配置时自动创建的私有同步仓库的默认名字 */
export const DEFAULT_REPO_NAME = 'dsh-one-pack-sync';

/**
 * 在 token 所属账号下确保存在一个私有同步仓库，并返回可写入 state 的 owner/repo。
 * - 仓库已存在：直接复用（绝不覆盖），created=false
 * - 仓库不存在：POST /user/repos 创建一个空私有仓库，created=true（首次 Push 会自动落种子提交）
 * @param {object} options
 * @param {string} options.token GitHub token
 * @param {string} [options.name] 仓库名，默认 DEFAULT_REPO_NAME
 * @param {string} [options.userAgent]
 * @param {AbortSignal|null} [options.signal]
 * @param {object|null} [options.client] 测试注入：兼容 GitHubClient 子集的实例
 * @returns {Promise<{repo:string,login:string,name:string,created:boolean,private:boolean}>}
 */
export async function ensureSyncRepo({
  token,
  name = DEFAULT_REPO_NAME,
  userAgent = 'dsh-one-pack',
  signal = null,
  client = null,
} = {}) {
  const clean = String(name ?? '').trim();
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(clean)) {
    throw new Error(`仓库名不合法：${name}（允许字母、数字、点、下划线、短横线，最长 100）`);
  }
  // user 级接口不依赖具体仓库；给构造器一个占位 slug 以满足 parseRepo
  const gh = client ?? new GitHubClient({ token, repo: 'one-pack/one-pack', userAgent, signal });
  const me = await gh.userInfo();
  const login = typeof me?.login === 'string' ? me.login : '';
  if (!login) throw new Error('无法从 token 解析 GitHub 账号（token 可能无效）');
  const slug = `${login}/${clean}`;
  const existing = await gh.repoMetaOrNull(login, clean);
  if (existing) {
    return { repo: slug, login, name: clean, created: false, private: Boolean(existing.private) };
  }
  try {
    const info = await gh.createUserRepo({
      name: clean,
      isPrivate: true,
      description: 'One Pack sync — DSH environment snapshot (plugins/settings/skills/sessions/files)',
    });
    return { repo: slug, login, name: clean, created: true, private: Boolean(info?.private !== false) };
  } catch (err) {
    if (err instanceof GitHubError) {
      if (err.status === 401) throw new GitHubError(401, 'Token 无效或已过期，请重新生成后保存');
      if (err.status === 403) {
        throw new GitHubError(
          403,
          'Token 权限不足，无法创建私有仓库：classic token 需要 repo scope；fine-grained token 需要 Administration: write。也可以手动创建仓库后填入 owner/repo',
        );
      }
    }
    throw err;
  }
}