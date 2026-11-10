// Vendored from dsh-github-sync (MIT, Copyright (c) dsh-github-sync contributors).
// See ../../NOTICE. Adapted for One Pack: default user agent and commit messages only;
// no behavioural change. Node built-ins + globalThis.fetch only.
//
// GitHub REST / Git Data API 的最小客户端。只用 globalThis.fetch（宿主已接代理 dispatcher）。
const API = 'https://api.github.com';

/**
 * 证书不受信的典型错误码。
 * 中国大陆最常见的成因：装了会解密 HTTPS 的加速/抓包工具（SteamTools/Watt Toolkit、Fiddler、
 * 部分安全软件的网页防护），它们用自签根证书替换 GitHub 的真证书，Node 的内置 CA 不认。
 */
const TLS_TRUST_CODES = /UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_GET_ISSUER_CERT|CERT_SIGNATURE_FAILURE|unable to get local issuer certificate/i;

export function isTlsTrustError(text) {
  return TLS_TRUST_CODES.test(String(text ?? ''));
}

export const TLS_TRUST_HINT = '这通常是本机有软件在解密 HTTPS（如 SteamTools/Watt Toolkit、Fiddler、安全软件的网页防护）。'
  + '三种解法，从简到繁：①把 api.github.com 加进那个软件的跳过/绕过列表；'
  + '②关掉它的「HTTPS 解密 / 网页防护 / GitHub 加速」；'
  + '③导出它的根证书，给 DSH 的 Node 设置环境变量 NODE_EXTRA_CA_CERTS 指向该证书后重启 DSH。';

export class GitHubError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.body = body;
  }
}

/** 接受 owner/repo、https://github.com/owner/repo、git@… 等写法 */
export function parseRepo(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('仓库地址为空');
  const s = raw.replace(/\.git$/i, '').replace(/\/+$/, '');
  const url = s.match(/github\.com[/:]([^/\s]+)\/([^/\s]+)$/i);
  if (url) return { owner: url[1], repo: url[2] };
  const short = s.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (short) return { owner: short[1], repo: short[2] };
  throw new Error(`无法识别仓库地址：${raw}（应为 owner/repo 或 https://github.com/owner/repo）`);
}

export class GitHubClient {
  constructor({ token, repo, branch = 'main', userAgent = 'dsh-one-pack', signal = null }) {
    const { owner, repo: name } = parseRepo(repo);
    this.owner = owner;
    this.repo = name;
    this.token = token;
    this.branch = branch;
    this.userAgent = userAgent;
    this.signal = signal;
  }

  get slug() { return `${this.owner}/${this.repo}`; }

