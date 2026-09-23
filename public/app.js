/* 摄影测量复核台 —— 页面层。规则一律以 /domain/rules.js 与服务端为准。 */
const state = { db: { points: [], rods: [], reviews: [], shots: [], growths: [] }, tab: 'dashboard' };
const S = Rules.STATUS;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const esc = (v = '') => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
const fmtDate = (v) => !v ? '-' : new Date(v).toLocaleString('zh-CN', { hour12: false });
const n = (v) => (v === null || v === undefined || v === '' ? '-' : v);

function toast(message, bad = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('bad', bad);
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2200);
}

async function api(path, options = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || '请求失败');
  }
  if (res.status === 204) return null;
  return res.json();
}

// ---------- 数据辅助 ----------

const pointById = (id) => state.db.points.find((p) => p.id === id);
const rodById = (id) => state.db.rods.find((r) => r.id === id);
const reviewById = (id) => state.db.reviews.find((r) => r.id === id);
const pointLabel = (p) => (p ? `${p.code}（${p.zone || p.cave || '未分区'}）` : '样点已删除');

function openReviewFor(pointId) {
  return state.db.reviews.find((r) => r.pointId === pointId && r.status === S.REVIEW_OPEN);
}

function shotsOf(pointId) {
  return state.db.shots.filter((s) => s.pointId === pointId).sort(Rules.compareShots);
}

function growthsOf(pointId) {
  return state.db.growths
    .filter((g) => g.pointId === pointId && g.status !== S.GROWTH_INVALID)
    .sort((a, b) => String(a.toDate).localeCompare(String(b.toDate)));
}

function shotByIdLocal(id) {
  return state.db.shots.find((s) => s.id === id);
}

function pointStatus(p) {
  return Rules.pointStatus(p, state.db.shots, state.db.growths, state.db.reviews.filter((r) => r.status === S.REVIEW_OPEN));
}

const TONES = {
  '已采用': 'ok', '正常': 'ok', '已关闭': 'ok', '在库': 'ok', '已确认': 'ok',
  '进行中': 'warn', '待重拍': 'bad', '待确认': 'warn', '使用中': 'warn',
  '复核进行中': 'warn', '已失效': 'bad'
};
const pill = (value, tone = TONES[value] || '') => `<span class="pill ${tone}">${esc(value || '-')}</span>`;

function historyHtml(record) {
  const list = record.history || [];
  if (!list.length) return '';
  return `<div class="history">${list.slice(0, 6).map((h) => `
    <div class="history-item"><span>${fmtDate(h.at)}</span><span><b>${esc(h.action)}</b>${h.note ? '：' + esc(h.note) : ''}</span></div>`).join('')}
  </div>`;
}

// ---------- 弹层与表单 ----------

function openModal(title, bodyHtml) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = bodyHtml;
  $('#modalMask').hidden = false;
  const firstInput = $('#modalBody input, #modalBody select, #modalBody textarea');
  if (firstInput) firstInput.focus();
}
function closeModal() { $('#modalMask').hidden = true; $('#modalBody').innerHTML = ''; }
$('#modalClose').addEventListener('click', closeModal);
$('#modalMask').addEventListener('click', (e) => { if (e.target.id === 'modalMask') closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

function field(label, inner, wide = false) {
  return `<label class="${wide ? 'wide' : ''}"><span>${label}</span>${inner}</label>`;
}
const textInput = (name, value = '', required = true) =>
  `<input name="${name}" value="${esc(value)}" ${required ? 'required' : ''}>`;
const numInput = (name, value = '', required = true, step = 'any') =>
  `<input type="number" step="${step}" name="${name}" value="${value ?? ''}" ${required ? 'required' : ''}>`;
const dateInput = (name, value = new Date().toISOString().slice(0, 10)) =>
  `<input type="date" name="${name}" value="${value}" required>`;

function formHtml(id, fields, submitLabel, extraClass = '') {
  return `<form class="modal-form ${extraClass}" id="${id}"><div class="form-grid">${fields.join('')}</div>
    <div class="actions"><button type="submit">${esc(submitLabel)}</button><button type="button" class="ghost" id="modalCancel">取消</button></div></form>`;
}

function readForm(form) {
  return Object.fromEntries(new FormData(form).entries());
}

async function submitModalForm(form, request, onOk) {
  try {
    const result = await request();
    closeModal();
    await reload();
    toast(onOk(result));
  } catch (error) {
    toast(error.message, true);
    form?.querySelector('button[type=submit]')?.focus();
  }
}

document.addEventListener('click', (e) => { if (e.target.id === 'modalCancel') closeModal(); });

// ---------- 各操作表单 ----------

function openPointForm() {
  const html = formHtml('f-point', [
    field('样点编号', textInput('code')),
    field('所在分区/洞室', textInput('zone')),
    field('洞穴', textInput('cave', '', false)),
    field('备注', `<textarea name="note"></textarea>`, true)
  ], '建立样点');
  openModal('新增样点（首张采用照片将自动成为基准）', html);
  $('#f-point').addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = readForm(e.target);
    await submitModalForm(e.target, () => api('/api/points', { method: 'POST', body: JSON.stringify(v) }), () => '样点已建档');
  });
}

