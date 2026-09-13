const crypto = require('crypto');

// 巡演装箱闭环工作流
// 装箱单状态机：已装箱 → 巡演中 → 返场清点中 → 已闭环（只能按顺序流转）
// 物品状态联动：
//   装箱     偶头 可演出→已装箱        配件 在库→已装箱
//   返场     完好→可演出/在库  缺损→待修补/缺损  遗失→不可演出/遗失（并登记缺损追踪单）
//   缺损处理 已补齐→可演出/在库  确认为遗失→不可演出/遗失
// 所有多步写入都在同一个事务里，任何一步失败整体回滚；每次状态变化写入 events 审计表。

const WORKFLOW_LOCKED_COLLECTIONS = new Set(['tourBoxes', 'lossReports']);

const BOX_STATUS = { PACKED: '已装箱', TOURING: '巡演中', RETURNING: '返场清点中', CLOSED: '已闭环' };

const ITEM_COLLECTION = { puppetHead: 'puppetHeads', accessory: 'accessories' };

const PACKABLE_STATUS = { puppetHead: '可演出', accessory: '在库' };

const RETURN_STATUS = {
  puppetHead: { 完好: '可演出', 缺损: '待修补', 遗失: '不可演出' },
  accessory: { 完好: '在库', 缺损: '缺损', 遗失: '遗失' }
};

const RESOLVE_STATUS = {
  已补齐: { puppetHead: '可演出', accessory: '在库' },
  确认为遗失: { puppetHead: '不可演出', accessory: '遗失' }
};

const LOSS_TERMINAL = Object.keys(RESOLVE_STATUS);

