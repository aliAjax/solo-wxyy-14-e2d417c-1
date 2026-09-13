const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const config = require('./project.config');
const { registerWorkflowRoutes, WORKFLOW_LOCKED_COLLECTIONS } = require('./workflow');

const app = express();
const PORT = process.env.PORT || config.port;
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'app.db');

app.use(express.json({ limit: '2mb' }));

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

function now() {
  return new Date().toISOString();
}

function initSchema() {
  db.exec(`
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  collection TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_records_collection ON records(collection);
CREATE INDEX IF NOT EXISTS idx_records_status ON records(status);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  collection TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT,
  actor TEXT,
  note TEXT,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_record ON events(record_id);
CREATE TABLE IF NOT EXISTS tour_box_items (
  box_id TEXT NOT NULL,
  item_type TEXT NOT NULL CHECK (item_type IN ('puppetHead', 'accessory')),
  item_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (box_id, item_type, item_id)
);
CREATE INDEX IF NOT EXISTS idx_tour_box_items_item ON tour_box_items(item_type, item_id);
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  collection TEXT NOT NULL,
  record_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`);
}

function toRecord(row) {
  const data = JSON.parse(row.data || '{}');
  return {
    id: row.id,
    collection: row.collection,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...data
  };
}

function findCollection(name) {
  const collection = config.collections[name];
  if (!collection) {
    const error = new Error('unknown collection: ' + name);
    error.status = 404;
    throw error;
  }
  return collection;
}

function titleFor(collectionConfig, data) {
  return (collectionConfig.titleFields || [])
    .map((field) => data[field])
    .filter(Boolean)
    .join(' / ') || data.name || data.title || data.code || '';
}

function validate(collectionConfig, data) {
  const missing = (collectionConfig.required || []).filter((field) => data[field] === undefined || data[field] === '');
  if (missing.length) {
    const error = new Error('missing required fields: ' + missing.join(', '));
    error.status = 400;
    throw error;
  }
}

function insertEvent({ recordId, collection, action, status, actor, note, data }) {
  db.prepare(
    'INSERT INTO events (id, record_id, collection, action, status, actor, note, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    crypto.randomUUID(),
    recordId,
    collection,
    action || '记录',
    status || '',
    actor || '',
    note || '',
    JSON.stringify(data || {}),
    now()
  );
}

