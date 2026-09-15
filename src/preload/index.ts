import { contextBridge, ipcRenderer } from 'electron';

const workflow = (action: string, payload?: unknown) => ipcRenderer.invoke('workflows', action, payload);
async function legacySeeding(config: any) {
  const live = config.targetType === 'live' || config.targetType === 'livestream';
  const result = await workflow('start', { command: live ? 'live' : 'video', accountIds: config.accountIds,
    browserOverrides: { maxThreads: config.maxThreads, disableAudio: config.muteBrowserAudio },
    config: live ? { liveUrls: [config.targetUrl], minWatchMinutes: Math.max(1, Math.ceil(config.liveDurationSeconds / 60)), maxWatchMinutes: Math.max(1, Math.ceil(config.liveDurationSeconds / 60)), isSendHearts: config.likeEnabled, isCommentLive: !!config.comments?.length, liveComments: config.comments, commentIntervalSeconds: Math.max(1, config.delaySeconds) }
      : { videoUrls: [config.targetUrl], isLike: config.likeEnabled, isComment: !!config.comments?.length, comments: config.comments, minDelaySeconds: config.delaySeconds, maxDelaySeconds: config.delaySeconds } });
  if (!result.success) return result;
  for (;;) { await new Promise(resolve => setTimeout(resolve, 500)); const state = await workflow('state'); if (!state.isRunning) return state; }
}

contextBridge.exposeInMainWorld('electronAPI', {
  workflows: (action: string, payload?: unknown) => ipcRenderer.invoke('workflows', action, payload),
  getDesktopMetadata: () => ipcRenderer.invoke('get-desktop-metadata'),
  getApiAuthToken: () => ipcRenderer.invoke('get-api-auth-token'),
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
  ) => workflow('start', { command: 'login', accountIds: [accountId], config: {}, browserOverrides: { disableAudio: muteBrowserAudio } }),

  openMultiAccountChromes: (accountIds: string[], maxThreads: number, accountsData: any[], muteBrowserAudio?: boolean) =>
    workflow('start', { command: 'login', accountIds, config: {}, browserOverrides: { maxThreads, disableAudio: muteBrowserAudio } }),
  closeAllBrowserWindows: () => workflow('cancel'),
  executeSeedingTask: (config: any, accounts: any[]) =>
    legacySeeding(config),
  onSeedingStateChanged: (callback: (state: any) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: any) => callback(state);
    ipcRenderer.on('seeding-state-changed', listener);
    return () => ipcRenderer.removeListener('seeding-state-changed', listener);
  },
  platform: process.platform,
});
