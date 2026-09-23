const state = {
  config: null,
  db: {},
  activeTab: ''
};

const R = window.rules;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function fmtDate(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function num(value, digits = 3) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : '-';
}

function signedMm(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${n > 0 ? '+' : ''}${n.toFixed(3)} mm`;
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2200);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || '请求失败');
  }
  if (res.status === 204) return null;
  return res.json();
}

function collectionLabel(collection) {
  return state.config.collections[collection]?.label || collection;
}

function siteOf(id) {
  return state.db.sites?.find((entry) => entry.id === id) || null;
}

function rulerOf(id) {
  return state.db.rulers?.find((entry) => entry.id === id) || null;
}

function siteLabel(site) {
  return site ? [site.pointCode, site.cave, site.zone].filter(Boolean).join(' / ') : '未关联样点';
}

function relationLabel(relation, id) {
  const item = state.db[relation.collection]?.find((entry) => entry.id === id);
  return item ? relation.labelFields.map((field) => item[field]).filter(Boolean).join(' / ') : '未关联';
}

// —— 前端用规则层即时重算，保证页面显示与服务端判定同源 ——
function liveReview(review) {
  const ruler = rulerOf(review.rulerId);
  const site = siteOf(review.siteId);
  if (!ruler || !site) return null;
  return R.evaluateReview(
    { photoUrl: review.photoUrl, caliberMm: review.caliberMm, caliberPx: review.caliberPx, lengthPx: review.lengthPx },
    ruler, site, state.db.reviews, review.id
  );
}

function toneFor(value) {
  return state.config.tones?.[value] || '';
}

function pill(value, tone = '') {
  return `<span class="pill ${tone}">${escapeHtml(value || '-')}</span>`;
}

function historyHtml(item) {
  const history = item.history || [];
  if (!history.length) return '';
  return `<div class="history">${history.slice(0, 6).map((entry) => `
    <div class="history-item"><span>${escapeHtml(fmtDate(entry.at))}</span><span>${escapeHtml(entry.action)}${entry.note ? '：' + escapeHtml(entry.note) : ''}</span></div>
  `).join('')}</div>`;
}

function flowButtons(item, collection) {
  return state.config.flows
    .filter((flow) => flow.collection === collection)
    .filter((flow) => !flow.when || flow.when.includes(item.status))
    .map((flow) => `<button class="${flow.danger ? 'danger' : 'ghost'}" data-flow="${flow.id}" data-id="${item.id}">${escapeHtml(flow.label)}</button>`)
    .join('');
}

function deviationPill(live) {
  if (!live || !Number.isFinite(live.scaleDeviationPct)) return '<span class="pill">-</span>';
  const pct = (live.scaleDeviationPct * 100).toFixed(2);
  const tone = live.scaleOutOfTolerance ? 'bad' : 'ok';
  return `<span class="pill ${tone}">${pct}%</span>`;
}

function anchorLine(live) {
  if (!live) return '';
  const a = live.anchor;
  const where = a.source === 'baseline'
    ? `样点基准 ${num(a.length)} mm`
    : `上次通过 ${a.date || ''}（${num(a.length)} mm，上次增长 ${signedMm(a.growthMm)}）`;
  return `<div class="meta">增长锚点：${escapeHtml(where)}</div>`;
}

// —— 标尺台账卡片：占用状态随复核动态变化 ——
function renderRulerCard(ruler) {
  const occ = R.rulerOccupancy(ruler.id, state.db.reviews);
  const mmPerPx = R.scaleMmPerPx(ruler.caliberMm, ruler.caliberPx);
  const badge = occ.occupied
    ? pill(`占用中 · ${siteOf(occ.siteId)?.pointCode || '另一样点'}`, 'warn')
    : pill('空闲可领用', 'ok');
  return `<article class="card">
    <div class="card-head"><h3>${escapeHtml(ruler.rulerCode)}</h3>${badge}</div>
    ${ruler.note ? `<p>${escapeHtml(ruler.note)}</p>` : ''}
    <div class="detail">
      <div>标定长度<br><strong>${num(ruler.caliberMm)} mm</strong></div>
      <div>标定像素<br><strong>${num(ruler.caliberPx, 0)} px</strong></div>
      <div>每像素毫米<br><strong>${mmPerPx.toFixed(5)} mm/px</strong></div>
    </div>
    ${flowButtons(ruler, 'rulers')}
    ${historyHtml(ruler)}
  </article>`;
}

// —— 样点卡片 ——
function renderSiteCard(site) {
  const open = (state.db.reviews || []).filter((r) => r.siteId === site.id && r.status !== R.STATUS.PASSED).length;
  const badge = open ? pill(`${open} 条未闭环`, 'warn') : pill('链条正常', 'ok');
  return `<article class="card">
    <div class="card-head"><h3>${escapeHtml([site.pointCode, site.cave].filter(Boolean).join(' / '))}</h3>${badge}</div>
    <div class="meta">${escapeHtml(site.zone || '')}</div>
    ${site.note ? `<p>${escapeHtml(site.note)}</p>` : ''}
    <div class="detail"><div>基准断面长度<br><strong>${num(site.baselineMm)} mm</strong></div></div>
    <div class="actions">${flowButtons(site, 'sites')}</div>
    ${historyHtml(site)}
  </article>`;
}

// —— 复核履历卡片 ——
function renderReviewCard(review) {
  const site = siteOf(review.siteId);
  const ruler = rulerOf(review.rulerId);
  const live = liveReview(review);
  const growth = review.status === R.STATUS.PASSED || review.status === R.STATUS.PENDING
    ? signedMm(review.growthMm)
    : '—';
  const photo = review.photoUrl
    ? `<a class="photo-link" href="${escapeHtml(review.photoUrl)}" target="_blank" rel="noreferrer">查看标准照 ↗</a>`
    : '<span class="pill bad">照片缺失</span>';
  const reason = review.status === R.STATUS.RESHOOT
    ? `<div class="callout bad">进待重拍原因：${escapeHtml(review.reshootReason || '照片缺失或换算偏差超限')}</div>`
    : '';
  const invalid = review.status === R.STATUS.INVALID
    ? `<div class="callout bad">失效说明：${escapeHtml(review.invalidReason || '相关增长需重算')}</div>`
    : '';
  const checker = review.status === R.STATUS.PASSED
    ? `<div class="meta">确认测量员：${escapeHtml(review.checker)} 于 ${escapeHtml(fmtDate(review.confirmedAt))}</div>`
    : '';
  return `<article class="card review-card">
    <div class="card-head">
      <h3>${escapeHtml(siteLabel(site))} · ${escapeHtml(review.date)}</h3>
      ${pill(review.status, toneFor(review.status))}
    </div>
    <div class="meta">标尺 ${escapeHtml(ruler?.rulerCode || '未关联')} ｜ 拍摄 ${escapeHtml(review.surveyor)} ｜ ${photo}</div>
    ${anchorLine(live)}
    <div class="detail">
      <div>断面长度<br><strong>${num(review.lengthMm)} mm</strong></div>
      <div>较锚点增长<br><strong>${growth}</strong></div>
      <div>换算偏差<br><strong>${deviationPill(live)}</strong></div>
    </div>
    ${reason}${invalid}${checker}
    ${review.memo ? `<p>${escapeHtml(review.memo)}</p>` : ''}
    <div class="actions">${flowButtons(review, 'reviews')}</div>
    ${historyHtml(review)}
  </article>`;
}

function renderCard(item, collection, view) {
  if (collection === 'rulers') return renderRulerCard(item);
  if (collection === 'sites') return renderSiteCard(item);
  if (collection === 'reviews') return renderReviewCard(item);
  return '';
}

function matchesQuery(item, view, query) {
  if (!query) return true;
  const fields = view.searchFields || [];
  const extra = item.siteId ? [siteOf(item.siteId)?.pointCode, siteOf(item.siteId)?.cave] : [];
  return [...fields.map((f) => item[f]), ...extra].some((v) => String(v || '').includes(query));
}

function renderList(view) {
  const collection = view.collection;
  const query = $(`#search-${view.id}`)?.value.trim() || '';
  const status = $(`#status-${view.id}`)?.value || '';
  let items = [...(state.db[collection] || [])];
  if (view.sortField) {
    items.sort((a, b) => {
      const av = a[view.sortField];
      const bv = b[view.sortField];
      return typeof av === 'number' && typeof bv === 'number' ? bv - av : String(bv || '').localeCompare(String(av || ''));
    });
  }
  if (query) items = items.filter((item) => matchesQuery(item, view, query));
  if (status) items = items.filter((item) => item.status === status);
  return items.length
    ? items.map((item) => renderCard(item, collection, view)).join('')
    : `<div class="empty">暂无${escapeHtml(collectionLabel(collection))}</div>`;
}

