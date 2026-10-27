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

/** 「10/26 14:30」のような時刻付きの入力を { date, time } に */
function parseWhen(text, fallbackYear) {
  const t = String(text || '').trim().replace(/[０-９：]/g, (c) => (c === '：' ? ':' : String.fromCharCode(c.charCodeAt(0) - 0xfee0)));
  const m = /^(.*?)[\sT]+(\d{1,2}):(\d{2})$/.exec(t);
  const date = parseDate(m ? m[1] : t, fallbackYear);
  return date ? { date, time: m ? `${pad(m[2])}:${m[3]}` : '' } : null;
}

/** 「2026-10-26」「2026/10/26」「10/26」「10月26日」「20261026」を YYYY-MM-DD に */
function parseDate(text, fallbackYear) {
  const t = String(text || '').trim().replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/[／．.]/g, '/');
  let m;
  if ((m = /^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?(（.*）|\(.*\))?$/.exec(t))) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(t))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = /^(\d{1,2})[/月](\d{1,2})日?$/.exec(t))) return `${fallbackYear}-${pad(m[1])}-${pad(m[2])}`;
  return null;
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

/**
 * 入力から版を選ぶ。記録の ID（入力候補から選んだとき）、または日付（時刻付きも可）。
 * 日付だけなら、その日のいちばん新しい記録。記録のない日付なら、その時点で最も新しい記録
 */
function resolveDate(data, input) {
  const text = String(input || '').trim();
  if (!text || ['最新', 'latest', '今'].includes(text.toLowerCase())) return { v: data.versions[0] };
  const byId = data.versions.find((v) => v.date && v.key === text);
  if (byId) return { v: byId };
  const year = (data.versions[1]?.date || todayJst()).slice(0, 4);
  const want = parseWhen(text, year);
  if (!want) return { error: `日付「${text}」を読み取れませんでした。2026-10-26 や 10/26、10/26 14:30 のように入力してください。` };
  const limit = `${want.date} ${want.time || '99:99'}`;
  const dated = data.versions.map((v) => ({ v, k: `${vDate(v)} ${vTime(v) || (v.date ? '' : '99:98')}` }));
  const hit = dated.filter((x) => x.k <= limit).sort((a, b) => b.k.localeCompare(a.k))[0];
  if (!hit) {
    const o = [...data.versions].sort((a, b) => `${vDate(a)} ${vTime(a)}`.localeCompare(`${vDate(b)} ${vTime(b)}`))[0];
    return { error: `${longDate(want.date, want.time)}より前の記録はありません（いちばん古い記録は${longDate(vDate(o), vTime(o))}です）。` };
  }
  const exact = vDate(hit.v) === want.date && (!want.time || vTime(hit.v) === want.time);
  const note = exact ? '' : `${longDate(want.date, want.time)}の時点の地図として、${hit.v.date ? longDate(hit.v.date, hit.v.time) : '最新'}の記録を使います。`;
  return { v: hit.v, note };
}

const splitNames = (s) => String(s || '').split(/[\s,、，・]+/).map((x) => x.trim()).filter(Boolean);
// 「白地 国家 | 地形 国名」のように、組み合わせを | で区切る（/ は日付に使うので区切りにしない）
const SET_SEP = /[|｜;；]/;
const splitSets = (s) => String(s || '').split(SET_SEP).map((x) => x.trim());
const optionValue = (data, name) => (data.options || []).find((o) => o.name === name)?.value;

const MAX_SETS = 10;  // Discord の 1 投稿に付けられる画像の数
const OPACITY_GUIDE = '100＝そのまま（下は見えない）／75＝少し透ける／50＝半分透けて下も同じくらい見える／25＝うっすら（下が中心）／0＝見えない';

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

const choicesResponse = (choices) => json({ type: 8, data: { choices: choices.slice(0, 25) } });

