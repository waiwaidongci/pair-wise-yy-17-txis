/**
 * 摄影测量复核台 —— 服务层
 * 所有业务动作在此用 domain/rules.js 校验，存储交给 domain/store.js；页面只负责展示与提交。
 */
const express = require('express');
const path = require('path');
const R = require('./domain/rules');
const store = require('./domain/store');

const app = express();
const PORT = process.env.PORT || 3912;

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));
// 页面与服务端共用同一份规则（前端即时提示，服务端强制校验）
app.get('/domain/rules.js', (req, res) => res.sendFile(path.join(__dirname, 'domain', 'rules.js')));

function fail(res, status, error) {
  return res.status(status).json({ error });
}

function touch(record) {
  record.updatedAt = new Date().toISOString();
  return record;
}

function sortedShots(db, pointId) {
  return db.shots
    .filter((shot) => shot.pointId === pointId && shot.status === R.STATUS.SHOT_ACCEPTED)
    .sort(R.compareShots);
}

/** 基准/历史更正：旧增长全部保留并标记“已失效”，再按现有采用照片重算 */
function invalidateAndRebuild(db, point, reason) {
  const now = new Date().toISOString();
  db.growths
    .filter((growth) => growth.pointId === point.id && growth.status !== R.STATUS.GROWTH_INVALID)
    .forEach((growth) => {
      growth.status = R.STATUS.GROWTH_INVALID;
      growth.confirmedAt = null;
      touch(growth);
      store.addHistory(growth, '增长失效重算', reason);
    });

  const rebuilt = R.rebuildGrowths(point, db.shots, () => R.nextId('gr'));
  rebuilt.forEach((growth) => {
    growth.createdAt = now;
    growth.updatedAt = now;
    growth.history = [{ at: now, action: '增长重算生成，待另一位测量员确认', note: reason }];
    db.growths.push(growth);
  });
  return rebuilt;
}

function openReviewForPoint(db, pointId) {
  return db.reviews.find((review) => review.pointId === pointId && review.status === R.STATUS.REVIEW_OPEN);
}

// ---------- 读取 ----------

app.get('/api/db', async (req, res) => {
  const db = await store.load();
  res.json(db);
});

// ---------- 样点 ----------

app.post('/api/points', async (req, res) => {
  const db = await store.load();
  const b = req.body || {};
  const code = (b.code || '').trim();
  if (!code) return fail(res, 400, '样点编号必填');
  if (db.points.some((point) => point.code === code)) return fail(res, 409, `样点编号 ${code} 已存在`);

  const now = new Date().toISOString();
  const point = {
    id: R.nextId('pt'),
    code,
    cave: (b.cave || '').trim(),
    zone: (b.zone || '').trim(),
    note: (b.note || '').trim(),
    baselineScaleMm: null,
    baselineScalePixels: null,
    baselinePx: null,
    baselineMmPerPx: null,
    baselineShotId: null,
    baselineAt: '',
    baselineBy: '',
    createdAt: now,
    updatedAt: now,
    history: [{ at: now, action: '样点建档', note: '基准尚未设定，第一张采用照片将作为基准' }]
  };
  db.points.push(point);
  await store.save(db);
  res.status(201).json(point);
});

/** 设定或更正样点基准 -> 相关增长全部失效重算 */
app.post('/api/points/:id/baseline', async (req, res) => {
  const db = await store.load();
  const point = store.find(db, 'points', req.params.id);
  if (!point) return fail(res, 404, '样点不存在');
  const b = req.body || {};

  const scaleMm = Number(b.baselineScaleMm);
  const scalePixels = Number(b.baselineScalePixels);
  const baselinePx = Number(b.baselinePx);
  const k = R.mmPerPx(scaleMm, scalePixels);
  if (k === null) return fail(res, 400, '基准标尺毫米数/像素读数无效');
  if (!R.isFiniteNumber(baselinePx) || baselinePx <= 0) return fail(res, 400, '基准断面像素读数无效');
  const operator = (b.operator || '').trim();
  if (!operator) return fail(res, 400, '需要填写操作人');

  const now = new Date().toISOString();
  const hadBaseline = point.baselineMmPerPx !== null;
  Object.assign(point, {
    baselineScaleMm: scaleMm,
    baselineScalePixels: scalePixels,
    baselinePx,
    baselineMmPerPx: k,
    baselineAt: (b.baselineAt || '').slice(0, 10) || now.slice(0, 10),
    baselineBy: operator
  }, touch(point));
  store.addHistory(
    point,
    hadBaseline ? '基准更正，相关增长失效重算' : '设定基准',
    `断面 ${baselinePx}px = ${R.round(baselinePx * k, 3)}mm，换算 ${k}mm/px；操作人 ${operator}`
  );

  const rebuilt = invalidateAndRebuild(db, point, '样点基准更正');

  await store.save(db);
  res.json({ point, rebuiltGrowths: rebuilt.length });
});

