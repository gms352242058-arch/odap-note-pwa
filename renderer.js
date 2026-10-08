const $ = (s) => document.querySelector(s);
const LINK_RE = /\[\[([^\]|#]+)#page=(\d+)(?:\|([^\]]*))?\]\]/g;
const IMG_RE = /!\[\[([^\]]+)\]\]/g;
const NUMS = ['①', '②', '③', '④', '⑤'];

let DB = null;       // { decks, state, dataDir, books }
let S = null;        // 앱 상태 (오답·코멘트)
let view = { type: 'all', deck: null };
let subject = '전체';
let onlyWrong = false;
let query = '';
let list = [];
let cur = -1;
let ms = null;       // 모달 상태 { answered, revealed, editing }

// ---------- 유틸 ----------
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
function renderMath(el) {
  try {
    renderMathInElement(el, {
      delimiters: [{ left: '$$', right: '$$', display: true }, { left: '$', right: '$', display: false }],
      throwOnError: false,
    });
  } catch { /* 수식 오류는 원문 그대로 둔다 */ }
}
function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 1800);
}
let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => window.api.saveState(S), 300);
}
// 이미지는 Drive에서 받아와야 해서 data-p 로 표시만 해 두고, 모달을 그린 뒤 hydrateImgs 가 채운다
function hydrateImgs(root) {
  root.querySelectorAll('img[data-p]').forEach(async (im) => {
    im.onload = () => { const cv = $('#ink'); if (cv && cv.fit) cv.fit(); };
    try { im.src = await window.api.imageUrl(im.dataset.p); }
    catch (e) { im.alt = '그림을 불러오지 못했어요: ' + e.message; }
  });
}
window.addEventListener('odap-error', (e) => toast('저장 실패 (나중에 다시 시도): ' + e.detail));

// ---------- 카드 모델 ----------
// 틀린 횟수: 사용자가 직접 고친 값(wrongOverride)이 있으면 그것, 없으면 기록된 오답 시도 수. 최대 3까지만 센다
const wrongCount = (c) => { const s = stPeek(c); return s.wrongOverride != null ? s.wrongOverride : Math.min(3, s.attempts.filter((a) => !a.ok).length); };
const wrongLevel = (c) => Math.max(1, wrongCount(c)); // 색상·분류용 단계 1~3 (오답이지만 횟수 0이면 1단계로 취급)
const wrongLabel = (c) => { const n = wrongCount(c); return n ? `오답 ${n}회${n >= 3 ? '+' : ''}` : '오답'; };
const LEVELS = [1, 2, 3];
const levelName = (n) => `오답 ${n}회${n >= 3 ? '+' : ''}`;
const keyOf = (c) => c.file + '#' + c.title;
const st = (c) => (S.cards[keyOf(c)] ||= { wrong: false, attempts: [], comment: '' });
const stPeek = (c) => S.cards[keyOf(c)] || { wrong: false, attempts: [], comment: '' };
const subjectOf = (c) => (c.tag.split('/')[2] || '').replace(/\s*\|\s*$/, '').trim();
const deckLabel = (d) => (d.cards[0]?.title.split(' ')[0] || d.id);
const cardName = (c) => c.title.split(' ').slice(1).join(' ');
function splitQuestion(q) {
  const imgs = [...q.matchAll(IMG_RE)].map((m) => m[1].split('|')[0]); // ![[경로|700]]의 크기 지정은 무시
  return { text: q.replace(IMG_RE, '').trim(), imgs };
}
function splitExplain(e) {
  const links = [...e.matchAll(LINK_RE)].map((m) => ({ book: m[1], page: +m[2], label: m[3] || '' }));
  const text = e.replace(LINK_RE, '').replace(/(\s*·\s*)+$/, '').replace(/(\s*·\s*){2,}/g, ' · ').trim();
  return { text, links };
}
function joinExplain(text, links) {
  return [text, ...links.map((l) => `[[${l.book}#page=${l.page}${l.label ? '|' + l.label : ''}]]`)]
    .filter(Boolean).join(' · ');
}