function layerChoices(config, input) {
  const names = (config.layers || []).map((l) => l.name);
  const full = String(input || '');
  // 組み合わせが | で区切られていたら、最後の組み合わせだけを補う
  const cut = Math.max(...[...full.matchAll(new RegExp(SET_SEP.source, 'g'))].map((m) => m.index), -1);
  const head = cut >= 0 ? `${full.slice(0, cut + 1).trimEnd()} ` : '';
  const text = full.slice(cut + 1).replace(/^\s+/, '');
  const words = splitNames(text);
  const endsWithSpace = /[\s,、，・]$/.test(text);
  const done = endsWithSpace ? words : words.slice(0, -1);
  const partial = endsWithSpace ? '' : words[words.length - 1] || '';
  const prefix = `${head}${done.length ? `${done.join(' ')} ` : ''}`;
  const choices = [];
  if (!done.length && ALL_WORDS.some((w) => w.startsWith(partial))) choices.push({ name: `${head}すべてのレイヤー`, value: `${head}すべて` });
  for (const n of names) {
    if (done.includes(n) || (partial && !n.includes(partial))) continue;
    const value = `${prefix}${n}`;
    if (value.length <= 100) choices.push({ name: value, value });
  }
  // 入力がすでに完全なレイヤー名なら、そのまま確定できる候補と、次の組み合わせに進む候補も出す
  if (words.length && words.every((w) => names.includes(w))) {
    const cur = `${head}${words.join(' ')}`;
    if (!choices.some((c) => c.value === cur)) choices.unshift({ name: cur, value: cur });
    if (`${cur} | `.length <= 100) choices.splice(1, 0, { name: `${cur} | （次の画像のレイヤーを入力）`, value: `${cur} | ` });
  }
  return choices;
}

function opacityChoices(config, input) {
  const text = String(input || '');
  const names = (config.layers || []).map((l) => l.name);
  const lastWord = splitNames(text).pop() || '';
  const choices = [];
  // 最後に打ったのがレイヤー名なら、透明度の目安を候補にする
  if (names.includes(lastWord) && !/\d\s*%?\s*$/.test(text)) {
    for (const [v, d] of [[75, '少し透ける'], [50, '半分透ける'], [25, 'うっすら'], [0, '見えない'], [100, 'そのまま']]) {
      const value = `${text.trimEnd()} ${v}`;
      if (value.length <= 100) choices.push({ name: `${value}（${d}）`, value });
    }
    return choices;
  }
  const prefix = text.trim() ? `${text.trimEnd()} ` : '';
  for (const n of names) {
    const value = `${prefix}${n}`;
    if (value.length <= 100 && !splitNames(text).includes(n)) choices.push({ name: `${value} …（このあとに 0〜100 の数字）`, value });
  }
  return choices;
}

