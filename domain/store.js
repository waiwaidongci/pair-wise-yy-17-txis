/**
 * 摄影测量复核台 —— 存储层
 * 只负责 data/db.json 的读写、集合初始化和履历追加；不含业务规则。
 */
const fs = require('fs/promises');
const path = require('path');

const DB_FILE = path.join(__dirname, '..', 'data', 'db.json');

const COLLECTIONS = ['points', 'rods', 'reviews', 'shots', 'growths'];

let cache = null;
let writeQueue = Promise.resolve();

async function load() {
  if (cache) return cache;
  const raw = await fs.readFile(DB_FILE, 'utf8');
  const parsed = JSON.parse(raw);
  for (const name of COLLECTIONS) {
    parsed[name] = Array.isArray(parsed[name]) ? parsed[name] : [];
  }
  cache = parsed;
  return cache;
}

async function save(db = cache) {
  const snapshot = JSON.stringify(db, null, 2) + '\n';
  writeQueue = writeQueue.then(() => fs.writeFile(DB_FILE, snapshot));
  return writeQueue;
}

function reset() {
  cache = null;
}

/** 向任意记录追加一条履历（保存在该记录自身 history 内） */
function addHistory(record, action, note) {
  record.history = Array.isArray(record.history) ? record.history : [];
  record.history.unshift({ at: new Date().toISOString(), action, note: note || '' });
}

/** 找到集合中的记录 */
function find(db, collection, id) {
  return (db[collection] || []).find((item) => item.id === id);
}

module.exports = { DB_FILE, COLLECTIONS, load, save, reset, addHistory, find };