// ---------- 标尺 ----------

app.post('/api/rods', async (req, res) => {
  const db = await store.load();
  const b = req.body || {};
  const code = (b.code || '').trim();
  const lengthMm = Number(b.lengthMm);
  if (!code) return fail(res, 400, '标尺编号必填');
  if (!R.isFiniteNumber(lengthMm) || lengthMm <= 0) return fail(res, 400, '标尺长度(mm)无效');
  if (db.rods.some((rod) => rod.code === code)) return fail(res, 409, `标尺编号 ${code} 已登记`);

  const now = new Date().toISOString();
  const rod = {
    id: R.nextId('rd'),
    code,
    lengthMm,
    status: R.STATUS.ROD_IN_STOCK,
    currentReviewId: null,
    note: (b.note || '').trim(),
    createdAt: now,
    updatedAt: now,
    history: [{ at: now, action: '标尺登记入库', note: `长度 ${lengthMm}mm` }]
  };
  db.rods.push(rod);
  await store.save(db);
  res.status(201).json(rod);
});

// ---------- 复核（标尺借用/归还） ----------

/** 开启复核：选定样点与在库标尺；同一标尺复核完成前不能给别的样点使用 */
app.post('/api/reviews', async (req, res) => {
  const db = await store.load();
  const b = req.body || {};
  const point = store.find(db, 'points', b.pointId);
  const rod = store.find(db, 'rods', b.rodId);
  if (!point) return fail(res, 404, '样点不存在');
  if (!rod) return fail(res, 404, '标尺不存在');
  if (rod.status !== R.STATUS.ROD_IN_STOCK) {
    return fail(res, 409, `标尺 ${rod.code} 正在复核 ${rod.currentReviewId || ''} 中，完成前不能给别的样点使用`);
  }
  if (openReviewForPoint(db, point.id)) {
    return fail(res, 409, `样点 ${point.code} 已有进行中的复核，请先完成或关闭`);
  }
  const openedBy = (b.openedBy || '').trim();
  if (!openedBy) return fail(res, 400, '需要填写开启人');

  const now = new Date().toISOString();
  const review = {
    id: R.nextId('rv'),
    pointId: point.id,
    rodId: rod.id,
    purpose: (b.purpose || '').trim(),
    status: R.STATUS.REVIEW_OPEN,
    openedAt: now,
    openedBy,
    closedAt: null,
    closedBy: '',
    closeNote: '',
    createdAt: now,
    updatedAt: now,
    history: [{ at: now, action: `开启复核并启用标尺 ${rod.code}`, note: b.purpose || '' }]
  };
  db.reviews.push(review);
  rod.status = R.STATUS.ROD_BUSY;
  rod.currentReviewId = review.id;
  touch(rod);
  store.addHistory(rod, '标尺启用（锁定）', `复核 ${review.id}（样点 ${point.code}）`);

  await store.save(db);
  res.status(201).json(review);
});

