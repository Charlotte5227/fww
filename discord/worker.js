// Discord の /地図 コマンドを受け付ける Cloudflare Worker
//
// 1. Discord からのリクエストを公開鍵で確認する
// 2. /地図 で選択メニュー、/地図 使い方 でヘルプを出す（どちらも自分にだけ見える）
//    メニューの「地図を作る」で「考え中…」と返す（3 秒以内に返す必要があるため）
// 3. GitHub Actions を起動し、Actions 側で地図を合成して Discord に投稿する
// 4. お絵かきページからの送信（Discord でログイン → 送り先を選んで送る）と、/地図設定（管理メニュー）
//
// 必要な設定（Cloudflare の「設定」→「変数とシークレット」）
//   DISCORD_PUBLIC_KEY  Discord アプリの Public Key
//   GITHUB_REPO         例: Charlotte5227/fww
//   GITHUB_BRANCH       省略時は main
//   GITHUB_TOKEN        （シークレット）Actions の読み書き権限を持つ GitHub のトークン
//   SITE_URL            （任意）閲覧ページの URL。省略時は GitHub Pages の URL
//   SHARED_SECRET       （シークレット）GitHub の DISCORD_SHARED_SECRET と同じ文字列
//   ※ お絵かきページからの送信と /地図設定 に必要な設定は、下の「ここから：お絵かきページ…」を見てください

const WORKFLOW = 'discord-map.yml';

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

/* ---------- 地図のデータ（最新と履歴） ---------- */

