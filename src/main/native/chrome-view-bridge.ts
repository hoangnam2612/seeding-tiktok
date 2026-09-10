import { spawn, ChildProcess, execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';

export class ChromeViewBridge {
  private static instance: ChromeViewBridge;
  private process: ChildProcess | null = null;
  private isReady = false;
  private exePath = '';

  public static getInstance(): ChromeViewBridge {
    if (!ChromeViewBridge.instance) {
      ChromeViewBridge.instance = new ChromeViewBridge();
    }
    return ChromeViewBridge.instance;
  }

  private getCscPath(): string {
    const defaultCsc = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
    if (fs.existsSync(defaultCsc)) return defaultCsc;
    const x86Csc = 'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe';
    if (fs.existsSync(x86Csc)) return x86Csc;
    return 'csc.exe';
  }

  public ensureBinary(): string {
    if (process.platform !== 'win32') return '';

    const userData = app?.getPath ? app.getPath('userData') : process.cwd();
    const binDir = path.join(userData, 'bin');
    if (!fs.existsSync(binDir)) {
      fs.mkdirSync(binDir, { recursive: true });
    }

    const targetExe = path.join(binDir, 'ChromeView.exe');
    this.exePath = targetExe;

    // Check if binary already compiled
    if (fs.existsSync(targetExe)) {
      return targetExe;
    }

    const precompiledInDist = path.join(__dirname, 'bin/ChromeView.exe');
    if (fs.existsSync(precompiledInDist)) {
      try {
        fs.copyFileSync(precompiledInDist, targetExe);
        return targetExe;
      } catch {}
    }

    // Compile from source
    const sourcePath = path.resolve(__dirname, '../../src/main/native/ChromeViewForm.cs');
    const altSourcePath = path.resolve(__dirname, '../native/ChromeViewForm.cs');
    const actualSource = fs.existsSync(sourcePath) ? sourcePath : altSourcePath;

    if (fs.existsSync(actualSource)) {
      const csc = this.getCscPath();
      try {
        execSync(`"${csc}" /target:winexe /out:"${targetExe}" "${actualSource}"`, {
          windowsHide: true,
          stdio: 'ignore',
        });
        console.log('[ChromeViewBridge] Compiled ChromeView.exe successfully.');
      } catch (compileErr) {
        console.error('[ChromeViewBridge] Failed to compile ChromeView.exe:', compileErr);
      }
    }

    return targetExe;
  }

  public ensureStarted(): boolean {
    if (process.platform !== 'win32') return false;
    if (this.process && !this.process.killed) return true;

    const exe = this.ensureBinary();
    if (!fs.existsSync(exe)) return false;

    try {
      this.process = spawn(exe, [], {
        windowsHide: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.process.stdout?.on('data', (data) => {
        const msg = data.toString();
        if (msg.includes('CHROME_VIEW_READY')) {
          this.isReady = true;
        }
      });

      this.process.on('exit', () => {
        this.process = null;
        this.isReady = false;
      });

      this.isReady = true;
      return true;
    } catch (err) {
      console.error('[ChromeViewBridge] Failed to start ChromeView process:', err);
      return false;
    }
  }

  public sendCommand(cmd: string): void {
    if (!this.ensureStarted() || !this.process?.stdin) return;
    try {
      this.process.stdin.write(cmd + '\n');
    } catch (err) {
      console.error('[ChromeViewBridge] Error sending command:', cmd, err);
    }
  }

  public showView(): void {
    this.sendCommand('SHOW');
  }

  public addChrome(uniqueTitle: string, slotIndex: number, width: number, height: number): void {
    this.sendCommand(`ADD ${uniqueTitle} ${slotIndex} ${width} ${height}`);
  }

  public removeChrome(slotIndex: number): void {
    this.sendCommand(`REMOVE ${slotIndex}`);
  }

  public clear(): void {
    this.sendCommand('CLEAR');
  }

  public stop(): void {
    if (this.process) {
      this.sendCommand('QUIT');
      try {
        this.process.kill();
      } catch {}
      this.process = null;
    }
  }
}

export const chromeViewBridge = ChromeViewBridge.getInstance();
