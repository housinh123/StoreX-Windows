const { app, BrowserWindow, ipcMain, dialog, protocol, net, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const AdmZip = require('adm-zip');
const db = require('./database');

protocol.registerSchemesAsPrivileged([
  { scheme: 'storex-image', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
]);

let mainWindow;
let imageDir;

function sendToRenderer(name, ...args) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.executeJavaScript(
      `window.${name} && window.${name}(...${JSON.stringify(args)})`
    ).catch(() => {});
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 900,
    minHeight: 650,
    backgroundColor: '#090e19',
    title: 'StoreX',
    icon: path.join(__dirname, '..', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

function safeImagePath(name) {
  const base = path.basename(String(name || ''));
  const target = path.join(imageDir, base);
  return target.startsWith(imageDir + path.sep) ? target : null;
}

function writeDataImage(dataUrl) {
  const match = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/i.exec(String(dataUrl || ''));
  if (!match) throw new Error('صيغة الصورة غير مدعومة');
  const ext = match[1].toLowerCase().replace('jpeg', 'jpg');
  const name = `${Date.now()}-${require('node:crypto').randomUUID()}.${ext}`;
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length > 20 * 1024 * 1024) throw new Error('حجم الصورة أكبر من 20 ميغابايت');
  fs.writeFileSync(path.join(imageDir, name), bytes);
  return name;
}

function createBackup() {
  const zip = new AdmZip();
  const payload = db.exportAll();
  // Android compatibility: its importer expects backup.json at ZIP root.
  zip.addFile('backup.json', Buffer.from(JSON.stringify(payload, null, 2), 'utf8'));
  // Keep the first Windows prototype format too, so earlier desktop builds can read it.
  zip.addFile('storex-backup.json', Buffer.from(JSON.stringify({
    format: 'StoreXBackup', version: 1, exportedAt: new Date().toISOString(), ...payload
  }, null, 2), 'utf8'));
  for (const product of payload.products) {
    if (!product.image) continue;
    const file = safeImagePath(product.image);
    if (file && fs.existsSync(file)) zip.addLocalFile(file, 'images');
  }
  return zip;
}

function mergeBackup(buffer) {
  const zip = new AdmZip(buffer);
  const entry = zip.getEntry('backup.json') || zip.getEntry('storex-backup.json');
  if (!entry) throw new Error('ملف النسخة الاحتياطية لا يحتوي backup.json');
  const raw = JSON.parse(entry.getData().toString('utf8'));
  const data = raw.data && typeof raw.data === 'object' ? raw.data : raw;
  if (!Array.isArray(data.products) || !Array.isArray(data.categories)) {
    throw new Error('بنية النسخة الاحتياطية غير مدعومة');
  }
  // Only accept flat filenames inside images/; never extract arbitrary ZIP paths.
  const imageEntries = zip.getEntries().filter(e => !e.isDirectory && e.entryName.startsWith('images/'));
  for (const e of imageEntries) {
    const relative = e.entryName.slice('images/'.length);
    if (!relative || relative.includes('/') || relative.includes('\\') || relative === '.' || relative === '..') continue;
    const target = safeImagePath(relative);
    if (target) fs.writeFileSync(target, e.getData());
  }
  db.mergeAll(data);
}


app.whenReady().then(() => {
  imageDir = path.join(app.getPath('userData'), 'images');
  fs.mkdirSync(imageDir, { recursive: true });
  db.init(path.join(app.getPath('userData'), 'storex.sqlite'));

  protocol.handle('storex-image', request => {
    const url = new URL(request.url);
    const name = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    const file = safeImagePath(name);
    if (!file || !fs.existsSync(file)) return new Response('Not found', { status: 404 });
    const ext = path.extname(file).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    return new Response(fs.readFileSync(file), { headers: { 'content-type': mime, 'cache-control': 'no-store' } });
  });

  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(['media', 'camera'].includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    return ['media', 'camera'].includes(permission);
  });

  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// Synchronous SQLite operations keep the existing StoreX UI call pattern intact.
ipcMain.on('db:getData', event => { event.returnValue = JSON.stringify(db.getAll()); });
ipcMain.on('db:saveProduct', (event, json) => {
  try { event.returnValue = db.saveProduct(JSON.parse(json)); }
  catch (e) { event.returnValue = 0; console.error(e); }
});
ipcMain.on('db:deleteProduct', (event, id) => {
  const imageName = db.getProductImage(Number(id));
  const deleted = db.deleteProduct(Number(id));
  if (deleted && imageName && !imageName.includes('/') && !imageName.includes('\\') && !db.isImageUsed(imageName)) {
    const imageFile = safeImagePath(imageName);
    if (imageFile && fs.existsSync(imageFile)) { try { fs.unlinkSync(imageFile); } catch (e) { console.warn('Could not remove unused product image:', e); } }
  }
  event.returnValue = deleted;
});
ipcMain.on('db:saveCategory', (event, name) => { event.returnValue = db.saveCategory(String(name)); });
ipcMain.on('db:updateCategory', (event, oldName, newName) => { event.returnValue = db.updateCategory(String(oldName), String(newName)); });
ipcMain.on('db:deleteCategory', (event, name) => { event.returnValue = db.deleteCategory(String(name)); });
ipcMain.on('db:setExchangeRate', (event, rate) => { event.returnValue = db.setExchangeRate(Number(rate)); });
ipcMain.on('db:saveImage', (event, dataUrl) => {
  try { event.returnValue = writeDataImage(dataUrl); }
  catch (e) { console.error(e); event.returnValue = ''; }
});
ipcMain.on('db:imageUrl', (event, name) => {
  const file = safeImagePath(name);
  event.returnValue = file && fs.existsSync(file) ? `storex-image:///${encodeURIComponent(path.basename(file))}` : '';
});

ipcMain.handle('backup:export', async (_event, suggestedName) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'تصدير نسخة احتياطية',
    defaultPath: suggestedName || 'StoreX_Backup.zip',
    filters: [{ name: 'ZIP Backup', extensions: ['zip'] }]
  });
  if (result.canceled || !result.filePath) return false;
  try { createBackup().writeZip(result.filePath); sendToRenderer('onBackupExported', true); return true; }
  catch (e) { console.error(e); sendToRenderer('onBackupExported', false); return false; }
});

