const express = require('express');
const fs = require('fs/promises');
const path = require('path');

const app = express();
const config = require('./project.config');
const rules = require('./rules');

const PORT = process.env.PORT || config.port || 3900;
const DB_FILE = path.join(__dirname, 'data', 'db.json');

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));
// 规则层同时提供给浏览器，保证前后端同源规则
app.get('/rules.js', (req, res) => res.sendFile(path.join(__dirname, 'rules.js')));

async function readDb() {
  const raw = await fs.readFile(DB_FILE, 'utf8');
  return JSON.parse(raw);
}

async function writeDb(db) {
  await fs.writeFile(DB_FILE, JSON.stringify(db, null, 2) + '\n');
}

function stamp(action, note) {
  return { at: new Date().toISOString(), action, note: note || '' };
}

function pushHistory(item, action, note) {
  item.history = item.history || [];
  item.history.unshift(stamp(action, note));
}

function positiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : NaN;
}

// 从请求体取摄影测量输入
function measureInput(body) {
  return {
    photoUrl: String(body.photoUrl || '').trim(),
    caliberMm: positiveNumber(body.caliberMm),
    caliberPx: positiveNumber(body.caliberPx),
    lengthPx: positiveNumber(body.lengthPx)
  };
}

function validMeasure(input) {
  return Number.isFinite(input.caliberMm) && Number.isFinite(input.caliberPx) && Number.isFinite(input.lengthPx);
}

function anchorSnapshot(anchor) {
  return {
    anchorSource: anchor.source,
    anchorReviewId: anchor.reviewId,
    anchorDate: anchor.date,
    anchorLengthMm: Number.isFinite(anchor.length) ? rules.round(anchor.length) : null
  };
}

// 把规则评估结果写回复核记录
function applyEvaluation(review, evaluation) {
  review.status = evaluation.status;
  review.lengthMm = evaluation.lengthMm;
  review.growthMm = Number.isFinite(evaluation.growthMm) ? evaluation.growthMm : null;
  review.scaleDeviationPct = Number.isFinite(evaluation.scaleDeviationPct)
    ? rules.round(evaluation.scaleDeviationPct, 6)
    : null;
  Object.assign(review, anchorSnapshot(evaluation.anchor));
  if (evaluation.status === rules.STATUS.RESHOOT) {
    const reasons = [];
    if (evaluation.photoMissing) reasons.push('照片缺失');
    if (evaluation.scaleOutOfTolerance) reasons.push('换算偏差超过 1%');
    review.invalidReason = '';
    review.reshootReason = reasons.join('；');
  } else {
    review.reshootReason = '';
  }
}

function sortByConfig(a, b, field) {
  const av = a[field];
  const bv = b[field];
  if (typeof av === 'number' && typeof bv === 'number') return bv - av;
  return String(bv || '').localeCompare(String(av || ''));
}

app.get('/api/config', (req, res) => {
  res.json(config);
});

app.get('/api/db', async (req, res) => {
  const db = await readDb();
  for (const view of config.views) {
    if (!view.collection || !Array.isArray(db[view.collection])) continue;
    if (view.sortField) db[view.collection].sort((a, b) => sortByConfig(a, b, view.sortField));
  }
  res.json(db);
});