const WEEK = '日月火水木金土';
const ymdRe = /^(\d{4})-(\d{2})-(\d{2})$/;
function longDate(d, time = '') {
  const m = ymdRe.exec(d || '');
  if (!m) return d;
  const w = WEEK[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()];
  return `${+m[1]}年${+m[2]}月${+m[3]}日（${w}）${time ? ` ${time}` : ''}`;
}
const entryKey = (e) => `${e.date} ${e.time || ''} ${e.savedAt || ''}`;
const pad = (n) => String(n).padStart(2, '0');
function todayJst() {
  const d = new Date(Date.now() + 9 * 3600_000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// 2 つの設定が同じ地図かどうか
function sameMap(a, b) {
  const norm = (c) => JSON.stringify({ base: c?.base?.src || '', layers: (c?.layers || []).map((l) => [l.id, l.src, l.opacity ?? 1, l.visible !== false]), bg: c?.background?.src || '' });
  return norm(a) === norm(b);
}

async function fetchRaw(env, path) {
  const branch = env.GITHUB_BRANCH || 'main';
  return fetch(`https://raw.githubusercontent.com/${env.GITHUB_REPO}/${branch}/${path}`, {
    headers: { 'User-Agent': 'cylinder-viewer-discord' },
    cf: { cacheTtl: 60 },
  });
}

/**
 * 最新（config.json）と履歴（history.json）を読む（1 分キャッシュ）。
 * versions[0] が最新。key は最新なら 'latest'、過去は 'YYYY-MM-DD'。
 */
let cached = { at: 0, data: null };
async function loadData(env) {
  if (cached.data && Date.now() - cached.at < 60_000) return cached.data;
  const [cfgRes, histRes] = await Promise.all([fetchRaw(env, 'data/config.json'), fetchRaw(env, 'data/history.json')]);
  if (!cfgRes.ok) throw new Error(`config.json を読み込めませんでした（${cfgRes.status}）`);
  const latest = await cfgRes.json();
  const hist = histRes.ok ? await histRes.json().catch(() => null) : null;
  const used = new Set();
  const entries = (Array.isArray(hist?.entries) ? hist.entries : [])
    .filter((e) => e && ymdRe.test(e.date) && e.config)
    .sort((a, b) => entryKey(b).localeCompare(entryKey(a)))
    .map((e) => {
      let id = String(e.id || e.date);
      while (used.has(id)) id += '_';
      used.add(id);
      return { ...e, id, time: e.time || '' };
    });
  // いちばん新しい記録が今の地図と同じなら、それは「最新」として扱う
  const top = entries[0] && sameMap(entries[0].config, latest) ? entries.shift() : null;
  const versions = [
    { key: 'latest', date: '', time: '', since: top?.date || '', sinceTime: top?.time || '', memo: top?.memo || '', config: latest },
    ...entries.map((e) => ({ key: e.id, date: e.date, time: e.time, memo: e.memo || '', config: e.config })),
  ];
  cached = { at: Date.now(), data: { versions, latest } };
  return cached.data;
}

const versionByKey = (data, key) => data.versions.find((v) => v.key === key) || data.versions[0];
const vDate = (v) => v.date || v.since || todayJst();
const vTime = (v) => (v.date ? v.time : v.sinceTime) || '';
const vName = (v) => (v.date ? longDate(v.date, v.time) : '最新の地図');

const optionValue = (data, name) => (data.options || []).find((o) => o.name === name)?.value;
const MAX_SETS = 10;  // Discord の 1 投稿に付けられる画像の数

/** 「国家 50 海域:30、白地=80%」→ { 国家: 50, 海域: 30, 白地: 80 } */
function parseOpacity(config, text) {
  const names = (config.layers || []).map((l) => l.name);
  const out = {};
  const bad = [];
  const t = String(text || '').replace(/[０-９％：＝]/g, (c) => ({ '％': '%', '：': ':', '＝': '=' }[c] || String.fromCharCode(c.charCodeAt(0) - 0xfee0)));
  for (const line of t.split(/\n/)) {
    if (/^\s*#/.test(line)) continue;  // 説明の行
    const re = /([^\s,、，:=：]+?)\s*[:=]?\s*(\d{1,3})\s*%?(?=[\s,、，]|$)/g;
    let m;
    while ((m = re.exec(line))) {
      const name = m[1].trim();
      const val = Math.max(0, Math.min(100, Number(m[2])));
      if (names.includes(name)) out[name] = val; else bad.push(name);
    }
  }
  return { values: out, unknown: bad };
}

/* ---------- 選択メニュー ---------- */
// メニューの状態（日付・選択・透明度・取っておいた組み合わせ・自分だけ）は、
// メニューのボタンや選択欄そのものに書き込んでおき、操作されるたびにそこから読み戻す。

const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩';
const b36 = (n) => Number(n).toString(36);
const maskOf = (idx) => b36(idx.reduce((m, i) => m + 2 ** i, 0));
const idxOf = (mask) => { const n = parseInt(mask, 36) || 0; const out = []; for (let i = 0; 2 ** i <= n; i++) if (Math.floor(n / 2 ** i) % 2) out.push(i); return out; };
const encodeOps = (ops) => Object.entries(ops).map(([i, v]) => `${b36(i)}${b36(v).padStart(2, '0')}`).join('');
const decodeOps = (s) => { const o = {}; for (let i = 0; i + 3 <= (s || '').length; i += 3) o[parseInt(s[i], 36)] = parseInt(s.slice(i + 1, i + 3), 36); return o; };

/** メニューの状態を、操作されたメッセージから読み戻す */
function readState(data, interaction) {
  const comps = (interaction.message?.components || []).flatMap((r) => r.components || []);
  const find = (pre) => comps.find((c) => (c.custom_id || '').startsWith(pre));
  const key = find('date')?.options?.find((o) => o.default)?.value || 'latest';
  const v = versionByKey(data, key);
  const sel = (find('pick')?.options || []).filter((o) => o.default).map((o) => Number(o.value));
  const ops = decodeOps((find('op:')?.custom_id || 'op:').slice(3));
  // 取っておいた組み合わせは「外す」選択欄の項目に、日付と一緒に書いてある（値は 番号|日付の key|レイヤー）
  let sets = (find('sets')?.options || []).map((o) => {
    const [, k, mask] = String(o.value).split('|');
    return { v: versionByKey(data, k), idx: idxOf(mask) };
  });
  // 以前のメニュー（日付なし）で取っておいたもの
  const oldAdd = find('add:');
  if (!sets.length && oldAdd) sets = oldAdd.custom_id.slice(4).split(',').filter(Boolean).map((m) => ({ v, idx: idxOf(m) }));
  const priv = (find('priv:')?.custom_id || 'priv:0') === 'priv:1';
  return { v, sel, ops, sets, priv };
}

const namesOf = (v, idx) => idx.filter((i) => i < (v.config.layers || []).length).sort((a, b) => a - b).map((i) => v.config.layers[i].name);
const opacityOf = (v, ops, i) => (ops[i] ?? Math.round((v.config.layers[i]?.opacity ?? 1) * 100));
const sameSet = (a, b) => a.length === b.length && a.every((x, i) => x === [...b].sort((p, q) => p - q)[i]);
const sameEntry = (a, b) => a.v.key === b.v.key && sameSet([...a.idx].sort((p, q) => p - q), b.idx);
const shortName = (v) => {
  if (!v.date) return '最新';
  const m = ymdRe.exec(v.date);
  return m ? `${+m[2]}/${+m[3]}${v.time ? ` ${v.time}` : ''}` : v.date;
};

/** 送る組み合わせ：取っておいたもの＋今の選択（同じものは 1 枚）。{ v, idx, current } の並び */
function setsToSend(st) {
  const list = st.sets.map((s) => ({ v: s.v, idx: [...s.idx].sort((a, b) => a - b) }));
  const cur = { v: st.v, idx: [...st.sel].sort((a, b) => a - b), current: true };
  if (!list.some((s) => sameEntry(s, cur))) list.push(cur);
  return list.slice(0, MAX_SETS);
}

function menu(data, st) {
  const { v } = st;
  const layers = v.config.layers || [];
  const sel = [...new Set(st.sel)].filter((i) => i >= 0 && i < layers.length).sort((a, b) => a - b);
  const sets = st.sets
    .map((s) => ({ v: s.v, idx: s.idx.filter((i) => i < (s.v.config.layers || []).length) }))
    .slice(0, MAX_SETS - 1);
  const ops = Object.fromEntries(Object.entries(st.ops).filter(([i, val]) => i < layers.length && val !== Math.round((layers[i].opacity ?? 1) * 100)));
  const dated = data.versions.length > 1;
  const label = (s) => `${namesOf(s.v, s.idx).join('・') || '（下地だけ）'}${dated ? `（${shortName(s.v)}）` : ''}`;
  // 閲覧ページと同じく、手前に重なるレイヤーから並べる
  const options = layers
    .map((l, i) => ({ label: String(l.name || `レイヤー${i + 1}`).slice(0, 100), value: String(i), default: sel.includes(i) }))
    .reverse()
    .slice(0, 25);

  const rows = [];
  if (dated) {
    rows.push({
      type: 1,
      components: [{
        type: 3,
        custom_id: 'date',
        placeholder: '日付を選ぶ',
        options: data.versions.slice(0, 25).map((x) => ({
          label: vName(x).slice(0, 100),
          description: (x.date ? x.memo : [x.since ? `${longDate(x.since, x.sinceTime)}の記録` : '', x.memo].filter(Boolean).join('・')).slice(0, 100) || undefined,
          value: x.key,
          default: x.key === v.key,
        })),
      }],
    });
  }
  if (options.length) {
    rows.push({ type: 1, components: [{ type: 3, custom_id: 'pick', placeholder: 'レイヤーを選ぶ（複数可）', min_values: 0, max_values: options.length, options }] });
  }
  const sending = setsToSend({ v, sel, sets });
  rows.push({
    type: 1,
    components: [
      { type: 2, style: 1, custom_id: 'make', label: sending.length > 1 ? `地図を作る（${sending.length}枚）` : '地図を作る' },
      { type: 2, style: 2, custom_id: 'add', label: '組み合わせを追加', disabled: sets.length >= MAX_SETS - 1 },
      ...(options.length ? [{ type: 2, style: 2, custom_id: `op:${encodeOps(ops)}`, label: '透明度…' }] : []),
      { type: 2, style: st.priv ? 3 : 2, custom_id: `priv:${st.priv ? 1 : 0}`, label: `${st.priv ? '✅' : '⬜'} 自分だけに表示` },
    ],
  });
  rows.push({
    type: 1,
    components: [
      ...(options.length ? [
        { type: 2, style: 2, custom_id: 'all', label: 'すべて選ぶ' },
        { type: 2, style: 2, custom_id: 'def', label: '初期表示に戻す' },
      ] : []),
      { type: 2, style: 4, custom_id: 'clear', label: '組み合わせを空にする', disabled: !sets.length },
      { type: 2, style: 2, custom_id: 'help:menu', label: '❓ 使い方' },
    ],
  });
  // 取っておいた組み合わせの一覧（選ぶとその組み合わせを外す）。状態の保存場所も兼ねる
  if (sets.length) {
    rows.push({
      type: 1,
      components: [{
        type: 3,
        custom_id: 'sets',
        placeholder: '取っておいた組み合わせを外す（選んだものを外します）',
        min_values: 1,
        max_values: sets.length,
        options: sets.map((s, i) => ({
          label: `${CIRCLED[i]} ${label(s)}`.slice(0, 100),
          value: `${i}|${s.v.key}|${maskOf(s.idx)}`,
        })),
      }],
    });
  }

  const lines = ['地図に重ねるレイヤーを選んで（複数可）、「地図を作る」を押してください。下地はいつも含まれます。'];
  lines.push(`「組み合わせを追加」で今の選択を取っておくと、別々のレイヤー${dated ? 'や日付' : ''}の地図をまとめて送れます。`, '');
  if (dated) lines.push(`**日付**：${vName(v)}${v.date && v.memo ? `・${v.memo}` : ''}`);
  if (sets.length) {
    lines.push('**送る組み合わせ**：');
    sending.forEach((s, i) => lines.push(`${CIRCLED[i]} ${label(s)}${s.current ? '　← 今の選択' : ''}`));
  } else {
    lines.push(`**選択中**：${sel.length ? namesOf(v, sel).join('・') : '（なし。下地だけになります）'}`);
  }
  const changed = Object.keys(ops).map((i) => `${layers[i].name} ${ops[i]}%`);
  lines.push(`**透明度**：${changed.length ? changed.join('・') : '管理ページの設定のまま'}`);
  lines.push(`**送り先**：${st.priv ? '自分だけ（ほかの人には見えません）' : 'チャンネルの全員'}`);
  return { content: lines.join('\n').slice(0, 2000), flags: 64, allowed_mentions: { parse: [] }, components: rows };
}

/** 透明度を入力する画面（Discord のモーダル） */
function opacityModal(st) {
  const { v } = st;
  const layers = v.config.layers || [];
  // 選んでいるレイヤー（なければ全部）を、手前のものから並べる
  const usedNames = new Set(st.sets.flatMap((x) => namesOf(x.v, x.idx)));
  const used = new Set([...st.sel, ...layers.map((l, i) => (usedNames.has(l.name) ? i : -1)).filter((i) => i >= 0)]);
  const idx = layers.map((_, i) => i).filter((i) => !used.size || used.has(i)).reverse();
  const value = [
    '# 0〜100 の数字を書き換えてください',
    '# 100=そのまま 75=少し透ける 50=半分 25=うっすら 0=見えない',
    ...idx.map((i) => `${layers[i].name}: ${opacityOf(v, st.ops, i)}`),
  ].join('\n').slice(0, 4000);
  return {
    type: 9,
    data: {
      custom_id: 'opmodal',
      title: 'レイヤーの透明度',
      components: [{
        type: 1,
        components: [{ type: 4, custom_id: 'ops', style: 2, label: '透明度（%）', value, required: false, max_length: 4000 }],
      }],
    },
  };
}

/* ---------- 使い方（ヘルプ） ---------- */

function siteUrl(env) {
  if (env.SITE_URL) return env.SITE_URL;
  const [owner, repo] = String(env.GITHUB_REPO || '').split('/');
  if (!owner || !repo) return '';
  return repo.toLowerCase() === `${owner.toLowerCase()}.github.io` ? `https://${repo}/` : `https://${owner.toLowerCase()}.github.io/${repo}/`;
}

/** ヘルプの項目。key は /地図 使い方 の選択肢と同じ */
const HELP = [
  {
    key: 'index',
    title: 'はじめに',
    desc: 'できることと、基本の流れ',
    body: (ctx) => [
      `**${ctx.title}** の地図を、Discord に画像として送れます。`,
      '',
      '**基本の流れ**',
      '1. `/地図` と打って送信すると、自分にだけ見えるメニューが開きます。',
      '2. 「レイヤーを選ぶ」で、重ねたいレイヤーにチェックを付けます。',
      '3. 「地図を作る」を押すと、30秒〜1分ほどで地図が送られます。',
      '',
      '**できること**',
      '・好きなレイヤーを重ねた地図を送る',
      '・違うレイヤーや日付の地図を、最大 10 枚まとめて送る',
      '・過去の日付の地図を送る',
      '・レイヤーの透明度を変える',
      '・自分にだけ見える形で送る',
      '',
      '下の選択欄から、知りたい項目を選んでください。',
    ],
  },
  {
    key: 'menu',
    title: 'メニューの使い方',
    desc: 'ボタンや選択欄の意味',
    body: () => [
      '`/地図` で開くメニューの、上から順の説明です。',
      '',
      '**日付を選ぶ**：どの日の地図にするか（くわしくは「過去の地図」）',
      '**レイヤーを選ぶ**：重ねるレイヤーにチェック（複数可）。最初は閲覧ページの初期表示と同じです',
      '**地図を作る**：地図を送ります。メニューは残るので、続けて別の地図も作れます',
      '**組み合わせを追加**：今の選択を取っておきます（くわしくは「まとめて送る」）',
      '**透明度…**：レイヤーの透け具合を変えます（くわしくは「透明度」）',
      '**⬜ 自分だけに表示**：押すと ✅ になり、自分にだけ見える形で送ります',
      '**すべて選ぶ／初期表示に戻す**：レイヤーの選択をまとめて変えます',
      '**組み合わせを空にする**：取っておいた組み合わせを全部外します',
      '**取っておいた組み合わせを外す**（いちばん下）：選んだものだけ外します',
      '',
      '下地（いちばん下の画像）は、いつも含まれます。',
      'メニューは自分にしか見えません。不要になったら「メッセージを閉じる」で消せます。',
    ],
  },
  {
    key: 'sets',
    title: 'まとめて送る',
    desc: '違うレイヤーや日付の地図を一度に',
    body: () => [
      '違うレイヤーや日付の地図を、1 つの投稿にまとめて送れます（最大 10 枚）。',
      '',
      '1. レイヤー（と日付）を選んで「**組み合わせを追加**」を押します。',
      '2. 別のレイヤーや日付を選び直して、また「組み合わせを追加」。',
      '3. メニューの「送る組み合わせ」に ①②… と並ぶので、確認して「**地図を作る（○枚）**」を押します。',
      '',
      '・最後に選んでいる内容（「← 今の選択」）も 1 枚として送られます。同じ組み合わせは 1 枚になります。',
      '・組み合わせには、追加したときの日付が付きます。「① 白地・国家（10/26 15:46）」のように表示されます。',
      '・いらない組み合わせは、いちばん下の「取っておいた組み合わせを外す」で選んで外せます。',
      '・透明度は、まとめて送る地図すべてに同じ値が使われます。',
    ],
  },
  {
    key: 'date',
    title: '過去の地図',
    desc: '日付を選んで、その時点の地図を送る',
    body: (ctx) => [
      'メニューのいちばん上の「**日付を選ぶ**」で、過去の地図を選べます。',
      '',
      '・地図は、管理ページから公開するたびに記録として残ります。1 日に何回か更新した日は、時刻ごとに並びます。',
      '・新しい順に 25 件まで選べます。',
      '・日付を変えても、同じ名前のレイヤーの選択と透明度は引き継がれます。',
      '・別の日付の地図と並べて送りたいときは「まとめて送る」を見てください。',
      ctx.count > 1 ? `\n今は ${ctx.count - 1} 件の過去の記録があります（いちばん古いもの：${ctx.oldest}）。` : '\n今はまだ過去の記録がありません。',
    ],
  },
  {
    key: 'opacity',
    title: '透明度',
    desc: 'レイヤーの透け具合と目安',
    body: () => [
      'メニューの「**透明度…**」を押すと入力欄が開きます。',
      '`国家: 100` のような行の数字を書き換えて「送信」すると、そのレイヤーの透け具合が変わります。',
      '',
      '**目安**',
      '`100` そのまま。下のレイヤーは見えない（初期の状態）',
      '` 75` 少し透ける。下がうっすら見える',
      '` 50` 半分透ける。上と下が同じくらい見える',
      '` 25` うっすら見える。下のレイヤーが中心',
      '`  0` 見えない（そのレイヤーを外したのと同じ）',
      '',
      '・変えたレイヤーは、メニューの「透明度」の行に表示されます。',
      '・まとめて送るときは、すべての地図に同じ透明度が使われます。',
      '・書き換えなかったレイヤーは、管理ページで設定した透明度のままです。',
    ],
  },
  {
    key: 'private',
    title: '自分だけに表示',
    desc: 'ほかの人に見えない形で送る',
    body: () => [
      'メニューの「**⬜ 自分だけに表示**」を押すと ✅ に変わり、地図が自分にだけ見える形で送られます。もう一度押すと元に戻ります。',
      '',
      '・メニューの「送り先」の行で、今どちらになっているか確認できます。',
      '・自分だけの地図は、Discord の仕組み上、時間がたつと（またはアプリを開き直すと）消えることがあります。残したい地図は保存してください。',
      '・メニューとこの使い方は、いつも自分にだけ見えます。',
    ],
  },
  {
    key: 'trouble',
    title: '困ったとき',
    desc: '時間がかかる・届かないなど',
    body: () => [
      '**「考え中…」が長い**',
      '地図はその場で作っているため、30秒〜1分ほどかかります。枚数が多いと少し長くなります。3 分以上たっても変わらないときは、管理している人に連絡してください。',
      '',
      '**ボタンを押しても反応しない・古い内容のまま**',
      'メニューを開いてから時間がたつと、反応しなくなることがあります。`/地図` でメニューを開き直してください。',
      '',
      '**新しい地図が出てこない**',
      '管理ページで公開してから反映まで、1〜2分かかります。少し待ってからメニューを開き直してください。',
      '',
      '**陸地が透明になった**',
      '白地や地形のような、地面のレイヤーが選ばれていないためです。どちらかにチェックを付けてください。',
    ],
  },
  {
    key: 'site',
    title: '閲覧ページ',
    desc: 'ブラウザで地図を回して見る',
    body: (ctx) => [
      ctx.url ? `ブラウザで地図を見るときは、こちらを開いてください。\n${ctx.url}` : '閲覧ページの URL は、管理している人に聞いてください。',
      '',
      '・地図を筒のように回したり、平面で見たりできます。',
      '・レイヤーの表示や透明度を、その場で切り替えられます。',
      '・過去の日付の地図も見られます。',
      '・画面の範囲や地図全体を、画像として保存できます。',
      '・右上の鉛筆ボタンから、お絵かきページ（地図に自由に描けるページ）を開けます。描いた内容は自分のブラウザの中だけに残ります。サーバーで許可されていれば、保存メニューの「Discordに送る」からこのサーバーに送れます。',
    ],
  },
];

/** ヘルプのメッセージ（自分にだけ見える）。下の選択欄でほかの項目に切り替えられる */
function helpMessage(env, data, key) {
  const topic = HELP.find((h) => h.key === key) || HELP[0];
  const dated = data.versions.filter((v) => v.date);
  const oldest = dated[dated.length - 1];
  const ctx = {
    title: data.latest.title || '地図',
    url: siteUrl(env),
    count: data.versions.length,
    oldest: oldest ? longDate(oldest.date, oldest.time) : '',
  };
  return {
    content: [`## ❓ ${topic.title}`, ...topic.body(ctx)].join('\n').slice(0, 2000),
    flags: 64,
    allowed_mentions: { parse: [] },
    components: [
      {
        type: 1,
        components: [{
          type: 3,
          custom_id: 'help',
          placeholder: 'ほかの項目を見る',
          options: HELP.map((h) => ({ label: h.title, description: h.desc, value: h.key, default: h.key === topic.key })),
        }],
      },
      { type: 1, components: [{ type: 2, style: 1, custom_id: 'openmenu', label: '地図のメニューを開く' }] },
    ],
  };
}

const defaultIndexes = (config) => (config.layers || []).map((l, i) => (l.visible !== false ? i : -1)).filter((i) => i >= 0);
const parseIndexes = (s) => String(s || '').split(',').filter(Boolean).map(Number).filter(Number.isInteger);

function whoName(interaction) {
  const m = interaction.member;
  const u = m?.user || interaction.user || {};
  return m?.nick || u.global_name || u.username || '';
}

/**
 * Actions を起動する。sets は { names: レイヤー名の配列, date: 記録の key（最新は ''） } の配列、opacity は { レイヤー名: 0〜100 }
 */
async function startRender(env, interaction, { sets, opacity = {}, label, priv = false }) {
  const sealed = await seal({ t: interaction.token, a: interaction.application_id, e: priv ? 1 : 0 }, env.SHARED_SECRET);
  // 全部同じ日付なら日付は 1 つだけ送る。1 枚・透明度の変更なしなら、以前と同じ形で送る
  const dates = [...new Set(sets.map((x) => x.date))];
  const date = dates.length === 1 ? dates[0] : '';
  const layers = sets.length === 1 && !Object.keys(opacity).length
    ? sets[0].names
    : { sets: dates.length === 1 ? sets.map((x) => x.names) : sets.map((x) => ({ date: x.date, layers: x.names })), opacity };
  const inputs = { layers: JSON.stringify(layers), label, payload: sealed };
  if (date) inputs.date = date;  // 最新のときは送らない（古いワークフローでも動くように）
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${String(env.GITHUB_TOKEN || '').trim()}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'cylinder-viewer-discord',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ref: env.GITHUB_BRANCH || 'main', inputs }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error('GitHub dispatch failed', res.status, detail);
    const hint = res.status === 422 && date
      ? 'リポジトリの .github/workflows/discord-map.yml を最新版に更新してください（日付の指定に必要です）。'
      : 'Worker の GITHUB_TOKEN と GITHUB_REPO を確認してください。';
    // 「考え中…」のままにならないよう、失敗を知らせる
    await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: `地図を作成できませんでした（GitHub ${res.status}）。${hint}` }),
    });
  }
}