function httpError(status, message, details) {
  const error = new Error(message);
  error.status = status;
  if (details !== undefined) error.details = details;
  return error;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

function hashRequest(body) {
  return crypto.createHash('sha256').update(stableStringify(body || {})).digest('hex');
}

function registerWorkflowRoutes(app, ctx) {
  const { db, now, findCollection, titleFor, insertEvent, insertRecord, loadRecord, saveRecord, recordData, toRecord } = ctx;

  const itemTitle = (itemType, itemId) => {
    const row = db.prepare('SELECT title FROM records WHERE collection = ? AND id = ?').get(ITEM_COLLECTION[itemType], itemId);
    return row ? row.title : '';
  };

  const mustBox = (id) => {
    const box = loadRecord('tourBoxes', id);
    if (!box) throw httpError(404, '装箱单不存在: ' + id);
    return box;
  };

  // 物品是否被某个未闭环装箱单占用，返回占用它的装箱单 id
  const occupyingBox = (itemType, itemId) => {
    const row = db.prepare(
      `SELECT i.box_id AS boxId FROM tour_box_items i
       JOIN records b ON b.id = i.box_id
       WHERE i.item_type = ? AND i.item_id = ? AND b.collection = 'tourBoxes' AND b.status != ?
       LIMIT 1`
    ).get(itemType, itemId, BOX_STATUS.CLOSED);
    return row ? row.boxId : null;
  };

  const boxLossReports = (boxId) =>
    db.prepare("SELECT * FROM records WHERE collection = 'lossReports' AND json_extract(data, '$.tourBoxId') = ? ORDER BY created_at ASC, rowid ASC")
      .all(boxId)
      .map(toRecord);

  const boxDetail = (boxId) => {
    const box = mustBox(boxId);
    const items = db.prepare(
      `SELECT i.item_type AS itemType, i.item_id AS itemId, r.title, r.status,
              json_extract(r.data, '$.currentUsable') AS currentUsable
       FROM tour_box_items i
       JOIN records r ON r.id = i.item_id AND r.collection = CASE i.item_type WHEN 'puppetHead' THEN 'puppetHeads' ELSE 'accessories' END
       WHERE i.box_id = ?
       ORDER BY i.rowid ASC`
    ).all(boxId).map((item) => ({
      ...item,
      // json_extract 返回 0/1/null，配件无此标记则不输出该字段
      currentUsable: item.currentUsable === null ? undefined : item.currentUsable === 1
    }));
    return { ...box, items, lossReports: boxLossReports(boxId) };
  };

  // 带乐观锁的物品状态变更：当前状态不符则整体回滚；偶头可用性标记随状态联动
  const setItemStatus = ({ itemType, itemId, to, expected, action, actor, note, extra }) => {
    const collection = ITEM_COLLECTION[itemType];
    const record = loadRecord(collection, itemId);
    if (!record) throw httpError(409, `物品 ${itemId} 已不存在`);
    const data = recordData(record);
    if (itemType === 'puppetHead') data.currentUsable = to === '可演出';
    const changes = saveRecord(collection, itemId, data, to, expected);
    if (changes === 0) {
      const current = loadRecord(collection, itemId);
      throw httpError(409, `物品「${itemTitle(itemType, itemId)}」状态已变为「${current.status}」，操作冲突`, { itemId, expected, current: current.status });
    }
    insertEvent({
      recordId: itemId,
      collection,
      action,
      status: to,
      actor,
      note,
      data: { from: expected, to, itemType, ...extra }
    });
  };

  const setBoxStatus = ({ box, to, expected, action, actor, note, extra }) => {
    const changes = saveRecord('tourBoxes', box.id, recordData(box), to, expected);
    if (changes === 0) {
      const current = mustBox(box.id);
      throw httpError(409, `装箱单当前状态为「${current.status}」，不能执行「${action}」（需要「${expected}」）`, { current: current.status, required: expected });
    }
    insertEvent({
      recordId: box.id,
      collection: 'tourBoxes',
      action,
      status: to,
      actor,
      note,
      data: { from: expected, to, ...extra }
    });
  };

  // ---------- 创建装箱单（装箱） ----------
  app.post('/api/tourBoxes', (req, res, next) => {
    try {
      const body = req.body || {};
      const { showName, venue, play, actor = '', note = '' } = body;
      const headIds = body.headIds;
      const accessoryIds = body.accessoryIds === undefined ? [] : body.accessoryIds;

      for (const [field, value] of Object.entries({ showName, venue, play })) {
        if (typeof value !== 'string' || !value.trim()) throw httpError(400, `缺少必填字段: ${field}`);
      }
      if (!Array.isArray(headIds) || headIds.length === 0 || !headIds.every((v) => typeof v === 'string' && v)) {
        throw httpError(400, 'headIds 必须是非空字符串数组');
      }
      if (!Array.isArray(accessoryIds) || !accessoryIds.every((v) => typeof v === 'string' && v)) {
        throw httpError(400, 'accessoryIds 必须是字符串数组');
      }

      // 重复选择（同一物品出现多次，含偶头与配件之间）
      const picked = [
        ...headIds.map((id) => ['puppetHead', id]),
        ...accessoryIds.map((id) => ['accessory', id])
      ];
      const seen = new Set();
      const duplicates = [];
      for (const [type, id] of picked) {
        if (seen.has(id)) duplicates.push(id);
        seen.add(id);
      }
      if (duplicates.length) throw httpError(400, '重复选择物品: ' + duplicates.join(', '), { duplicates });

      // 幂等重放：同一个 Idempotency-Key + 相同请求体 → 返回首次结果
      const idemKey = req.get('Idempotency-Key') || null;
      if (idemKey) {
        const hit = db.prepare('SELECT * FROM idempotency_keys WHERE key = ?').get(idemKey);
        if (hit) {
          if (hit.request_hash !== hashRequest(body)) {
            throw httpError(409, 'Idempotency-Key 已被不同内容的请求使用', { key: idemKey });
          }
          res.set('Idempotent-Replay', 'true');
          return res.status(200).json(boxDetail(hit.record_id));
        }
      }

      const createBox = db.transaction(() => {
        // 校验物品存在、可演出、未被其他未闭环巡演占用
        const problems = [];
        for (const [itemType, itemId] of picked) {
          const record = loadRecord(ITEM_COLLECTION[itemType], itemId);
          const label = itemType === 'puppetHead' ? '偶头' : '配件';
          if (!record) {
            problems.push({ itemType, itemId, reason: `${label}不存在` });
            continue;
          }
          const packable = PACKABLE_STATUS[itemType];
          if (record.status !== packable) {
            problems.push({ itemType, itemId, title: itemTitle(itemType, itemId), reason: `当前状态「${record.status}」，要求「${packable}」` });
            continue;
          }
          // 可用性标记参与装箱校验：标记为不可用的偶头视为不可演出
          if (itemType === 'puppetHead' && record.currentUsable === false) {
            problems.push({ itemType, itemId, title: itemTitle(itemType, itemId), reason: '可用性标记 currentUsable=false，视为不可演出' });
            continue;
          }
          const occupiedBy = occupyingBox(itemType, itemId);
          if (occupiedBy) {
            problems.push({ itemType, itemId, title: itemTitle(itemType, itemId), reason: `已被未闭环装箱单 ${occupiedBy} 占用`, occupiedBy });
          }
        }
        if (problems.length) throw httpError(409, '存在不可装箱的物品', problems);

        const boxId = insertRecord('tourBoxes', {
          showName: showName.trim(),
          venue: venue.trim(),
          play: play.trim(),
          headIds,
          accessoryIds,
          packedAt: now()
        }, BOX_STATUS.PACKED);

        for (const [itemType, itemId] of picked) {
          db.prepare('INSERT INTO tour_box_items (box_id, item_type, item_id, created_at) VALUES (?, ?, ?, ?)')
            .run(boxId, itemType, itemId, now());
          setItemStatus({
            itemType, itemId,
            to: '已装箱',
            expected: PACKABLE_STATUS[itemType],
            action: '装箱',
            actor,
            note: `装入装箱单 ${boxId}（${showName.trim()}）`,
            extra: { boxId }
          });
        }

        insertEvent({
          recordId: boxId,
          collection: 'tourBoxes',
          action: '创建装箱单',
          status: BOX_STATUS.PACKED,
          actor,
          note,
          data: { from: null, to: BOX_STATUS.PACKED, showName, venue, play, headIds, accessoryIds }
        });

        if (idemKey) {
          db.prepare('INSERT INTO idempotency_keys (key, collection, record_id, request_hash, created_at) VALUES (?, ?, ?, ?, ?)')
            .run(idemKey, 'tourBoxes', boxId, hashRequest(body), now());
        }
        return boxId;
      });

      let boxId;
      try {
        boxId = createBox();
      } catch (error) {
        // 并发下同键竞争：唯一约束兜底，返回首次结果
        if (idemKey && String(error.code || '').startsWith('SQLITE_CONSTRAINT')) {
          const hit = db.prepare('SELECT * FROM idempotency_keys WHERE key = ?').get(idemKey);
          if (hit && hit.request_hash === hashRequest(body)) {
            res.set('Idempotent-Replay', 'true');
            return res.status(200).json(boxDetail(hit.record_id));
          }
        }
        throw error;
      }
      res.status(201).json(boxDetail(boxId));
    } catch (error) {
      next(error);
    }
  });

  // ---------- 出发巡演：已装箱 → 巡演中 ----------
  app.post('/api/tourBoxes/:id/depart', (req, res, next) => {
    try {
      const box = mustBox(req.params.id);
      const { actor = '', note = '' } = req.body || {};
      db.transaction(() => {
        setBoxStatus({ box, to: BOX_STATUS.TOURING, expected: BOX_STATUS.PACKED, action: '出发巡演', actor, note });
      })();
      res.json(boxDetail(box.id));
    } catch (error) {
      next(error);
    }
  });

  // ---------- 返场清点：巡演中 → 返场清点中，缺损同步物品状态并登记缺损单 ----------
  app.post('/api/tourBoxes/:id/return', (req, res, next) => {
    try {
      const box = mustBox(req.params.id);
      const { checks, actor = '', note = '' } = req.body || {};
      if (!Array.isArray(checks) || checks.length === 0) {
        throw httpError(400, 'checks 必须是非空数组，逐项清点箱内所有物品');
      }
      for (const [index, check] of checks.entries()) {
        if (!check || !ITEM_COLLECTION[check.itemType] || typeof check.itemId !== 'string' || !check.itemId) {
          throw httpError(400, `checks[${index}] 需要合法的 itemType（puppetHead/accessory）和 itemId`);
        }
        if (!RETURN_STATUS[check.itemType][check.condition]) {
          throw httpError(400, `checks[${index}].condition 必须是 完好/缺损/遗失 之一`);
        }
      }

      const returnBox = db.transaction(() => {
        // 先流转装箱单状态（带乐观锁），后续任何校验失败都会回滚它
        setBoxStatus({ box, to: BOX_STATUS.RETURNING, expected: BOX_STATUS.TOURING, action: '返场清点', actor, note });

        // 清点结果必须与箱内物品一一对应，不多不少
        const packed = db.prepare('SELECT item_type AS itemType, item_id AS itemId FROM tour_box_items WHERE box_id = ?').all(box.id);
        const packedKeys = new Map(packed.map((item) => [item.itemType + ':' + item.itemId, item]));
        const checkedKeys = new Set();
        const checkProblems = [];
        for (const check of checks) {
          const key = check.itemType + ':' + check.itemId;
          if (!packedKeys.has(key)) checkProblems.push({ itemType: check.itemType, itemId: check.itemId, reason: '不在本装箱单内' });
          else if (checkedKeys.has(key)) checkProblems.push({ itemType: check.itemType, itemId: check.itemId, reason: '重复清点' });
          checkedKeys.add(key);
        }
        for (const item of packed) {
          if (!checkedKeys.has(item.itemType + ':' + item.itemId)) {
            checkProblems.push({ itemType: item.itemType, itemId: item.itemId, reason: '漏清点' });
          }
        }
        if (checkProblems.length) throw httpError(400, '返场清点与箱内物品不一致', checkProblems);

        const summary = { 完好: 0, 缺损: 0, 遗失: 0 };
        for (const check of checks) {
          const to = RETURN_STATUS[check.itemType][check.condition];
          summary[check.condition] += 1;
          setItemStatus({
            itemType: check.itemType,
            itemId: check.itemId,
            to,
            expected: '已装箱',
            action: '返场-' + check.condition,
            actor,
            note: check.note || note,
            extra: { boxId: box.id, condition: check.condition }
          });
          if (check.condition !== '完好') {
            const reportId = insertRecord('lossReports', {
              tourBoxId: box.id,
              itemType: check.itemType,
              itemId: check.itemId,
              itemName: itemTitle(check.itemType, check.itemId),
              problem: check.condition,
              note: check.note || '',
              reportedBy: actor
            }, '待处理');
            insertEvent({
              recordId: reportId,
              collection: 'lossReports',
              action: '登记' + check.condition,
              status: '待处理',
              actor,
              note: check.note || '',
              data: { from: null, to: '待处理', tourBoxId: box.id, itemType: check.itemType, itemId: check.itemId, problem: check.condition }
            });
          }
        }
        insertEvent({
          recordId: box.id,
          collection: 'tourBoxes',
          action: '清点完成',
          status: BOX_STATUS.RETURNING,
          actor,
          note: `完好 ${summary.完好}，缺损 ${summary.缺损}，遗失 ${summary.遗失}`,
          data: { boxId: box.id, summary }
        });
      });
      returnBox();
      res.json(boxDetail(box.id));
    } catch (error) {
      next(error);
    }
  });

  // ---------- 闭环：返场清点中 → 已闭环，缺损未处理完禁止闭环 ----------
  app.post('/api/tourBoxes/:id/close', (req, res, next) => {
    try {
      const box = mustBox(req.params.id);
      const { actor = '', note = '' } = req.body || {};
      db.transaction(() => {
        const pending = boxLossReports(box.id).filter((report) => !LOSS_TERMINAL.includes(report.status));
        if (pending.length) {
          throw httpError(409, '尚有未处理完的缺损/遗失，不能闭环', pending.map((r) => ({ id: r.id, itemName: r.itemName, problem: r.problem, status: r.status })));
        }
        setBoxStatus({ box, to: BOX_STATUS.CLOSED, expected: BOX_STATUS.RETURNING, action: '闭环', actor, note });
      })();
      res.json(boxDetail(box.id));
    } catch (error) {
      next(error);
    }
  });

  // ---------- 处理缺损单：待处理 → 已补齐 / 确认为遗失，同步物品状态 ----------
  app.post('/api/lossReports/:id/resolve', (req, res, next) => {
    try {
      const report = loadRecord('lossReports', req.params.id);
      if (!report) throw httpError(404, '缺损单不存在: ' + req.params.id);
      const { resolution, actor = '', note = '' } = req.body || {};
      if (!RESOLVE_STATUS[resolution]) {
        throw httpError(400, 'resolution 必须是 ' + LOSS_TERMINAL.join(' / '));
      }
      db.transaction(() => {
        const changes = saveRecord('lossReports', report.id, { ...recordData(report), resolution, resolvedBy: actor, resolvedAt: now() }, resolution, '待处理');
        if (changes === 0) {
          const current = loadRecord('lossReports', report.id);
          throw httpError(409, `缺损单当前状态为「${current.status}」，只有「待处理」可以处理`, { current: current.status });
        }
        insertEvent({
          recordId: report.id,
          collection: 'lossReports',
          action: '缺损处理-' + resolution,
          status: resolution,
          actor,
          note,
          data: { from: '待处理', to: resolution, tourBoxId: report.tourBoxId, itemType: report.itemType, itemId: report.itemId }
        });
        // 物品状态同步：已补齐回到可用，确认遗失保持不可用
        const expectedItem = RETURN_STATUS[report.itemType][report.problem];
        setItemStatus({
          itemType: report.itemType,
          itemId: report.itemId,
          to: RESOLVE_STATUS[resolution][report.itemType],
          expected: expectedItem,
          action: '缺损处理-' + resolution,
          actor,
          note: note || `缺损单 ${report.id} 处理为「${resolution}」`,
          extra: { lossReportId: report.id, boxId: report.tourBoxId }
        });
      })();
      res.json(loadRecord('lossReports', report.id));
    } catch (error) {
      next(error);
    }
  });

  // ---------- 装箱单详情（含箱内物品与缺损单） ----------
  app.get('/api/tourBoxes/:id', (req, res, next) => {
    try {
      res.json(boxDetail(req.params.id));
    } catch (error) {
      next(error);
    }
  });
}

module.exports = { registerWorkflowRoutes, WORKFLOW_LOCKED_COLLECTIONS };