/** 关闭复核 = 该标尺本次复核完成，归库可再借用 */
app.post('/api/reviews/:id/close', async (req, res) => {
  const db = await store.load();
  const review = store.find(db, 'reviews', req.params.id);
  if (!review) return fail(res, 404, '复核不存在');
  const closedBy = ((req.body || {}).closedBy || '').trim();
  const closeNote = ((req.body || {}).closeNote || '').trim();
  const reviewShots = db.shots.filter((shot) => shot.reviewId === review.id);
  const check = R.canCloseReview(review, reviewShots, db.growths, closedBy);
  if (!check.ok) return fail(res, 409, check.errors.join('；'));

  const now = new Date().toISOString();
  review.status = R.STATUS.REVIEW_CLOSED;
  review.closedAt = now;
  review.closedBy = closedBy;
  review.closeNote = closeNote;
  touch(review);
  store.addHistory(review, '关闭复核并归还标尺', closeNote || '待办全部清零');

  const rod = store.find(db, 'rods', review.rodId);
  if (rod) {
    rod.status = R.STATUS.ROD_IN_STOCK;
    rod.currentReviewId = null;
    touch(rod);
    store.addHistory(rod, '标尺归库', `复核 ${review.id} 关闭`);
  }

  await store.save(db);
  res.json(review);
});

// ---------- 照片登记 / 重拍 ----------

function buildShotFromInput(db, review, input, now, extra = {}) {
  const point = store.find(db, 'points', review.pointId);
  const rod = store.find(db, 'rods', review.rodId);
  const scaleMm = R.isFiniteNumber(Number(input.scaleMm)) ? Number(input.scaleMm) : rod.lengthMm;
  const scalePixels = input.scalePixels === undefined || input.scalePixels === '' ? null : Number(input.scalePixels);
  const result = R.evaluateIntake(
    { photoUrl: input.photoUrl, scaleMm, scalePixels, sectionPixels: input.sectionPixels },
    point.baselineMmPerPx
  );
  const shot = {
    id: R.nextId('st'),
    pointId: point.id,
    reviewId: review.id,
    rodId: rod.id,
    date: (input.date || now.slice(0, 10)).slice(0, 10),
    photographer: (input.photographer || '').trim(),
    photoUrl: (input.photoUrl || '').trim(),
    scaleMm,
    scalePixels: scalePixels,
    mmPerPx: result.mmPerPx,
    sectionPixels: result.ok ? Number(input.sectionPixels) : null,
    status: result.status,
    deviationPct: result.deviationPct,
    reshootOfId: extra.reshootOfId || null,
    note: (input.note || '').trim(),
    createdAt: now,
    updatedAt: now,
    history: []
  };
  return { shot, result, point };
}

/** 月度标准照登记（进入某进行中的复核） */
app.post('/api/reviews/:id/shots', async (req, res) => {
  const db = await store.load();
  const review = store.find(db, 'reviews', req.params.id);
  if (!review) return fail(res, 404, '复核不存在');
  if (review.status !== R.STATUS.REVIEW_OPEN) return fail(res, 409, '该复核已关闭，不能再登记照片');
  const input = req.body || {};
  if (!(input.photographer || '').trim()) return fail(res, 400, '需要填写拍摄人');
  if (!(input.date || '').trim()) return fail(res, 400, '需要填写拍摄日期');

  const now = new Date().toISOString();
  const { shot, result, point } = buildShotFromInput(db, review, input, now);

  if (!result.ok) {
    store.addHistory(shot, '照片进待重拍', result.reason);
    db.shots.push(shot);
    await store.save(db);
    return res.status(201).json({ shot, growth: null, message: result.reason });
  }

  const previousAccepted = sortedShots(db, point.id);
  const isBaseline = previousAccepted.length === 0 && point.baselineMmPerPx === null;
  if (isBaseline) {
    // 首张采用照片作为该样点基准
    point.baselineScaleMm = shot.scaleMm;
    point.baselineScalePixels = shot.scalePixels;
    point.baselinePx = shot.sectionPixels;
    point.baselineMmPerPx = shot.mmPerPx;
    point.baselineShotId = shot.id;
    point.baselineAt = shot.date;
    point.baselineBy = shot.photographer;
    touch(point);
    store.addHistory(point, '首张采用照片设为基准', `照片 ${shot.id}，换算 ${shot.mmPerPx}mm/px`);
    store.addHistory(shot, '登记采用照片（基准）', `断面位置 ${R.round(shot.sectionPixels * shot.mmPerPx, 3)}mm`);
  } else {
    store.addHistory(shot, '登记采用照片', `断面位置 ${R.round(shot.sectionPixels * shot.mmPerPx, 3)}mm`);
  }

  let growth = null;
  if (!isBaseline) {
    growth = R.growthForNewShot(point, previousAccepted, shot, () => R.nextId('gr'));
    if (growth) {
      growth.createdAt = now;
      growth.updatedAt = now;
      growth.history = [{ at: now, action: '增长生成，待另一位测量员确认', note: '' }];
      db.growths.push(growth);
      store.addHistory(shot, '产生待确认增长', `${growth.delta}mm（${growth.direction}）`);
    }
  }

  db.shots.push(shot);
  await store.save(db);
  res.status(201).json({ shot, growth });
});

