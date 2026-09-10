import { Injectable } from '@nestjs/common';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { ensurePersistentDataDir } from '../data-dir';
import { decryptSecret, encryptSecret, hasEncryptedSecret } from '../secret-json';

export interface AppSettings {
  omocaptchaApiKey?: string;
  chromeWindowPreset?: string;
  chromeWindowWidth?: number;
  chromeWindowHeight?: number;
  chromeGridColumns?: number;
  chromeScaleFactor?: number;
}

export function getStoredAppSettings(): AppSettings {
  try {
    const dataDir = ensurePersistentDataDir();
    const settingsFilePath = path.join(dataDir, 'settings.json');
    if (!fs.existsSync(settingsFilePath)) {
      return {
        chromeWindowPreset: '360x480',
        chromeWindowWidth: 360,
        chromeWindowHeight: 480,
        chromeGridColumns: 4,
        chromeScaleFactor: 0.65,
      };
    }
    const settings = JSON.parse(fs.readFileSync(settingsFilePath, 'utf-8'));
    return {
      chromeWindowPreset: settings.chromeWindowPreset || '360x480',
      chromeWindowWidth: settings.chromeWindowWidth || 360,
      chromeWindowHeight: settings.chromeWindowHeight || 480,
      chromeGridColumns: settings.chromeGridColumns || 4,
      chromeScaleFactor: settings.chromeScaleFactor !== undefined ? settings.chromeScaleFactor : 0.65,
      ...settings,
      omocaptchaApiKey: decryptSecret(settings.omocaptchaApiKey),
    };
  } catch (err) {
    console.error('[AppService] Failed to read stored settings:', err);
    return {
      chromeWindowPreset: '360x480',
      chromeWindowWidth: 360,
      chromeWindowHeight: 480,
      chromeGridColumns: 4,
      chromeScaleFactor: 0.65,
    };
  }
}

@Injectable()
export class AppService {
  private dataDir = ensurePersistentDataDir();
  private settingsFilePath = path.join(this.dataDir, 'settings.json');

  private ensureDataDir() {
    this.dataDir = ensurePersistentDataDir();
    this.settingsFilePath = path.join(this.dataDir, 'settings.json');
  }

  getSettings(): AppSettings {
    try {
      this.ensureDataDir();
      if (!fs.existsSync(this.settingsFilePath)) {
        return {
          chromeWindowPreset: '360x480',
          chromeWindowWidth: 360,
          chromeWindowHeight: 480,
          chromeGridColumns: 4,
          chromeScaleFactor: 0.65,
        };
      }
      const settings = JSON.parse(fs.readFileSync(this.settingsFilePath, 'utf-8'));
      const decryptedSettings: AppSettings = {
        chromeWindowPreset: settings.chromeWindowPreset || '360x480',
        chromeWindowWidth: settings.chromeWindowWidth || 360,
        chromeWindowHeight: settings.chromeWindowHeight || 480,
        chromeGridColumns: settings.chromeGridColumns || 4,
        chromeScaleFactor: settings.chromeScaleFactor !== undefined ? settings.chromeScaleFactor : 0.65,
        ...settings,
        omocaptchaApiKey: decryptSecret(settings.omocaptchaApiKey),
      };
      if (decryptedSettings.omocaptchaApiKey && !hasEncryptedSecret(settings.omocaptchaApiKey)) {
        fs.writeFileSync(
          this.settingsFilePath,
          JSON.stringify({ ...settings, omocaptchaApiKey: encryptSecret(decryptedSettings.omocaptchaApiKey) }, null, 2),
          'utf-8'
        );
      }
      return decryptedSettings;
    } catch (err) {
      console.error('[AppService] Failed to read settings:', err);
      return {
        chromeWindowPreset: '360x480',
        chromeWindowWidth: 360,
        chromeWindowHeight: 480,
        chromeGridColumns: 4,
        chromeScaleFactor: 0.65,
      };
    }
  }

  saveSettings(settings: AppSettings): AppSettings {
    this.ensureDataDir();
    const current = this.getSettings();
    const next: AppSettings = {
      ...current,
      omocaptchaApiKey: settings.omocaptchaApiKey !== undefined ? settings.omocaptchaApiKey.trim() : (current.omocaptchaApiKey || ''),
      chromeWindowPreset: settings.chromeWindowPreset || current.chromeWindowPreset || '360x480',
      chromeWindowWidth: Number(settings.chromeWindowWidth) || current.chromeWindowWidth || 360,
      chromeWindowHeight: Number(settings.chromeWindowHeight) || current.chromeWindowHeight || 480,
      chromeGridColumns: Number(settings.chromeGridColumns) || current.chromeGridColumns || 4,
      chromeScaleFactor: settings.chromeScaleFactor !== undefined ? Number(settings.chromeScaleFactor) : (current.chromeScaleFactor ?? 0.65),
    };
    const storageSettings: AppSettings = {
      ...next,
      omocaptchaApiKey: encryptSecret(next.omocaptchaApiKey),
    };
    fs.writeFileSync(this.settingsFilePath, JSON.stringify(storageSettings, null, 2), 'utf-8');
    return next;
  }

  getHello(): { message: string; timestamp: string } {
    return {
      message: 'Xin chào! NestJS Backend đang chạy mượt mà bên trong Electron Main Process! 🚀',
      timestamp: new Date().toISOString(),
    };
  }

  getStatus() {
    return {
      status: 'online',
      framework: 'NestJS v10',
      runtime: `Node.js ${process.version}`,
      platform: process.platform,
      arch: process.arch,
      uptimeSeconds: Math.floor(process.uptime()),
      memoryUsage: {
        rssMB: (process.memoryUsage().rss / 1024 / 1024).toFixed(2),
        heapTotalMB: (process.memoryUsage().heapTotal / 1024 / 1024).toFixed(2),
        heapUsedMB: (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2),
      },
      system: {
        totalMemGB: (os.totalmem() / 1024 / 1024 / 1024).toFixed(2),
        freeMemGB: (os.freemem() / 1024 / 1024 / 1024).toFixed(2),
        cpus: os.cpus().length,
        hostname: os.hostname(),
      },
    };
  }

  processTask(taskName: string, payload: any) {
    return {
      success: true,
      taskId: `TASK-${Math.floor(Math.random() * 899999 + 100000)}`,
      receivedTask: taskName,
      payload,
      processedAt: new Date().toISOString(),
    };
  }
}