/* =====================================================================
 * ここから：お絵かきページからの送信と、/地図設定（管理メニュー）
 *
 * 追加で必要な設定（Cloudflare の「設定」→「変数とシークレット」／「バインディング」）
 *   DISCORD_APP_ID         Discord アプリの Application ID
 *   DISCORD_BOT_TOKEN      （シークレット）Bot の Token
 *   DISCORD_CLIENT_SECRET  （シークレット）OAuth2 の Client Secret（Discord でログインするため）
 *   SETTINGS               KV 名前空間のバインディング（サーバーごとの設定を保存する）
 *   ALLOWED_ORIGINS        （任意）お絵かきページを置いているサイト。SITE_URL と違う場合だけ。カンマ区切り
 * ===================================================================== */

const API = 'https://discord.com/api/v10';
const PERM = { ADMIN: 1n << 3n, VIEW: 1n << 10n, SEND: 1n << 11n, ATTACH: 1n << 15n };
const ALL_PERMS = (1n << 53n) - 1n;
const NEED = PERM.VIEW | PERM.SEND | PERM.ATTACH;
const SEND_INTERVAL = 30;           // 同じ人が続けて送れる間隔（秒）
const MAX_UPLOAD = 10 * 1024 * 1024; // Discord に Bot が送れる大きさ（ブーストなし）
const LOCK_TRIES = 5;               // パスワードを続けて間違えられる回数
const LOCK_MIN = 10;                // 間違え続けたときに使えなくなる時間（分）
const GRANT_MIN = 30;               // パスワードで開いた管理メニューを操作できる時間（分）
const PW_ITER = 10000;

