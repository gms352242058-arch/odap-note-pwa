// 웹(PWA)용 window.api — Electron의 main.js + preload.js 역할을 Google Drive REST로 대신한다.
// 데이터는 PC 앱과 같은 Drive 폴더('전기기사오답노트앱')의 md 덱과 app_data.json 을 그대로 읽고 쓴다.
(() => {
  'use strict';
  const DEMO = new URLSearchParams(location.search).has('demo'); // demo/ 폴더의 샘플로 UI만 확인 (로그인 없음)
  const FOLDER_NAME = '전기기사오답노트앱';
  const SCOPE = 'https://www.googleapis.com/auth/drive'; // 기존 폴더(앱이 만든 게 아님)를 읽어야 해서 drive.file로는 부족
  const API = 'https://www.googleapis.com/drive/v3';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
  const STATE_NAME = 'app_data.json';
  const BOOKS = ['전기자기학_속전속결.pdf', '전력공학_속전속결.pdf', '전기기기_속전속결.pdf', '전기설비기술기준_속전속결.pdf', '나침판.pdf'];
  const SAVE_DELAY = 4000; // 풀이 기록이 3MB라 필기·답 선택마다 올리지 않고 모아서 올린다

  // ---------- md 파서 / 직렬화 (main.js와 동일) ----------
  function parseDeck(text) {
    const blocks = text.replace(/\r\n/g, '\n').split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
    return blocks.map((b) => {
      const c = { title: '', question: '', options: [], explain: '', tag: '', extra: [] };
      for (const line of b.split('\n')) {
        const m = line.match(/^(T|MCQ|O|A|I|G) \| ?(.*)$/);
        if (!m) { c.extra.push(line); continue; }
        const [, k, v] = m;
        if (k === 'T') c.title = v.replace(/ \|$/, '');
        else if (k === 'MCQ') c.question = v.replace(/ \|$/, '');
        else if (k === 'O') c.options.push({ text: v, correct: false });
        else if (k === 'A') c.options.push({ text: v, correct: true });
        else if (k === 'I') c.explain = v;
        else if (k === 'G') c.tag = v;
      }
      return c;
    });
  }
  function serializeCard(c) {
    const out = [`T | ${c.title} |`, `MCQ | ${c.question} |`];
    for (const o of c.options) out.push(`${o.correct ? 'A' : 'O'} | ${o.text}`);
    if (c.explain) out.push(`I | ${c.explain}`);
    out.push(`G | ${c.tag}`);
    for (const e of c.extra || []) out.push(e);
    return out.join('\n');
  }
  const serializeDeck = (cards) => cards.map(serializeCard).join('\n\n') + '\n';

  // ---------- 오프라인 캐시 (IndexedDB) ----------
  const idb = (() => {
    let p;
    const open = () => (p ||= new Promise((res, rej) => {
      const r = indexedDB.open('odap', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }));
    const tx = async (mode, fn) => {
      const db = await open();
      return new Promise((res, rej) => {
        const t = db.transaction('kv', mode);
        const rq = fn(t.objectStore('kv'));
        t.oncomplete = () => res(rq && rq.result);
        t.onerror = () => rej(t.error);
      });
    };
    return {
      get: (k) => tx('readonly', (s) => s.get(k)).catch(() => undefined),
      set: (k, v) => tx('readwrite', (s) => s.put(v, k)).catch(() => {}),
    };
  })();

  // ---------- Google 로그인 (토큰만 사용, 서버 없음) ----------
  // 클라이언트 ID는 공개 값이다(보안 비밀 아님). 기본값을 넣어 두면 폰에서 붙여넣을 필요가 없다.
  const DEFAULT_CID = '520643851637-pfrrpdjfn1p3e5dp12r2v2eln7tblukp.apps.googleusercontent.com';
  const getCid = () => localStorage.getItem('odap.cid') || DEFAULT_CID;
  let tok = null;
  try { tok = JSON.parse(localStorage.getItem('odap.tok')); } catch { /* 첫 실행 */ }
  const tokOk = () => tok && tok.exp > Date.now() + 60000;

  function gsiReady() {
    return new Promise((res, rej) => {
      if (window.google?.accounts?.oauth2) return res();
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.onload = res;
      s.onerror = () => rej(new Error('Google 로그인 스크립트를 불러오지 못했어요 (인터넷 연결 확인)'));
      document.head.appendChild(s);
    });
  }
  async function requestToken(prompt) {
    await gsiReady();
    return new Promise((res, rej) => {
      const client = google.accounts.oauth2.initTokenClient({
        client_id: getCid(),
        scope: SCOPE,
        callback: (r) => {
          if (r.error) return rej(new Error(r.error_description || r.error));
          tok = { t: r.access_token, exp: Date.now() + (r.expires_in || 3600) * 1000 };
          localStorage.setItem('odap.tok', JSON.stringify(tok));
          res(tok.t);
        },
        error_callback: (e) => rej(new Error(e.type || 'auth')),
      });
      client.requestAccessToken({ prompt });
    });
  }
  function loginOverlay(msg) {
    return new Promise((resolve) => {
      const el = document.createElement('div');
      el.className = 'login';
      el.innerHTML = `<div class="login-box"><h2>⚡ 오답노트</h2>
        <p>Google Drive의 '${FOLDER_NAME}' 폴더와 연결합니다.</p>
        <label>OAuth 클라이언트 ID<input id="cid" placeholder="123456-abc.apps.googleusercontent.com" autocomplete="off"></label>
        <button class="primary" id="go">Google로 로그인</button><p class="err" id="err"></p></div>`;
      document.body.appendChild(el);
      const err = el.querySelector('#err'), cid = el.querySelector('#cid');
      cid.value = getCid();
      if (msg) err.textContent = msg;
      el.querySelector('#go').onclick = async () => {
        if (!cid.value.trim()) { err.textContent = '클라이언트 ID를 입력하세요'; return; }
        localStorage.setItem('odap.cid', cid.value.trim());
        try { const t = await requestToken(''); el.remove(); resolve(t); } catch (e) { err.textContent = '로그인 실패: ' + e.message; }
      };
    });
  }
  let loginP = null;
  function ensureToken() {
    if (tokOk()) return Promise.resolve(tok.t);
    loginP ||= (async () => {
      if (getCid()) { try { return await requestToken(''); } catch { /* 팝업이 막히면 버튼으로 */ } }
      return loginOverlay();
    })().finally(() => { loginP = null; });
    return loginP;
  }

  // ---------- Drive 호출 ----------
  async function dfetch(url, opts = {}, retry = true) {
    const t = await ensureToken();
    const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + t } });
    if (r.status === 401 && retry) { tok = null; localStorage.removeItem('odap.tok'); return dfetch(url, opts, false); }
    if (!r.ok) throw new Error(`Drive ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r;
  }
  const qs = (o) => new URLSearchParams(o).toString();
  const qEsc = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  async function list(q) {
    const out = [];
    let pt;
    do {
      const r = await dfetch(`${API}/files?` + qs({ q, fields: 'nextPageToken,files(id,name,mimeType,modifiedTime)', pageSize: 1000, ...(pt ? { pageToken: pt } : {}) }));
      const j = await r.json();
      out.push(...j.files); pt = j.nextPageToken;
    } while (pt);
    return out;
  }
  const media = (id) => dfetch(`${API}/files/${id}?alt=media`);
  async function createFile(name, mime, text, parent) {
    const b = 'odapb' + Date.now();
    const body = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [parent] })}\r\n--${b}\r\nContent-Type: ${mime}; charset=UTF-8\r\n\r\n${text}\r\n--${b}--`;
    const r = await dfetch(`${UPLOAD}/files?uploadType=multipart&fields=id,name,modifiedTime`, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${b}` }, body });
    return r.json();
  }
  async function updateFile(id, mime, text) {
    const r = await dfetch(`${UPLOAD}/files/${id}?uploadType=media&fields=id,modifiedTime`, { method: 'PATCH', headers: { 'Content-Type': mime + '; charset=UTF-8' }, body: text });
    return r.json();
  }
  async function pool(items, n, fn) {
    const out = new Array(items.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
    }));
    return out;
  }

  let rootId = localStorage.getItem('odap.root');
  let files = {};            // 폴더 안 파일 목록 (이름 → {id, name, modifiedTime})
  let stateMt = null;        // 마지막으로 읽거나 올린 app_data.json 수정 시각
  let base = {};             // 마지막으로 동기화한 카드 상태 (병합 기준)
  const backedUp = new Set();

  async function getRoot() {
    if (rootId) return rootId;
    const f = await list(`name='${qEsc(FOLDER_NAME)}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
    if (!f.length) throw new Error(`Drive에서 '${FOLDER_NAME}' 폴더를 찾지 못했어요 (로그인한 계정 확인)`);
    rootId = f[0].id;
    localStorage.setItem('odap.root', rootId);
    return rootId;
  }

  // ---------- 풀이 기록 병합 ----------
  // PC에서 동시에 고쳤을 수 있으므로: 한쪽만 바뀐 카드는 바뀐 쪽을 따르고, 양쪽이 다 바뀐 카드는 시도 기록을 합친다.
  const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  function mergeInto(local, remote) {
    const rc = remote.cards || {};
    for (const k of new Set([...Object.keys(local.cards), ...Object.keys(rc)])) {
      const l = local.cards[k], r = rc[k], b = base[k];
      if (!r) continue;
      if (!l) { local.cards[k] = r; continue; }
      if (same(r, b)) continue;                       // 원격은 그대로 → 로컬 유지
      if (same(l, b)) { local.cards[k] = r; continue; } // 로컬은 그대로 → 원격 채택
      const at = new Map();
      [...(r.attempts || []), ...(l.attempts || [])].forEach((a) => at.set(a.ts, a));
      const m = { ...r, ...l, attempts: [...at.values()].sort((x, y) => x.ts - y.ts) };
      const ink = (l.ink || []).length >= (r.ink || []).length ? l.ink : r.ink;
      if (ink) m.ink = ink;
      local.cards[k] = m;
    }
    for (const k of Object.keys(remote)) if (!(k in local)) local[k] = remote[k];
  }

  // ---------- window.api ----------
  async function loadAll() {
    if (DEMO) return demoLoad();
    await flush();
    let listing;
    try {
      listing = await list(`'${await getRoot()}' in parents and trashed=false`);
      idb.set('listing', listing);
    } catch (e) {
      listing = await idb.get('listing'); // 오프라인이면 마지막으로 본 목록
      if (!listing) throw e;
    }
    files = Object.fromEntries(listing.map((f) => [f.name, f]));
    const names = listing.map((f) => f.name).filter((n) => /^\d{8}_flashcards\.md$/.test(n)).sort().reverse();
    const decks = await pool(names, 6, async (file) => {
      const f = files[file];
      const c = await idb.get('md:' + file);
      let text;
      if (c && c.mt === f.modifiedTime) text = c.text;
      else {
        try { text = await (await media(f.id)).text(); idb.set('md:' + file, { mt: f.modifiedTime, text }); }
        catch (e) { if (!c) throw e; text = c.text; }
      }
      return { file, id: file.slice(0, 8), cards: parseDeck(text) };
    });
    let state = { cards: {} };
    const sf = files[STATE_NAME];
    if (sf) {
      const c = await idb.get('state');
      if (c && c.mt === sf.modifiedTime) state = c.state;
      else {
        try { state = await (await media(sf.id)).json(); idb.set('state', { mt: sf.modifiedTime, state }); }
        catch (e) { if (!c) throw e; state = c.state; } // 못 읽었는데 빈 상태로 덮어쓰는 일은 없도록 캐시도 없으면 중단
      }
      stateMt = sf.modifiedTime;
    }
    if (!state.cards) state.cards = {};
    base = JSON.parse(JSON.stringify(state.cards));
    return { decks, state, dataDir: '', books: BOOKS };
  }

  async function doSave(s) {
    if (DEMO) { localStorage.setItem('odap.demo.state', JSON.stringify(s)); return; }
    const sf = files[STATE_NAME];
    if (sf) {
      const meta = await (await dfetch(`${API}/files/${sf.id}?fields=modifiedTime`)).json();
      if (meta.modifiedTime !== stateMt) mergeInto(s, await (await media(sf.id)).json());
    }
    const body = JSON.stringify(s, null, 1);
    const j = sf ? await updateFile(sf.id, 'application/json', body) : await createFile(STATE_NAME, 'application/json', body, await getRoot());
    files[STATE_NAME] = { id: j.id, name: STATE_NAME, modifiedTime: j.modifiedTime };
    stateMt = j.modifiedTime;
    base = JSON.parse(JSON.stringify(s.cards));
    idb.set('state', { mt: stateMt, state: s });
  }

  let pending = null, timer = null, saving = Promise.resolve();
  function saveState(state) {
    pending = state;
    clearTimeout(timer);
    timer = setTimeout(flush, SAVE_DELAY);
    return true;
  }
  function flush() {
    clearTimeout(timer);
    if (pending) {
      const s = pending;
      pending = null;
      saving = saving.then(() => doSave(s)).catch((e) => {
        pending ||= s;
        window.dispatchEvent(new CustomEvent('odap-error', { detail: e.message }));
      });
    }
    return saving;
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
  window.addEventListener('pagehide', flush);
  window.addEventListener('online', flush);

  async function saveCard(file, oldTitle, card) {
    if (DEMO) throw new Error('데모 모드에서는 저장되지 않아요');
    const f = files[file];
    if (!f) throw new Error('덱 파일을 찾을 수 없음: ' + file);
    const text = await (await media(f.id)).text();
    if (!backedUp.has(file) && !files[file + '.bak']) {
      await dfetch(`${API}/files/${f.id}/copy`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: file + '.bak', parents: [await getRoot()] }) });
    }
    backedUp.add(file);
    const cards = parseDeck(text);
    const i = cards.findIndex((c) => c.title === oldTitle);
    if (i < 0) throw new Error('카드를 찾을 수 없음: ' + oldTitle);
    card.extra = cards[i].extra;
    cards[i] = card;
    const out = serializeDeck(cards);
    const j = await updateFile(f.id, 'text/markdown', out);
    files[file] = { ...f, modifiedTime: j.modifiedTime };
    idb.set('md:' + file, { mt: j.modifiedTime, text: out });
    return true;
  }

  // 속전속결 PDF는 볼트(Drive) 안에 있으니 Drive 뷰어로 연다. 페이지 이동은 뷰어가 보장하지 않아서 렌더러가 쪽수를 알려준다.
  const bookIds = JSON.parse(localStorage.getItem('odap.books') || '{}');
  async function openLink(book, page) {
    if (DEMO) throw new Error('데모 모드에서는 열 수 없어요');
    const w = window.open('', '_blank'); // 클릭 직후에 창을 확보해야 팝업 차단을 피한다
    try {
      if (!bookIds[book]) {
        const f = await list(`name='${qEsc(book)}' and trashed=false`);
        if (!f.length) throw new Error(`Drive에서 ${book} 을(를) 찾지 못했어요`);
        bookIds[book] = f[0].id;
        localStorage.setItem('odap.books', JSON.stringify(bookIds));
      }
      const url = `https://drive.google.com/file/d/${bookIds[book]}/view#page=${page}`;
      if (w) w.location = url; else location.href = url;
    } catch (e) { if (w) w.close(); throw e; }
  }

  async function askClaude(text) {
    text = String(text);
    try { await navigator.clipboard.writeText(text); } catch { /* 권한 없으면 열기만 */ }
    const q = encodeURIComponent(text);
    const prefilled = q.length < 1800;
    window.open(prefilled ? `https://claude.ai/new?q=${q}` : 'https://claude.ai/new', '_blank');
    return { prefilled };
  }

  const dirs = {};
  const imgUrls = {};
  async function imageUrl(p) {
    if (DEMO) return 'demo/' + p;
    if (imgUrls[p]) return imgUrls[p];
    let blob = await idb.get('img:' + p);
    if (!blob) {
      const [dir, ...rest] = p.split('/');
      const name = rest.join('/');
      if (!files[dir]) throw new Error('이미지 폴더 없음: ' + dir);
      dirs[dir] ||= await list(`'${files[dir].id}' in parents and trashed=false`);
      const f = dirs[dir].find((x) => x.name === name);
      if (!f) throw new Error('이미지 없음: ' + p);
      blob = await (await media(f.id)).blob();
      idb.set('img:' + p, blob);
    }
    return (imgUrls[p] = URL.createObjectURL(blob));
  }

  function setTheme(t) {
    document.querySelector('meta[name=theme-color]')?.setAttribute('content', t === 'dark' ? '#141211' : '#f5f5f4');
  }

  // ---------- 데모 모드 ----------
  async function demoLoad() {
    const text = await (await fetch('demo/20220424_flashcards.md')).text();
    let state = { cards: {} };
    try { state = JSON.parse(localStorage.getItem('odap.demo.state')) || state; } catch { /* 첫 실행 */ }
    return { decks: [{ file: '20220424_flashcards.md', id: '20220424', cards: parseDeck(text) }], state, dataDir: '', books: BOOKS };
  }

  window.api = { loadAll, saveCard, saveState, openLink, askClaude, setTheme, imageUrl };
})();