/** 重拍：替换某张待重拍照片。通过则采用并补算增长；仍不合格则继续待重拍 */
app.post('/api/shots/:id/reshoot', async (req, res) => {
  const db = await store.load();
  const original = store.find(db, 'shots', req.params.id);
  if (!original) return fail(res, 404, '照片不存在');
  if (original.status !== R.STATUS.SHOT_RESHOOT) return fail(res, 409, '只有待重拍照片可以补拍');
  const review = store.find(db, 'reviews', original.reviewId);
  if (!review || review.status !== R.STATUS.REVIEW_OPEN) return fail(res, 409, '所在复核已关闭');
  const input = req.body || {};
  if (!(input.photographer || '').trim()) return fail(res, 400, '需要填写拍摄人');

  const now = new Date().toISOString();
  const { shot, result, point } = buildShotFromInput(db, review, input, now, { reshootOfId: original.id });

  if (!result.ok) {
    Object.assign(original, {
      date: shot.date,
      photographer: shot.photographer,
      photoUrl: shot.photoUrl,
      scaleMm: shot.scaleMm,
      scalePixels: shot.scalePixels,
      mmPerPx: shot.mmPerPx,
      sectionPixels: null,
      deviationPct: result.deviationPct,
      note: shot.note
    }, touch(original));
    store.addHistory(original, '重拍仍不合格，继续待重拍', result.reason);
    await store.save(db);
    return jsonShot(res, original, null, result.reason);
  }

  // 重拍通过：沿用原记录 id，保持履历连续
  Object.assign(original, {
    date: shot.date,
    photographer: shot.photographer,
    photoUrl: shot.photoUrl,
    scaleMm: shot.scaleMm,
    scalePixels: shot.scalePixels,
    mmPerPx: shot.mmPerPx,
    sectionPixels: shot.sectionPixels,
    status: R.STATUS.SHOT_ACCEPTED,
    deviationPct: result.deviationPct,
    note: shot.note
  }, touch(original));

  const previousAccepted = sortedShots(db, point.id).filter((item) => item.id !== original.id);
  const isBaseline = previousAccepted.length === 0 && point.baselineMmPerPx === null;
  let growth = null;
  if (isBaseline) {
    point.baselineScaleMm = original.scaleMm;
    point.baselineScalePixels = original.scalePixels;
    point.baselinePx = original.sectionPixels;
    point.baselineMmPerPx = original.mmPerPx;
    point.baselineShotId = original.id;
    point.baselineAt = original.date;
    point.baselineBy = original.photographer;
    touch(point);
    store.addHistory(point, '重拍采用照片设为基准', `照片 ${original.id}`);
    store.addHistory(original, '重拍通过并采用（基准）', `断面位置 ${R.round(original.sectionPixels * original.mmPerPx, 3)}mm`);
  } else {
    growth = R.growthForNewShot(point, previousAccepted, original, () => R.nextId('gr'));
    if (growth) {
      growth.createdAt = now;
      growth.updatedAt = now;
      growth.history = [{ at: now, action: '重拍补算增长，待另一位测量员确认', note: '' }];
      db.growths.push(growth);
    }
    store.addHistory(original, '重拍通过并采用', `断面位置 ${R.round(original.sectionPixels * original.mmPerPx, 3)}mm`);
  }

  await store.save(db);
  res.status(201).json({ shot: original, growth });
});