// ---------- 通用登记 ----------
app.post('/api/:collection', async (req, res) => {
  const db = await readDb();
  const { collection } = req.params;
  if (!Array.isArray(db[collection])) return res.status(404).json({ error: '未知数据表' });

  const now = new Date().toISOString();

  if (collection === 'reviews') return createReview(req, res, db, now);

  const item = {
    id: `${collection}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
    ...req.body,
    createdAt: now,
    updatedAt: now,
    history: [stamp('创建', '')]
  };
  if (collection === 'rulers') {
    item.caliberMm = positiveNumber(item.caliberMm);
    item.caliberPx = positiveNumber(item.caliberPx);
    if (!Number.isFinite(item.caliberMm) || !Number.isFinite(item.caliberPx)) {
      return res.status(400).json({ error: '标尺标定长度与像素必须为正数' });
    }
  }
  if (collection === 'sites') {
    item.baselineMm = positiveNumber(item.baselineMm);
    if (!Number.isFinite(item.baselineMm)) return res.status(400).json({ error: '基准断面长度必须为正数' });
  }
  db[collection].push(item);
  await writeDb(db);
  res.status(201).json(item);
});

async function createReview(req, res, db, now) {
  const body = req.body || {};
  const site = db.sites.find((entry) => entry.id === body.siteId);
  if (!site) return res.status(400).json({ error: '请选择样点' });
  const ruler = db.rulers.find((entry) => entry.id === body.rulerId);
  if (!ruler) return res.status(400).json({ error: '请选择标尺' });
  if (!body.date || !String(body.surveyor || '').trim()) {
    return res.status(400).json({ error: '拍摄日期与拍摄测量员为必填' });
  }
  const input = measureInput(body);
  if (!validMeasure(input)) return res.status(400).json({ error: '标尺读数与断面像素必须为正数' });

  // 同一标尺复核完成前不能给别的样点使用
  const selectable = rules.rulerSelectable(ruler, db.reviews, site.id);
  if (!selectable.usable) {
    const occSite = db.sites.find((entry) => entry.id === selectable.occupancy.siteId);
    const where = occSite ? `${occSite.pointCode}（${occSite.cave}）` : '另一样点';
    return res.status(409).json({ error: `标尺 ${ruler.rulerCode} 在 ${where} 的复核未完成，暂不能用于本样点` });
  }

  const evaluation = rules.evaluateReview(input, ruler, site, db.reviews, null);
  const review = {
    id: `review-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
    siteId: site.id,
    rulerId: ruler.id,
    date: body.date,
    surveyor: String(body.surveyor).trim(),
    photoUrl: input.photoUrl,
    caliberMm: input.caliberMm,
    caliberPx: input.caliberPx,
    lengthPx: input.lengthPx,
    memo: String(body.memo || ''),
    checker: '',
    confirmedAt: null,
    invalidReason: '',
    reshootReason: '',
    createdAt: now,
    updatedAt: now,
    history: []
  };
  applyEvaluation(review, evaluation);
  pushHistory(review, '登记复核', review.status === rules.STATUS.RESHOOT ? `进待重拍：${review.reshootReason}` : '照片与换算合格，待另一位测量员确认');
  db.reviews.push(review);
  await writeDb(db);
  res.status(201).json(review);
}

// 受管表不允许直接改写；标尺台账允许维护标定值
app.patch('/api/:collection/:id', async (req, res) => {
  const { collection, id } = req.params;
  if (collection !== 'rulers') {
    return res.status(403).json({ error: '样点与复核记录须通过“基准更正 / 重拍 / 更正历史”工作流修改' });
  }
  const db = await readDb();
  const ruler = db.rulers.find((entry) => entry.id === id);
  if (!ruler) return res.status(404).json({ error: 'not found' });

  const next = {};
  if (req.body.caliberMm !== undefined) {
    const n = positiveNumber(req.body.caliberMm);
    if (!Number.isFinite(n)) return res.status(400).json({ error: '标定长度必须为正数' });
    next.caliberMm = n;
  }
  if (req.body.caliberPx !== undefined) {
    const n = positiveNumber(req.body.caliberPx);
    if (!Number.isFinite(n)) return res.status(400).json({ error: '标定像素必须为正数' });
    next.caliberPx = n;
  }
  if (req.body.note !== undefined) next.note = String(req.body.note);

  const occ = rules.rulerOccupancy(ruler.id, db.reviews);
  if (occ.occupied && (next.caliberMm !== undefined || next.caliberPx !== undefined)) {
    return res.status(409).json({ error: '该标尺仍有未完成复核，不能修改标定值' });
  }
  Object.assign(ruler, next, { updatedAt: new Date().toISOString() });
  pushHistory(ruler, '更新台账', req.body.note || '标定信息维护');
  await writeDb(db);
  res.json(ruler);
});

app.delete('/api/:collection/:id', async (req, res) => {
  const { collection, id } = req.params;
  const db = await readDb();
  if (!Array.isArray(db[collection])) return res.status(404).json({ error: '未知数据表' });
  if (collection === 'rulers') {
    if (db.reviews.some((entry) => entry.rulerId === id)) {
      return res.status(409).json({ error: '标尺已有复核记录，不能删除（可在台账中维护）' });
    }
  } else {
    return res.status(403).json({ error: '样点与复核履历需保留以备追溯，不能删除' });
  }
  db.rulers = db.rulers.filter((entry) => entry.id !== id);
  await writeDb(db);
  res.status(204).end();
});

function findReview(db, id) {
  return db.reviews.find((entry) => entry.id === id);
}

// 重新按最新锚点评估某条复核（不改变状态门槛以外的字段）
function liveEvaluation(db, review) {
  const ruler = db.rulers.find((entry) => entry.id === review.rulerId);
  const site = db.sites.find((entry) => entry.id === review.siteId);
  return rules.evaluateReview(
    { photoUrl: review.photoUrl, caliberMm: review.caliberMm, caliberPx: review.caliberPx, lengthPx: review.lengthPx },
    ruler, site, db.reviews, review.id
  );
}

// 上游变更后，重算同点所有“待确认”记录的长度/锚点/增长（按日期先后）
function recomputePending(db, siteId, excludeId) {
  const pending = db.reviews
    .filter((r) => r.siteId === siteId && r.status === rules.STATUS.PENDING && r.id !== excludeId)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) ||
      String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  pending.forEach((r) => {
    const evaluation = liveEvaluation(db, r);
    applyEvaluation(r, evaluation);
    r.updatedAt = new Date().toISOString();
    const anchorText = evaluation.anchor.source === 'baseline'
      ? `样点基准 ${evaluation.anchor.length} mm`
      : `${evaluation.anchor.date} 已通过复核`;
    pushHistory(r, '增长重算', `上游变更，锚点更新为${anchorText}，增长 ${r.growthMm} mm`);
  });
}