function openBaselineForm(point) {
  const html = formHtml('f-baseline', [
    field('基准标尺物理长度(mm)', numInput('baselineScaleMm', point.baselineScaleMm ?? 100)),
    field('基准照片内标尺像素', numInput('baselineScalePixels', point.baselineScalePixels ?? '')),
    field('基准断面对应像素', numInput('baselinePx', point.baselinePx ?? '')),
    field('基准拍摄日期', `<input type="date" name="baselineAt" value="${point.baselineAt || ''}" required>`),
    field('操作人', textInput('operator')),
    field('更正原因', `<input name="reason" placeholder="如：基准断面线重新标定" required>`)
  ], point.baselineMmPerPx === null ? '设定基准' : '更正基准（相关增长将失效重算）');
  openModal(point.baselineMmPerPx === null ? '设定样点基准' : `更正基准 · ${point.code}`, html);
  $('#f-baseline').addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = readForm(e.target);
    await submitModalForm(e.target, () => api(`/api/points/${point.id}/baseline`, { method: 'POST', body: JSON.stringify(v) }),
      (r) => point.baselineMmPerPx === null ? '基准已设定' : `基准已更正，重算 ${r.rebuiltGrowths} 条增长待确认`);
  });
}

function openRodForm() {
  const html = formHtml('f-rod', [
    field('标尺编号', textInput('code')),
    field('物理长度(mm)', numInput('lengthMm', 100)),
    field('备注', `<input name="note" placeholder="刻度状态、存放位置等">`, true)
  ], '登记标尺入库');
  openModal('登记标尺', html);
  $('#f-rod').addEventListener('submit', async (e) => {
    e.preventDefault();
    await submitModalForm(e.target, () => api('/api/rods', { method: 'POST', body: JSON.stringify(readForm(e.target)) }), () => '标尺已登记入库');
  });
}

function openReviewForm() {
  const inStockRods = state.db.rods.filter((r) => r.status === S.ROD_IN_STOCK);
  const availablePoints = state.db.points.filter((p) => !openReviewFor(p.id));
  const rodOptions = inStockRods.map((r) => `<option value="${r.id}">${esc(r.code)} · ${r.lengthMm}mm · 在库</option>`).join('');
  const pointOptions = availablePoints.map((p) => `<option value="${p.id}">${esc(pointLabel(p))}</option>`).join('');
  const warn = (!inStockRods.length || !availablePoints.length)
    ? `<p class="form-warn">没有可借的在库标尺或没有空闲样点：同一标尺复核完成前不能给别的样点使用。</p>` : '';
  const html = formHtml('f-review', [
    field('样点', `<select name="pointId" required ${availablePoints.length ? '' : 'disabled'}><option value="">请选择样点</option>${pointOptions}</select>`, true),
    field('标尺（锁定至本复核关闭）', `<select name="rodId" required ${inStockRods.length ? '' : 'disabled'}><option value="">请选择标尺</option>${rodOptions}</select>`, true),
    field('复核目的', textInput('purpose', '月度标准照增长复核', false), true),
    field('开启人', textInput('openedBy'))
  ], '开启复核并锁定标尺') + warn;
  openModal('开启复核（标尺锁定）', html);
  $('#f-review').addEventListener('submit', async (e) => {
    e.preventDefault();
    await submitModalForm(e.target, () => api('/api/reviews', { method: 'POST', body: JSON.stringify(readForm(e.target)) }), () => '复核已开启，标尺已锁定');
  });
}