const enc = new TextEncoder();
const b64u = (bytes) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64u = (s) => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

/** seal の逆。開けなければ null */
async function unseal(token, secret) {
  try {
    const all = unb64u(token);
    const keyBytes = await crypto.subtle.digest('SHA-256', enc.encode(secret));
    const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12) }, key, all.slice(12));
    return JSON.parse(new TextDecoder().decode(pt));
  } catch {
    return null;
  }
}
// ログイン情報などは、Actions に渡すものとは別の鍵で暗号化する
const sessionSecret = (env) => `${env.SHARED_SECRET || ''}|draw-session`;

/** Discord の API を呼ぶ。user を渡すとその人として（OAuth）、なければ Bot として */
async function dapi(env, path, { method = 'GET', body, user, form } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const headers = { Authorization: user ? `Bearer ${user}` : `Bot ${String(env.DISCORD_BOT_TOKEN || '').trim()}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${API}${path}`, { method, headers, body: form || (body !== undefined ? JSON.stringify(body) : undefined) });
    if (res.status === 429 && attempt === 0) {
      const ra = Number((await res.json().catch(() => ({}))).retry_after ?? res.headers.get('Retry-After') ?? 99);
      if (ra <= 3) { await new Promise((r) => setTimeout(r, ra * 1000 + 100)); continue; }
      return { status: 429, data: { retry_after: ra } };
    }
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    return { status: res.status, data };
  }
  return { status: 429, data: {} };
}

let botIdCache = '';
async function botId(env) {
  if (botIdCache) return botIdCache;
  const r = await dapi(env, '/users/@me');
  botIdCache = r.data?.id || String(env.DISCORD_APP_ID || '');
  return botIdCache;
}

/* ---------- 権限の計算 ---------- */

function basePerms(guild, member) {
  const uid = member.user?.id;
  if (guild.owner_id && guild.owner_id === uid) return ALL_PERMS;
  const roles = new Map((guild.roles || []).map((r) => [r.id, BigInt(r.permissions)]));
  let p = roles.get(guild.id) || 0n;  // @everyone
  for (const r of member.roles || []) p |= roles.get(r) || 0n;
  return p & PERM.ADMIN ? ALL_PERMS : p;
}

function channelPerms(guild, member, channel) {
  const base = basePerms(guild, member);
  if (base === ALL_PERMS) return ALL_PERMS;
  let p = base;
  const ow = channel.permission_overwrites || [];
  const apply = (o) => { p = (p & ~BigInt(o.deny)) | BigInt(o.allow); };
  const ev = ow.find((o) => o.id === guild.id);
  if (ev) apply(ev);
  let allow = 0n, deny = 0n;
  for (const o of ow) if (Number(o.type) === 0 && o.id !== guild.id && (member.roles || []).includes(o.id)) { allow |= BigInt(o.allow); deny |= BigInt(o.deny); }
  p = (p & ~deny) | allow;
  const mine = ow.find((o) => Number(o.type) === 1 && o.id === member.user?.id);
  if (mine) apply(mine);
  if (!(p & PERM.VIEW)) return 0n;
  return p;
}

const canPost = (p) => (p & NEED) === NEED;

/* ---------- サーバーごとの設定（KV） ---------- */

const DEFAULT_SETTINGS = {
  enabled: false,          // お絵かきページからの送信
  defaultChannel: '',      // 送り先の初期チャンネル
  sendMode: 'admins',      // 送れる人：admins（管理者だけ）| all | roles | users
  sendRoles: [],
  sendUsers: [],
  adminRoles: [],          // 管理メニューを使える人（サーバー管理者のほかに）
  adminUsers: [],
  pw: null,                // { salt, hash, iter }
  notifyChannel: '',       // パスワードで開いたときの通知先
  log: [],                 // [{ at, uid, name, kind }]
};

async function getSettings(env, gid) {
  if (!env.SETTINGS) throw new Error('no-kv');
  const raw = await env.SETTINGS.get(`guild:${gid}`, 'json');
  return { ...DEFAULT_SETTINGS, ...(raw || {}) };
}
async function putSettings(env, gid, s) { await env.SETTINGS.put(`guild:${gid}`, JSON.stringify(s)); }

const isAdminMember = (s, member, perms) =>
  !!(perms & PERM.ADMIN) || (member.roles || []).some((r) => s.adminRoles.includes(r)) || s.adminUsers.includes(member.user?.id);

function canSendBySettings(s, member, perms) {
  if (isAdminMember(s, member, perms)) return true;
  if (s.sendMode === 'all') return true;
  if (s.sendMode === 'roles') return (member.roles || []).some((r) => s.sendRoles.includes(r));
  if (s.sendMode === 'users') return s.sendUsers.includes(member.user?.id);
  return false;
}

