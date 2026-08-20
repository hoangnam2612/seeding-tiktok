import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  getDesktopMetadata: () => ipcRenderer.invoke('get-desktop-metadata'),
  focusWindow: () => ipcRenderer.invoke('focus-window'),
  openAccountLoginWindow: (
    accountId: string,
    username: string,
    cookie?: string,
    proxy?: string,
    proxyType?: string,
    password?: string,
    email?: string,
    passMail?: string,
    twoFactor?: string,
    muteBrowserAudio?: boolean
  ) => ipcRenderer.invoke('open-account-login-window', accountId, username, cookie, proxy, proxyType, password, email, passMail, twoFactor, muteBrowserAudio),

  openMultiAccountChromes: (accountIds: string[], maxThreads: number, accountsData: any[], muteBrowserAudio?: boolean) =>
    ipcRenderer.invoke('open-multi-account-chromes', accountIds, maxThreads, accountsData, muteBrowserAudio),
  closeAllBrowserWindows: () => ipcRenderer.invoke('close-all-browser-windows'),
  executeSeedingTask: (config: any, accounts: any[]) =>
    ipcRenderer.invoke('execute-seeding-task', config, accounts),
  onSeedingStateChanged: (callback: (state: any) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: any) => callback(state);
    ipcRenderer.on('seeding-state-changed', listener);
    return () => ipcRenderer.removeListener('seeding-state-changed', listener);
  },
  platform: process.platform,
});