// 历史更正：其后的已通过复核失效
function invalidatePassedAfter(db, siteId, date, reviewId, reason) {
  const cascade = rules.reviewsToInvalidateForCorrection(siteId, date, reviewId, db.reviews);
  cascade.forEach((entry) => {
    entry.status = rules.STATUS.INVALID;
    entry.invalidReason = reason;
    entry.updatedAt = new Date().toISOString();
    pushHistory(entry, '增长失效', `上游 ${date} 复核被更正`);
  });
  return cascade;
}

// ---------- 工作流：登记重拍 ----------
app.post('/api/reviews/reshoot/:id', async (req, res) => {
  const db = await readDb();
  const review = findReview(db, req.params.id);
  if (!review) return res.status(404).json({ error: 'not found' });
  if (![rules.STATUS.RESHOOT, rules.STATUS.INVALID].includes(review.status)) {
    return res.status(409).json({ error: '只有待重拍或已失效的复核可登记重拍' });
  }
  const body = req.body || {};
  if (body.rulerId) {
    const ruler = db.rulers.find((entry) => entry.id === body.rulerId);
    if (!ruler) return res.status(400).json({ error: '标尺不存在' });
    const selectable = rules.rulerSelectable(ruler, db.reviews, review.siteId);
    if (!selectable.usable) return res.status(409).json({ error: '更换的标尺正被另一样点占用' });
    review.rulerId = ruler.id;
  }
  if (body.surveyor && String(body.surveyor).trim()) review.surveyor = String(body.surveyor).trim();
  if (body.photoUrl !== undefined) review.photoUrl = String(body.photoUrl).trim();
  ['caliberMm', 'caliberPx', 'lengthPx'].forEach((key) => {
    if (body[key] !== undefined) review[key] = positiveNumber(body[key]);
  });
  if (!validMeasure(review)) return res.status(400).json({ error: '标尺读数与断面像素必须为正数' });

  const evaluation = liveEvaluation(db, review);
  applyEvaluation(review, evaluation);
  review.checker = '';
  review.confirmedAt = null;
  review.invalidReason = '';
  review.updatedAt = new Date().toISOString();
  pushHistory(review, '登记重拍',
    review.status === rules.STATUS.RESHOOT ? `仍待重拍：${review.reshootReason}` : '重拍合格，重新进入待确认');
  await writeDb(db);
  res.json(review);
});