function intakeFormHtml(formId, shot) {
  const rods = state.db.rods;
  return formHtml(formId, [
    field('拍摄日期', dateInput('date', shot?.date || new Date().toISOString().slice(0, 10))),
    field('拍摄人', textInput('photographer', shot?.photographer || '')),
    field('标准照链接', `<input name="photoUrl" placeholder="https://…（留空 = 照片缺失，只进待重拍）" value="${esc(shot?.photoUrl || '')}" required>`),
    field('所用标尺', `<select name="rodId">${rods.map((r) => `<option value="${r.id}" ${shot && shot.rodId === r.id ? 'selected' : ''}>${esc(r.code)} · ${r.lengthMm}mm</option>`).join('')}</select>`),
    field('照片内标尺像素长度', numInput('scalePixels', shot?.scalePixels ?? '')),
    field('断面对应像素位置', numInput('sectionPixels', shot?.sectionPixels ?? '')),
    field('备注', `<input name="note" value="${esc(shot?.note || '')}">`, true),
    `<div class="wide intake-preview" id="intakePreview"></div>`
  ], shot ? '提交重拍' : '登记照片', 'intake-form');
}

function intakePreview(body, rodId) {
  const rod = rodById(rodId) || {};
  const scaleMm = rod.lengthMm;
  const scalePixels = Number(body.scalePixels);
  const sectionPixels = Number(body.sectionPixels);
  const photoUrl = (body.photoUrl || '').trim();
  const k = Rules.mmPerPx(scaleMm, scalePixels);
  const el = $('#intakePreview');
  if (!el) return;
  if (!photoUrl) { el.innerHTML = `<b class="bad">照片缺失 → 待重拍</b>`; return; }
  if (k === null) { el.innerHTML = `<span class="muted">填写标尺像素读数后预览换算</span>`; return; }
  const positionMm = Rules.isFiniteNumber(sectionPixels) && sectionPixels > 0 ? Rules.round(sectionPixels * k, 3) : null;
  el.innerHTML = `换算系数 <b>${k} mm/px</b>${positionMm !== null ? ` · 断面位置 <b>${positionMm} mm</b>` : ''}`;
}

function openShotForm(review) {
  const point = pointById(review.pointId);
  openModal(`登记标准照 · ${point.code}（${review.id}）`, intakeFormHtml('f-shot'));
  const form = $('#f-shot');
  form.addEventListener('input', () => intakePreview(readForm(form), readForm(form).rodId));
  form.addEventListener('change', () => intakePreview(readForm(form), readForm(form).rodId));
  intakePreview(readForm(form), readForm(form).rodId);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = readForm(form);
    const rod = rodById(v.rodId);
    const payload = { ...v, scaleMm: rod.lengthMm };
    await submitModalForm(form, () => api(`/api/reviews/${review.id}/shots`, { method: 'POST', body: JSON.stringify(payload) }),
      (r) => r.growth ? `照片已采用，产生增长 ${r.growth.delta}mm（待确认）`
        : r.shot.status === S.SHOT_ACCEPTED ? '基准照片已采用' : `照片只进待重拍：${r.message}`);
  });
}

function openReshootForm(shot) {
  openModal(`补拍重传 · ${shot.date} 的待重拍照片`, intakeFormHtml('f-reshoot', shot));
  const form = $('#f-reshoot');
  form.addEventListener('input', () => intakePreview(readForm(form), readForm(form).rodId));
  form.addEventListener('change', () => intakePreview(readForm(form), readForm(form).rodId));
  intakePreview(readForm(form), readForm(form).rodId);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = readForm(form);
    const rod = rodById(v.rodId);
    await submitModalForm(form, () => api(`/api/shots/${shot.id}/reshoot`, { method: 'POST', body: JSON.stringify({ ...v, scaleMm: rod.lengthMm }) }),
      (r) => r.growth ? `重拍通过，补算增长 ${r.growth.delta}mm（待确认）`
        : r.shot.status === S.SHOT_ACCEPTED ? '重拍照片已采用（基准）' : `重拍仍进待重拍：${r.message}`);
  });
}

