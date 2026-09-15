import 'reflect-metadata';
import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';
import { Request, Response, NextFunction } from 'express';
import { API_AUTH_HEADER, getApiAuthToken, isValidApiAuthToken } from './api-auth';

// Disable Chromium WebAuthn / Passkey OS popups
app.commandLine.appendSwitch('disable-features', 'WebAuthentication,WebAuthenticationConditionalUI,WebAuthenticationUI');

import { NestFactory } from '@nestjs/core';
import { AppModule } from './nest/app.module';
import { AccountsService } from './nest/accounts/accounts.service';
import { AutomationService } from './nest/automation/automation.service';
import { ClientAuthService } from './nest/client-auth/client-auth.service';

import { setupWorkflowIPC } from './workflows/ipc';


let mainWindow: BrowserWindow | null = null;
const NEST_PORT = 3000;

async function bootstrapNest() {
  const nestApp = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });
  nestApp.enableCors({
    origin: (origin, callback) => {
      const allowedOrigins = new Set([
        'http://localhost:5174',
        'http://127.0.0.1:5174',
        'file://',
        'null',
      ]);
      if (!origin || allowedOrigins.has(origin)) return callback(null, true);
      return callback(null, false);
    },
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    allowedHeaders: `Content-Type, Accept, Authorization, ${API_AUTH_HEADER}`,
  });
  nestApp.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'OPTIONS' || !req.path.startsWith('/api')) return next();
    if (isValidApiAuthToken(req.header(API_AUTH_HEADER))) return next();
    return res.status(401).json({ success: false, message: 'Unauthorized local API request.' });
  });
  await nestApp.listen(NEST_PORT, '127.0.0.1');
  console.log(`[NestJS Backend] Listening on http://127.0.0.1:${NEST_PORT}`);

  const accountsService = nestApp.get(AccountsService);
  const automationService = nestApp.get(AutomationService);
  const clientAuthService = nestApp.get(ClientAuthService);
  setupWorkflowIPC(accountsService, automationService, clientAuthService, () => mainWindow);

  const reportCrash = (label: string, error: unknown) => {
    const details = error instanceof Error
      ? `${label}: ${error.stack || error.message}`
      : `${label}: ${String(error)}`;
    clientAuthService.reportTelemetry('crash', details).catch(() => undefined);
  };
  process.on('uncaughtException', (error) => {
    reportCrash('uncaughtException', error);
    console.error('[Uncaught Exception]', error);
  });
  process.on('unhandledRejection', (reason) => {
    reportCrash('unhandledRejection', reason);
    console.error('[Unhandled Rejection]', reason);
  });


}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 650,
    title: 'Seeding TikTok',
    backgroundColor: '#0f172a',
    show: false,
    // Keep the native title bar so every screen has a draggable window handle.
    frame: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

  if (isDev) {
    mainWindow.loadURL('http://localhost:5174');
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

ipcMain.handle('get-api-auth-token', () => getApiAuthToken());
