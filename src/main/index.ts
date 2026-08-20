import 'reflect-metadata';
import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';

// Disable Chromium WebAuthn / Passkey OS popups
app.commandLine.appendSwitch('disable-features', 'WebAuthentication,WebAuthenticationConditionalUI,WebAuthenticationUI');

import { NestFactory } from '@nestjs/core';
import { AppModule } from './nest/app.module';
import { AccountsService } from './nest/accounts/accounts.service';
import { AutomationService } from './nest/automation/automation.service';
import { setupAutomationIPC } from './automation-runner';


let mainWindow: BrowserWindow | null = null;
const NEST_PORT = 3000;

async function bootstrapNest() {
  const nestApp = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });
  nestApp.enableCors({
    origin: '*',
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    allowedHeaders: 'Content-Type, Accept, Authorization',
  });
  await nestApp.listen(NEST_PORT, '127.0.0.1');
  console.log(`[NestJS Backend] Listening on http://127.0.0.1:${NEST_PORT}`);

  const accountsService = nestApp.get(AccountsService);
  const automationService = nestApp.get(AutomationService);

  setupAutomationIPC(
    (log) => automationService.addLog(log),
    (id, status) => accountsService.updateAccountStatus(id, status),
    (id, update) => accountsService.updateAccount(id, update),
    (state) => {
      if (!mainWindow?.isDestroyed()) {
        mainWindow?.webContents.send('seeding-state-changed', state);
      }
    }
  );
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 650,
    title: 'Electron + NestJS + React App',
    backgroundColor: '#0f172a',
    show: false,
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' }
      : { titleBarStyle: 'hidden', titleBarOverlay: { color: '#0b0f19', symbolColor: '#f8fafc', height: 35 } }),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    mainWindow?.focus();
    mainWindow?.webContents.focus();
  });

  mainWindow.on('focus', () => {
    mainWindow?.webContents.focus();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  try {
    await bootstrapNest();
  } catch (error) {
    console.error('[NestJS Boot Error]', error);
  }
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// IPC Handler to focus main window
ipcMain.handle('focus-window', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    mainWindow.webContents.focus();
  }
  return true;
});

// IPC Handler for native desktop metadata
ipcMain.handle('get-desktop-metadata', () => {
  return {
    appName: 'Electron Nest React App',
    version: '1.0.0',
    nestUrl: `http://127.0.0.1:${NEST_PORT}/api`,
    electronVersion: process.versions.electron,
    chromeVersion: process.versions.chrome,
    nodeVersion: process.versions.node,
  };
});