function openCorrectForm(shot) {
  const point = pointById(shot.pointId);
  const html = formHtml('f-correct', [
    field('照片链接', `<input name="photoUrl" value="${esc(shot.photoUrl)}" required>`),
    field('标尺物理长度(mm)', numInput('scaleMm', shot.scaleMm)),
    field('照片内标尺像素长度', numInput('scalePixels', shot.scalePixels)),
    field('断面对应像素位置', numInput('sectionPixels', shot.sectionPixels)),
    field('更正人', textInput('operator')),
    `<div class="wide form-warn">更正后会重新按 1% 偏差校验；一旦保存，该样点相关增长全部标记失效并按现有照片重算。</div>`
  ], '更正并重算');
  openModal(`更正历史拍摄 · ${point.code} / ${shot.date}`, html);
  const form = $('#f-correct');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = readForm(form);
    await submitModalForm(form, () => api(`/api/shots/${shot.id}/correct`, { method: 'POST', body: JSON.stringify(v) }),
      (r) => `已更正，重算 ${r.rebuiltGrowths} 条增长待确认`);
  });
}

function openConfirmForm(growth) {
  const chain = growthsOf(growth.pointId);
  const index = chain.findIndex((g) => g.id === growth.id);
  const prev = index > 0 ? chain[index - 1] : null;
  const pair = Rules.evaluatePair(prev, growth);
  const fromShot = shotByIdLocal(growth.fromShotId);
  const toShot = shotByIdLocal(growth.toShotId);
  const photographers = [fromShot?.photographer, toShot?.photographer].filter(Boolean).join('、');
  const pairHtml = prev ? `
    <div class="pair-box ${pair.ok ? 'ok' : 'bad'}">
      <div>上一次：${prev.fromDate} → ${prev.toDate}，<b>${prev.delta}mm</b>（${esc(prev.direction)}）</div>
      <div>这一次：${growth.fromDate} → ${growth.toDate}，<b>${growth.delta}mm</b>（${esc(growth.direction)}）</div>
      <div>同向：${pair.sameDirection ? '是' : '<b class="bad">否</b>'} · 两次差值 <b>${pair.difference}mm</b>（限值 0.2mm）</div>
      ${pair.ok ? '' : `<div class="bad">${pair.errors.map(esc).join('；')}</div>`}
    </div>` : `<p class="form-warn">${(pair.errors[0] || '需要连续两次增长')}。先补下一次月度照片。</p>`;
  const html = pairHtml + formHtml('f-confirm', [
    field(`确认测量员（须异于拍摄人：${esc(photographers)}）`, textInput('confirmer'))
  ], '确认通过（与上一次配对）');
  openModal('另一位测量员确认增长', html);
  const form = $('#f-confirm');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = readForm(form);
    await submitModalForm(form, () => api(`/api/growths/${growth.id}/confirm`, { method: 'POST', body: JSON.stringify(v) }),
      (r) => `已确认 ${r.confirmed.length} 条增长`);
  });
}

function openCloseForm(review) {
  const html = formHtml('f-close', [
    field('关闭操作人', textInput('closedBy')),
    field('关闭备注', `<input name="closeNote" placeholder="如：两条增长均已由第二位测量员确认">`, true)
  ], '关闭复核并归还标尺');
  openModal(`关闭复核 · ${pointLabel(pointById(review.pointId))}`, html);
  const form = $('#f-close');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = readForm(form);
    await submitModalForm(form, () => api(`/api/reviews/${review.id}/close`, { method: 'POST', body: JSON.stringify(v) }),
      () => '复核已关闭，标尺归库');
  });
}

