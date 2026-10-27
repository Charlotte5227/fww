// Discord の /地図 コマンドを受け付ける Cloudflare Worker
//
// 1. Discord からのリクエストを公開鍵で確認する
// 2. レイヤー名を確認して「考え中…」と返す（3 秒以内に返す必要があるため）
// 3. GitHub Actions を起動し、Actions 側で地図を合成して Discord に投稿する
//
// 必要な設定（Cloudflare の「設定」→「変数とシークレット」）
//   DISCORD_PUBLIC_KEY  Discord アプリの Public Key
//   GITHUB_REPO         例: Charlotte5227/fww
//   GITHUB_BRANCH       省略時は main
//   GITHUB_TOKEN        （シークレット）Actions の読み書き権限を持つ GitHub のトークン
//   SHARED_SECRET       （シークレット）GitHub の DISCORD_SHARED_SECRET と同じ文字列

const WORKFLOW = 'discord-map.yml';
const ALL_WORDS = ['すべて', '全部', 'all'];

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

// Discord に「自分だけに見える」エラーを返す
const ephemeral = (content) => json({ type: 4, data: { content, flags: 64 } });

const hex = (s) => new Uint8Array(s.match(/.{1,2}/g).map((b) => parseInt(b, 16)));

async function verify(request, body, publicKey) {
  const sig = request.headers.get('X-Signature-Ed25519');
  const ts = request.headers.get('X-Signature-Timestamp');
  if (!sig || !ts || !publicKey) return false;
  const data = new TextEncoder().encode(ts + body);
  for (const alg of [{ name: 'Ed25519' }, { name: 'NODE-ED25519', namedCurve: 'NODE-ED25519' }]) {
    try {
      const key = await crypto.subtle.importKey('raw', hex(publicKey), alg, false, ['verify']);
      return await crypto.subtle.verify(alg.name, key, hex(sig), data);
    } catch {
      // 古い実行環境向けの名前で再試行
    }
  }
  return false;
}

/** 返信先（interaction token）を暗号化して Actions に渡す。公開リポジトリのログに残さないため */
async function seal(obj, secret) {
  const keyBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj))));
  const all = new Uint8Array(iv.length + ct.length);
  all.set(iv);
  all.set(ct, iv.length);
  let bin = '';
  for (const b of all) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** リポジトリの data/config.json（1 分キャッシュ） */
let cached = { at: 0, config: null };
async function loadConfig(env) {
  if (cached.config && Date.now() - cached.at < 60_000) return cached.config;
  const branch = env.GITHUB_BRANCH || 'main';
  const res = await fetch(`https://raw.githubusercontent.com/${env.GITHUB_REPO}/${branch}/data/config.json`, {
    headers: { 'User-Agent': 'cylinder-viewer-discord' },
    cf: { cacheTtl: 60 },
  });
  if (!res.ok) throw new Error(`config.json を読み込めませんでした（${res.status}）`);
  cached = { at: Date.now(), config: await res.json() };
  return cached.config;
}

const splitNames = (s) => String(s || '').split(/[\s,、，・]+/).map((x) => x.trim()).filter(Boolean);
const optionValue = (data, name) => (data.options || []).find((o) => o.name === name)?.value;

/** 入力されたレイヤー名を確認する。空なら初期表示のレイヤー */
function resolveLayers(config, input) {
  const layers = config.layers || [];
  const words = splitNames(input);
  if (!words.length) return { names: layers.filter((l) => l.visible !== false).map((l) => l.name), label: '初期表示' };
  if (words.some((w) => ALL_WORDS.includes(w.toLowerCase()))) return { names: layers.map((l) => l.name), label: 'すべて' };
  const unknown = words.filter((w) => !layers.some((l) => l.name === w));
  if (unknown.length) return { unknown };
  // 重なり順は管理ページの設定どおり（入力の順番は関係ない）
  const names = layers.filter((l) => words.includes(l.name)).map((l) => l.name);
  return { names, label: names.join('・') };
}

function autocomplete(config, input) {
  const names = (config.layers || []).map((l) => l.name);
  const text = String(input || '');
  const words = splitNames(text);
  const endsWithSpace = /[\s,、，・]$/.test(text);
  const done = endsWithSpace ? words : words.slice(0, -1);
  const partial = endsWithSpace ? '' : words[words.length - 1] || '';
  const prefix = done.length ? `${done.join(' ')} ` : '';
  const choices = [];
  if (!done.length && ALL_WORDS.some((w) => w.startsWith(partial))) choices.push({ name: 'すべてのレイヤー', value: 'すべて' });
  for (const n of names) {
    if (done.includes(n) || (partial && !n.includes(partial))) continue;
    const value = `${prefix}${n}`;
    if (value.length <= 100) choices.push({ name: value, value });
  }
  // 入力がすでに完全なレイヤー名なら、そのまま確定できる候補も出す
  if (words.length && words.every((w) => names.includes(w)) && !choices.some((c) => c.value === words.join(' '))) {
    choices.unshift({ name: words.join(' '), value: words.join(' ') });
  }
  return json({ type: 8, data: { choices: choices.slice(0, 25) } });
}

async function startRender(env, interaction, names, label) {
  const sealed = await seal({ t: interaction.token, a: interaction.application_id }, env.SHARED_SECRET);
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'cylinder-viewer-discord',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ref: env.GITHUB_BRANCH || 'main', inputs: { layers: JSON.stringify(names), label, payload: sealed } }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error('GitHub dispatch failed', res.status, detail);
    // 「考え中…」のままにならないよう、失敗を知らせる
    await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: `地図を作成できませんでした（GitHub ${res.status}）。Worker の GITHUB_TOKEN と GITHUB_REPO を確認してください。` }),
    });
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'GET') return new Response('筒ビューア Discord 連携は動いています。', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

    const body = await request.text();
    if (!(await verify(request, body, env.DISCORD_PUBLIC_KEY))) return new Response('Bad signature', { status: 401 });
    const interaction = JSON.parse(body);

    if (interaction.type === 1) return json({ type: 1 }); // PING

    try {
      if (interaction.type === 4) { // 入力候補
        const config = await loadConfig(env);
        return autocomplete(config, optionValue(interaction.data, 'layers'));
      }
      if (interaction.type === 2 && interaction.data?.name === 'map') {
        const config = await loadConfig(env);
        const r = resolveLayers(config, optionValue(interaction.data, 'layers'));
        if (r.unknown) {
          const list = (config.layers || []).map((l) => `「${l.name}」`).join(' ');
          return ephemeral(`レイヤー ${r.unknown.map((u) => `「${u}」`).join('')} が見つかりません。\n使えるレイヤー: ${list}`);
        }
        if (!r.names.length && !config.base?.src) return ephemeral('表示するレイヤーがありません。');
        ctx.waitUntil(startRender(env, interaction, r.names, r.label));
        return json({ type: 5 }); // 考え中…（Actions が完成した地図に差し替える）
      }
    } catch (e) {
      console.error(e);
      return ephemeral(`エラーが発生しました: ${e.message}`);
    }
    return ephemeral('このコマンドには対応していません。');
  },
};
