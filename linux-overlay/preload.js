/* preload.js — efterligner WebView2's `window.chrome.webview`-kanal, så
 * RLLiveTracker.html (?overlay&glass&slot=…) kører UÆNDRET under Electron.
 *
 * Siden bruger (RLLiveTracker.html, glass-blokken ~linje 6610-6685):
 *   ovHost = window.chrome && window.chrome.webview
 *   ovHost.postMessage('size:B,H')   // klyngens mål i CSS-px
 *   ovHost.postMessage('empty')      // intet at vise -> værten skjuler ruden
 *   ovHost.postMessage('drag')       // alt-træk / midterklik -> værten flytter vinduet
 *   ovHost.addEventListener('message', e => e.data === 'max:N')  // plads til kanten
 *
 * Kører med contextIsolation:false, så `window` HER er sidens eget window og
 * shim'en kan lægges direkte på window.chrome. Siden er vores egen
 * localhost-side, så det er acceptabelt for en prototype — men det er en
 * bevidst afvigelse fra Electrons anbefaling. */
'use strict';
const { ipcRenderer } = require('electron');

const listeners = new Set();
const shim = {
  postMessage(msg){ ipcRenderer.send('ov:msg', String(msg)); },
  addEventListener(type, fn){ if (type === 'message' && typeof fn === 'function') listeners.add(fn); },
  removeEventListener(type, fn){ if (type === 'message') listeners.delete(fn); }
};
ipcRenderer.on('ov:host', (_e, data) => {
  for (const fn of listeners){ try{ fn({ data: String(data) }); }catch{} }
});

if (!window.chrome || typeof window.chrome !== 'object'){
  try{ window.chrome = {}; }catch{}
}
try{ window.chrome.webview = shim; }
catch{
  try{ Object.defineProperty(window.chrome, 'webview', { value: shim, configurable: true }); }catch{}
}

/* Windows-værten får slut-på-træk gratis fra WM_NCLBUTTONDOWN. Her melder
 * siden det selv: pointerup hvor som helst = trækket er slut. */
window.addEventListener('pointerup', () => ipcRenderer.send('ov:msg', 'dragend'), true);
window.addEventListener('pointercancel', () => ipcRenderer.send('ov:msg', 'dragend'), true);