function openPointDetail(point) {
  const shots = shotsOf(point.id);
  const growths = growthsOf(point.id);
  const invalids = state.db.growths.filter((g) => g.pointId === point.id && g.status === S.GROWTH_INVALID);
  const timeline = [
    ...shots.map((s) => ({ at: s.createdAt, kind: 'shot', item: s })),
    ...growths.map((g) => ({ at: g.confirmedAt || g.createdAt, kind: 'growth', item: g })),
    ...invalids.map((g) => ({ at: g.updatedAt, kind: 'invalid', item: g }))
  ].sort((a, b) => String(b.at).localeCompare(String(a.at)));

  const shotRow = (s) => `
    <div class="timeline-item ${s.status === S.SHOT_RESHOOT ? 'is-bad' : ''}">
      <div class="timeline-head"><b>${s.date}</b> ${pill(s.status)}
        <span class="muted">拍摄 ${esc(s.photographer)} · 标尺 ${esc(rodById(s.rodId)?.code || '-')} · ${esc(reviewById(s.reviewId)?.id || '')}</span></div>
      <div class="muted">标尺 ${n(s.scaleMm)}mm / ${n(s.scalePixels)}px → ${n(s.mmPerPx)} mm/px
        ${s.deviationPct !== null ? ` · 偏差 <b class="${s.deviationPct > 1 ? 'bad' : 'ok'}">${s.deviationPct}%</b>` : ' · 基准'}
        ${s.sectionPixels ? ` · 断面 ${s.sectionPixels}px ≈ ${Rules.round(s.sectionPixels * s.mmPerPx, 3)}mm` : ''}
      </div>
      <div class="muted">照片：${s.photoUrl ? `<a href="${esc(s.photoUrl)}" target="_blank" rel="noopener">${esc(s.photoUrl)}</a>` : '<b class="bad">缺失</b>'}${s.note ? ' · ' + esc(s.note) : ''}</div>
      <div class="inline-actions">
        ${s.status === S.SHOT_RESHOOT ? `<button class="ghost" data-act="reshoot" data-id="${s.id}">补拍重传</button>` : ''}
        ${s.status === S.SHOT_ACCEPTED && reviewById(s.reviewId)?.status === S.REVIEW_OPEN ? `<button class="ghost" data-act="correct" data-id="${s.id}">更正历史拍摄</button>` : ''}
      </div>
    </div>`;

  const growthRow = (g, invalid = false) => `
    <div class="timeline-item ${invalid ? 'is-bad' : ''}">
      <div class="timeline-head"><b>${g.fromDate} → ${g.toDate}</b> ${pill(g.status)}
        <span class="muted">增长 <b>${g.delta}mm</b>（${esc(g.direction)}）${g.confirmer ? ' · 确认 ' + esc(g.confirmer) : ''}</span></div>
      ${!invalid && g.status === S.GROWTH_PENDING ? `<div class="inline-actions"><button data-act="confirm" data-id="${g.id}">另一位测量员确认</button></div>` : ''}
    </div>`;

  const body = `
    <div class="detail-box">
      <div><span>基准换算</span><b>${n(point.baselineMmPerPx)} mm/px</b></div>
      <div><span>基准断面</span><b>${point.baselinePx ? point.baselinePx + 'px ≈ ' + Rules.round(point.baselinePx * point.baselineMmPerPx, 3) + 'mm' : '-'}</b></div>
      <div><span>基准日期/人</span><b>${n(point.baselineAt)} / ${esc(point.baselineBy || '-')}</b></div>
      <div><span>当前状态</span>${pill(pointStatus(point))}</div>
    </div>
    <div class="inline-actions">
      <button class="ghost" data-act="baseline" data-id="${point.id}">${point.baselineMmPerPx === null ? '设定基准' : '更正基准'}</button>
    </div>
    <h3 class="timeline-title">照片与增长履历</h3>
    <div class="timeline">${timeline.length ? timeline.map((t) => t.kind === 'shot' ? shotRow(t.item) : growthRow(t.item, t.kind === 'invalid')).join('') : '<div class="empty">暂无记录</div>'}</div>
    ${historyHtml(point)}`;
  openModal(`样点履历 · ${point.code}`, body);
}

// ---------- 页面渲染 ----------

const TABS = [
  { id: 'dashboard', label: '复核看板' },
  { id: 'points', label: '样点档案' },
  { id: 'rods', label: '标尺登记' },
  { id: 'reviews', label: '复核周期' },
  { id: 'growths', label: '增长确认' }
];

function renderTabs() {
  $('#tabs').innerHTML = TABS.map((t) => `<button class="tab ${t.id === state.tab ? 'active' : ''}" data-tab="${t.id}">${t.label}</button>`).join('');
}

function stat(label, value, tone = '') {
  return `<div class="stat"><span>${esc(label)}</span><strong class="${tone}">${value}</strong></div>`;
}

