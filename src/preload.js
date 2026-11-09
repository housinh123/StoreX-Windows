const { contextBridge, ipcRenderer } = require('electron');

const sync = (channel, ...args) => ipcRenderer.sendSync(channel, ...args);

contextBridge.exposeInMainWorld('StoreXHost', Object.freeze({
  getData: () => sync('db:getData'),
  saveProduct: json => sync('db:saveProduct', json),
  deleteProduct: id => sync('db:deleteProduct', id),
  saveCategory: name => sync('db:saveCategory', name),
  updateCategory: (oldName, newName) => sync('db:updateCategory', oldName, newName),
  deleteCategory: name => sync('db:deleteCategory', name),
  setExchangeRate: rate => sync('db:setExchangeRate', rate),
  saveImage: dataUrl => sync('db:saveImage', dataUrl),
  imageUrl: name => sync('db:imageUrl', name),
  exportBackup: name => ipcRenderer.invoke('backup:export', name),
  importBackup: () => ipcRenderer.invoke('backup:import'),
  fetchMarketRate: () => ipcRenderer.invoke('rate:fetch'),
  printReport: html => ipcRenderer.invoke('report:print', html),
  saveReportImage: dataUrl => ipcRenderer.invoke('report:saveImage', dataUrl),
  openExternal: url => ipcRenderer.invoke('native:openExternal', url)
}));
