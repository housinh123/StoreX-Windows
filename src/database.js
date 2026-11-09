const Database = require('better-sqlite3');
let connection;

const DEFAULT_RATE = 14800;

function init(filePath) {
  connection = new Database(filePath);
  connection.pragma('journal_mode = WAL');
  connection.pragma('foreign_keys = ON');
  connection.pragma('busy_timeout = 5000');
  connection.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category TEXT DEFAULT 'عام',
      barcode TEXT DEFAULT '',
      costUsd REAL DEFAULT 0,
      costSyp REAL DEFAULT 0,
      sellUsd REAL DEFAULT 0,
      sellSyp REAL DEFAULT 0,
      image TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS categories (name TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
  `);

  // Compatibility migration from the first Windows prototype, which used
  // exchangeRate/exchangeRateUpdatedAt instead of Android's original keys.
  const migrateSetting = connection.transaction(() => {
    const oldRate = connection.prepare("SELECT value FROM settings WHERE key='exchangeRate'").get();
    const oldDate = connection.prepare("SELECT value FROM settings WHERE key='exchangeRateUpdatedAt'").get();
    if (oldRate && !connection.prepare("SELECT 1 FROM settings WHERE key='rate'").get()) {
      connection.prepare("INSERT INTO settings(key,value) VALUES('rate',?)").run(String(oldRate.value));
    }
    if (oldDate && !connection.prepare("SELECT 1 FROM settings WHERE key='rateUpdatedAt'").get()) {
      connection.prepare("INSERT INTO settings(key,value) VALUES('rateUpdatedAt',?)").run(String(oldDate.value || ''));
    }
    connection.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES('rate',?)").run(String(DEFAULT_RATE));
    connection.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES('rateUpdatedAt','')").run();
    connection.prepare("INSERT OR IGNORE INTO categories(name) VALUES('عام')").run();
  });
  migrateSetting();
}

function getSetting(key, fallback = '') {
  const row = connection.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  connection.prepare(`INSERT INTO settings(key,value) VALUES(?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, String(value));
}
function getAll() {
  const products = connection.prepare(`SELECT id,name,category,barcode,costUsd,costSyp,sellUsd,sellSyp,image
    FROM products ORDER BY id DESC`).all();
  const categories = connection.prepare('SELECT name FROM categories ORDER BY name').all().map(x => x.name);
  return {
    products,
    categories: categories.length ? categories : ['عام'],
    exchangeRate: Number(getSetting('rate', String(DEFAULT_RATE))) || DEFAULT_RATE,
    exchangeRateUpdatedAt: getSetting('rateUpdatedAt', '')
  };
}
function saveProduct(p) {
  if (!p || !String(p.name || '').trim()) return -1;
  const values = [
    String(p.name).trim(), String(p.category || 'عام'), String(p.barcode || ''),
    Number(p.costUsd) || 0, Number(p.costSyp) || 0,
    Number(p.sellUsd) || 0, Number(p.sellSyp) || 0, String(p.image || '')
  ];
  const id = Number(p.id) || 0;
  if (id > 0) {
    const result = connection.prepare(`UPDATE products SET name=?,category=?,barcode=?,costUsd=?,costSyp=?,sellUsd=?,sellSyp=?,image=? WHERE id=?`)
      .run(...values, id);
    return result.changes > 0 ? id : -1;
  }
  return Number(connection.prepare(`INSERT INTO products(name,category,barcode,costUsd,costSyp,sellUsd,sellSyp,image)
    VALUES(?,?,?,?,?,?,?,?)`).run(...values).lastInsertRowid);
}
function getProductImage(id) {
  const row = connection.prepare('SELECT image FROM products WHERE id=?').get(Number(id));
  return row ? String(row.image || '') : '';
}
function isImageUsed(name) {
  return !!connection.prepare('SELECT 1 FROM products WHERE image=? LIMIT 1').get(String(name));
}
function deleteProduct(id) {
  return connection.prepare('DELETE FROM products WHERE id=?').run(Number(id)).changes > 0;
}
function saveCategory(name) {
  const clean = String(name || '').trim();
  if (!clean) return false;
  try { return connection.prepare('INSERT INTO categories(name) VALUES(?)').run(clean).changes > 0; }
  catch { return false; }
}
function updateCategory(oldName, newName) {
  const oldValue = String(oldName || '').trim();
  const newValue = String(newName || '').trim();
  if (!oldValue || !newValue || oldValue === 'عام') return false;
  const tx = connection.transaction(() => {
    const changed = connection.prepare('UPDATE categories SET name=? WHERE name=?').run(newValue, oldValue);
    if (!changed.changes) return false;
    connection.prepare('UPDATE products SET category=? WHERE category=?').run(newValue, oldValue);
    return true;
  });
  try { return tx(); } catch { return false; }
}
function deleteCategory(name) {
  const value = String(name || '').trim();
  if (!value || value === 'عام') return false;
  const tx = connection.transaction(() => {
    connection.prepare("UPDATE products SET category='عام' WHERE category=?").run(value);
    return connection.prepare('DELETE FROM categories WHERE name=?').run(value).changes > 0;
  });
  return tx();
}
function setExchangeRate(rate) {
  const value = Number(rate);
  if (!Number.isFinite(value) || value <= 0) return false;
  setSetting('rate', value);
  return true;
}
function updateMarketRateAndRecalculateProducts(rate, updatedAt) {
  const newRate = Number(rate);
  if (!Number.isFinite(newRate) || newRate <= 0) return false;
  const tx = connection.transaction(() => {
    const previousRate = Number(getSetting('rate', String(newRate))) || newRate;
    const rows = connection.prepare('SELECT id,costUsd,costSyp,sellUsd,sellSyp FROM products').all();
    const update = connection.prepare(`UPDATE products SET costUsd=?,costSyp=?,sellUsd=?,sellSyp=? WHERE id=?`);
    for (const row of rows) {
      const costUsd = row.costUsd > 0 ? row.costUsd : row.costSyp > 0 ? row.costSyp / previousRate : 0;
      const sellUsd = row.sellUsd > 0 ? row.sellUsd : row.sellSyp > 0 ? row.sellSyp / previousRate : 0;
      update.run(costUsd, costUsd > 0 ? Math.round(costUsd * newRate) : 0,
        sellUsd, sellUsd > 0 ? Math.round(sellUsd * newRate) : 0, row.id);
    }
    setSetting('rate', newRate);
    setSetting('rateUpdatedAt', String(updatedAt || ''));
  });
  tx();
  return true;
}
function exportAll() {
  const data = getAll();
  return {
    products: data.products,
    categories: data.categories,
    exchangeRate: data.exchangeRate,
    exchangeRateUpdatedAt: data.exchangeRateUpdatedAt
  };
}
// Mirrors the Android StoreDatabase.mergeImportData behavior: categories are
// additive; products with the same exact name are updated, others are inserted;
// existing rows are never cleared and incoming IDs are not forced onto the DB.
function mergeAll(data) {
  if (!data || !Array.isArray(data.products) || !Array.isArray(data.categories)) {
    throw new Error('بنية بيانات النسخة الاحتياطية غير صالحة');
  }
  const tx = connection.transaction(() => {
    const addCategory = connection.prepare('INSERT OR IGNORE INTO categories(name) VALUES(?)');
    for (const name of data.categories) {
      const clean = String(name || '').trim();
      if (clean) addCategory.run(clean);
    }
    addCategory.run('عام');

    const findByName = connection.prepare('SELECT id FROM products WHERE name=? LIMIT 1');
    const update = connection.prepare(`UPDATE products SET name=?,category=?,barcode=?,costUsd=?,costSyp=?,sellUsd=?,sellSyp=?,image=? WHERE id=?`);
    const insert = connection.prepare(`INSERT INTO products(name,category,barcode,costUsd,costSyp,sellUsd,sellSyp,image)
      VALUES(?,?,?,?,?,?,?,?)`);
    for (const p of data.products) {
      const name = String(p.name || '').trim();
      if (!name) throw new Error('توجد بيانات منتج بدون اسم');
      const category = String(p.category || 'عام');
      addCategory.run(category);
      const values = [name, category, String(p.barcode || ''), Number(p.costUsd) || 0,
        Number(p.costSyp) || 0, Number(p.sellUsd) || 0, Number(p.sellSyp) || 0, String(p.image || '')];
      const existing = findByName.get(name);
      if (existing) update.run(...values, existing.id);
      else insert.run(...values);
    }
    const rate = Number(data.exchangeRate);
    if (Number.isFinite(rate) && rate > 0) setSetting('rate', rate);
    if (data.exchangeRateUpdatedAt) setSetting('rateUpdatedAt', data.exchangeRateUpdatedAt);
  });
  tx();
}
module.exports = {
  init, getAll, saveProduct, deleteProduct, getProductImage, isImageUsed, saveCategory, updateCategory,
  deleteCategory, setExchangeRate, updateMarketRateAndRecalculateProducts,
  exportAll, mergeAll
};