function dashboardView() {
  const open = state.db.reviews.filter((r) => r.status === S.REVIEW_OPEN);
  const reshoots = state.db.shots.filter((s) => s.status === S.SHOT_RESHOOT);
  const pending = state.db.growths.filter((g) => g.status === S.GROWTH_PENDING);
  const busyRods = state.db.rods.filter((r) => r.status === S.ROD_BUSY);
  const pointRows = state.db.points.map((p) => {
    const review = openReviewFor(p.id);
    return `<tr>
      <td><a href="#" data-act="detail" data-id="${p.id}"><b>${esc(p.code)}</b></a><div class="muted">${esc(p.zone)}</div></td>
      <td>${pill(pointStatus(p))}</td>
      <td>${review ? esc(review.id) + '（标尺 ' + esc(rodById(review.rodId)?.code) + '）' : '<span class="muted">无进行中复核</span>'}</td>
      <td>${shotsOf(p.id).filter((s) => s.status === S.SHOT_RESHOOT).length}</td>
      <td>${growthsOf(p.id).filter((g) => g.status === S.GROWTH_PENDING).length}</td>
      <td>${p.baselineMmPerPx ? p.baselineMmPerPx + ' mm/px' : '<span class="muted">未设基准</span>'}</td>
    </tr>`;
  }).join('');
  return `
    <div class="stats">
      ${stat('进行中复核', open.length, open.length ? 'warn-text' : 'ok-text')}
      ${stat('待重拍照片', reshoots.length, reshoots.length ? 'bad-text' : 'ok-text')}
      ${stat('待确认增长', pending.length, pending.length ? 'warn-text' : 'ok-text')}
      ${stat('锁定标尺 / 在库', `${busyRods.length} / ${state.db.rods.length - busyRods.length}`)}
    </div>
    <div class="grid">
      <section class="panel">
        <h2>待办队列</h2>
        <div class="list">
          ${reshoots.map((s) => {
            const p = pointById(s.pointId);
            return `<article class="card"><div class="card-head"><h3>待重拍 · ${esc(p.code)} / ${s.date}</h3>${pill('待重拍', 'bad')}</div>
              <p class="meta">${esc(s.history?.[0]?.note || '')}</p>
              <div class="actions"><button data-act="reshoot" data-id="${s.id}">补拍重传</button>
              <button class="ghost" data-act="detail" data-id="${p.id}">看样点履历</button></div></article>`;
          }).join('') || '<div class="empty">没有待重拍照片</div>'}
          ${pending.map((g) => {
            const p = pointById(g.pointId);
            return `<article class="card"><div class="card-head"><h3>待确认增长 · ${esc(p.code)}</h3>${pill('待确认', 'warn')}</div>
              <p class="meta">${g.fromDate} → ${g.toDate}：<b>${g.delta}mm</b>（${esc(g.direction)}）</p>
              <div class="actions"><button data-act="confirm" data-id="${g.id}">另一位测量员确认</button></div></article>`;
          }).join('') || '<div class="empty">没有待确认增长</div>'}
        </div>
      </section>
      <section class="panel">
        <h2>样点总览 <button class="ghost small" id="btnNewPoint">新增样点</button></h2>
        <table class="table"><thead><tr><th>样点</th><th>状态</th><th>进行中复核</th><th>待重拍</th><th>待确认</th><th>基准换算</th></tr></thead>
        <tbody>${pointRows}</tbody></table>
      </section>
    </div>`;
}

function pointsView() {
  return `<section class="panel">
    <div class="section-head"><h2>样点档案与履历</h2><button id="btnNewPoint">新增样点</button></div>
    <div class="cards">${state.db.points.map((p) => {
      const review = openReviewFor(p.id);
      const growths = growthsOf(p.id);
      const last = growths[growths.length - 1];
      return `<article class="card point-card">
        <div class="card-head"><h3>${esc(p.code)}</h3>${pill(pointStatus(p))}</div>
        <p class="meta">${esc(p.cave)} · ${esc(p.zone)}</p>
        <div class="detail">
          <div><span>基准换算</span><b>${n(p.baselineMmPerPx)} mm/px</b></div>
          <div><span>最近增长</span><b>${last ? last.delta + 'mm ' + last.direction : '-'}</b></div>
          <div><span>当前复核</span><b>${review ? review.id : '无'}</b></div>
        </div>
        <p class="meta">${esc(p.note || '')}</p>
        <div class="actions">
          <button data-act="detail" data-id="${p.id}">查看履历</button>
          <button class="ghost" data-act="baseline" data-id="${p.id}">${p.baselineMmPerPx === null ? '设定基准' : '更正基准'}</button>
        </div>
        ${historyHtml(p)}
      </article>`;
    }).join('')}</div>
  </section>`;
}

