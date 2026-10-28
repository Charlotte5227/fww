// お絵かきページ：Discord に送る
//
// Discord でログイン（Worker 経由）→ 送り先のチャンネルを選ぶ → 画像を Worker に渡して送ってもらう。
// ログインの情報（Worker が暗号化したもの）は、このブラウザの localStorage にだけ保存する。

const $ = (s, el = document) => el.querySelector(s);
const LIMIT = 9.5 * 1024 * 1024;  // Discord に送れる大きさ（10MB）より少し小さく
const COOLDOWN = 30;

const ERRORS = {
  login_required: 'ログインし直してください。',
  session_expired: 'ログインの有効期限が切れました。もう一度ログインしてください。',
  rate_limited: (e) => `続けて送るには、あと ${e.wait} 秒待ってください。`,
  bad_channel: 'チャンネル ID が正しくありません（数字だけの長い番号です）。',
  bad_channel_type: 'そのチャンネルには送れません。テキストチャンネルを選んでください。',
  bot_no_access: 'Bot がそのサーバーにいないか、そのチャンネルを見られません。',
  not_member: 'そのサーバーに参加していないため、送れません。',
  disabled: 'そのサーバーでは、お絵かきページからの送信が許可されていません。',
  not_allowed: 'そのサーバーで送れる人に含まれていません。',
  no_permission: 'そのチャンネルに書き込む権限がありません。',
  bot_no_permission: 'Bot にそのチャンネルへ書き込む権限（メッセージの送信・ファイルの添付）がありません。',
  too_large: '画像が大きすぎて送れませんでした。',
  discord_busy: (e) => `Discord が混み合っています。${e.wait || 30} 秒ほど待ってから、もう一度お試しください。`,
  not_configured: 'Discord 連携の設定がまだ終わっていません。管理している人に伝えてください。',
  origin_not_allowed: 'このページからの送信が許可されていません（Worker の SITE_URL の設定を確認してください）。',
  discord_error: (e) => `Discord でエラーが発生しました（${e.status || '不明'}）。時間をおいてお試しください。`,
  server_error: 'Worker でエラーが発生しました。時間をおいてお試しください。',
  bad_request: '画像を送れませんでした。もう一度お試しください。',
};
const REASONS = {
  disabled: '送信が許可されていません',
  not_allowed: '送れる人に含まれていません',
  no_channel: '送れるチャンネルがありません',
  not_member: '参加していません',
  bot_no_access: 'Bot が見られません',
};

const errorText = (e) => {
  const m = ERRORS[e?.error];
  return typeof m === 'function' ? m(e) : m || `送れませんでした（${e?.error || '不明なエラー'}）。`;
};

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 保存できなくても続ける */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* なし */ } },
};

/**
 * @param {object} o
 * @param {string} o.worker  Worker の URL
 * @param {(kind:string, layerId?:string) => Promise<{canvas?:HTMLCanvasElement, blob?:Blob}>} o.makeImage
 * @param {() => {id:string,name:string}[]} o.layers  送れるレイヤー（手前から）
 * @param {() => boolean} o.isFlat
 * @param {() => Promise<void>} o.beforeLeave  ログインでページを離れる前（自動保存を済ませる）
 * @param {(id:string, btn:string) => void} o.open
 * @param {(text:string, opts?:object) => void} o.toast
 */