function allCards() {
  return DB.decks.flatMap((d) => d.cards.map((c) => { c.file = d.file; c.deckId = d.id; return c; }));
}

// ---------- 목록 ----------
function computeList() {
  let cs = allCards();
  if (view.type === 'deck') cs = cs.filter((c) => c.deckId === view.deck);
  if (view.type === 'wrong') cs = cs.filter((c) => stPeek(c).wrong);
  if (view.type === 'wlevel') cs = cs.filter((c) => stPeek(c).wrong && wrongLevel(c) === +view.deck);
  if (view.type === 'comment') cs = cs.filter((c) => stPeek(c).comment.trim());
  if (onlyWrong && view.type !== 'wrong' && view.type !== 'wlevel') cs = cs.filter((c) => stPeek(c).wrong);
  if (subject !== '전체') cs = cs.filter((c) => subjectOf(c) === subject);
  if (query) {
    const q = query.toLowerCase();
    cs = cs.filter((c) => (c.question + c.options.map((o) => o.text).join(' ') + c.explain + stPeek(c).comment).toLowerCase().includes(q));
  }
  return cs;
}

function renderNav() {
  const cs = allCards();
  const wrongN = cs.filter((c) => stPeek(c).wrong).length;
  const cmtN = cs.filter((c) => stPeek(c).comment.trim()).length;
  const item = (type, deck, label, cnt, bad, dot) => {
    const active = view.type === type && view.deck === deck;
    return `<button class="nav-item ${active ? 'active' : ''}" data-type="${type}" data-deck="${deck || ''}">
      ${dot !== undefined ? `<span class="dot ${dot ? 'on' : ''}"></span>` : ''}<span>${label}</span>
      <span class="cnt ${bad && cnt ? 'bad' : ''}">${cnt}</span></button>`;
  };
  let h = item('all', null, '▤ 전체 문제', cs.length) + item('wrong', null, '✗ 오답노트', wrongN, true);
  for (const n of LEVELS) {
    const k = cs.filter((c) => stPeek(c).wrong && wrongLevel(c) === n).length;
    h += `<button class="nav-item sub ${view.type === 'wlevel' && view.deck === String(n) ? 'active' : ''}" data-type="wlevel" data-deck="${n}">
      <span class="dot lv${n}"></span><span>${levelName(n)}</span><span class="cnt lvcnt lv${n}">${k}</span></button>`;
  }
  h += item('comment', null, '✎ 코멘트', cmtN);
  const years = {};
  DB.decks.forEach((d) => (years[d.id.slice(0, 4)] ||= []).push(d));
  for (const y of Object.keys(years).sort().reverse()) {
    h += `<div class="nav-sec">${y}년</div>`;
    for (const d of years[y]) {
      const w = d.cards.filter((c) => stPeek(c).wrong).length;
      h += item('deck', d.id, deckLabel(d), w ? w : d.cards.length, !!w, w > 0);
    }
  }
  $('#nav').innerHTML = h;
  $('#nav').querySelectorAll('.nav-item').forEach((b) => (b.onclick = () => {
    view = { type: b.dataset.type, deck: b.dataset.deck || null };
    closeSide();
    render();
  }));
}

function renderHead() {
  let t = '전체 문제', sub = '';
  if (view.type === 'wrong') { t = '오답노트'; sub = '틀린 문제만 모아 봅니다'; }
  if (view.type === 'wlevel') { t = levelName(+view.deck); sub = '틀린 횟수별로 모아 봅니다'; }
  if (view.type === 'comment') { t = '코멘트'; sub = '메모를 남긴 문제'; }
  if (view.type === 'deck') {
    const d = DB.decks.find((x) => x.id === view.deck);
    t = `${view.deck.slice(0, 4)}년 · ${deckLabel(d)}`; sub = d.file;
  }
  $('#title').textContent = t;
  $('#subtitle').textContent = `${sub ? sub + ' · ' : ''}${list.length}문제`;
}