// —— 表单 ——
function optionList(items, labelFields) {
  return items.map((item) => {
    const label = labelFields.map((field) => item[field]).filter(Boolean).join(' / ');
    return `<option value="${item.id}">${escapeHtml(label)}</option>`;
  }).join('');
}

// 标尺下拉：占用他人样点的标尺禁用，同点未结链条可继续使用
function rulerOptions(siteId) {
  return (state.db.rulers || []).map((ruler) => {
    const verdict = R.rulerSelectable(ruler, state.db.reviews, siteId);
    const occ = verdict.occupancy;
    let suffix = '';
    if (!verdict.usable) suffix = `（${siteOf(occ.siteId)?.pointCode || '另一样点'}复核未完成，禁用）`;
    else if (occ.occupied) suffix = '（本样点链条未结，可继续使用）';
    return `<option value="${ruler.id}" ${verdict.usable ? '' : 'disabled'}>${escapeHtml(ruler.rulerCode + suffix)}</option>`;
  }).join('');
}

function formField(field, values = {}) {
  const required = field.required ? 'required' : '';
  const val = (name) => (values[name] == null ? '' : `value="${escapeHtml(values[name])}"`);
  const wide = field.wide ? 'wide' : '';
  if (field.type === 'textarea') {
    return `<label class="${wide}">${field.label}<textarea name="${field.name}" placeholder="${escapeHtml(field.placeholder || '')}">${escapeHtml(values[field.name] || '')}</textarea></label>`;
  }
  if (field.type === 'select') {
    return `<label class="${wide}">${field.label}<select name="${field.name}" ${required}>${field.options.map((o) => `<option ${values[field.name] === o ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('')}</select></label>`;
  }
  if (field.type === 'relation') {
    return `<label class="${wide}">${field.label}<select name="${field.name}" data-site-select ${required}><option value="">请选择样点</option>${optionList(state.db[field.collection] || [], field.labelFields)}</select></label>`;
  }
  if (field.type === 'ruler') {
    return `<label class="${wide}">${field.label}<select name="${field.name}" data-ruler-select ${required}><option value="">请先选择样点</option></select></label>`;
  }
  const step = field.step ? `step="${field.step}"` : '';
  return `<label class="${wide}">${field.label}<input type="${field.type || 'text'}" name="${field.name}" ${step} placeholder="${escapeHtml(field.placeholder || '')}" ${val(field.name)} ${required}></label>`;
}

function renderCreateForm(view) {
  return `<form class="panel review-form" data-create="${view.collection}" data-view="${view.id}">
    <h2>${escapeHtml(view.formTitle)}</h2>
    <div class="form-grid">${view.fields.map((f) => formField(f, { date: new Date().toISOString().slice(0, 10) })).join('')}</div>
    <div id="preview-${view.id}"></div>
    <div class="actions"><button>${escapeHtml(view.submitLabel || '保存')}</button></div>
  </form>`;
}

function renderCrudView(view) {
  const statusOptions = view.statusOptions || [];
  return `<section class="view" id="${view.id}">
    <div class="grid">
      ${renderCreateForm(view)}
      <div class="panel">
        <h2>${escapeHtml(view.listTitle)}</h2>
        <div class="toolbar">
          <input id="search-${view.id}" placeholder="${escapeHtml(view.searchPlaceholder || '搜索')}">
          ${statusOptions.length ? `<select id="status-${view.id}">
            <option value="">全部状态</option>
            ${statusOptions.map((o) => `<option>${escapeHtml(o)}</option>`).join('')}
          </select>` : '<span></span>'}
        </div>
        <div class="list" id="list-${view.id}">${renderList(view)}</div>
      </div>
    </div>
  </section>`;
}

function renderDashboardView(view) {
  const source = view.focus;
  let items = (state.db[source.collection] || [])
    .filter((item) => source.values.includes(item[source.field]));
  items.sort((a, b) => {
    const rank = { '待重拍': 0, '已失效': 1, '待确认': 2 };
    return (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || String(b.date || '').localeCompare(String(a.date || ''));
  });
  items = items.slice(0, source.limit || 10);
  const cardView = state.config.views.find((entry) => entry.collection === source.collection);
  return `<section class="view active" id="${view.id}">
    ${renderStats()}
    <div class="rules-panel panel">
      <h2>复核规则（rules.js）</h2>
      <ul>
        <li>登记标尺编号与像素/毫米换算；<strong>同一标尺复核完成前不能给别的样点使用</strong>。</li>
        <li>照片缺失，或本次换算相对标尺标定偏差<strong>超过 1%</strong>，只进<span class="pill bad">待重拍</span>。</li>
        <li>由<strong>另一位测量员</strong>确认：连续两次增长同向且增长量差值<strong>不超过 0.2 mm</strong>，方为<span class="pill ok">已通过</span>。</li>
        <li>样点基准更正或历史拍摄更正，相关增长<span class="pill bad">已失效</span>并自动重算锚点。</li>
      </ul>
    </div>
    <div class="panel"><h2>${escapeHtml(view.focusTitle)}</h2><div class="list">${items.length ? items.map((item) => renderCard(item, source.collection, cardView)).join('') : '<div class="empty">所有复核均已闭环</div>'}</div></div>
  </section>`;
}

function renderStats() {
  return `<div class="stats">${state.config.stats.map((stat) => {
    const items = state.db[stat.collection] || [];
    const value = stat.filter ? items.filter((item) => item[stat.filter.field] === stat.filter.value).length : items.length;
    return `<div class="stat"><span>${escapeHtml(stat.label)}</span><strong>${value}</strong></div>`;
  }).join('')}</div>`;
}

function render() {
  $('#title').textContent = state.config.title;
  document.title = state.config.title;
  $('#lede').textContent = state.config.lede;
  $('#main').innerHTML = state.config.views.map((view) => view.type === 'dashboard' ? renderDashboardView(view) : renderCrudView(view)).join('');
  setTab(state.activeTab || state.config.views[0].id);
  wireForms();
}

function renderTabs() {
  $('#tabs').innerHTML = state.config.views.map((view, index) => `
    <button class="tab${index === 0 ? ' active' : ''}" data-tab="${view.id}">${escapeHtml(view.label)}</button>
  `).join('');
  state.activeTab = state.config.views[0].id;
}

function setTab(tabId) {
  state.activeTab = tabId;
  $$('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === tabId));
  $$('.view').forEach((view) => view.classList.toggle('active', view.id === tabId));
}

// —— 新建复核表单：标尺联动 + 规则即时预览 ——
function wireForms() {
  $$('[data-site-select]').forEach((select) => {
    select.addEventListener('change', () => {
      const rulerSelect = select.closest('form').querySelector('[data-ruler-select]');
      if (rulerSelect) rulerSelect.innerHTML = select.value ? rulerOptions(select.value) : '<option value="">请先选择样点</option>';
      updatePreview(select.closest('form'));
    });
  });
  $$('.review-form').forEach((form) => {
    if (form.dataset.create === 'reviews') form.addEventListener('input', () => updatePreview(form));
  });
}

function updatePreview(form) {
  const view = state.config.views.find((v) => v.id === form.dataset.view);
  const box = $(`#preview-${view.id}`);
  if (!box) return;
  const data = Object.fromEntries(new FormData(form).entries());
  const site = siteOf(data.siteId);
  const ruler = rulerOf(data.rulerId);
  const cm = Number(data.caliberMm);
  const px = Number(data.caliberPx);
  const lenPx = Number(data.lengthPx);
  if (!ruler || !px || !cm) { box.innerHTML = ''; return; }
  const dev = R.scaleDeviationPct(cm, px, ruler);
  const out = R.scaleOutOfTolerance(dev);
  const missing = R.photoMissing(data.photoUrl);
  const length = R.sectionLengthMm(lenPx, cm, px);
  const anchor = site ? R.anchorLengthMm(site, state.db.reviews) : null;
  const growth = anchor ? R.round(length - anchor.length) : NaN;
  const will = missing || out ? R.STATUS.RESHOOT : R.STATUS.PENDING;
  box.innerHTML = `<div class="preview ${out || missing ? 'bad' : 'ok'}">
    <div class="preview-head">提交后判定：${pill(will, out || missing ? 'bad' : 'warn')}</div>
    <div class="detail">
      <div>换算偏差<br><strong>${Number.isFinite(dev) ? (dev * 100).toFixed(2) + '%' : '-'}</strong>（限 ±1%）</div>
      <div>断面长度<br><strong>${Number.isFinite(length) ? length.toFixed(3) : '-'} mm</strong></div>
      <div>较锚点增长<br><strong>${signedMm(growth)}</strong></div>
    </div>
    ${missing ? '<div class="meta">⚠ 标准照链接为空，只进待重拍</div>' : ''}
    ${out ? '<div class="meta">⚠ 换算偏差超过 1%，只进待重拍</div>' : ''}
  </div>`;
}

// —— 工作流弹窗 ——
function openModal(html) {
  $('#modal').innerHTML = html;
  $('#modalMask').hidden = false;
}
function closeModal() {
  $('#modalMask').hidden = true;
  $('#modal').innerHTML = '';
}

function modalShell(title, body, submitLabel, danger) {
  return `<button class="modal-close" data-close type="button">×</button>
    <h2>${escapeHtml(title)}</h2>
    ${body}
    <div class="actions">
      <button class="${danger ? 'danger' : ''}" data-modal-submit>${escapeHtml(submitLabel)}</button>
      <button class="ghost" data-close type="button">取消</button>
    </div>`;
}

function measureFields(review) {
  return `<div class="form-grid">
    <label>照片链接<input name="photoUrl" value="${escapeHtml(review.photoUrl || '')}"></label>
    <label>标尺读数 (mm)<input name="caliberMm" type="number" step="0.001" value="${escapeHtml(review.caliberMm)}"></label>
    <label>标尺读数 (px)<input name="caliberPx" type="number" step="1" value="${escapeHtml(review.caliberPx)}"></label>
    <label>断面长度 (px)<input name="lengthPx" type="number" step="0.01" value="${escapeHtml(review.lengthPx)}"></label>
  </div>`;
}

function modalContext(id) {
  const review = state.db.reviews.find((r) => r.id === id);
  const site = siteOf(review.siteId);
  const ruler = rulerOf(review.rulerId);
  return { review, site, ruler };
}

function openReshoot(id) {
  const { review, site } = modalContext(id);
  const sameSiteRulers = (state.db.rulers || [])
    .map((r) => ({ ruler: r, verdict: R.rulerSelectable(r, state.db.reviews, site.id) }))
    .filter((x) => x.verdict.usable);
  openModal(modalShell('登记重拍', `
    <p class="meta">${escapeHtml(siteLabel(site))} ｜ 原拍摄 ${escapeHtml(review.date)} ｜ 原拍摄人 ${escapeHtml(review.surveyor)}</p>
    ${measureFields(review)}
    <label>重拍测量员（可换人）<input name="surveyor" value="${escapeHtml(review.surveyor)}"></label>
    <label>可换用标尺<select name="rulerId">
      ${sameSiteRulers.map((x) => `<option value="${x.ruler.id}" ${x.ruler.id === review.rulerId ? 'selected' : ''}>${escapeHtml(x.ruler.rulerCode)}</option>`).join('')}
    </select></label>
  `, '提交重拍', false));
  wireMeasureModal(`/api/reviews/reshoot/${id}`, review);
}

function openConfirm(id) {
  const { review } = modalContext(id);
  const live = liveReview(review);
  openModal(modalShell('另一位测量员复核确认', `
    <div class="detail">
      <div>断面长度<br><strong>${num(review.lengthMm)} mm</strong></div>
      <div>本次增长<br><strong>${signedMm(review.growthMm)}</strong></div>
      <div>换算偏差<br>${deviationPill(live)}</div>
    </div>
    ${anchorLine(live)}
    <p class="meta">拍摄测量员：${escapeHtml(review.surveyor)}。确认人须为<strong>另一位</strong>测量员，且连续两次增长同向、差值不超过 0.2 mm。</p>
    <label>确认测量员<input name="checker" placeholder="请签名"></label>
  `, '确认通过', false));
  $('#modal [data-modal-submit]').addEventListener('click', async () => {
    try {
      const checker = $('#modal [name="checker"]').value;
      await api(`/api/reviews/confirm/${id}`, { method: 'POST', body: JSON.stringify({ checker }) });
      closeModal();
      await load();
      toast('已复核通过');
    } catch (error) {
      toast(error.message);
    }
  });
}

function openCorrect(id) {
  const { review, site } = modalContext(id);
  openModal(modalShell('更正历史拍摄', `
    <div class="callout bad">更正后本条作废重判，且 ${escapeHtml(site.pointCode)} 其后的已通过增长全部失效重算。</div>
    <p class="meta">${escapeHtml(siteLabel(site))} ｜ ${escapeHtml(review.date)}</p>
    ${measureFields(review)}
    <label>更正原因<input name="reason" placeholder="如：按原图复核断面像素"></label>
  `, '提交更正', true));
  wireMeasureModal(`/api/reviews/correct/${id}`, review);
}

function openBaseline(siteId) {
  const site = siteOf(siteId);
  const passed = R.reviewsToInvalidateForBaseline(siteId, state.db.reviews).length;
  openModal(modalShell('样点基准更正', `
    <label>样点<strong>${escapeHtml(siteLabel(site))}</strong></label>
    <label>现行基准长度<br><strong>${num(site.baselineMm)} mm</strong></label>
    <label>新基准长度 (mm)<input name="baselineMm" type="number" step="0.001" value="${escapeHtml(site.baselineMm)}"></label>
    <label>更正原因<input name="reason"></label>
    <div class="callout bad">提交后该样点 ${passed} 条已通过复核将全部变为“已失效”，增长链按新基准重算。</div>
  `, '更正基准并重算', true));
  $('#modal [data-modal-submit]').addEventListener('click', async () => {
    try {
      const payload = {
        baselineMm: Number($('#modal [name="baselineMm"]').value),
        reason: $('#modal [name="reason"]').value
      };
      await api(`/api/sites/baseline/${siteId}`, { method: 'POST', body: JSON.stringify(payload) });
      closeModal();
      await load();
      toast('基准已更正，相关增长失效重算');
    } catch (error) {
      toast(error.message);
    }
  });
}

// 重拍 / 更正共用的测量字段提交
function wireMeasureModal(url, review) {
  $('#modal [data-modal-submit]').addEventListener('click', async () => {
    try {
      const payload = {
        photoUrl: $('#modal [name="photoUrl"]').value,
        caliberMm: Number($('#modal [name="caliberMm"]').value),
        caliberPx: Number($('#modal [name="caliberPx"]').value),
        lengthPx: Number($('#modal [name="lengthPx"]').value)
      };
      const surveyorInput = $('#modal [name="surveyor"]');
      if (surveyorInput) payload.surveyor = surveyorInput.value;
      const rulerSelect = $('#modal [name="rulerId"]');
      if (rulerSelect) payload.rulerId = rulerSelect.value;
      const reasonInput = $('#modal [name="reason"]');
      if (reasonInput) payload.reason = reasonInput.value;
      await api(url, { method: 'POST', body: JSON.stringify(payload) });
      closeModal();
      await load();
      toast('已提交并按规则重新判定');
    } catch (error) {
      toast(error.message);
    }
  });
}

// —— 事件 ——
document.addEventListener('click', (event) => {
  const tab = event.target.closest('.tab');
  const flow = event.target.closest('[data-flow]');
  const close = event.target.closest('[data-close]');
  if (tab) setTab(tab.dataset.tab);
  if (close) closeModal();
  if (event.target === $('#modalMask')) closeModal();
  if (flow) {
    const map = { reshoot: openReshoot, confirm: openConfirm, correct: openCorrect, baseline: openBaseline };
    map[flow.dataset.flow]?.(flow.dataset.id);
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeModal();
});

document.addEventListener('input', (event) => {
  const view = state.config.views?.find((v) => event.target.id === `search-${v.id}` || event.target.id === `status-${v.id}`);
  if (view) $(`#list-${view.id}`).innerHTML = renderList(view);
});

document.addEventListener('submit', async (event) => {
  const form = event.target.closest('[data-create]');
  if (!form) return;
  event.preventDefault();
  const view = state.config.views.find((entry) => entry.id === form.dataset.view);
  const payload = Object.fromEntries(new FormData(form).entries());
  for (const field of view.fields) {
    if (field.type === 'number' || ['caliberMm', 'caliberPx', 'lengthPx', 'baselineMm'].includes(field.name)) {
      if (payload[field.name] !== undefined) payload[field.name] = Number(payload[field.name]);
    }
  }
  try {
    await api(`/api/${form.dataset.create}`, { method: 'POST', body: JSON.stringify(payload) });
    form.reset();
    await load();
    toast('已保存并按规则判定');
  } catch (error) {
    toast(error.message);
  }
});

$('#refreshBtn').addEventListener('click', () => load().then(() => toast('已刷新')));

async function load() {
  state.db = await api('/api/db');
  render();
}

async function boot() {
  state.config = await api('/api/config');
  renderTabs();
  await load();
}

boot().catch((error) => toast(error.message));
