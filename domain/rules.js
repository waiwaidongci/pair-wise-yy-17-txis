/**
 * 摄影测量复核台 —— 规则层（纯函数，前后端共用）
 *
 * 业务规则：
 * 1. 标尺登记：编号 + 物理长度(mm)；照片内标尺像素长度 -> 像素/毫米换算系数 k = 标尺mm / 标尺像素。
 * 2. 同一标尺在某样点复核完成（复核关闭、标尺归库）前，不能给别的样点使用。
 * 3. 照片缺失，或换算系数相对该样点基准系数偏差超过 1%，只进“待重拍”，不参与增长计算。
 * 4. 增长 = 相邻两张采用照片的断面位置(mm)之差。另一位测量员确认：
 *    连续两次增长同向且两次差值不超过 0.2mm，且确认人不是两张照片的拍摄人，才通过。
 * 5. 样点基准更正、或历史拍摄更正，会使相关增长全部失效并按现有照片重算。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Rules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEVIATION_LIMIT = 0.01; // 换算偏差阈值：1%
  const MAX_PAIR_DELTA = 0.2;   // 连续两次增长允许的最大差值：0.2mm

  const STATUS = {
    SHOT_ACCEPTED: '已采用',
    SHOT_RESHOOT: '待重拍',
    GROWTH_PENDING: '待确认',
    GROWTH_CONFIRMED: '已确认',
    GROWTH_INVALID: '已失效',
    REVIEW_OPEN: '进行中',
    REVIEW_CLOSED: '已关闭',
    ROD_IN_STOCK: '在库',
    ROD_BUSY: '使用中'
  };

  function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
  }

  function round(value, digits = 3) {
    const factor = 10 ** digits;
    return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
  }

  /** 像素 -> 毫米换算系数（每像素多少毫米） */
  function mmPerPx(scaleMm, scalePixels) {
    if (!isFiniteNumber(scaleMm) || !isFiniteNumber(scalePixels)) return null;
    if (scaleMm <= 0 || scalePixels <= 0) return null;
    return round(scaleMm / scalePixels, 6);
  }

  /** 换算系数相对基准系数的相对偏差（百分比数值，如 1.25 表示 1.25%）；无基准时返回 null */
  function deviationPct(actual, reference) {
    if (!isFiniteNumber(actual) || !isFiniteNumber(reference) || reference <= 0) return null;
    return round((Math.abs(actual - reference) / reference) * 100, 3);
  }

  /**
   * 复核一次拍摄登记。
   * @param {object} input { photoUrl, scaleMm, scalePixels, sectionPixels }
   * @param {number|null} referenceMmPerPx 样点基准换算系数；建立基准前为 null（不校验偏差）
   * @returns {{ok:boolean,status:string,reason?:string,mmPerPx?:number,deviationPct?:number|null}}
   */
  function evaluateIntake(input, referenceMmPerPx) {
    const photoUrl = (input.photoUrl || '').trim();
    if (!photoUrl) return fail('照片缺失，进待重拍');

    const scaleMm = Number(input.scaleMm);
    const scalePixels = Number(input.scalePixels);
    const k = mmPerPx(scaleMm, scalePixels);
    if (k === null) return fail('标尺毫米数或标尺像素读数缺失/无效，进待重拍');

    const sectionPixels = Number(input.sectionPixels);
    if (!isFiniteNumber(sectionPixels) || sectionPixels <= 0) {
      return fail('断面对应像素读数缺失/无效，进待重拍');
    }

    const deviation = deviationPct(k, referenceMmPerPx);
    if (deviation !== null && deviation > DEVIATION_LIMIT * 100) {
      return fail(`换算偏差 ${deviation}% 超过 ${DEVIATION_LIMIT * 100}%，进待重拍`, k, deviation);
    }
    return { ok: true, status: STATUS.SHOT_ACCEPTED, mmPerPx: k, deviationPct: deviation };
  }

  function fail(reason, k = null, deviation = null) {
    return { ok: false, status: STATUS.SHOT_RESHOOT, reason, mmPerPx: k, deviationPct: deviation };
  }

  function directionLabel(delta) {
    if (delta > 0) return '正向增长';
    if (delta < 0) return '负向（回缩）';
    return '持平';
  }

  /** 构造一条增长记录（新算出的增长一律“待确认”） */
  function buildGrowth(params) {
    const delta = round(params.delta, 3);
    return {
      id: params.id,
      pointId: params.pointId,
      fromShotId: params.fromShotId,
      toShotId: params.toShotId,
      fromDate: params.fromDate,
      toDate: params.toDate,
      delta,
      direction: directionLabel(delta),
      status: STATUS.GROWTH_PENDING,
      confirmer: '',
      confirmedAt: null
    };
  }

  /**
   * 连续两次增长的配对校验。
   * @returns {{ok:boolean, sameDirection:boolean, difference:number, errors:string[]}}
   */
  function evaluatePair(previous, current) {
    const errors = [];
    if (!previous) {
      return { ok: false, hasPair: false, sameDirection: false, difference: null, errors: ['需要连续两次增长才能确认（当前只有一次）'] };
    }
    const sameDirection = Math.sign(previous.delta) === Math.sign(current.delta) && current.delta !== 0;
    const difference = round(Math.abs(current.delta - previous.delta), 3);
    if (!sameDirection) errors.push('连续两次增长方向不一致');
    if (difference > MAX_PAIR_DELTA) errors.push(`两次增长差值 ${difference}mm 超过 ${MAX_PAIR_DELTA}mm`);
    return { ok: errors.length === 0, hasPair: true, sameDirection, difference, errors };
  }

  /**
   * 确认增长的完整校验（含“另一位测量员”规则）。
   * @param current 待确认增长；previous 上一条增长；shotById(id) 取照片
   */
  function canConfirm(current, previous, shotById, confirmer) {
    const errors = [];
    if (!current || current.status !== STATUS.GROWTH_PENDING) errors.push('该增长不是待确认状态');
    const name = (confirmer || '').trim();
    if (!name) errors.push('需要填写确认测量员');

    const pair = evaluatePair(previous, current || { delta: 0 });
    if (!pair.ok) errors.push(...pair.errors);

    if (current && name) {
      const fromShot = shotById(current.fromShotId);
      const toShot = shotById(current.toShotId);
      const photographers = [fromShot?.photographer, toShot?.photographer].filter(Boolean);
      if (photographers.includes(name)) {
        errors.push('确认人必须是另一位测量员，不能是两张照片的拍摄人');
      }
    }
    return { ok: errors.length === 0, errors, pair };
  }

  /**
   * 基准/历史更正后重算某样点的全部增长。
   * 第一张“已采用”照片作为基准照片，之后每张采用照片产生一条增长。
   * 断面位置(mm) = 断面像素 × 当张照片自己的换算系数。
   * 重算产生的增长一律回到“待确认”。
   */
  function rebuildGrowths(point, shots, idFactory) {
    const accepted = shots
      .filter((shot) => shot.pointId === point.id && shot.status === STATUS.SHOT_ACCEPTED)
      .sort(compareShots);
    if (!isFiniteNumber(Number(point.baselinePx)) || !mmPerPx(point.baselineScaleMm, point.baselineScalePixels)) return [];

    const baselinePositionMm = round(Number(point.baselinePx) * mmPerPx(point.baselineScaleMm, point.baselineScalePixels), 3);
    const growths = [];
    let prevShot = null;
    let prevPositionMm = baselinePositionMm;

    accepted.forEach((shot, index) => {
      if (index === 0) {
        prevShot = shot;
        prevPositionMm = round(Number(shot.sectionPixels) * shot.mmPerPx, 3);
        return;
      }
      const positionMm = round(Number(shot.sectionPixels) * shot.mmPerPx, 3);
      growths.push(buildGrowth({
        id: idFactory(),
        pointId: point.id,
        fromShotId: prevShot.id,
        toShotId: shot.id,
        fromDate: prevShot.date,
        toDate: shot.date,
        delta: positionMm - prevPositionMm
      }));
      prevShot = shot;
      prevPositionMm = positionMm;
    });
    return growths;
  }

  function compareShots(a, b) {
    const byDate = String(a.date).localeCompare(String(b.date));
    if (byDate !== 0) return byDate;
    return String(a.createdAt).localeCompare(String(b.createdAt));
  }

  /** 追加一张新采用照片时，计算它与上一张采用照片之间的增长；它是基准照片时返回 null */
  function growthForNewShot(point, previousAcceptedShots, newShot, idFactory) {
    const accepted = [...previousAcceptedShots].sort(compareShots);
    const prevShot = accepted[accepted.length - 1];
    if (!prevShot) return null; // 第一张采用照片即基准照片
    const prevPositionMm = round(Number(prevShot.sectionPixels) * prevShot.mmPerPx, 3);
    const positionMm = round(Number(newShot.sectionPixels) * newShot.mmPerPx, 3);
    return buildGrowth({
      id: idFactory(),
      pointId: point.id,
      fromShotId: prevShot.id,
      toShotId: newShot.id,
      fromDate: prevShot.date,
      toDate: newShot.date,
      delta: positionMm - prevPositionMm
    });
  }

  /**
   * 关闭复核（= 该标尺本次复核完成、可以归库）的校验。
   * @param review 复核；reviewShots 该复核下的照片；growths 全量增长
   */
  function canCloseReview(review, reviewShots, growths, closedBy) {
    const errors = [];
    if (!review || review.status !== STATUS.REVIEW_OPEN) errors.push('复核不是进行中状态');
    if (!(closedBy || '').trim()) errors.push('需要填写关闭操作人');

    const accepted = reviewShots.filter((shot) => shot.status === STATUS.SHOT_ACCEPTED);
    const reshoots = reviewShots.filter((shot) => shot.status === STATUS.SHOT_RESHOOT);
    if (accepted.length === 0) errors.push('还没有采用的标准照，不能关闭');
    if (reshoots.length > 0) errors.push(`有 ${reshoots.length} 张照片待重拍，不能关闭`);

    const acceptedIds = new Set(accepted.map((shot) => shot.id));
    const pending = growths.filter(
      (growth) => growth.pointId === review.pointId
        && acceptedIds.has(growth.toShotId)
        && growth.status === STATUS.GROWTH_PENDING
    );
    if (pending.length > 0) errors.push(`有 ${pending.length} 条增长待另一位测量员确认，不能关闭`);
    return { ok: errors.length === 0, errors };
  }

  /** 样点列表状态（用于列表徽标） */
  function pointStatus(point, shots, growths, openReviews) {
    const hasReshoot = shots.some((shot) => shot.pointId === point.id && shot.status === STATUS.SHOT_RESHOOT);
    if (hasReshoot) return '待重拍';
    const hasPending = growths.some((growth) => growth.pointId === point.id && growth.status === STATUS.GROWTH_PENDING);
    if (hasPending) return '待确认';
    if (openReviews.some((review) => review.pointId === point.id)) return '复核进行中';
    return '正常';
  }

  function nextId(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 7)}`;
  }

  return {
    DEVIATION_LIMIT,
    MAX_PAIR_DELTA,
    STATUS,
    round,
    isFiniteNumber,
    mmPerPx,
    deviationPct,
    evaluateIntake,
    directionLabel,
    buildGrowth,
    evaluatePair,
    canConfirm,
    rebuildGrowths,
    growthForNewShot,
    compareShots,
    canCloseReview,
    pointStatus,
    nextId
  };
});
