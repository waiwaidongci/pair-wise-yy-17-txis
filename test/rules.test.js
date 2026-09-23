const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../domain/rules');

test('像素毫米换算：k = 标尺毫米 / 标尺像素', () => {
  assert.equal(R.mmPerPx(100, 2000), 0.05);
  assert.equal(R.mmPerPx(0, 2000), null);
  assert.equal(R.mmPerPx(100, 0), null);
});

test('照片缺失只进待重拍', () => {
  const result = R.evaluateIntake({ photoUrl: '   ', scaleMm: 100, scalePixels: 2000, sectionPixels: 100 }, 0.05);
  assert.equal(result.ok, false);
  assert.equal(result.status, R.STATUS.SHOT_RESHOOT);
  assert.match(result.reason, /照片缺失/);
});

test('换算偏差恰好 1% 采用，超过 1% 待重拍', () => {
  // 基准 0.05；1.01 倍 => 0.0505，偏差恰好 1%（边界允许）
  const atLimit = R.evaluateIntake({ photoUrl: 'p.jpg', scaleMm: 101, scalePixels: 2000, sectionPixels: 100 }, 0.05);
  assert.equal(atLimit.ok, true);
  assert.ok(Math.abs(atLimit.deviationPct - 1) < 1e-6);

  // 1.02 倍 => 2%，进待重拍
  const over = R.evaluateIntake({ photoUrl: 'p.jpg', scaleMm: 102, scalePixels: 2000, sectionPixels: 100 }, 0.05);
  assert.equal(over.ok, false);
  assert.equal(over.status, R.STATUS.SHOT_RESHOOT);
  assert.match(over.reason, /换算偏差/);
});

test('标尺或断面像素读数无效进待重拍', () => {
  assert.equal(R.evaluateIntake({ photoUrl: 'p.jpg', scaleMm: 100, scalePixels: '', sectionPixels: 100 }, 0.05).ok, false);
  assert.equal(R.evaluateIntake({ photoUrl: 'p.jpg', scaleMm: 100, scalePixels: 2000, sectionPixels: '' }, 0.05).ok, false);
});

test('连续两次增长：同向且差值不超过 0.2mm 才通过', () => {
  const g1 = { delta: 0.24 };
  const g2 = { delta: 0.31 };
  assert.equal(R.evaluatePair(g1, g2).ok, true); // 差 0.07

  const opposite = R.evaluatePair(g1, { delta: -0.3 });
  assert.equal(opposite.ok, false);
  assert.match(opposite.errors[0], /方向不一致/);

  const tooFar = R.evaluatePair(g1, { delta: 0.5 });
  assert.equal(tooFar.ok, false);
  assert.match(tooFar.errors[0], /超过 0.2mm/);

  // 只有一次增长不能确认
  assert.equal(R.evaluatePair(null, g1).ok, false);
});

test('确认人不能是两张照片的拍摄人', () => {
  const current = { status: R.STATUS.GROWTH_PENDING, delta: 0.31, fromShotId: 's1', toShotId: 's2' };
  const previous = { delta: 0.24 };
  const shots = { s1: { photographer: '沈宁' }, s2: { photographer: '江屿' } };
  const shotById = (id) => shots[id];

  assert.equal(R.canConfirm(current, previous, shotById, '黎澈').ok, true);
  const self = R.canConfirm(current, previous, shotById, '沈宁');
  assert.equal(self.ok, false);
  assert.match(self.errors.join(','), /另一位测量员/);
  assert.equal(R.canConfirm(current, previous, shotById, '').ok, false);
});

test('基准/历史更正后重算增长，新增长全部回到待确认', () => {
  const point = { id: 'pt', baselinePx: 1000, baselineScaleMm: 100, baselineScalePixels: 2000 }; // 基准位置 50mm
  const shots = [
    { id: 's1', pointId: 'pt', date: '2026-06-01', status: R.STATUS.SHOT_ACCEPTED, mmPerPx: 0.05, sectionPixels: 1005 }, // 50.25
    { id: 's2', pointId: 'pt', date: '2026-07-01', status: R.STATUS.SHOT_ACCEPTED, mmPerPx: 0.05, sectionPixels: 1011 }, // 50.55
    { id: 's3', pointId: 'pt', date: '2026-08-01', status: R.STATUS.RESHOOT || R.STATUS.SHOT_RESHOOT, mmPerPx: 0.07, sectionPixels: 900 }
  ];
  let seq = 0;
  const growths = R.rebuildGrowths(point, shots, () => `g${++seq}`);
  assert.equal(growths.length, 1); // 待重拍照片不参与
  assert.equal(growths[0].delta, 0.3);
  assert.equal(growths[0].status, R.STATUS.GROWTH_PENDING);
  assert.equal(growths[0].confirmer, '');
});

test('关闭复核：有待重拍或待确认时不能关闭', () => {
  const review = { id: 'rv', pointId: 'pt', status: R.STATUS.REVIEW_OPEN };
  const shots = [{ pointId: 'pt', status: R.STATUS.SHOT_ACCEPTED, id: 's1' }];
  assert.equal(R.canCloseReview(review, shots, [], '黎澈').ok, true);

  const reshoots = [...shots, { pointId: 'pt', status: R.STATUS.SHOT_RESHOOT, id: 's2' }];
  assert.equal(R.canCloseReview(review, reshoots, [], '黎澈').ok, false);

  const pending = [{ pointId: 'pt', status: R.STATUS.GROWTH_PENDING, toShotId: 's1' }];
  assert.equal(R.canCloseReview(review, shots, pending, '黎澈').ok, false);

  const confirmed = [{ pointId: 'pt', status: R.STATUS.GROWTH_CONFIRMED, toShotId: 's1' }];
  assert.equal(R.canCloseReview(review, shots, confirmed, '黎澈').ok, true);
});