function renderFilters() {
  const subs = ['전체', ...new Set(allCards().map(subjectOf).filter(Boolean))];
  let h = subs.map((s) => `<button class="chipbtn ${s === subject ? 'on' : ''}" data-s="${s}">${s}</button>`).join('');
  if (view.type !== 'wrong' && view.type !== 'wlevel') h += `<button class="chipbtn ${onlyWrong ? 'on' : ''}" id="ow">✗ 틀린 것만</button>`;
  $('#filters').innerHTML = h;
  $('#filters').querySelectorAll('[data-s]').forEach((b) => (b.onclick = () => { subject = b.dataset.s; render(); }));
  const ow = $('#ow'); if (ow) ow.onclick = () => { onlyWrong = !onlyWrong; render(); };
}

function renderGrid() {
  if (!list.length) { $('#grid').innerHTML = '<div class="empty">표시할 문제가 없습니다.</div>'; return; }
  $('#grid').innerHTML = list.map((c, i) => {
    const s = stPeek(c);
    const last = s.attempts[s.attempts.length - 1];
    const cleared = s.wrongOverride === 0; // 횟수를 직접 0으로 돌린 문제는 오답 색을 쓰지 않는다
    const isGood = last ? last.ok : false, isBad = !cleared && (last ? !last.ok : s.wrong);
    const cls = isBad ? `bad lv${wrongLevel(c)}` : isGood ? 'good' : '';
    const badge = isBad ? `<span class="badge bad lv${wrongLevel(c)}">${wrongLabel(c)}</span>` : isGood ? '<span class="badge good">정답</span>' : '';
    const d = DB.decks.find((x) => x.id === c.deckId);
    return `<div class="card ${cls}" data-i="${i}">
      <div class="ct"><span>${deckLabel(d)} · ${cardName(c)}</span><span>${badge}${s.comment.trim() ? ' ✎' : ''}</span></div>
      <div class="cq">${fmt(splitQuestion(c.question).text) || '(그림 문제)'}</div></div>`;
  }).join('');
  renderMath($('#grid'));
  $('#grid').querySelectorAll('.card').forEach((el) => (el.onclick = () => openModal(+el.dataset.i)));
}

function render() {
  list = computeList();
  renderNav(); renderHead(); renderFilters(); renderGrid();
}

// ---------- 모달 ----------
function openModal(i) {
  cur = i; ms = { answered: null, revealed: false, editing: false, base: inkBase(list[i]) };
  $('#scrim').hidden = false;
  renderModal();
}
function closeModal() { $('#scrim').hidden = true; cur = -1; render(); }