// ---------- 工作流：另一位测量员确认 ----------
app.post('/api/reviews/confirm/:id', async (req, res) => {
  const db = await readDb();
  const review = findReview(db, req.params.id);
  if (!review) return res.status(404).json({ error: 'not found' });
  if (review.status !== rules.STATUS.PENDING) {
    return res.status(409).json({ error: '仅“待确认”的复核可确认通过' });
  }

  const checker = String(req.body?.checker || '').trim();
  if (!checker) return res.status(400).json({ error: '请填写确认测量员' });
  if (checker === review.surveyor.trim()) {
    return res.status(409).json({ error: '确认测量员必须是另一位测量员，不能由拍摄人自确认' });
  }

  // 以最新锚点重新计算增长，再做连续两次同向 + 0.2 mm 判定
  const evaluation = liveEvaluation(db, review);
  if (evaluation.status !== rules.STATUS.PENDING) {
    return res.status(409).json({ error: `照片或换算已不合格（${evaluation.photoMissing ? '照片缺失' : '换算偏差超过 1%'}），请先登记重拍` });
  }
  const reviewLike = { ...review, status: rules.STATUS.PENDING, surveyor: review.surveyor, growthMm: evaluation.growthMm, anchor: evaluation.anchor };
  const decision = rules.canConfirm(reviewLike, checker);
  if (!decision.ok) return res.status(409).json({ error: decision.reasons.join('；') });

  applyEvaluation(review, evaluation);
  review.status = rules.STATUS.PASSED;
  review.checker = checker;
  review.confirmedAt = new Date().toISOString();
  review.invalidReason = '';
  review.reshootReason = '';
  review.updatedAt = review.confirmedAt;
  const anchorNote = evaluation.anchor.source === 'review'
    ? `较上次增长差值 ${decision.growthDelta} mm（限 0.2 mm）`
    : '该样点首次通过，锚点为基准长度';
  pushHistory(review, '复核通过', `${checker} 确认；增长 ${review.growthMm} mm；${anchorNote}`);
  // 本次通过成为新锚点，其后待确认记录的增长自动重算
  recomputePending(db, review.siteId, review.id);
  await writeDb(db);
  res.json(review);
});

// ---------- 工作流：历史拍摄更正 ----------
app.post('/api/reviews/correct/:id', async (req, res) => {
  const db = await readDb();
  const review = findReview(db, req.params.id);
  if (!review) return res.status(404).json({ error: 'not found' });
  if (review.status !== rules.STATUS.PASSED) {
    return res.status(409).json({ error: '只能更正已通过的历史拍摄记录' });
  }
  const body = req.body || {};
  if (body.photoUrl !== undefined) review.photoUrl = String(body.photoUrl).trim();
  ['caliberMm', 'caliberPx', 'lengthPx'].forEach((key) => {
    if (body[key] !== undefined) review[key] = positiveNumber(body[key]);
  });
  if (!validMeasure(review)) return res.status(400).json({ error: '标尺读数与断面像素必须为正数' });

  const evaluation = liveEvaluation(db, review);
  applyEvaluation(review, evaluation);
  review.checker = '';
  review.confirmedAt = null;
  review.invalidReason = '历史拍摄已更正，原通过结论作废，需重新确认';
  review.updatedAt = new Date().toISOString();
  const cascadeCount = invalidatePassedAfter(
    db, review.siteId, review.date, review.id,
    `${review.date} 的历史拍摄更正，后续增长链失效待重算`
  ).length;
  // 后续“待确认”记录不失效，但锚点与增长立即按新链重算
  recomputePending(db, review.siteId, review.id);
  pushHistory(review, '更正历史拍摄',
    `${body.reason || '更正像素/毫米读数'}；${cascadeCount ? `联动失效 ${cascadeCount} 条后续复核` : '无后续已通过复核'}`);
  await writeDb(db);
  res.json(review);
});

// ---------- 工作流：样点基准更正 ----------
app.post('/api/sites/baseline/:id', async (req, res) => {
  const db = await readDb();
  const site = db.sites.find((entry) => entry.id === req.params.id);
  if (!site) return res.status(404).json({ error: 'not found' });
  const next = positiveNumber(req.body?.baselineMm);
  if (!Number.isFinite(next)) return res.status(400).json({ error: '新基准长度必须为正数' });

  const previous = site.baselineMm;
  site.baselineMm = next;
  site.updatedAt = new Date().toISOString();
  pushHistory(site, '基准更正', `${previous} mm → ${next} mm；${req.body?.reason || ''}`);

  const cascade = rules.reviewsToInvalidateForBaseline(site.id, db.reviews);
  cascade.forEach((entry) => {
    entry.status = rules.STATUS.INVALID;
    entry.invalidReason = '样点基准更正，相关增长全部失效，需重拍复核';
    entry.updatedAt = new Date().toISOString();
    pushHistory(entry, '增长失效', '样点基准更正');
  });
  // 尚未通过的待确认记录直接按新基准重算
  recomputePending(db, site.id, null);
  await writeDb(db);
  res.json(site);
});

app.listen(PORT, () => {
  console.log(`${config.title} running at http://localhost:${PORT}`);
});