function jsonShot(res, shot, growth, message) {
  return res.status(201).json({ shot, growth, message });
}

/** 更正历史拍摄读数 -> 相关增长全部失效重算 */
app.post('/api/shots/:id/correct', async (req, res) => {
  const db = await store.load();
  const shot = store.find(db, 'shots', req.params.id);
  if (!shot) return fail(res, 404, '照片不存在');
  if (shot.status !== R.STATUS.SHOT_ACCEPTED) return fail(res, 409, '只能更正已采用照片；待重拍照片请走重拍');
  const point = store.find(db, 'points', shot.pointId);
  const input = req.body || {};
  const operator = (input.operator || '').trim();
  if (!operator) return fail(res, 400, '需要填写更正人');

  const patch = {
    photoUrl: (input.photoUrl ?? shot.photoUrl).trim(),
    scaleMm: input.scaleMm !== undefined ? Number(input.scaleMm) : shot.scaleMm,
    scalePixels: input.scalePixels !== undefined ? Number(input.scalePixels) : shot.scalePixels,
    sectionPixels: input.sectionPixels !== undefined ? Number(input.sectionPixels) : shot.sectionPixels
  };
  const result = R.evaluateIntake(patch, point.baselineMmPerPx);
  if (!result.ok) {
    return fail(res, 409, `更正后${result.reason}；请安排重拍，历史拍摄读数未改动`);
  }

  const before = `标尺 ${shot.scalePixels}px / 断面 ${shot.sectionPixels}px`;
  Object.assign(shot, {
    photoUrl: patch.photoUrl,
    scaleMm: patch.scaleMm,
    scalePixels: patch.scalePixels,
    mmPerPx: result.mmPerPx,
    sectionPixels: patch.sectionPixels,
    deviationPct: result.deviationPct
  }, touch(shot));
  store.addHistory(shot, '历史拍摄更正，相关增长失效重算', `${before} -> 标尺 ${patch.scalePixels}px / 断面 ${patch.sectionPixels}px；更正人 ${operator}`);

  const rebuilt = invalidateAndRebuild(db, point, `历史拍摄 ${shot.date} 读数更正（${operator}）`);

  await store.save(db);
  res.json({ shot, rebuiltGrowths: rebuilt.length });
});

// ---------- 增长确认（另一位测量员） ----------

app.post('/api/growths/:id/confirm', async (req, res) => {
  const db = await store.load();
  const current = store.find(db, 'growths', req.params.id);
  if (!current) return fail(res, 404, '增长记录不存在');

  // 候选配对：同一样点、按日期相邻的上一条非失效增长
  const chain = db.growths
    .filter((growth) => growth.pointId === current.pointId && growth.status !== R.STATUS.GROWTH_INVALID)
    .sort((a, b) => String(a.toDate).localeCompare(String(b.toDate)) || String(a.createdAt).localeCompare(String(b.createdAt)));
  const index = chain.indexOf(current);
  const previous = index > 0 ? chain[index - 1] : null;
  const shotById = (id) => db.shots.find((shot) => shot.id === id);
  const confirmer = ((req.body || {}).confirmer || '').trim();

  const check = R.canConfirm(current, previous, shotById, confirmer);
  if (!check.ok) return fail(res, 409, check.errors.join('；'));

  const now = new Date().toISOString();
  const targets = [previous, current];
  targets.forEach((growth) => {
    growth.status = R.STATUS.GROWTH_CONFIRMED;
    growth.confirmer = confirmer;
    growth.confirmedAt = now;
    touch(growth);
    store.addHistory(
      growth,
      '增长已确认',
      `确认人 ${confirmer}，连续两次同向、差值 ${check.pair.difference}mm`
    );
  });

  await store.save(db);
  res.json({ confirmed: targets.map((growth) => growth.id) });
});

app.listen(PORT, () => {
  console.log(`钟乳石摄影测量复核台 running at http://localhost:${PORT}`);
});
