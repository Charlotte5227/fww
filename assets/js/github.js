// GitHub API を使ってリポジトリへ直接コミットする（GitHub Pages 用）
const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

function explain(status, path, body) {
  if (status === 401) return 'トークンが正しくないか、有効期限が切れています。新しいトークンを作成してください。';
  if (status === 403) return 'このリポジトリへの書き込み権限がありません。トークンの「Contents」権限が「Read and write」になっているか確認してください。';
  if (status === 404) return `見つかりませんでした（${path}）。ユーザー名・リポジトリ名・ブランチ名を確認してください。`;
  if (status === 409 || status === 422) return `GitHub 側で更新が競合しました。もう一度お試しください。${body?.message ? `（${body.message}）` : ''}`;
  return `GitHub との通信に失敗しました（${status}${body?.message ? `: ${body.message}` : ''}）`;
}

export function guessRepo(loc = window.location) {
  const m = loc.hostname.match(/^([^.]+)\.github\.io$/i);
  if (!m) return {};
  const owner = m[1];
  const first = loc.pathname.split('/').filter(Boolean)[0];
  // ユーザーサイト（owner.github.io）なら管理ページは /admin/ 直下
  const repo = first && first !== 'admin' ? first : `${owner}.github.io`;
  return { owner, repo };
}

/** Blob → base64 文字列 */
export function blobToBase64(blob) {
  return new Promise((ok, ng) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(',')[1] || '');
    r.onerror = () => ng(r.error);
    r.readAsDataURL(blob);
  });
}

function textToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export class GitHubClient {
  constructor({ owner, repo, branch, token }) {
    Object.assign(this, { owner, repo, branch, token });
  }

  get base() { return `${API}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}`; }

  async request(method, path, body, { raw = false, accept } = {}) {
    const res = await fetch(path.startsWith('http') ? path : this.base + path, {
      method,
      cache: 'no-store',
      headers: {
        Accept: accept || 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      let data = null;
      try { data = await res.json(); } catch { /* 本文なし */ }
      throw new GitHubError(explain(res.status, path, data), res.status);
    }
    if (raw) return res;
    return res.status === 204 ? null : res.json();
  }

  /** 接続確認。書き込み権限とデフォルトブランチを返す */
  async verify() {
    const info = await this.request('GET', '');
    if (!this.branch) this.branch = info.default_branch;
    await this.request('GET', `/branches/${encodeURIComponent(this.branch)}`);
    return { canPush: info.permissions ? !!info.permissions.push : true, defaultBranch: info.default_branch, private: info.private };
  }

  async getText(path) {
    const res = await this.request('GET', `/contents/${path}?ref=${encodeURIComponent(this.branch)}`, null, { raw: true, accept: 'application/vnd.github.raw+json' });
    return res.text();
  }

  async getBlob(path) {
    const res = await this.request('GET', `/contents/${path}?ref=${encodeURIComponent(this.branch)}`, null, { raw: true, accept: 'application/vnd.github.raw+json' });
    return res.blob();
  }

  /**
   * 複数ファイルの追加・更新・削除を 1 つのコミットにまとめる
   * files の各要素は blob（画像）・text（文字）・sha（リポジトリにすでにある中身をそのまま使う）のどれか
   * @param {{files: {path:string, blob?:Blob, text?:string, sha?:string}[], deletes: string[], message: string, onProgress?:(msg:string, ratio:number)=>void}} p
   */
  async commit({ files, deletes = [], message, onProgress = () => {} }) {
    const total = files.length + 3;
    let done = 0;
    const step = (msg) => onProgress(msg, Math.min(1, done / total));

    // 1) ファイル本体をアップロード（blob 作成）
    const entries = [];
    for (const f of files) {
      if (f.sha) { entries.push({ path: f.path, mode: '100644', type: 'blob', sha: f.sha }); done++; continue; }
      step(`アップロード中：${f.path.split('/').pop()}`);
      const content = f.blob ? await blobToBase64(f.blob) : textToBase64(f.text ?? '');
      const blob = await this.request('POST', '/git/blobs', { content, encoding: 'base64' });
      entries.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
      done++;
    }

    // 2) ツリーとコミットを作ってブランチを進める（競合したら最新を取り直して再試行）
    for (let attempt = 0; attempt < 3; attempt++) {
      step('コミットを作成中');
      const ref = await this.request('GET', `/git/ref/heads/${encodeURIComponent(this.branch)}`);
      const head = await this.request('GET', `/git/commits/${ref.object.sha}`);
      const existing = await this.existingPaths(head.tree.sha, deletes);
      const tree = await this.request('POST', '/git/trees', {
        base_tree: head.tree.sha,
        tree: [
          ...entries,
          ...deletes.filter((p) => existing.has(p)).map((p) => ({ path: p, mode: '100644', type: 'blob', sha: null })),
        ],
      });
      done++;
      const commit = await this.request('POST', '/git/commits', { message, tree: tree.sha, parents: [ref.object.sha] });
      done++;
      step('ブランチを更新中');
      try {
        await this.request('PATCH', `/git/refs/heads/${encodeURIComponent(this.branch)}`, { sha: commit.sha });
        done = total;
        step('完了');
        return commit;
      } catch (e) {
        if (e.status !== 422 && e.status !== 409) throw e;
        done -= 2;
      }
    }
    throw new GitHubError('ほかの更新と競合したため、公開できませんでした。少し待ってからもう一度お試しください。', 409);
  }

  /** あるファイルを変更したコミットの一覧（新しい順） */
  async commitsFor(path, max = 300) {
    const out = [];
    for (let page = 1; out.length < max; page++) {
      const list = await this.request('GET', `/commits?path=${encodeURIComponent(path)}&sha=${encodeURIComponent(this.branch)}&per_page=100&page=${page}`);
      out.push(...list);
      if (list.length < 100) break;
    }
    return out.slice(0, max);
  }

  /** あるコミット時点のファイル（文字） */
  async getTextAt(path, ref) {
    const res = await this.request('GET', `/contents/${path}?ref=${encodeURIComponent(ref)}`, null, { raw: true, accept: 'application/vnd.github.raw+json' });
    return res.text();
  }

  /** blob の sha から中身を取得 */
  async getBlobBySha(sha) {
    const res = await this.request('GET', `/git/blobs/${sha}`, null, { raw: true, accept: 'application/vnd.github.raw+json' });
    return res.blob();
  }

  /** ツリーの中身（パス → blob の sha） */
  async treeMap(treeSha) {
    const t = await this.request('GET', `/git/trees/${treeSha}?recursive=1`);
    return new Map(t.tree.filter((x) => x.type === 'blob').map((x) => [x.path, x.sha]));
  }

  /** 削除対象のうち実際にリポジトリに存在するものを調べる（存在しないパスを消そうとするとエラーになるため） */
  async existingPaths(treeSha, paths) {
    if (!paths.length) return new Set();
    const t = await this.request('GET', `/git/trees/${treeSha}?recursive=1`);
    const all = new Set(t.tree.map((x) => x.path));
    return new Set(paths.filter((p) => all.has(p)));
  }
}
