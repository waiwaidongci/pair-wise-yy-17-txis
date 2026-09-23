/*
 * 规则层（rules.js）
 * 钟乳石断面摄影测量复核的全部业务阈值与判定规则集中在此。
 * 不含任何 HTTP 或文件存储代码；浏览器与 Node 共用同一份规则。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.rules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // —— 阈值（需求中写死的规则）——
  var SCALE_TOLERANCE = 0.01;       // 换算偏差超过 1% 只进待重拍
  var GROWTH_DELTA_LIMIT = 0.2;     // 连续两次增长差值不超过 0.2 mm
  var LENGTH_PRECISION = 3;         // 断面长度保留 3 位小数

  // —— 复核状态 ——
  var STATUS = {
    RESHOOT: '待重拍',
    PENDING: '待确认',
    PASSED: '已通过',
    INVALID: '已失效'
  };
  var REVIEW_STATUSES = [STATUS.RESHOOT, STATUS.PENDING, STATUS.PASSED, STATUS.INVALID];

  function round(value, digits) {
    var factor = Math.pow(10, digits == null ? LENGTH_PRECISION : digits);
    return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
  }

  function toNumber(value) {
    var n = Number(value);
    return Number.isFinite(n) ? n : NaN;
  }

  // 照片缺失判定：空白链接视为缺失
  function photoMissing(photoUrl) {
    return !photoUrl || !String(photoUrl).trim();
  }

  // 像素与毫米换算：每像素对应毫米数
  function scaleMmPerPx(caliberMm, caliberPx) {
    return toNumber(caliberMm) / toNumber(caliberPx);
  }

  // 与标尺标定值的换算偏差（带符号百分比，绝对值 > 1% 即超限）
  function scaleDeviationPct(caliberMm, caliberPx, ruler) {
    if (!ruler || !toNumber(ruler.caliberMm) || !toNumber(ruler.caliberPx)) return NaN;
    var expected = scaleMmPerPx(ruler.caliberMm, ruler.caliberPx);
    if (!expected) return NaN;
    var observed = scaleMmPerPx(caliberMm, caliberPx);
    return (observed - expected) / expected;
  }

  function scaleOutOfTolerance(deviationPct) {
    return Number.isFinite(deviationPct) && Math.abs(deviationPct) > SCALE_TOLERANCE;
  }

  // 断面长度（毫米）
  function sectionLengthMm(lengthPx, caliberMm, caliberPx) {
    return round(toNumber(lengthPx) * scaleMmPerPx(caliberMm, caliberPx));
  }

  /*
   * 标尺占用：同一标尺复核完成前不能给别的样点使用。
   * “未完成”＝存在已占用该标尺的样点，其链条上有非“已通过”记录
   *（待重拍/待确认/已失效都会把标尺锁住；已失效仍属同一样点的未结链条）。
   */
  function rulerOccupancy(rulerId, reviews) {
    var mine = (reviews || []).filter(function (r) { return r.rulerId === rulerId; });
    var open = mine.find(function (r) { return r.status !== STATUS.PASSED; });
    return { occupied: !!open, siteId: open ? open.siteId : null, reviewId: open ? open.id : null };
  }

  // 某样点最近一次“已通过”的复核，作为增长锚点
  function latestPassed(siteId, reviews) {
    return (reviews || [])
      .filter(function (r) { return r.siteId === siteId && r.status === STATUS.PASSED; })
      .sort(function (a, b) {
        return String(b.date).localeCompare(String(a.date)) ||
          String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
      })[0] || null;
  }

  // 锚点长度：有已通过复核用其断面长度，否则回退到样点基准长度
  function anchorLengthMm(siteId, reviews) {
    var passed = latestPassed(typeof siteId === 'object' && siteId ? siteId.id : siteId, reviews);
    if (passed) {
      return {
        length: toNumber(passed.lengthMm),
        source: 'review',
        reviewId: passed.id,
        date: passed.date,
        growthMm: toNumber(passed.growthMm) // 锚点复核自身的增长，用于“连续两次同向”判定
      };
    }
    var site = typeof siteId === 'object' && siteId ? siteId : null;
    return { length: toNumber(site && site.baselineMm), source: 'baseline', reviewId: null, date: null, growthMm: null };
  }

  // 计算增长：长度、增长毫米数、相对锚点
  function evaluateReview(input, ruler, site, reviews, excludeId) {
    var others = (reviews || []).filter(function (r) { return r.id !== excludeId; });
    var photoMiss = photoMissing(input.photoUrl);
    var deviation = scaleDeviationPct(input.caliberMm, input.caliberPx, ruler);
    var lengthMm = sectionLengthMm(input.lengthPx, input.caliberMm, input.caliberPx);
    var anchor = anchorLengthMm(site, others);
    var growthMm = Number.isFinite(lengthMm) && Number.isFinite(anchor.length) ? round(lengthMm - anchor.length) : NaN;
    var needReshoot = photoMiss || scaleOutOfTolerance(deviation);
    return {
      photoMissing: photoMiss,
      scaleDeviationPct: deviation,
      scaleOutOfTolerance: scaleOutOfTolerance(deviation),
      lengthMm: lengthMm,
      anchor: anchor,
      growthMm: growthMm,
      status: needReshoot ? STATUS.RESHOOT : STATUS.PENDING
    };
  }

  // 增长方向：正/负，0 视为“无方向”，不满足同向
  function direction(growthMm) {
    if (!Number.isFinite(growthMm) || growthMm === 0) return 0;
    return growthMm > 0 ? 1 : -1;
  }

  /*
   * 另一位测量员确认通过的条件：
   * 1. 复核必须处于“待确认”（照片与换算已合格）；
   * 2. 确认人必须不同于拍摄测量员；
   * 3. 若锚点本身来自一次已通过复核，则需“连续两次增长同向且差值不超过 0.2 mm”；
   *    锚点为样点基准（该样点首次通过）时没有上一次增长可比对，不设同向门槛。
   */
  function canConfirm(review, checkerName) {
    var reasons = [];
    if (review.status !== STATUS.PENDING) reasons.push('仅“待确认”的复核可确认通过');
    if (!checkerNameValid(checkerName)) reasons.push('请填写确认测量员');
    if (checkerName && review.surveyor && String(checkerName).trim() === String(review.surveyor).trim()) {
      reasons.push('确认测量员必须是另一位测量员，不能由拍摄人自确认');
    }

    var anchor = review.anchor || null;
    var sameDirection = true;
    var growthDelta = NaN;
    if (anchor && anchor.source === 'review' && Number.isFinite(anchor.growthMm)) {
      growthDelta = Math.abs(review.growthMm - anchor.growthMm);
      sameDirection = direction(review.growthMm) !== 0 &&
        direction(review.growthMm) === direction(anchor.growthMm) &&
        growthDelta <= GROWTH_DELTA_LIMIT + Number.EPSILON;
      if (!sameDirection) {
        reasons.push('连续两次增长未同向，或增长量差值超过 0.2 mm');
      }
    }
    return {
      ok: reasons.length === 0,
      reasons: reasons,
      anchor: anchor,
      growthDelta: Number.isFinite(growthDelta) ? round(growthDelta) : null
    };
  }

  function checkerNameValid(name) {
    return !!name && !!String(name).trim();
  }

  // 标尺在“新建复核”时是否可用（busySite 与当前样点相同则允许同点连续使用）
  function rulerSelectable(ruler, reviews, siteId) {
    var occ = rulerOccupancy(ruler.id, reviews);
    if (!occ.occupied) return { usable: true, occupancy: occ };
    return { usable: occ.siteId === siteId, occupancy: occ };
  }

  // 基准更正：该样点所有“已通过”复核失效
  function reviewsToInvalidateForBaseline(siteId, reviews) {
    return (reviews || []).filter(function (r) {
      return r.siteId === siteId && r.status === STATUS.PASSED;
    });
  }

  // 历史拍摄更正：被更正记录之后（含同日更晚登记）的同点“已通过”复核失效；
  // 被更正记录自身由调用方处理。
  function reviewsToInvalidateForCorrection(siteId, date, reviewId, reviews) {
    var target = (reviews || []).find(function (r) { return r.id === reviewId; });
    var targetCreated = target ? String(target.createdAt || '') : '';
    return (reviews || []).filter(function (r) {
      if (r.id === reviewId || r.siteId !== siteId || r.status !== STATUS.PASSED) return false;
      if (String(r.date) > String(date)) return true;
      if (String(r.date) === String(date) && targetCreated && String(r.createdAt || '') >= targetCreated) return true;
      return false;
    });
  }

  return {
    SCALE_TOLERANCE: SCALE_TOLERANCE,
    GROWTH_DELTA_LIMIT: GROWTH_DELTA_LIMIT,
    LENGTH_PRECISION: LENGTH_PRECISION,
    STATUS: STATUS,
    REVIEW_STATUSES: REVIEW_STATUSES,
    round: round,
    photoMissing: photoMissing,
    scaleMmPerPx: scaleMmPerPx,
    scaleDeviationPct: scaleDeviationPct,
    scaleOutOfTolerance: scaleOutOfTolerance,
    sectionLengthMm: sectionLengthMm,
    rulerOccupancy: rulerOccupancy,
    rulerSelectable: rulerSelectable,
    latestPassed: latestPassed,
    anchorLengthMm: anchorLengthMm,
    evaluateReview: evaluateReview,
    canConfirm: canConfirm,
    direction: direction,
    reviewsToInvalidateForBaseline: reviewsToInvalidateForBaseline,
    reviewsToInvalidateForCorrection: reviewsToInvalidateForCorrection
  };
});