ipcMain.handle('backup:import', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'استيراد نسخة احتياطية',
    properties: ['openFile'],
    filters: [{ name: 'ZIP Backup', extensions: ['zip'] }]
  });
  if (result.canceled || !result.filePaths[0]) return false;
  try {
    mergeBackup(fs.readFileSync(result.filePaths[0]));
    sendToRenderer('onBackupImported', true);
    return true;
  } catch (e) {
    console.error(e);
    dialog.showErrorBox('تعذر استيراد النسخة', e.message || 'ملف غير صالح');
    sendToRenderer('onBackupImported', false);
    return false;
  }
});

ipcMain.handle('report:print', async (_event, reportHtml) => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  });
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(String(reportHtml)));
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { top: 0.35, bottom: 0.35, left: 0.35, right: 0.35 }
    });
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'حفظ تقرير StoreX بصيغة PDF',
      defaultPath: `StoreX_Report_${new Date().toISOString().slice(0,10)}.pdf`,
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    });
    if (result.canceled || !result.filePath) return false;
    fs.writeFileSync(result.filePath, pdf);
    return true;
  } finally { if (!win.isDestroyed()) win.close(); }
});

ipcMain.handle('report:saveImage', async (_event, dataUrl) => {
  try {
    const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/i.exec(String(dataUrl || ''));
    if (!match) throw new Error('بيانات الصورة غير صالحة');
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'حفظ صورة التقرير',
      defaultPath: `StoreX_Report_${new Date().toISOString().slice(0,10)}.png`,
      filters: [{ name: 'PNG', extensions: ['png'] }]
    });
    if (result.canceled || !result.filePath) return false;
    fs.writeFileSync(result.filePath, Buffer.from(match[1], 'base64'));
    sendToRenderer('onReportImageSaved', true);
    return true;
  } catch (e) {
    console.error(e); sendToRenderer('onReportImageSaved', false); return false;
  }
});

ipcMain.handle('rate:fetch', async () => {
  const endpoint = 'https://lirascope.syria-cloud.sy/api/v1/rates/latest?currencies=USD&lang=ar';
  try {
    const response = await net.fetch(endpoint, {
      headers: { Accept: 'application/json', 'User-Agent': 'StoreX-Windows/1.0' }
    });
    if (!response.ok) throw new Error(`مصدر الأسعار أعاد HTTP ${response.status}`);
    const root = await response.json();
    const rates = Array.isArray(root?.marketRates) ? root.marketRates : null;
    if (!rates) throw new Error('لم تصل قائمة أسعار السوق من المصدر');
    const usd = rates.find(item => String(item?.currency || '').toUpperCase() === 'USD');
    if (!usd) throw new Error('سعر الدولار غير موجود في بيانات السوق');
    const marketSellNewSyp = Number(usd.sell);
    if (!Number.isFinite(marketSellNewSyp) || marketSellNewSyp <= 0) {
      throw new Error('قيمة سعر السوق غير صالحة');
    }
    // Android source stores the app rate in the older SYP unit (x100).
    const appRate = marketSellNewSyp * 100;
    const updatedAt = String(usd.timestampUtc || root.timestampUtc || '');
    if (!db.updateMarketRateAndRecalculateProducts(appRate, updatedAt)) {
      throw new Error('تعذر حفظ سعر السوق في قاعدة البيانات');
    }
    sendToRenderer('onMarketRateUpdated', appRate, updatedAt);
    return true;
  } catch (e) {
    console.error(e);
    sendToRenderer('onMarketRateFailed', e.message || 'تعذر جلب سعر السوق');
    return false;
  }
});

ipcMain.handle('native:openExternal', async (_event, url) => {
  const { shell } = require('electron');
  if (/^https?:\/\//i.test(String(url))) return shell.openExternal(String(url));
  return false;
});
