import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  getDesktopMetadata: () => ipcRenderer.invoke('get-desktop-metadata'),
  focusWindow: () => ipcRenderer.invoke('focus-window'),
  openAccountLoginWindow: (
    accountId: string,
    username: string,
    cookie?: string,
    proxy?: string,
    password?: string,
    email?: string,
    passMail?: string,
    twoFactor?: string
  ) => ipcRenderer.invoke('open-account-login-window', accountId, username, cookie, proxy, password, email, passMail, twoFactor),

  openMultiAccountChromes: (accountIds: string[], maxThreads: number, accountsData: any[]) =>
    ipcRenderer.invoke('open-multi-account-chromes', accountIds, maxThreads, accountsData),
  closeAllBrowserWindows: () => ipcRenderer.invoke('close-all-browser-windows'),
  executeSeedingTask: (config: any, accounts: any[]) =>
    ipcRenderer.invoke('execute-seeding-task', config, accounts),
  platform: process.platform,
});