function renderModal() {
  const c = list[cur];
  if (!c) return closeModal();
  const s = st(c);
  const q = splitQuestion(c.question);
  const ex = splitExplain(c.explain);
  const d = DB.decks.find((x) => x.id === c.deckId);
  if (ms.editing) return renderEdit(c, d);
  const shown = ms.answered !== null || ms.revealed;
  const opts = c.options.map((o, i) => {
    let cls = '';
    if (shown) { if (o.correct) cls = 'right'; else if (i === ms.answered) cls = 'wrong'; }
    return `<button class="opt ${cls}" data-o="${i}"><span class="no">${NUMS[i]}</span><span>${fmt(o.text)}</span></button>`;
  }).join('');
  const links = ex.links.map((l, i) => `<button class="link" data-l="${i}">📖 ${esc(l.label || l.book.replace('.pdf', ''))} · p.${l.page}<span class="x" data-del="${i}" title="링크 삭제">✕</span></button>`).join('');
  $('#modal').innerHTML = `
    <div class="mh"><h2>${deckLabel(d)} · ${cardName(c)} <span style="color:var(--ink-3);font-weight:400">(${cur + 1}/${list.length})</span></h2>
      <div class="acts">
        <button class="ghost" id="bPrev">◀</button><button class="ghost" id="bNext">▶</button>
        <button class="ghost ${inkOn && inkTool === 'pen' ? 'on' : ''}" id="bInk" title="단축키 R">🖍 빨간펜</button>
        <button class="ghost ${inkOn && inkTool === 'erase' ? 'on' : ''}" id="bEraser" title="단축키 E">🧽 지우개</button>
        ${inkOn ? '<button class="ghost" id="bInkClear">전체 지우기</button>' : ''}
        <button class="ghost" id="bAsk" title="단축키 C">💬 Claude에게 질문</button>
        <span class="stepper lv${wrongLevel(c)} ${wrongCount(c) ? '' : 'zero'}" title="틀린 횟수를 직접 고칠 수 있어요"><button id="wcMinus">−</button><span>틀린 횟수 ${wrongCount(c)}${wrongCount(c) >= 3 ? '+' : ''}</span><button id="wcPlus">+</button></span>
        <button class="ghost" id="bEdit">✎ 수정</button>
        <button class="ghost" id="bClose">닫기</button></div></div>
    <div class="q">${fmt(q.text)}</div>
    ${q.imgs.map((p) => `<img class="qimg" data-p="${esc(p).replace(/"/g, '&quot;')}">`).join('')}
    <div class="opts">${opts}</div>
    ${shown ? '' : '<button class="ghost" id="bReveal">정답 보기 (기록 안 함)</button>'}
    ${shown ? `<div class="sec"><h3>해설</h3><div class="expl">${fmt(ex.text) || '(해설 없음)'}</div></div>
    <div class="sec"><h3>참고서 링크</h3>
      <div class="links">${links || '<span class="hint">링크 없음</span>'}</div>
      <div class="addlink">
        <select id="lbBook">${DB.books.map((b) => `<option>${b}</option>`).join('')}</select>
        <input id="lbPage" type="number" min="1" placeholder="PDF 페이지" style="width:110px">
        <input id="lbLabel" placeholder="라벨 (선택)" style="flex:1;min-width:120px">
        <button class="ghost" id="lbAdd">+ 링크 추가</button></div></div>
    <div class="sec"><h3>코멘트</h3><textarea id="cmt" rows="3" placeholder="메모를 남기세요 (자동 저장)">${esc(s.comment)}</textarea></div>` : ''}`;
  const gotRight = ms.answered !== null && c.options[ms.answered].correct;
  const gotWrong = ms.answered !== null && !c.options[ms.answered].correct;
  const isWrongNow = gotWrong || (ms.answered === null && !!s.wrong);
  $('#modal').classList.toggle('iswrong', isWrongNow);
  $('#modal').classList.remove('lv1', 'lv2', 'lv3');
  if (isWrongNow) $('#modal').classList.add('lv' + wrongLevel(c));
  $('#modal').classList.toggle('isright', gotRight);
  renderMath($('#modal'));
  hydrateImgs($('#modal'));
  $('#bClose').onclick = closeModal;
  $('#bPrev').onclick = () => go(-1);
  $('#bNext').onclick = () => go(1);
  $('#bAsk').onclick = askClaude;
  $('#bInk').onclick = () => toggleInk('pen');
  $('#bEraser').onclick = () => toggleInk('erase');
  const ic = $('#bInkClear'); if (ic) ic.onclick = () => { s.ink = (s.ink || []).slice(0, shown ? 0 : ms.base); persist(); renderModal(); };
  $('#bEdit').onclick = () => { ms.editing = true; renderModal(); };
  const setCount = (n) => { s.wrongOverride = Math.max(0, Math.min(3, n)); s.wrong = s.wrongOverride > 0; persist(); renderModal(); };
  $('#wcMinus').onclick = () => setCount(wrongCount(c) - 1);
  $('#wcPlus').onclick = () => setCount(wrongCount(c) + 1);
  const rv = $('#bReveal'); if (rv) rv.onclick = () => { ms.revealed = true; renderModal(); };
  $('#modal').querySelectorAll('.opt').forEach((b) => (b.onclick = () => answer(+b.dataset.o)));
  $('#modal').querySelectorAll('.link').forEach((b) => (b.onclick = (e) => {
    if (e.target.dataset.del !== undefined) return removeLink(+e.target.dataset.del);
    const l = ex.links[+b.dataset.l];
    toast(`${l.book.replace('.pdf', '')} p.${l.page} 로 이동 (Drive 뷰어에서 직접 이동)`);
    window.api.openLink(l.book, l.page).catch((err) => toast(err.message));
  }));
  if (shown) {
    $('#lbAdd').onclick = addLink;
    $('#cmt').oninput = (e) => { s.comment = e.target.value; persist(); };
  }
  setupInk(s, shown);
}

// ---------- 빨간펜 ----------
// 문제를 열 때 이미 있던 필기(풀이 기록)는 정답을 볼 때까지 숨긴다. 그 사이에 새로 쓴 필기는 바로 보인다.
const inkBase = (c) => (stPeek(c).ink || []).length;
let inkOn = false;
let inkTool = 'pen'; // 'pen' | 'erase'
// 같은 도구를 다시 누르면 끄고, 다른 도구를 누르면 도구만 바꾼다
function toggleInk(tool) {
  if (inkOn && inkTool === tool) inkOn = false; else { inkOn = true; inkTool = tool; }
  renderModal();
}
// 점 p와 선분 a-b 사이 거리
function distSeg(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
function setupInk(s, shown) {
  const m = $('#modal');
  const cv = document.createElement('canvas');
  cv.id = 'ink';
  cv.className = inkOn ? 'on' : '';
  cv.width = m.clientWidth; cv.height = m.scrollHeight;
  m.appendChild(cv);
  const ctx = cv.getContext('2d');
  ctx.strokeStyle = 'rgba(255,30,30,.85)'; ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const draw = (pts) => {
    ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
    if (pts.length === 1) ctx.lineTo(pts[0][0] + .1, pts[0][1]);
    pts.forEach((p) => ctx.lineTo(p[0], p[1]));
    ctx.stroke();
  };
  const first = () => (shown ? 0 : ms.base); // 정답 보기 전에는 이전 필기를 그리지도, 지우개로 건드리지도 않는다
  const redraw = () => { ctx.clearRect(0, 0, cv.width, cv.height); (s.ink || []).slice(first()).forEach(draw); };
  redraw();
  // 그림이 늦게 뜨면 모달이 길어지므로 캔버스를 다시 맞추고 필기를 복원한다 (크기를 바꾸면 그리기 설정도 초기화됨)
  cv.fit = () => {
    cv.width = m.clientWidth; cv.height = m.scrollHeight;
    ctx.strokeStyle = 'rgba(255,30,30,.85)'; ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    redraw();
  };
  if (!inkOn) return;
  const pos = (e) => { const r = cv.getBoundingClientRect(); return [Math.round(e.clientX - r.left), Math.round(e.clientY - r.top)]; };
  if (inkTool === 'erase') {
    // 지우개: 커서가 닿은 획만 통째로 지운다
    const R = 12;
    let down = false;
    const hit = (p) => {
      const before = (s.ink || []).length;
      const f = first();
      s.ink = (s.ink || []).filter((st, k) => k < f || !st.some((q, i) => distSeg(p, st[i - 1] || q, q) <= R + 2));
      if (s.ink.length !== before) { redraw(); persist(); }
    };
    cv.classList.add('erase');
    cv.onpointerdown = (e) => { cv.setPointerCapture(e.pointerId); down = true; hit(pos(e)); };
    cv.onpointermove = (e) => { if (down) hit(pos(e)); };
    cv.onpointerup = () => { down = false; };
    return;
  }
  let cur = null;
  cv.onpointerdown = (e) => { cv.setPointerCapture(e.pointerId); cur = [pos(e)]; draw(cur); };
  cv.onpointermove = (e) => {
    if (!cur) return;
    cur.push(pos(e));
    const n = cur.length; draw(cur.slice(Math.max(0, n - 2)));
  };
  cv.onpointerup = () => { if (!cur) return; (s.ink ||= []).push(cur); cur = null; persist(); };
}

// 현재 문제를 Claude에게 물어볼 질문으로 만들어 클립보드에 복사한다 (붙여넣기만 하면 됨)
async function askClaude() {
  const c = list[cur];
  if (!c) return;
  const q = splitQuestion(c.question);
  const ex = splitExplain(c.explain);
  const lines = ['전기기사 필기 문제인데 설명해줘.', '', `[${c.title}]`, q.text];
  c.options.forEach((o, i) => lines.push(`${NUMS[i]} ${o.text}`));
  lines.push('', `정답: ${NUMS[c.options.findIndex((o) => o.correct)]}`);
  if (ms.answered !== null) lines.push(`내 선택: ${NUMS[ms.answered]} (${c.options[ms.answered].correct ? '정답' : '오답'})`);
  if (ex.text) lines.push(`기존 해설: ${ex.text}`);
  lines.push('', '왜 이 답이 되는지, 풀이 과정과 핵심 개념을 쉽게 설명해줘.');
  if (q.imgs.length) lines.push('(문제에 그림이 있어요. 필요하면 그림을 붙여넣을게요.)');
  try {
    const r = await window.api.askClaude(lines.join('\n'));
    toast(r.prefilled ? 'Claude로 보냈어요' : 'Claude를 열었어요 — 입력창에 붙여넣기 (Ctrl+V)');
  } catch (e) { toast('Claude 열기 실패: ' + e.message); }
}

function go(d) {
  const n = cur + d;
  if (n < 0 || n >= list.length) return;
  cur = n; ms = { answered: null, revealed: false, editing: false, base: inkBase(list[n]) };
  renderModal();
}

function answer(i) {
  if (ms.answered !== null) return;
  const c = list[cur], s = st(c);
  const ok = !!c.options[i].correct;
  ms.answered = i;
  s.attempts.push({ ts: Date.now(), choice: i, ok });
  if (!ok) { s.wrong = true; if (s.wrongOverride != null) s.wrongOverride = Math.min(3, s.wrongOverride + 1); }
  persist();
  renderModal();
}

async function saveCardNow(c, oldTitle) {
  try {
    await window.api.saveCard(c.file, oldTitle, { title: c.title, question: c.question, options: c.options, explain: c.explain, tag: c.tag, extra: c.extra });
    return true;
  } catch (e) { toast('저장 실패: ' + e.message); return false; }
}

async function addLink() {
  const page = parseInt($('#lbPage').value, 10);
  if (!page) return toast('페이지 번호를 입력하세요');
  const c = list[cur];
  const ex = splitExplain(c.explain);
  ex.links.push({ book: $('#lbBook').value, page, label: $('#lbLabel').value.trim() });
  c.explain = joinExplain(ex.text, ex.links);
  if (await saveCardNow(c, c.title)) { toast('링크 추가됨'); renderModal(); }
}
async function removeLink(i) {
  const c = list[cur];
  const ex = splitExplain(c.explain);
  ex.links.splice(i, 1);
  c.explain = joinExplain(ex.text, ex.links);
  if (await saveCardNow(c, c.title)) renderModal();
}

function renderEdit(c, d) {
  const q = c.question, ex = splitExplain(c.explain);
  const rows = c.options.map((o, i) => `<div class="editrow"><input type="radio" name="ans" value="${i}" ${o.correct ? 'checked' : ''} title="정답"><textarea class="eo" rows="2">${esc(o.text)}</textarea></div>`).join('');
  $('#modal').innerHTML = `
    <div class="mh"><h2>수정 · ${deckLabel(d)} · ${cardName(c)}</h2></div>
    <div class="sec"><h3>문제 (그림은 ![[폴더/파일.png]] 형태 그대로 유지)</h3><textarea id="eq" rows="4">${esc(q)}</textarea></div>
    <div class="sec"><h3>보기 (왼쪽 라디오 = 정답)</h3>${rows}</div>
    <div class="sec"><h3>해설 (링크는 아래 '참고서 링크'에서 추가/삭제)</h3><textarea id="ee" rows="4">${esc(ex.text)}</textarea></div>
    <div class="sec"><h3>태그</h3><input id="et" style="width:100%" value="${esc(c.tag)}"></div>
    <div class="hint">저장하면 ${c.file} 파일에 바로 반영됩니다 (최초 1회 .bak 백업 생성).</div>
    <div class="mf"><button class="ghost" id="eCancel">취소</button><button class="primary" id="eSave">저장</button></div>`;
  $('#eCancel').onclick = () => { ms.editing = false; renderModal(); };
  $('#eSave').onclick = async () => {
    const texts = [...document.querySelectorAll('.eo')].map((t) => t.value.trim());
    const ans = document.querySelector('input[name=ans]:checked');
    if (!ans) return toast('정답을 선택하세요');
    if (texts.some((t) => !t)) return toast('빈 보기가 있습니다');
    c.question = $('#eq').value.trim().replace(/\n/g, ' ');
    c.options = texts.map((t, i) => ({ text: t.replace(/\n/g, ' '), correct: i === +ans.value }));
    c.explain = joinExplain($('#ee').value.trim().replace(/\n/g, ' '), ex.links);
    c.tag = $('#et').value.trim();
    if (await saveCardNow(c, c.title)) { toast('저장됨'); ms.editing = false; renderModal(); }
  };
}

// ---------- 초기화 ----------
async function init() {
  const dark = localStorage.getItem('dark') !== '0';
  $('#dark').checked = dark; applyTheme(dark);
  DB = await window.api.loadAll();
  S = DB.state;
  render();
}
function applyTheme(dark) {
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  localStorage.setItem('dark', dark ? '1' : '0');
  window.api.setTheme(dark ? 'dark' : 'light');
}
// 폰 화면에서는 사이드바를 ☰ 로 여닫는다
const closeSide = () => document.body.classList.remove('side-open');
$('#menu').onclick = () => document.body.classList.toggle('side-open');
$('#sideScrim').onclick = closeSide;
$('#dark').onchange = (e) => applyTheme(e.target.checked);
$('#search').oninput = (e) => { query = e.target.value.trim(); render(); };
$('#reload').onclick = async () => { await window.api.saveState(S); DB = await window.api.loadAll(); S = DB.state; render(); toast('새로고침 완료'); };
$('#startSolve').onclick = () => { if (list.length) openModal(0); };
$('#scrim').onclick = (e) => { if (e.target.id === 'scrim' && !(ms && ms.editing)) closeModal(); };
document.addEventListener('keydown', (e) => {
  if ($('#scrim').hidden) return;
  const tag = document.activeElement.tagName;
  if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return;
  if (e.key === 'Escape') { if (inkOn && !ms.editing) { inkOn = false; renderModal(); } else closeModal(); }
  else if (ms.editing) return;
  else if ((e.key === 'r' || e.key === 'R' || e.key === 'ㄱ') && !e.ctrlKey && !e.metaKey && !e.altKey) toggleInk('pen');
  else if ((e.key === 'e' || e.key === 'E' || e.key === 'ㄷ') && !e.ctrlKey && !e.metaKey && !e.altKey) toggleInk('erase');
  else if ((e.key === 'c' || e.key === 'C' || e.key === 'ㅊ') && !e.ctrlKey && !e.metaKey && !e.altKey) askClaude();
  else if (e.key === 'ArrowLeft') go(-1);
  else if (e.key === 'ArrowRight') go(1);
  else if (/^[1-5]$/.test(e.key)) { const n = +e.key - 1; if (list[cur] && n < list[cur].options.length) answer(n); }
});
init();