/* ---------- お絵かきページ向け：CORS とログイン ---------- */

function allowedOrigins(env) {
  const list = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  try { const u = siteUrl(env); if (u) list.push(new URL(u).origin); } catch { /* 設定なし */ }
  return list;
}

function cors(env, request, res) {
  const origin = request.headers.get('Origin');
  const h = new Headers(res.headers);
  if (origin && allowedOrigins(env).includes(origin)) {
    h.set('Access-Control-Allow-Origin', origin);
    h.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    h.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    h.set('Access-Control-Max-Age', '86400');
  }
  h.set('Vary', 'Origin');
  return new Response(res.body, { status: res.status, headers: h });
}

const apiError = (code, extra = {}, status = 400) => json({ ok: false, error: code, ...extra }, status);

function returnUrlOk(env, url) {
  try { return allowedOrigins(env).includes(new URL(url).origin); } catch { return false; }
}

async function oauthLogin(env, url) {
  const ret = url.searchParams.get('return') || '';
  if (!returnUrlOk(env, ret)) return new Response('戻り先のページが許可されていません。Worker の SITE_URL（または ALLOWED_ORIGINS）を確認してください。', { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  if (!env.DISCORD_APP_ID || !env.DISCORD_CLIENT_SECRET) return new Response('Worker に DISCORD_APP_ID と DISCORD_CLIENT_SECRET が設定されていません。', { status: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  const state = await seal({ r: ret, x: Date.now() + 10 * 60_000 }, sessionSecret(env));
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: String(env.DISCORD_APP_ID).trim(),
    scope: 'identify guilds',
    redirect_uri: `${url.origin}/oauth/callback`,
    state,
    prompt: 'none',
  });
  return Response.redirect(`https://discord.com/oauth2/authorize?${q}`, 302);
}

async function oauthCallback(env, url) {
  const st = await unseal(url.searchParams.get('state') || '', sessionSecret(env));
  if (!st || st.x < Date.now() || !returnUrlOk(env, st.r)) return new Response('ログインの有効期限が切れました。もう一度お試しください。', { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  const back = (hash) => Response.redirect(`${st.r.split('#')[0]}#${hash}`, 302);
  const code = url.searchParams.get('code');
  if (!code) return back('dlogin-error=denied');
  const tr = await fetch(`${API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: String(env.DISCORD_APP_ID).trim(),
      client_secret: String(env.DISCORD_CLIENT_SECRET).trim(),
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${url.origin}/oauth/callback`,
    }),
  });
  const tok = await tr.json().catch(() => ({}));
  if (!tr.ok || !tok.access_token) return back('dlogin-error=token');
  const me = await dapi(env, '/users/@me', { user: tok.access_token });
  if (me.status !== 200) return back('dlogin-error=user');
  const exp = Date.now() + Math.min(Number(tok.expires_in) || 604800, 604800) * 1000;
  const name = me.data.global_name || me.data.username;
  const session = await seal({ u: me.data.id, n: name, t: tok.access_token, x: exp }, sessionSecret(env));
  const q = new URLSearchParams({ dlogin: session, did: me.data.id, dname: name, dexp: String(exp) });
  return back(q.toString());
}

async function sessionOf(env, request) {
  const m = /^Bearer\s+(.+)$/.exec(request.headers.get('Authorization') || '');
  if (!m) return null;
  const s = await unseal(m[1].trim(), sessionSecret(env));
  if (!s || !s.u || s.x < Date.now()) return null;
  return s;
}

/* ---------- お絵かきページ向け：送り先の一覧 ---------- */

const CHANNEL_TYPES = [0, 5];  // テキスト・アナウンス

async function guildContext(env, gid, uid) {
  const bid = await botId(env);
  const [g, ch, mu, mb] = await Promise.all([
    dapi(env, `/guilds/${gid}`),
    dapi(env, `/guilds/${gid}/channels`),
    dapi(env, `/guilds/${gid}/members/${uid}`),
    dapi(env, `/guilds/${gid}/members/${bid}`),
  ]);
  return { guild: g.data, guildStatus: g.status, channels: Array.isArray(ch.data) ? ch.data : [], member: mu.status === 200 ? mu.data : null, bot: mb.status === 200 ? mb.data : null };
}

function postableChannels(c) {
  const cats = new Map(c.channels.filter((x) => x.type === 4).map((x) => [x.id, x]));
  return c.channels
    .filter((x) => CHANNEL_TYPES.includes(x.type))
    .filter((x) => canPost(channelPerms(c.guild, c.member, x)) && canPost(channelPerms(c.guild, c.bot, x)))
    .sort((a, b) => ((cats.get(a.parent_id)?.position ?? -1) - (cats.get(b.parent_id)?.position ?? -1)) || (a.position - b.position))
    .map((x) => ({ id: x.id, name: x.name, category: cats.get(x.parent_id)?.name || '' }));
}

async function apiTargets(env, s) {
  const [ug, bg] = await Promise.all([dapi(env, '/users/@me/guilds', { user: s.t }), dapi(env, '/users/@me/guilds?limit=200')]);
  if (ug.status === 401) return apiError('session_expired', {}, 401);
  if (ug.status !== 200 || bg.status !== 200) return apiError('discord_error', { status: ug.status !== 200 ? ug.status : bg.status }, 502);
  const botGuilds = new Set(bg.data.map((g) => g.id));
  const common = ug.data.filter((g) => botGuilds.has(g.id)).slice(0, 10);
  const out = [];
  for (const g of common) {
    const st = await getSettings(env, g.id);
    const item = { id: g.id, name: g.name, ok: false, reason: '', defaultChannel: st.defaultChannel || '', channels: [] };
    out.push(item);
    if (!st.enabled) { item.reason = 'disabled'; continue; }
    const c = await guildContext(env, g.id, s.u);
    if (!c.member) { item.reason = 'not_member'; continue; }
    if (!c.bot || !c.guild) { item.reason = 'bot_no_access'; continue; }
    if (!canSendBySettings(st, c.member, basePerms(c.guild, c.member))) { item.reason = 'not_allowed'; continue; }
    item.channels = postableChannels(c);
    if (!item.channels.length) { item.reason = 'no_channel'; continue; }
    item.ok = true;
  }
  return json({ ok: true, user: { id: s.u, name: s.n }, guilds: out });
}

/* ---------- お絵かきページ向け：画像を送る ---------- */

function jstStamp() {
  const d = new Date(Date.now() + 9 * 3600_000);
  return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

async function apiSend(env, s, request) {
  // 続けて送れるのは 30 秒ごと
  const rateKey = `rate:${s.u}`;
  const last = Number(await env.SETTINGS.get(rateKey)) || 0;
  const wait = Math.ceil(SEND_INTERVAL - (Date.now() - last) / 1000);
  if (wait > 0) return apiError('rate_limited', { wait }, 429);

  let form;
  try { form = await request.formData(); } catch { return apiError('bad_request'); }
  const cid = String(form.get('channel') || '').trim();
  const file = form.get('file');
  if (!/^\d{15,22}$/.test(cid)) return apiError('bad_channel');
  if (!file || typeof file === 'string') return apiError('bad_request');
  if (file.size > MAX_UPLOAD) return apiError('too_large');
  const buf = new Uint8Array(await file.arrayBuffer());
  if (!(buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)) return apiError('bad_request');

  // チャンネルとサーバー
  const ch = await dapi(env, `/channels/${cid}`);
  if (ch.status === 404 || ch.status === 403 || ch.status === 401) return apiError('bot_no_access');
  if (ch.status !== 200) return apiError('discord_error', { status: ch.status }, 502);
  if (!ch.data.guild_id) return apiError('bad_channel');
  if (!CHANNEL_TYPES.includes(ch.data.type)) return apiError('bad_channel_type');
  const gid = ch.data.guild_id;
  const st = await getSettings(env, gid);
  if (!st.enabled) return apiError('disabled');
  const c = await guildContext(env, gid, s.u);
  if (!c.guild || !c.bot) return apiError('bot_no_access');
  if (!c.member) return apiError('not_member');
  if (!canSendBySettings(st, c.member, basePerms(c.guild, c.member))) return apiError('not_allowed');
  if (!canPost(channelPerms(c.guild, c.member, ch.data))) return apiError('no_permission');
  if (!canPost(channelPerms(c.guild, c.bot, ch.data))) return apiError('bot_no_permission');

  // 送る（本文なし。ファイル名に日時と送った人の ID）
  const filename = `${jstStamp()}_DiscordID-${s.u}.png`;
  const fd = new FormData();
  fd.append('payload_json', JSON.stringify({ attachments: [{ id: 0, filename }], allowed_mentions: { parse: [] } }));
  fd.append('files[0]', new Blob([buf], { type: 'image/png' }), filename);
  const r = await dapi(env, `/channels/${cid}/messages`, { method: 'POST', form: fd });
  if (r.status === 429) return apiError('discord_busy', { wait: Math.ceil(r.data?.retry_after || 30) }, 429);
  if (r.status === 413 || r.data?.code === 40005) return apiError('too_large');
  if (r.status !== 200) return apiError('discord_error', { status: r.status, code: r.data?.code }, 502);
  await env.SETTINGS.put(rateKey, String(Date.now()), { expirationTtl: 60 });
  return json({ ok: true, filename, url: `https://discord.com/channels/${gid}/${cid}/${r.data.id}`, channel: ch.data.name, guild: c.guild.name });
}

async function handleApi(env, request, url) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
  const origin = request.headers.get('Origin');
  if (origin && !allowedOrigins(env).includes(origin)) return apiError('origin_not_allowed', {}, 403);
  if (!env.SETTINGS || !env.DISCORD_BOT_TOKEN) return apiError('not_configured', {}, 500);
  const s = await sessionOf(env, request);
  if (!s) return apiError('login_required', {}, 401);
  if (url.pathname === '/api/targets' && request.method === 'GET') return apiTargets(env, s);
  if (url.pathname === '/api/send' && request.method === 'POST') return apiSend(env, s, request);
  return apiError('not_found', {}, 404);
}

/* ---------- /地図設定（管理メニュー） ---------- */

async function hashPassword(pw, salt, iter = PW_ITER) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256);
  return new Uint8Array(bits);
}
async function checkPassword(pw, rec) {
  if (!rec?.hash) return false;
  const h = await hashPassword(pw, unb64u(rec.salt), rec.iter || PW_ITER);
  const want = unb64u(rec.hash);
  let d = h.length ^ want.length;
  for (let i = 0; i < Math.min(h.length, want.length); i++) d |= h[i] ^ want[i];
  return d === 0;
}