export function createDiscord(o) {
  const worker = o.worker.replace(/\/+$/, '');
  const KEY = `draw-discord:${worker}`;
  const panel = $('#discordPanel');
  const els = {
    login: $('#dcLogin'), main: $('#dcMain'), user: $('#dcUser'), loginBtn: $('#dcLoginBtn'),
    kind: $('#dcKind'), layer: $('#dcLayer'), target: $('#dcTarget'), reload: $('#dcReload'),
    channelId: $('#dcChannelId'), msg: $('#dcMsg'), send: $('#dcSend'),
  };
  let session = store.get(KEY);
  let kind = 'full';
  let targets = null;
  let sending = false;
  let cooldownTimer = 0;

  const loggedIn = () => session && session.s && session.exp > Date.now();

  function msg(text, cls = '') {
    els.msg.className = `dc-msg ${cls}`.trim();
    els.msg.textContent = '';
    if (text instanceof Node) els.msg.append(text); else els.msg.textContent = text || '';
  }

  /* ---------- ログイン ---------- */

  // ログインから戻ってきたとき（URL の # の後ろに結果が付いてくる）
  function readReturn() {
    const h = new URLSearchParams(location.hash.slice(1));
    let reopen = false;
    if (h.has('dlogin')) {
      session = { s: h.get('dlogin'), id: h.get('did'), name: h.get('dname'), exp: Number(h.get('dexp')) || Date.now() + 6 * 86400_000 };
      store.set(KEY, session);
      reopen = true;
    } else if (h.has('dlogin-error')) {
      reopen = true;
      const text = h.get('dlogin-error') === 'denied' ? 'Discord へのログインを取りやめました' : 'Discord にログインできませんでした。もう一度お試しください';
      setTimeout(() => o.toast(text, { error: true }), 300);
    }
    if (h.has('dlogin') || h.has('dlogin-error')) history.replaceState(null, '', location.pathname + location.search);
    return reopen;
  }

  async function login() {
    els.loginBtn.disabled = true;
    try { await o.beforeLeave(); } catch { /* 保存に失敗しても、ログインは続ける */ }
    location.href = `${worker}/oauth/login?return=${encodeURIComponent(location.origin + location.pathname)}`;
  }

  function logout() {
    session = null;
    targets = null;
    store.del(KEY);
    render();
  }

  /* ---------- 送り先 ---------- */

  async function api(path, init = {}) {
    let res;
    try {
      res = await fetch(`${worker}${path}`, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${session.s}` } });
    } catch {
      return { ok: false, error: 'network' };
    }
    const data = await res.json().catch(() => ({ ok: false, error: 'server_error' }));
    if (res.status === 401) { logout(); data.error = data.error === 'session_expired' ? data.error : 'session_expired'; }
    return data;
  }

  async function loadTargets() {
    els.target.replaceChildren(new Option('読み込み中…', ''));
    els.target.disabled = true;
    msg('');
    const r = await api('/api/targets');
    els.target.disabled = false;
    if (!r.ok) {
      targets = null;
      if (!loggedIn()) { render(); msg(errorText(r), 'is-error'); return; }
      els.target.replaceChildren(new Option('読み込めませんでした', ''));
      msg(r.error === 'network' ? 'Worker に接続できませんでした。通信状態を確認してください。' : errorText(r), 'is-error');
      fillManual();
      return;
    }
    targets = r.guilds;
    fillTargets();
  }

  function fillTargets() {
    const sel = els.target;
    sel.replaceChildren();
    const last = store.get(`${KEY}:last`);
    let pick = '';
    for (const g of targets || []) {
      const og = document.createElement('optgroup');
      og.label = g.ok ? g.name : `${g.name}（${REASONS[g.reason] || '送れません'}）`;
      if (g.ok) {
        for (const c of g.channels) {
          const op = new Option(`${c.category ? `${c.category} / ` : ''}#${c.name}`, c.id);
          og.append(op);
          if (c.id === last) pick = c.id;
          if (!pick && c.id === g.defaultChannel) pick = c.id;
        }
      } else {
        const op = new Option(REASONS[g.reason] || '送れません', '');
        op.disabled = true;
        og.append(op);
      }
      sel.append(og);
    }
    if (!targets?.some((g) => g.ok)) {
      sel.prepend(new Option(targets?.length ? '送れるサーバーがありません' : 'Bot のいるサーバーに参加していません', ''));
    }
    fillManual();
    if (!pick) pick = targets?.find((g) => g.ok)?.channels[0]?.id || '';
    sel.value = pick || (last === 'manual' ? 'manual' : sel.options[0]?.value || '');
    onTarget();
  }

  function fillManual() {
    const og = document.createElement('optgroup');
    og.label = 'そのほか';
    og.append(new Option('チャンネル ID を入力する…', 'manual'));
    els.target.append(og);
  }

  function onTarget() {
    const manual = els.target.value === 'manual';
    els.channelId.hidden = !manual;
    if (manual) {
      const saved = store.get(`${KEY}:manualId`);
      if (saved && !els.channelId.value) els.channelId.value = saved;
    }
    updateSend();
  }

  const channelId = () => (els.target.value === 'manual' ? els.channelId.value.trim() : els.target.value);

  /* ---------- 画像の種類 ---------- */

  function setKind(k) {
    kind = k;
    els.kind.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.kind === k)));
    els.layer.hidden = k !== 'layer';
    if (k === 'layer') {
      const cur = els.layer.value;
      els.layer.replaceChildren(...o.layers().map((l) => new Option(l.name, l.id)));
      if (cur) els.layer.value = cur;
    }
    updateSend();
  }

  /** 送れる大きさに収める（大きすぎるときは少しずつ縮める） */
  async function fit(canvas) {
    let c = canvas;
    let scale = 1;
    for (;;) {
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      if (!blob) throw new Error('画像を作れませんでした');
      if (blob.size <= LIMIT || c.width < 64) {
        if (c !== canvas) c.width = c.height = 0;
        return { blob, scale };
      }
      scale *= 0.8;
      const n = document.createElement('canvas');
      n.width = Math.max(1, Math.round(canvas.width * scale));
      n.height = Math.max(1, Math.round(canvas.height * scale));
      const ctx = n.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(canvas, 0, 0, n.width, n.height);
      if (c !== canvas) c.width = c.height = 0;
      c = n;
    }
  }

  /* ---------- 送る ---------- */

  function cooldownLeft() {
    const until = store.get(`${KEY}:until`) || 0;
    return Math.max(0, Math.ceil((until - Date.now()) / 1000));
  }

  function updateSend() {
    const left = cooldownLeft();
    const id = channelId();
    const viewNg = kind === 'view' && !o.isFlat();
    els.send.disabled = sending || left > 0 || !id || viewNg;
    els.send.textContent = sending ? '送信中…' : left > 0 ? `あと ${left} 秒で送れます` : '送信';
    if (viewNg && !sending) msg('「表示範囲」は平面表示のときに使えます。', 'is-error');
    clearTimeout(cooldownTimer);
    if (left > 0 && !panel.hidden) cooldownTimer = setTimeout(updateSend, 1000);
  }

  async function send() {
    const cid = channelId();
    if (!/^\d{15,22}$/.test(cid)) { msg(ERRORS.bad_channel, 'is-error'); return; }
    sending = true;
    updateSend();
    msg('画像を作っています…');
    try {
      const img = await o.makeImage(kind, els.layer.value);
      let blob = img.blob;
      let scale = 1;
      if (!blob || blob.type !== 'image/png' || blob.size > LIMIT) {
        const r = await fit(img.canvas);
        blob = r.blob;
        scale = r.scale;
      }
      if (img.canvas) img.canvas.width = img.canvas.height = 0;
      msg('送っています…');
      const fd = new FormData();
      fd.append('channel', cid);
      fd.append('file', blob, 'map.png');
      const r = await api('/api/send', { method: 'POST', body: fd });
      if (!r.ok) {
        if (r.error === 'rate_limited') store.set(`${KEY}:until`, Date.now() + (r.wait || COOLDOWN) * 1000);
        msg(r.error === 'network' ? 'Worker に接続できませんでした。通信状態を確認してください。' : errorText(r), 'is-error');
        if (!loggedIn()) render();
        return;
      }
      store.set(`${KEY}:until`, Date.now() + COOLDOWN * 1000);
      store.set(`${KEY}:last`, els.target.value === 'manual' ? 'manual' : cid);
      if (els.target.value === 'manual') store.set(`${KEY}:manualId`, cid);
      const p = document.createElement('span');
      p.append(`✅ ${r.guild ? `${r.guild} の ` : ''}#${r.channel || 'チャンネル'} に送りました${scale < 1 ? `（大きかったため ${Math.round(scale * 100)}% に縮めました）` : ''}。 `);
      const a = document.createElement('a');
      a.href = r.url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = 'Discord で見る';
      p.append(a);
      msg(p, 'is-ok');
    } catch (e) {
      console.error(e);
      msg(e.message || '送れませんでした。', 'is-error');
    } finally {
      sending = false;
      updateSend();
    }
  }

  /* ---------- 表示 ---------- */

  function render() {
    const inn = loggedIn();
    if (session && !inn) { store.del(KEY); session = null; }
    els.login.hidden = inn;
    els.main.hidden = !inn;
    els.loginBtn.disabled = false;
    els.user.replaceChildren();
    if (inn) {
      els.user.append(`ログイン中：${session.name || 'Discord'}`);
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = 'ログアウト';
      b.addEventListener('click', logout);
      els.user.append(b);
    }
  }

  function onOpen() {
    render();
    if (!loggedIn()) return;
    setKind(kind === 'view' && !o.isFlat() ? 'full' : kind);
    if (!targets) loadTargets(); else updateSend();
  }

  els.loginBtn.addEventListener('click', login);
  els.kind.addEventListener('click', (e) => { const b = e.target.closest('button[data-kind]'); if (b) { msg(''); setKind(b.dataset.kind); } });
  els.target.addEventListener('change', () => { msg(''); onTarget(); });
  els.channelId.addEventListener('input', updateSend);
  els.reload.addEventListener('click', () => { targets = null; loadTargets(); });
  els.send.addEventListener('click', send);
  $('#dcClose').addEventListener('click', () => { panel.hidden = true; });

  const reopen = readReturn();
  return {
    open() { o.open('discordPanel', 'saveBtn'); onOpen(); },
    onOpen,
    reopen,
  };
}
