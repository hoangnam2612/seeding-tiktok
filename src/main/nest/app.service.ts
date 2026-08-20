import { Injectable } from '@nestjs/common';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { ensurePersistentDataDir } from '../data-dir';
import { decryptSecret, encryptSecret, hasEncryptedSecret } from '../secret-json';

export interface AppSettings {
  omocaptchaApiKey?: string;
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
      if (!fs.existsSync(this.settingsFilePath)) return {};
      const settings = JSON.parse(fs.readFileSync(this.settingsFilePath, 'utf-8'));
      const decryptedSettings = {
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
      return {};
    }
  }

  saveSettings(settings: AppSettings): AppSettings {
    this.ensureDataDir();
    const current = this.getSettings();
    const next: AppSettings = {
      ...current,
      omocaptchaApiKey: settings.omocaptchaApiKey?.trim() || '',
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