const memberPerms = (interaction) => { try { return BigInt(interaction.member?.permissions || '0'); } catch { return 0n; } };
const userOf = (interaction) => interaction.member?.user || interaction.user || {};
const nameOf = (u) => u.global_name || u.username || '';
const eph = (data) => json({ type: 4, data: { flags: 64, allowed_mentions: { parse: [] }, ...data } });
const NO_PERMISSION = '⚠ 権限がありません！';

function jst(ms) {
  const d = new Date(ms + 9 * 3600_000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

async function notify(env, s, content) {
  if (!s.notifyChannel) return;
  await dapi(env, `/channels/${s.notifyChannel}/messages`, { method: 'POST', body: { content, allowed_mentions: { parse: [] } } }).catch(() => {});
}

const SEND_MODES = [
  ['admins', '管理者だけ', '管理メニューを使える人だけが送れます（最初の設定）'],
  ['all', '全員', 'サーバーの全員が送れます'],
  ['roles', 'ロールで指定', '選んだロールを持つ人と管理者が送れます'],
  ['users', 'アカウントで指定', '選んだ人と管理者が送れます'],
];

const list = (ids, f, none = 'なし') => (ids.length ? ids.map(f).join(' ') : none);
const roleM = (id) => `<@&${id}>`;
const userM = (id) => `<@${id}>`;
const chM = (id) => (id ? `<#${id}>` : '未設定');

function senderText(s) {
  if (s.sendMode === 'all') return '全員';
  if (s.sendMode === 'roles') return `ロール：${list(s.sendRoles, roleM, '（未選択）')}（と管理者）`;
  if (s.sendMode === 'users') return `アカウント：${list(s.sendUsers, userM, '（未選択）')}（と管理者）`;
  return '管理者だけ';
}

const btn = (custom_id, label, style = 2, extra = {}) => ({ type: 2, custom_id, label, style, ...extra });
const row = (...components) => ({ type: 1, components });
const backRow = (...more) => row(btn('as:page:main', '← 戻る'), ...more);

const ADMIN_HELP = [
  '**❓ 管理メニューの説明**',
  '',
  'このメニューで、お絵かきページ（地図に自由に描けるページ）から、このサーバーに画像を送れるようにする設定を決めます。設定はサーバーごとです。',
  '',
  '**送信の設定**',
  '・「送信を有効にする」を押すと、お絵かきページの保存メニューの「Discordに送る」から、このサーバーに送れるようになります（最初は止まっています）。',
  '・初期チャンネル：送り先を選ぶときに、最初から選ばれているチャンネルです。',
  '・送れる人：管理者だけ（最初の設定）／全員／ロールで指定／アカウントで指定。管理メニューを使える人は、いつでも送れます。',
  '・送る人は、Discord でログインして送ります。その人が書き込めないチャンネルや、Bot が見られないチャンネルには送れません。同じ人が送れるのは 30 秒に 1 回です。',
  '・送られる画像には本文がなく、ファイル名が「月-日-時分秒_DiscordID-送った人のID.png」になります。',
  '',
  '**管理者の設定**',
  '・サーバーの管理者権限を持つ人（とサーバーの持ち主）は、いつでもこのメニューを使えます。',
  '・ここで選んだロール・アカウントの人も、パスワードなしで使えるようになります。',
  '',
  '**パスワードと記録**',
  '・パスワードを設定すると、権限のない人でも `/地図設定 パスワード:〇〇` で、このメニューを開けるようになります（最初は設定されていません）。',
  `・パスワードを ${LOCK_TRIES} 回続けて間違えると、その人は ${LOCK_MIN} 分間開けなくなります。`,
  `・パスワードで開いた人は、そこから ${GRANT_MIN} 分間このメニューを操作できます。`,
  '・パスワードで開いた記録は「記録を見る」で確認できます。通知先のチャンネルを選ぶと、開かれたときにそこへお知らせします。',
  '・パスワードは元に戻せない形で保存しています。忘れたときは、管理者が設定し直してください。',
  '',
  '※ この説明は `/地図 使い方` には出てきません。',
].join('\n');

function adminPage(s, page, note = '') {
  const head = note ? `${note}\n\n` : '';
  if (page === 'send') {
    const rows = [
      row({ type: 8, custom_id: 'as:defch', placeholder: '送信先の初期チャンネルを選ぶ', channel_types: CHANNEL_TYPES, min_values: 0, max_values: 1, default_values: s.defaultChannel ? [{ id: s.defaultChannel, type: 'channel' }] : [] }),
      row({ type: 3, custom_id: 'as:mode', placeholder: '送れる人', options: SEND_MODES.map(([value, label, description]) => ({ value, label, description, default: s.sendMode === value })) }),
    ];
    if (s.sendMode === 'roles') rows.push(row({ type: 6, custom_id: 'as:sroles', placeholder: '送れるロールを選ぶ（複数可）', min_values: 0, max_values: 25, default_values: s.sendRoles.map((id) => ({ id, type: 'role' })) }));
    if (s.sendMode === 'users') rows.push(row({ type: 5, custom_id: 'as:susers', placeholder: '送れる人を選ぶ（複数可）', min_values: 0, max_values: 25, default_values: s.sendUsers.map((id) => ({ id, type: 'user' })) }));
    rows.push(backRow());
    return { content: `${head}**📤 送信の設定**\n初期チャンネル：${chM(s.defaultChannel)}\n送れる人：${senderText(s)}`, components: rows };
  }
  if (page === 'admins') {
    return {
      content: `${head}**👑 管理者の設定**\nサーバーの管理者権限を持つ人のほかに、このメニューを使える人を選びます。\nロール：${list(s.adminRoles, roleM)}\nアカウント：${list(s.adminUsers, userM)}`,
      components: [
        row({ type: 6, custom_id: 'as:aroles', placeholder: '管理メニューを使えるロール（複数可）', min_values: 0, max_values: 25, default_values: s.adminRoles.map((id) => ({ id, type: 'role' })) }),
        row({ type: 5, custom_id: 'as:ausers', placeholder: '管理メニューを使える人（複数可）', min_values: 0, max_values: 25, default_values: s.adminUsers.map((id) => ({ id, type: 'user' })) }),
        backRow(),
      ],
    };
  }
  if (page === 'pass') {
    return {
      content: `${head}**🔑 パスワードと記録**\nパスワード：${s.pw ? '設定済み' : '未設定（パスワードでは開けません）'}\nパスワードで開かれたときの通知先：${s.notifyChannel ? chM(s.notifyChannel) : 'なし'}`,
      components: [
        row(btn('as:pw', s.pw ? 'パスワードを変更' : 'パスワードを設定', 1), btn('as:pwoff', 'パスワードをなくす', 4, { disabled: !s.pw }), btn('as:page:log', '記録を見る')),
        row({ type: 8, custom_id: 'as:notify', placeholder: '通知先のチャンネルを選ぶ（選ばなければ通知しない）', channel_types: CHANNEL_TYPES, min_values: 0, max_values: 1, default_values: s.notifyChannel ? [{ id: s.notifyChannel, type: 'channel' }] : [] }),
        backRow(),
      ],
    };
  }
  if (page === 'log') {
    const lines = s.log.length
      ? s.log.map((l) => `・${jst(l.at)}　${userM(l.uid)}（${l.name || '名前不明'}）${l.kind === 'lock' ? `が ${LOCK_TRIES} 回間違えたため ${LOCK_MIN} 分間ロック` : 'がパスワードで開きました'}`).join('\n')
      : 'まだ記録はありません。';
    return { content: `${head}**📜 パスワードで開いた記録**（新しい順・最大 20 件）\n${lines}`, components: [row(btn('as:page:pass', '← 戻る'))] };
  }
  if (page === 'help') return { content: ADMIN_HELP, components: [backRow()] };
  return {
    content: [
      head + '**⚙️ 地図の管理メニュー**（このサーバーの設定・自分にだけ見えます）',
      `お絵かきページからの送信：${s.enabled ? '✅ 有効' : '⛔ 止めています'}`,
      `送信先の初期チャンネル：${chM(s.defaultChannel)}`,
      `送れる人：${senderText(s)}`,
      `管理メニューを使える人：サーバー管理者${s.adminRoles.length ? `、${list(s.adminRoles, roleM)}` : ''}${s.adminUsers.length ? `、${list(s.adminUsers, userM)}` : ''}`,
      `パスワード：${s.pw ? '設定済み' : '未設定'}`,
    ].join('\n'),
    components: [
      row(
        s.enabled ? btn('as:toggle', '送信を止める', 4) : btn('as:toggle', '送信を有効にする', 3),
        btn('as:page:send', '📤 送信の設定'),
        btn('as:page:admins', '👑 管理者の設定'),
        btn('as:page:pass', '🔑 パスワード・記録'),
        btn('as:page:help', '❓ 説明'),
      ),
    ],
  };
}

const pwModal = () => ({
  type: 9,
  data: {
    custom_id: 'as:pwmodal',
    title: 'パスワードの設定',
    components: [
      row({ type: 4, custom_id: 'pw', label: '新しいパスワード（4〜64文字）', style: 1, min_length: 4, max_length: 64, required: true }),
      row({ type: 4, custom_id: 'pw2', label: '確認のため、もう一度', style: 1, min_length: 4, max_length: 64, required: true }),
    ],
  },
});

/** 管理メニューを操作してよいか（権限がある、またはパスワードで開いてから時間内） */
async function adminAllowed(env, s, interaction) {
  const member = interaction.member || {};
  if (isAdminMember(s, member, memberPerms(interaction))) return true;
  return !!(await env.SETTINGS.get(`grant:${interaction.guild_id}:${userOf(interaction).id}`));
}

async function openAdmin(env, interaction) {
  if (!interaction.guild_id) return eph({ content: 'このコマンドはサーバーの中で使ってください。' });
  if (!env.SETTINGS) return eph({ content: '管理メニューを使うには、Cloudflare の Worker に KV（SETTINGS）を設定してください。' });
  const gid = interaction.guild_id;
  const u = userOf(interaction);
  const s = await getSettings(env, gid);
  if (isAdminMember(s, interaction.member || {}, memberPerms(interaction))) return eph(adminPage(s, 'main'));

  const pw = String(optionValue(interaction.data, 'password') ?? '');
  if (!pw || !s.pw) return eph({ content: NO_PERMISSION });
  const lockKey = `lock:${gid}:${u.id}`;
  const lock = (await env.SETTINGS.get(lockKey, 'json')) || { n: 0, until: 0 };
  if (lock.until > Date.now()) return eph({ content: `${NO_PERMISSION}\nパスワードを続けて間違えたため、${Math.ceil((lock.until - Date.now()) / 60000)} 分ほどたってからもう一度お試しください。` });
  if (!(await checkPassword(pw, s.pw))) {
    lock.n += 1;
    if (lock.n >= LOCK_TRIES) {
      lock.n = 0;
      lock.until = Date.now() + LOCK_MIN * 60_000;
      s.log = [{ at: Date.now(), uid: u.id, name: nameOf(u), kind: 'lock' }, ...s.log].slice(0, 20);
      await putSettings(env, gid, s);
      await notify(env, s, `⚠ ${userM(u.id)}（${nameOf(u)}）さんが /地図設定 のパスワードを ${LOCK_TRIES} 回続けて間違えたため、${LOCK_MIN} 分間開けないようにしました。`);
    }
    await env.SETTINGS.put(lockKey, JSON.stringify(lock), { expirationTtl: (LOCK_MIN + 5) * 60 });
    const left = lock.until > Date.now() ? `${LOCK_MIN} 分間は開けません。` : `あと ${LOCK_TRIES - lock.n} 回間違えると、${LOCK_MIN} 分間開けなくなります。`;
    return eph({ content: `${NO_PERMISSION}\nパスワードが違います。${left}` });
  }
  await env.SETTINGS.delete(lockKey);
  await env.SETTINGS.put(`grant:${gid}:${u.id}`, '1', { expirationTtl: GRANT_MIN * 60 });
  s.log = [{ at: Date.now(), uid: u.id, name: nameOf(u), kind: 'open' }, ...s.log].slice(0, 20);
  await putSettings(env, gid, s);
  await notify(env, s, `🔑 ${userM(u.id)}（${nameOf(u)}）さんが、パスワードで /地図設定 を開きました。`);
  return eph(adminPage(s, 'main', `🔑 パスワードで開きました（${GRANT_MIN} 分間操作できます）。`));
}

const update = (data) => json({ type: 7, data: { allowed_mentions: { parse: [] }, ...data } });

async function adminComponent(env, interaction) {
  if (!env.SETTINGS) return eph({ content: 'KV（SETTINGS）が設定されていません。' });
  const gid = interaction.guild_id;
  const s = await getSettings(env, gid);
  if (!(await adminAllowed(env, s, interaction))) return eph({ content: `${NO_PERMISSION}\nもう一度 /地図設定 を開いてください。` });
  const id = interaction.data.custom_id;
  const values = interaction.data.values || [];
  const save = async (page, note) => { await putSettings(env, gid, s); return update(adminPage(s, page, note)); };

  if (id.startsWith('as:page:')) return update(adminPage(s, id.slice(8)));
  if (id === 'as:toggle') { s.enabled = !s.enabled; return save('main', s.enabled ? '✅ お絵かきページからの送信を有効にしました。' : '⛔ お絵かきページからの送信を止めました。'); }
  if (id === 'as:defch') { s.defaultChannel = values[0] || ''; return save('send', '✅ 初期チャンネルを変更しました。'); }
  if (id === 'as:mode') { s.sendMode = SEND_MODES.some(([v]) => v === values[0]) ? values[0] : 'admins'; return save('send', '✅ 送れる人を変更しました。'); }
  if (id === 'as:sroles') { s.sendRoles = values; return save('send', '✅ 送れるロールを変更しました。'); }
  if (id === 'as:susers') { s.sendUsers = values; return save('send', '✅ 送れる人を変更しました。'); }
  if (id === 'as:aroles') { s.adminRoles = values; return save('admins', '✅ 管理メニューを使えるロールを変更しました。'); }
  if (id === 'as:ausers') { s.adminUsers = values; return save('admins', '✅ 管理メニューを使える人を変更しました。'); }
  if (id === 'as:notify') { s.notifyChannel = values[0] || ''; return save('pass', '✅ 通知先を変更しました。'); }
  if (id === 'as:pw') return json(pwModal());
  if (id === 'as:pwoff') { s.pw = null; return save('pass', '✅ パスワードをなくしました。パスワードでは開けなくなります。'); }
  return update(adminPage(s, 'main'));
}

async function adminModal(env, interaction) {
  const gid = interaction.guild_id;
  const s = await getSettings(env, gid);
  if (!(await adminAllowed(env, s, interaction))) return eph({ content: NO_PERMISSION });
  const field = (cid) => {
    for (const r of interaction.data.components || []) {
      for (const c of r.components || [r.component].filter(Boolean)) if (c.custom_id === cid) return String(c.value || '');
    }
    return '';
  };
  const pw = field('pw'), pw2 = field('pw2');
  if (pw !== pw2) return update(adminPage(s, 'pass', '⚠ 2 つの入力が違っていたため、パスワードは変更していません。'));
  if (pw.length < 4) return update(adminPage(s, 'pass', '⚠ パスワードは 4 文字以上にしてください。'));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  s.pw = { salt: b64u(salt), hash: b64u(await hashPassword(pw, salt)), iter: PW_ITER };
  await putSettings(env, gid, s);
  return update(adminPage(s, 'pass', '✅ パスワードを設定しました。'));
}

// 「考え中…」の返事（自分だけなら、ほかの人には見えない）
const deferred = (priv) => json({ type: 5, data: { flags: priv ? 64 : 0 } });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // お絵かきページから（ログイン・送り先の一覧・送信）
    if (url.pathname === '/oauth/login') return oauthLogin(env, url);
    if (url.pathname === '/oauth/callback') return oauthCallback(env, url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return cors(env, request, await handleApi(env, request, url));
      } catch (e) {
        console.error(e);
        return cors(env, request, apiError('server_error', { message: String(e.message || e) }, 500));
      }
    }
    if (request.method === 'GET') return new Response('筒ビューア Discord 連携は動いています。', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

    const body = await request.text();
    if (!(await verify(request, body, env.DISCORD_PUBLIC_KEY))) return new Response('Bad signature', { status: 401 });
    const interaction = JSON.parse(body);

    if (interaction.type === 1) return json({ type: 1 }); // PING

    try {
      // /地図設定（管理メニュー）は地図のデータを使わないので先に
      if (interaction.type === 2 && interaction.data?.name === 'mapsettings') return await openAdmin(env, interaction);
      if (interaction.type === 3 && String(interaction.data?.custom_id || '').startsWith('as:')) return await adminComponent(env, interaction);
      if (interaction.type === 5 && interaction.data?.custom_id === 'as:pwmodal') return await adminModal(env, interaction);

      const data = await loadData(env);

      if (interaction.type === 2 && interaction.data?.name === 'map') {
        const topic = optionValue(interaction.data, 'help');
        // /地図 使い方 → ヘルプ（自分にだけ見える）
        if (topic) return json({ type: 4, data: helpMessage(env, data, topic) });
        // /地図 → 選択メニュー（自分にだけ見える）
        const v = data.versions[0];
        return json({ type: 4, data: menu(data, { v, sel: defaultIndexes(v.config), ops: {}, sets: [], priv: false }) });
      }

      if (interaction.type === 5 && interaction.data?.custom_id === 'opmodal') { // 透明度の入力
        const st = readState(data, interaction);
        const comp = interaction.data.components?.[0];
        const text = comp?.components?.[0]?.value ?? comp?.component?.value ?? '';
        const op = parseOpacity(st.v.config, text);
        const layers = st.v.config.layers || [];
        for (const [n, val] of Object.entries(op.values)) st.ops[layers.findIndex((l) => l.name === n)] = val;
        const m = menu(data, st);
        if (op.unknown.length) m.content = `⚠ 見つからないレイヤー名がありました：${op.unknown.join('、')}\n\n${m.content}`;
        return json({ type: 7, data: m });
      }

      if (interaction.type === 3) { // 選択メニューの操作
        const id = interaction.data?.custom_id || '';
        // ヘルプの操作
        if (id === 'help') return json({ type: 7, data: helpMessage(env, data, interaction.data.values?.[0]) });
        if (id.startsWith('help:')) return json({ type: 4, data: helpMessage(env, data, id.slice(5)) });  // メニューから新しく開く
        if (id === 'openmenu') {
          const v = data.versions[0];
          return json({ type: 4, data: menu(data, { v, sel: defaultIndexes(v.config), ops: {}, sets: [], priv: false }) });
        }
        // 以前のメニューの操作には、新しいメニューを出し直す
        if (/^(make:|pick:|date:|all:|def:|preset:)/.test(id)) {
          const v = versionByKey(data, id.split(':')[1]);
          return json({ type: 7, data: menu(data, { v, sel: defaultIndexes(v.config), ops: {}, sets: [], priv: false }) });
        }
        const st = readState(data, interaction);
        const layers = st.v.config.layers || [];
        if (id === 'date') {
          // 日付を変えたら、同じ名前のレイヤーの選択・透明度・組み合わせを引き継ぐ
          const nv = versionByKey(data, interaction.data.values?.[0]);
          const map = (idx) => namesOf(st.v, idx).map((n) => (nv.config.layers || []).findIndex((l) => l.name === n)).filter((i) => i >= 0);
          const ops = {};
          for (const [i, val] of Object.entries(st.ops)) {
            const j = (nv.config.layers || []).findIndex((l) => l.name === layers[i]?.name);
            if (j >= 0) ops[j] = val;
          }
          // 取っておいた組み合わせは、それぞれの日付のまま
          return json({ type: 7, data: menu(data, { ...st, v: nv, sel: map(st.sel), ops }) });
        }
        if (id === 'pick') return json({ type: 7, data: menu(data, { ...st, sel: (interaction.data.values || []).map(Number) }) });
        if (id === 'all') return json({ type: 7, data: menu(data, { ...st, sel: layers.map((_, i) => i) }) });
        if (id === 'def') return json({ type: 7, data: menu(data, { ...st, sel: defaultIndexes(st.v.config) }) });
        if (id === 'add' || id.startsWith('add:')) {
          const cur = { v: st.v, idx: [...st.sel].sort((a, b) => a - b) };
          const sets = st.sets.some((s) => sameEntry(s, cur)) ? st.sets : [...st.sets, cur];
          return json({ type: 7, data: menu(data, { ...st, sets }) });
        }
        if (id === 'sets') {  // 選んだ組み合わせを外す
          const drop = new Set((interaction.data.values || []).map((x) => Number(String(x).split('|')[0])));
          return json({ type: 7, data: menu(data, { ...st, sets: st.sets.filter((_, i) => !drop.has(i)) }) });
        }
        if (id === 'clear') return json({ type: 7, data: menu(data, { ...st, sets: [] }) });
        if (id.startsWith('priv:')) return json({ type: 7, data: menu(data, { ...st, priv: !st.priv }) });
        if (id.startsWith('op:')) return json(opacityModal(st));
        if (id === 'make') {
          const list = setsToSend(st);
          if (list.every((s) => !s.idx.length) && !st.v.config.base?.src) return ephemeral('表示するレイヤーがありません。');
          const opacity = Object.fromEntries(Object.entries(st.ops).map(([i, val]) => [layers[i]?.name, val]).filter(([n]) => n));
          const who = whoName(interaction);
          ctx.waitUntil(startRender(env, interaction, {
            sets: list.map((s) => ({ names: namesOf(s.v, s.idx), date: s.v.date ? s.v.key : '' })),
            opacity,
            label: who ? `${who} さんの選択` : '選択メニュー',
            priv: st.priv,
          }));
          // メニューはそのまま残し、地図は新しい投稿として送る
          return deferred(st.priv);
        }
      }
    } catch (e) {
      console.error(e);
      return ephemeral(`エラーが発生しました: ${e.message}`);
    }
    return ephemeral('このコマンドには対応していません。');
  },
};