  async #req(method, path, { body, timeoutMs = 45000, tries = 3 } = {}) {
    let res = null;
    let lastErr = null;
    for (let i = 0; i < tries; i++) {
      try {
        res = await fetch(`${API}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': this.userAgent,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: this.signal
            ? AbortSignal.any([AbortSignal.timeout(timeoutMs), this.signal])
            : AbortSignal.timeout(timeoutMs),
        });
        lastErr = null;
        break;
      } catch (err) {
        if (this.signal?.aborted) throw new GitHubError(0, '已取消');
        const cause = err?.cause?.code || err?.name || err?.cause?.message || '';
        // 证书不受信是确定性错误，重试没有意义，直接带上可执行的排查建议
        if (isTlsTrustError(cause) || isTlsTrustError(err?.message)) {
          throw new GitHubError(0, `${method} ${path} 网络失败：${err.message}${cause ? '（' + cause + '）' : ''}。${TLS_TRUST_HINT}`);
        }
        lastErr = new GitHubError(0, `${method} ${path} 网络失败：${err.message}${cause ? '（' + cause + '）' : ''}`);
        if (i < tries - 1) await new Promise((r) => setTimeout(r, 400 * (i + 1)));
      }
    }
    if (!res) throw lastErr;
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json())?.message ?? ''; } catch { /* 忽略 */ }
      throw new GitHubError(res.status, `${method} ${path} → ${res.status}${detail ? ' ' + detail : ''}`);
    }
    if (res.status === 204) return null;
    const ct = res.headers.get('content-type') ?? '';
    return ct.includes('application/json') ? res.json() : res.arrayBuffer();
  }

  /** 仓库信息（含 private，用于安全红线校验） */
  repoInfo() { return this.#req('GET', `/repos/${this.slug}`); }

  getRef(ref = this.branch) { return this.#req('GET', `/repos/${this.slug}/git/ref/heads/${ref}`); }
  getCommit(sha) { return this.#req('GET', `/repos/${this.slug}/git/commits/${sha}`); }
  getTree(sha, recursive = true) {
    return this.#req('GET', `/repos/${this.slug}/git/trees/${sha}${recursive ? '?recursive=1' : ''}`);
  }
  createBlob(content) {
    return this.#req('POST', `/repos/${this.slug}/git/blobs`, {
      body: { content: Buffer.from(content).toString('base64'), encoding: 'base64' },
      timeoutMs: 180000,
    });
  }
  createTree(baseTree, entries) {
    const body = { tree: entries };
    if (baseTree) body.base_tree = baseTree;
    return this.#req('POST', `/repos/${this.slug}/git/trees`, { body });
  }
  createCommit({ message, tree, parents }) {
    return this.#req('POST', `/repos/${this.slug}/git/commits`, { body: { message, tree, parents } });
  }
  updateRef(sha, force = false) {
    return this.#req('PATCH', `/repos/${this.slug}/git/refs/heads/${this.branch}`, { body: { sha, force } });
  }
  getBlob(sha) { return this.#req('GET', `/repos/${this.slug}/git/blobs/${sha}`, { timeoutMs: 120000 }); }

  /** 当前 token 对应的账号信息（GET /user），用于自动建仓时确定 owner */
  userInfo() { return this.#req('GET', '/user'); }

  /** 指定仓库的元信息；仓库不存在返回 null（404），无权限等情况仍抛错 */
  async repoMetaOrNull(owner, name) {
    try {
      return await this.#req('GET', `/repos/${owner}/${name}`);
    } catch (err) {
      if (err instanceof GitHubError && err.status === 404) return null;
      throw err;
    }
  }

  /**
   * 在当前账号下创建仓库（默认私有）。
   * classic token 需要 repo scope；fine-grained token 需要 Administration: write。
   */
  createUserRepo({ name, isPrivate = true, description = '' }) {
    return this.#req('POST', '/user/repos', {
      body: { name, private: isPrivate, description, auto_init: false },
      timeoutMs: 60000,
    });
  }

  /** 全树索引：path → { sha, size }；空仓库返回空表而不是抛错 */
  async listFiles() {
    const refObj = await this.getRefOrNull();
    if (!refObj) return { commitSha: null, treeSha: null, map: new Map(), empty: true };
    const commit = await this.getCommit(refObj.object.sha);
    const tree = await this.getTree(commit.tree.sha, true);
    if (tree.truncated) throw new GitHubError(0, '仓库树太大，GitHub 返回被截断');
    const map = new Map();
    for (const e of tree.tree) {
      if (e.type !== 'blob') continue;
      map.set(e.path, { sha: e.sha, size: e.size ?? 0 });
    }
    return { commitSha: refObj.object.sha, treeSha: commit.tree.sha, map, empty: false };
  }

  /** 分支不存在（空仓库）返回 null，而不是抛错。空仓库 GitHub 返回 409，未建分支返回 404 */
  async getRefOrNull(ref = this.branch) {
    try {
      return await this.getRef(ref);
    } catch (err) {
      if (err instanceof GitHubError && (err.status === 404 || err.status === 409)) return null;
      throw err;
    }
  }

  /** 空仓库的第一次提交：直接建分支引用 */
  createRef(sha) {
    return this.#req('POST', `/repos/${this.slug}/git/refs`, {
      body: { ref: `refs/heads/${this.branch}`, sha },
    });
  }

  /** Contents API 写单文件；空仓库上它是唯一能建"第一个提交"的入口 */
  putContents(path, content, message) {
    const encoded = String(path).split('/').map(encodeURIComponent).join('/');
    return this.#req('PUT', `/repos/${this.slug}/contents/${encoded}`, {
      body: { message, content: Buffer.from(content).toString('base64') },
    });
  }

  async readFile(path, map) {
    const idx = map ?? (await this.listFiles()).map;
    const hit = idx.get(path);
    if (!hit) return null;
    const blob = await this.getBlob(hit.sha);
    return Buffer.from(blob.content, blob.encoding === 'base64' ? 'base64' : 'utf8');
  }

  /**
   * 一批文件 = 一个原子提交。
   * files: [{ path, content: Buffer|string }]；deletions: [path]
   * 空仓库 → 无 base_tree、无 parent，最后建引用。
   * 非快进（别人先推了）→ 重读 ref 重试一次。
   */
  async commitBatch({
    files, deletions = [], message, attempts = 3, concurrency = 3,
    onProgress = () => {}, shouldCancel = () => false,
    skipPaths = () => new Set(), transformFile = null,
  }) {
    let lastErr;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        if (shouldCancel()) throw new Error('已取消');
        onProgress({ phase: 'ref', index: 0, total: files.length, bytes: 0 });
        let refObj = await this.getRefOrNull();
        // 记录"进来时仓库是不是空的"——下面打种子会把 ref 建出来，之后再判断就晚了
        let brandNewRepo = !refObj;
        let seeded = false;
        if (!refObj) {
          // 零提交仓库：Git Data API 会 409，先用 Contents API 落一个种子文件
          onProgress({ phase: 'seed', index: 0, total: files.length, bytes: 0 });
          const seed = files[0] ?? { path: 'README.md', content: '# dsh-one-pack\n' };
          await this.putContents(seed.path, seed.content, message);
          refObj = await this.getRefOrNull();
          if (!refObj) throw new Error('空仓库初始化失败：没能创建第一个提交');
          seeded = true;
        }
        const baseSha = refObj?.object?.sha ?? null;
        const baseCommit = baseSha ? await this.getCommit(baseSha) : null;
        // blob 并发上传：串行时 30 个文件要 30 次往返，实测 4 路并行能快 2~3 倍
        const jobs = [];
        for (let i = 0; i < files.length; i++) {
          const f = files[i];
          if (skipPaths().has(f.path)) {
            onProgress({ phase: 'skip', index: i, total: files.length, path: f.path, bytes: 0 });
            continue;
          }
          jobs.push({ index: i, file: f });
        }
        const blobs = new Array(jobs.length);
        const used = jobs.map((j) => j.file);
        let cursor = 0;
        let completed = 0;
        const lanes = Math.max(1, Math.min(Number(concurrency) || 4, 6, jobs.length || 1));
        const worker = async () => {
          while (true) {
            if (shouldCancel()) throw new Error('已取消');
            const k = cursor++;
            if (k >= jobs.length) return;
            const job = jobs[k];
            const size = Buffer.byteLength(job.file.content);
            onProgress({ phase: 'blob', index: job.index, done: completed, total: files.length, path: job.file.path, bytes: 0 });
            const content = transformFile ? transformFile(job.file.path, job.file.content) : job.file.content;
            // 单个 blob 单独重试：并发经代理时偶发"malformed request"，重整个批次代价太大
            let sha = null;
            for (let t = 0; t < 3; t++) {
              try {
                sha = (await this.createBlob(content)).sha;
                break;
              } catch (err) {
                if (this.signal?.aborted) throw new Error('已取消');
                if (t === 2) throw new Error(`${job.file.path}: ${err.message}`);
                await new Promise((r) => setTimeout(r, 400 * (t + 1)));
              }
            }
            blobs[k] = sha;
            completed += 1;
            onProgress({ phase: 'blob-done', index: job.index, done: completed, total: files.length, path: job.file.path, bytes: size });
          }
        };
        await Promise.all(Array.from({ length: lanes }, () => worker()));
        if (!used.length) throw new Error('所有文件都被跳过了');
        if (shouldCancel()) throw new Error('已取消');
        onProgress({ phase: 'tree', index: files.length, total: files.length, bytes: 0 });
        const entries = used.map((f, i) => ({ path: f.path, mode: '100644', type: 'blob', sha: blobs[i] }));
        for (const p of deletions) entries.push({ path: p, mode: '100644', type: 'blob', sha: null });
        const tree = await this.createTree(baseCommit?.tree?.sha ?? null, entries);
        if (!tree.sha) throw new Error('没有可提交的内容');
        onProgress({ phase: 'commit', index: files.length, total: files.length, bytes: 0 });
        const commit = await this.createCommit({ message, tree: tree.sha, parents: baseSha ? [baseSha] : [] });
        onProgress({ phase: 'ref', index: files.length, total: files.length, bytes: 0 });
        if (baseSha) await this.updateRef(commit.sha);
        else await this.createRef(commit.sha);
        onProgress({ phase: 'done', index: files.length, total: files.length, bytes: 0 });
        return { commitSha: commit.sha, treeSha: tree.sha, files: used.length, firstCommit: brandNewRepo, seeded };
      } catch (err) {
        if (err?.message === '已取消') throw err;
        lastErr = err;
        const status = err instanceof GitHubError ? err.status : -1;
        // 422/409 = 别人先推了（非快进）；0 = 网络失败（代理抖动）
        const retryable = status === 422 || status === 409 || status === 0;
        if (!retryable || attempt === attempts - 1) throw err;
        if (status === 0) await new Promise((r) => setTimeout(r, 700));
      }
    }
    throw lastErr;
  }
}