function insertRecord(collection, data, status, id) {
  const collectionConfig = findCollection(collection);
  const recordId = id || crypto.randomUUID();
  const createdAt = now();
  const stored = { ...data, status };
  db.prepare(
    'INSERT INTO records (id, collection, status, title, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(recordId, collection, status, titleFor(collectionConfig, stored), JSON.stringify(stored), createdAt, createdAt);
  return recordId;
}

function loadRecord(collection, id) {
  const row = db
    .prepare('SELECT * FROM records WHERE collection = ? AND id = ? LIMIT 1')
    .get(collection, id);
  return row ? toRecord(row) : null;
}

// 把 loadRecord 展开的记录还原成可入库的 data（去掉元字段，status 以记录当前状态为准）
function recordData(record) {
  const { id, collection, status, createdAt, updatedAt, ...data } = record;
  return data;
}

// expectedStatus 提供乐观并发保护：只有当前状态匹配才更新，否则 changes === 0
function saveRecord(collection, id, data, status, expectedStatus) {
  const collectionConfig = findCollection(collection);
  const stored = { ...data, status };
  const params = [status, titleFor(collectionConfig, stored), JSON.stringify(stored), now(), collection, id];
  let sql = 'UPDATE records SET status = ?, title = ?, data = ?, updated_at = ? WHERE collection = ? AND id = ?';
  if (expectedStatus !== undefined) {
    sql += ' AND status = ?';
    params.push(expectedStatus);
  }
  return db.prepare(sql).run(...params).changes;
}

function applyQuery(records, query) {
  return records.filter((record) => {
    if (query.status && record.status !== query.status) return false;
    if (query.search) {
      const haystack = JSON.stringify(record).toLowerCase();
      if (!haystack.includes(String(query.search).toLowerCase())) return false;
    }
    for (const [key, value] of Object.entries(query)) {
      if (['status', 'search', 'limit'].includes(key)) continue;
      if (record[key] === undefined) return false;
      if (!String(record[key]).toLowerCase().includes(String(value).toLowerCase())) return false;
    }
    return true;
  });
}

// 物品类集合：被巡演闭环引用，通用接口的删除/改状态需要额外守卫
const ITEM_COLLECTIONS = new Set(['puppetHeads', 'accessories']);

// 物品被哪些装箱单引用（含已闭环的历史单）；未闭环的引用即为占用
function itemBoxRefs(itemId) {
  return db.prepare(
    `SELECT i.box_id AS boxId, b.status AS boxStatus FROM tour_box_items i
     JOIN records b ON b.id = i.box_id AND b.collection = 'tourBoxes'
     WHERE i.item_id = ?`
  ).all(itemId);
}

// 占用中的物品状态只能经工作流（返场清点/缺损处理）变更；「已装箱」只能由装箱流程进入
function guardItemStatusChange(collection, id, targetStatus, currentStatus) {
  if (!ITEM_COLLECTIONS.has(collection)) return;
  if (targetStatus === '已装箱' && currentStatus !== '已装箱') {
    const error = new Error('「已装箱」状态只能由装箱流程设置');
    error.status = 409;
    throw error;
  }
  if (targetStatus === currentStatus) return;
  const unclosed = itemBoxRefs(id).find((ref) => ref.boxStatus !== '已闭环');
  if (unclosed || currentStatus === '已装箱') {
    const error = new Error(
      '物品正在巡演闭环中（装箱单 ' + (unclosed ? unclosed.boxId : '未知') + '），状态只能经返场清点/缺损处理变更'
    );
    error.status = 409;
    error.details = { occupiedBy: unclosed ? unclosed.boxId : null, currentStatus };
    throw error;
  }
}

// 偶头可用性标记与状态保持一致：占用中由工作流托管（恒为不可用，禁止显式篡改）；
// 未占用时管理员可显式指定，未指定则随状态变化自动推导
function deriveCurrentUsable(collection, id, record, status, nextData, explicit) {
  if (collection !== 'puppetHeads') return;
  const occupied = status === '已装箱' || itemBoxRefs(id).some((ref) => ref.boxStatus !== '已闭环');
  if (occupied) {
    nextData.currentUsable = false;
  } else if (!explicit && status !== record.status) {
    nextData.currentUsable = status === '可演出';
  }
}

function seedIfEmpty() {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM records').get();
  if (count > 0) return;
  const seedAll = db.transaction(() => {
    for (const seed of config.seed || []) {
      const collectionConfig = findCollection(seed.collection);
      const status = seed.status || collectionConfig.defaultStatus || '';
      const id = insertRecord(seed.collection, { ...seed.data }, status, seed.id);
      insertEvent({
        recordId: id,
        collection: seed.collection,
        action: seed.eventAction || '创建',
        status,
        actor: seed.actor || 'system',
        note: seed.note || '',
        data: { ...seed.data, status }
      });
    }
  });
  seedAll();
}

initSchema();
seedIfEmpty();

const ctx = { db, now, findCollection, titleFor, validate, insertEvent, insertRecord, loadRecord, saveRecord, recordData, toRecord };

// 巡演装箱闭环工作流接口（注册在通用 CRUD 之前，优先匹配）
registerWorkflowRoutes(app, ctx);

app.get('/health', (req, res) => {
  res.json({ ok: true, service: config.title, port: PORT });
});

app.get('/api/meta', (req, res) => {
  res.json({
    title: config.title,
    description: config.description,
    collections: config.collections,
    examples: config.examples || []
  });
});

app.get('/api/:collection', (req, res, next) => {
  try {
    findCollection(req.params.collection);
    const rows = db
      .prepare('SELECT * FROM records WHERE collection = ? ORDER BY updated_at DESC')
      .all(req.params.collection)
      .map(toRecord);
    const filtered = applyQuery(rows, req.query);
    const limit = Number(req.query.limit || 0);
    res.json(limit > 0 ? filtered.slice(0, limit) : filtered);
  } catch (error) {
    next(error);
  }
});

app.post('/api/:collection', (req, res, next) => {
  try {
    if (WORKFLOW_LOCKED_COLLECTIONS.has(req.params.collection)) {
      return res.status(403).json({
        error: req.params.collection + ' 由闭环工作流管理，请使用专用接口',
        use: req.params.collection === 'tourBoxes' ? 'POST /api/tourBoxes（装箱）' : 'POST /api/tourBoxes/:id/return（返场清点自动登记缺损）'
      });
    }
    const collectionConfig = findCollection(req.params.collection);
    const data = { ...collectionConfig.defaults, ...req.body };
    const status = data.status || collectionConfig.defaultStatus || '';
    validate(collectionConfig, data);
    if (ITEM_COLLECTIONS.has(req.params.collection)) {
      if (status === '已装箱') {
        return res.status(409).json({ error: '「已装箱」状态只能由装箱流程设置' });
      }
      // 可用性标记与状态保持一致（未显式指定时按状态推导）
      if (req.params.collection === 'puppetHeads' && req.body.currentUsable === undefined) {
        data.currentUsable = status === '可演出';
      }
    }
    const createOne = db.transaction(() => {
      const id = insertRecord(req.params.collection, data, status);
      insertEvent({
        recordId: id,
        collection: req.params.collection,
        action: req.body.action || '创建',
        status,
        actor: req.body.actor || '',
        note: req.body.note || '',
        data: { ...data, status }
      });
      return id;
    });
    res.status(201).json(loadRecord(req.params.collection, createOne()));
  } catch (error) {
    next(error);
  }
});

app.get('/api/:collection/:id', (req, res, next) => {
  try {
    findCollection(req.params.collection);
    const record = loadRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    res.json(record);
  } catch (error) {
    next(error);
  }
});

app.patch('/api/:collection/:id', (req, res, next) => {
  try {
    if (WORKFLOW_LOCKED_COLLECTIONS.has(req.params.collection)) {
      return res.status(403).json({ error: req.params.collection + ' 由闭环工作流管理，状态只能通过装箱/巡演/返场/闭环接口流转' });
    }
    const collectionConfig = findCollection(req.params.collection);
    const record = loadRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    const nextData = { ...recordData(record), ...req.body };
    const status = nextData.status || record.status;
    if (ITEM_COLLECTIONS.has(req.params.collection)) {
      if (req.body.status !== undefined && collectionConfig.statuses && !collectionConfig.statuses.includes(status)) {
        return res.status(400).json({ error: 'invalid status: ' + status });
      }
      guardItemStatusChange(req.params.collection, req.params.id, status, record.status);
      deriveCurrentUsable(req.params.collection, req.params.id, record, status, nextData, req.body.currentUsable !== undefined);
    }
    const updateOne = db.transaction(() => {
      saveRecord(req.params.collection, req.params.id, nextData, status);
      insertEvent({
        recordId: req.params.id,
        collection: req.params.collection,
        action: req.body.action || '更新',
        status,
        actor: req.body.actor || '',
        note: req.body.note || '',
        data: req.body
      });
    });
    updateOne();
    res.json(loadRecord(req.params.collection, req.params.id));
  } catch (error) {
    next(error);
  }
});

app.post('/api/:collection/:id/events', (req, res, next) => {
  try {
    if (WORKFLOW_LOCKED_COLLECTIONS.has(req.params.collection)) {
      return res.status(403).json({ error: req.params.collection + ' 由闭环工作流管理，状态只能通过装箱/巡演/返场/闭环接口流转' });
    }
    const collectionConfig = findCollection(req.params.collection);
    const record = loadRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    const status = req.body.status || record.status;
    if (collectionConfig.statuses && !collectionConfig.statuses.includes(status)) {
      return res.status(400).json({ error: 'invalid status: ' + status });
    }
    guardItemStatusChange(req.params.collection, req.params.id, status, record.status);
    const nextData = { ...recordData(record), ...(req.body.fields || {}) };
    deriveCurrentUsable(req.params.collection, req.params.id, record, status, nextData, !!(req.body.fields && 'currentUsable' in req.body.fields));
    const applyOne = db.transaction(() => {
      saveRecord(req.params.collection, req.params.id, nextData, status);
      insertEvent({
        recordId: req.params.id,
        collection: req.params.collection,
        action: req.body.action || status || '记录',
        status,
        actor: req.body.actor || '',
        note: req.body.note || '',
        data: req.body
      });
    });
    applyOne();
    res.json(loadRecord(req.params.collection, req.params.id));
  } catch (error) {
    next(error);
  }
});

app.get('/api/:collection/:id/timeline', (req, res, next) => {
  try {
    findCollection(req.params.collection);
    const record = loadRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    const events = db
      .prepare('SELECT * FROM events WHERE record_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(req.params.id)
      .map((event) => ({
        id: event.id,
        action: event.action,
        status: event.status,
        actor: event.actor,
        note: event.note,
        data: JSON.parse(event.data || '{}'),
        createdAt: event.created_at
      }));
    res.json({ record, events });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/:collection/:id', (req, res, next) => {
  try {
    if (WORKFLOW_LOCKED_COLLECTIONS.has(req.params.collection)) {
      return res.status(403).json({ error: req.params.collection + ' 由闭环工作流管理，不允许删除' });
    }
    findCollection(req.params.collection);
    if (ITEM_COLLECTIONS.has(req.params.collection)) {
      const refs = itemBoxRefs(req.params.id);
      if (refs.length) {
        const unclosed = refs.find((ref) => ref.boxStatus !== '已闭环');
        return res.status(409).json({
          error: unclosed
            ? '物品被未闭环装箱单 ' + unclosed.boxId + ' 占用，不能移除'
            : '物品已被历史装箱单引用，为保证审计可追溯不能移除',
          details: refs
        });
      }
    }
    const removeOne = db.transaction(() => {
      db.prepare('DELETE FROM records WHERE collection = ? AND id = ?').run(req.params.collection, req.params.id);
      db.prepare('DELETE FROM events WHERE record_id = ?').run(req.params.id);
    });
    removeOne();
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.use((error, req, res, next) => {
  const body = { error: error.message || 'server error' };
  if (error.details !== undefined) body.details = error.details;
  res.status(error.status || 500).json(body);
});

app.listen(PORT, () => {
  console.log(config.title + ' API running at http://localhost:' + PORT);
});