function dateChoices(data, input) {
  const text = String(input || '').trim();
  const parsed = parseDate(text, (data.versions[1]?.date || todayJst()).slice(0, 4));
  const all = data.versions.map((v) => {
    const d = v.date || v.since;
    const m = ymdRe.exec(d || '');
    return {
      name: (v.date ? `${longDate(v.date, v.time)}${v.memo ? `・${v.memo}` : ''}` : `最新の地図${v.since ? `（${longDate(v.since, v.sinceTime)}）` : ''}${v.memo ? `・${v.memo}` : ''}`).slice(0, 100),
      value: v.date ? v.key : '最新',
      // 「10/26」「1026」のような打ち方でも見つかるように
      keys: m ? [d, d.replace(/-/g, '/'), `${+m[2]}/${+m[3]}`, `${m[2]}${m[3]}`, `${+m[2]}月${+m[3]}日`] : [],
    };
  });
  const out = (list) => list.map(({ name, value }) => ({ name, value }));
  if (!text) return out(all);
  const t = text.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  const hits = all.filter((c) => c.name.includes(t) || c.value.includes(t) || c.keys.some((k) => k.startsWith(t) || k.includes(t)) || (parsed && c.value === parsed));
  // 一覧にない日付も入力できるようにする（その日の時点の地図になる）。いちばん古い記録より前は出さない
  const oldest = all.map((c) => c.keys[0]).filter(Boolean).sort()[0] || '';
  if (parsed && parsed >= oldest && !hits.some((c) => c.keys[0] === parsed)) hits.push({ name: `${longDate(parsed)}の時点の地図`, value: parsed });
  return out(hits);
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

// 「考え中…」の返事（自分だけなら、ほかの人には見えない）
const deferred = (priv) => json({ type: 5, data: { flags: priv ? 64 : 0 } });

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'GET') return new Response('筒ビューア Discord 連携は動いています。', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

    const body = await request.text();
    if (!(await verify(request, body, env.DISCORD_PUBLIC_KEY))) return new Response('Bad signature', { status: 401 });
    const interaction = JSON.parse(body);

    if (interaction.type === 1) return json({ type: 1 }); // PING

    try {
      const data = await loadData(env);

      if (interaction.type === 4) { // 入力候補
        const focused = (interaction.data.options || []).find((o) => o.focused)?.name;
        if (focused === 'date') return choicesResponse(dateChoices(data, optionValue(interaction.data, 'date')));
        const r = resolveDate(data, optionValue(interaction.data, 'date'));
        const config = (r.v || data.versions[0]).config;
        if (focused === 'opacity') return choicesResponse(opacityChoices(config, optionValue(interaction.data, 'opacity')));
        return choicesResponse(layerChoices(config, optionValue(interaction.data, focused || 'layers')));
      }

      if (interaction.type === 2 && interaction.data?.name === 'map') { // /地図
        const d = resolveDate(data, optionValue(interaction.data, 'date'));
        if (d.error) return ephemeral(d.error);
        const { v } = d;
        const priv = optionValue(interaction.data, 'private') === true;
        const op = parseOpacity(v.config, optionValue(interaction.data, 'opacity'));
        if (op.unknown.length) return ephemeral(`透明度：レイヤー ${op.unknown.map((u) => `「${u}」`).join('')} が見つかりません。\n書き方の例：国家 50 海域 30\n目安：${OPACITY_GUIDE}`);
        // 「レイヤー」と「画像2」〜「画像10」の欄（どの欄も | で区切って複数枚にできる）
        const typed = ['layers', ...Array.from({ length: MAX_SETS - 1 }, (_, i) => `layers${i + 2}`)]
          .map((n) => String(optionValue(interaction.data, n) || '').trim())
          .filter(Boolean)
          .join(' | ');
        // レイヤーを打たなかったときは選択メニューを出す（自分にだけ見える）
        if (!splitNames(typed.replace(SET_SEP, ' ')).length) {
          const layers = v.config.layers || [];
          const ops = Object.fromEntries(Object.entries(op.values).map(([n, val]) => [layers.findIndex((l) => l.name === n), val]));
          const m = menu(data, { v, sel: defaultIndexes(v.config), ops, sets: [], priv });
          if (d.note) m.content = `${d.note}\n\n${m.content}`;
          return json({ type: 4, data: m });
        }
        const parts = splitSets(typed).filter((p) => splitNames(p).length);
        if (parts.length > MAX_SETS) return ephemeral(`一度に送れる地図は ${MAX_SETS} 枚までです。`);
        const sets = [];
        let label = '';
        for (const p of parts) {
          // 組み合わせごとに「@10/26」で日付を変えられる
          const at = p.match(/[@＠]\s*([^\s|｜]+(?:\s+\d{1,2}[:：]\d{2})?)/);
          let pv = v;
          if (at) {
            const r2 = resolveDate(data, at[1]);
            if (r2.error) return ephemeral(r2.error);
            pv = r2.v;
          }
          const words = at ? p.replace(at[0], ' ') : p;
          const r = resolveLayers(pv.config, words);
          if (r.unknown) {
            const list = (pv.config.layers || []).map((l) => `「${l.name}」`).join(' ');
            return ephemeral(`${pv.date ? `${vName(pv)}の地図に` : ''}レイヤー ${r.unknown.map((u) => `「${u}」`).join('')} が見つかりません。\n使えるレイヤー: ${list}`);
          }
          sets.push({ names: r.names, date: pv.date ? pv.key : '' });
          label = r.label;
        }
        if (sets.every((s) => !s.names.length) && !v.config.base?.src) return ephemeral('表示するレイヤーがありません。');
        ctx.waitUntil(startRender(env, interaction, { sets, opacity: op.values, label: sets.length === 1 ? label : '', priv }));
        return deferred(priv); // 考え中…（Actions が完成した地図に差し替える）
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