function rodsView() {
  return `<section class="panel">
    <div class="section-head"><h2>标尺登记</h2><button id="btnNewRod">登记标尺</button></div>
    <div class="cards">${state.db.rods.map((r) => {
      const review = reviewById(r.currentReviewId);
      const p = review ? pointById(review.pointId) : null;
      return `<article class="card">
        <div class="card-head"><h3>${esc(r.code)}</h3>${pill(r.status)}</div>
        <div class="detail">
          <div><span>物理长度</span><b>${r.lengthMm} mm</b></div>
          <div><span>锁定于</span><b>${p ? esc(pointLabel(p)) : '—'}</b></div>
          <div><span>复核单</span><b>${review ? review.id : '—'}</b></div>
        </div>
        <p class="meta">${esc(r.note || '')}${r.status === S.ROD_BUSY ? '<br>同一标尺复核完成前不能给别的样点使用。' : ''}</p>
        ${historyHtml(r)}
      </article>`;
    }).join('')}</div>
  </section>`;
}

function reviewsView() {
  const [open, closed] = [
    state.db.reviews.filter((r) => r.status === S.REVIEW_OPEN),
    state.db.reviews.filter((r) => r.status === S.REVIEW_CLOSED)
  ].map((list) => list.sort((a, b) => String(b.openedAt).localeCompare(String(a.openedAt))));

  const card = (r) => {
    const p = pointById(r.pointId);
    const rod = rodById(r.rodId);
    const shots = state.db.shots.filter((s) => s.reviewId === r.id).sort(Rules.compareShots);
    const acceptedIds = new Set(shots.filter((s) => s.status === S.SHOT_ACCEPTED).map((s) => s.id));
    const pendingGrowths = state.db.growths.filter((g) => acceptedIds.has(g.toShotId) && g.status === S.GROWTH_PENDING);
    const reshoots = shots.filter((s) => s.status === S.SHOT_RESHOOT);
    return `<article class="card review-card">
      <div class="card-head"><h3>${esc(r.id)} · ${esc(pointLabel(p))}</h3>${pill(r.status)}</div>
      <p class="meta">${esc(r.purpose || '')}<br>开启人 ${esc(r.openedBy)} · 标尺 ${esc(rod?.code)}（${rod?.lengthMm}mm）${r.status === S.REVIEW_CLOSED ? ` · 关闭人 ${esc(r.closedBy)}` : ''}</p>
      <div class="detail">
        <div><span>采用照片</span><b>${shots.length - reshoots.length}</b></div>
        <div><span>待重拍</span><b class="${reshoots.length ? 'bad-text' : ''}">${reshoots.length}</b></div>
        <div><span>待确认增长</span><b class="${pendingGrowths.length ? 'warn-text' : ''}">${pendingGrowths.length}</b></div>
      </div>
      <div class="shot-strip">${shots.map((s) => `
        <div class="shot-chip ${s.status === S.SHOT_RESHOOT ? 'bad' : 'ok'}" title="${esc(s.history?.[0]?.note || '')}">
          ${s.date} · ${s.status === S.SHOT_RESHOOT ? '待重拍' : s.mmPerPx + 'mm/px'}
          ${s.status === S.SHOT_RESHOOT ? `<button class="link-btn" data-act="reshoot" data-id="${s.id}">补拍</button>` : ''}
        </div>`).join('') || '<span class="muted">尚无照片</span>'}</div>
      <div class="actions">
        ${r.status === S.REVIEW_OPEN ? `
          <button data-act="shot" data-id="${r.id}">登记月度标准照</button>
          <button class="ghost" data-act="close" data-id="${r.id}">完成并归还标尺</button>` : ''}
        <button class="ghost" data-act="detail" data-id="${p.id}">样点履历</button>
      </div>
      ${historyHtml(r)}
    </article>`;
  };

  return `<div class="list">
    <section class="panel">
      <div class="section-head"><h2>进行中复核（标尺锁定）</h2><button id="btnNewReview">开启复核</button></div>
      <div class="cards">${open.map(card).join('') || '<div class="empty">没有进行中的复核</div>'}</div>
    </section>
    <section class="panel">
      <h2>已关闭复核（标尺已归库）</h2>
      <div class="cards compact">${closed.map(card).join('') || '<div class="empty">暂无历史复核</div>'}</div>
    </section>
  </div>`;
}

function growthsView() {
  const rows = [...state.db.growths]
    .sort((a, b) => String(b.toDate).localeCompare(String(a.toDate)))
    .map((g) => {
      const p = pointById(g.pointId);
      // 上一条 = 时间上更早的相邻一条（已失效记录不参与配对）
      const chain = state.db.growths
        .filter((x) => x.pointId === g.pointId && x.status !== S.GROWTH_INVALID)
        .sort((a, b) => String(a.toDate).localeCompare(String(b.toDate)));
      const idx = chain.indexOf(g);
      const earlier = idx > 0 ? chain[idx - 1] : null;
      const pair = g.status === S.GROWTH_PENDING ? Rules.evaluatePair(earlier, g) : null;
      return `<article class="card growth-card ${g.status === S.GROWTH_INVALID ? 'is-bad' : ''}">
        <div class="card-head"><h3>${esc(p.code)} · ${g.fromDate} → ${g.toDate}</h3>${pill(g.status)}</div>
        <div class="detail">
          <div><span>增长量</span><b>${g.delta} mm</b></div>
          <div><span>方向</span><b>${esc(g.direction)}</b></div>
          <div><span>确认人</span><b>${esc(g.confirmer || '—')}</b></div>
        </div>
        ${pair ? `<div class="pair-box ${pair.ok ? 'ok' : 'bad'}">配对校验：${pair.hasPair ? `同向 ${pair.sameDirection ? '✓' : '✗'} · 差值 ${pair.difference}mm（≤0.2）` : esc(pair.errors[0])}</div>` : ''}
        ${g.status === S.GROWTH_PENDING ? `<div class="actions"><button data-act="confirm" data-id="${g.id}">另一位测量员确认</button></div>` : ''}
        ${g.status === S.GROWTH_INVALID ? `<p class="meta">${esc(g.history?.[0]?.note || '基准或历史拍摄更正后失效')}</p>` : ''}
      </article>`;
    }).join('');
  return `<section class="panel">
    <h2>增长记录与确认履历</h2>
    <p class="meta rule-note">确认条件：连续两次增长同向、两次差值不超过 0.2mm，且确认人不是两张照片的拍摄人。基准/历史更正后旧增长保留为“已失效”。</p>
    <div class="cards">${rows}</div>
  </section>`;
}

function render() {
  $('#lede').textContent = '标尺锁定登记、像素毫米换算与 1% 偏差闸口、另一位测量员双人确认增长；基准或历史拍摄更正自动失效重算。';
  renderTabs();
  const views = { dashboard: dashboardView, points: pointsView, rods: rodsView, reviews: reviewsView, growths: growthsView };
  $('#main').innerHTML = views[state.tab]();
}

async function reload() {
  state.db = await api('/api/db');
  render();
}

document.addEventListener('click', async (e) => {
  const tab = e.target.closest('[data-tab]');
  if (tab) { state.tab = tab.dataset.tab; render(); return; }

  const quick = e.target.closest('#btnNewPoint, #btnNewRod, #btnNewReview');
  if (quick) {
    ({ btnNewPoint: openPointForm, btnNewRod: openRodForm, btnNewReview: openReviewForm })[quick.id]();
    return;
  }

  const act = e.target.closest('[data-act]');
  if (!act) return;
  e.preventDefault();
  const { act: type, id } = act.dataset;
  try {
    if (type === 'detail') openPointDetail(pointById(id));
    else if (type === 'baseline') openBaselineForm(pointById(id));
    else if (type === 'shot') openShotForm(reviewById(id));
    else if (type === 'close') openCloseForm(reviewById(id));
    else if (type === 'reshoot') openReshootForm(shotByIdLocal(id));
    else if (type === 'correct') openCorrectForm(shotByIdLocal(id));
    else if (type === 'confirm') openConfirmForm(state.db.growths.find((g) => g.id === id));
  } catch (error) {
    toast(error.message, true);
  }
});

$('#refreshBtn').addEventListener('click', () => reload().then(() => toast('数据已刷新')));

reload().catch((error) => toast(error.message, true));
