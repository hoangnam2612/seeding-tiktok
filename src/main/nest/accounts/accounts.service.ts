import { Injectable, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { TikTokAccount, AccountCategory, ProxyEntry } from './account.interface';
import https from 'https';
import { ensurePersistentDataDir } from '../../data-dir';

@Injectable()
export class AccountsService implements OnModuleInit {
  private dataDir: string;
  private accountsFilePath: string;
  private categoriesFilePath: string;
  private proxiesFilePath: string;

  private accounts: TikTokAccount[] = [];
  private categories: AccountCategory[] = [];
  private proxies: ProxyEntry[] = [];

  onModuleInit() {
    this.dataDir = ensurePersistentDataDir();
    this.accountsFilePath = path.join(this.dataDir, 'accounts.json');
    this.categoriesFilePath = path.join(this.dataDir, 'categories.json');
    this.proxiesFilePath = path.join(this.dataDir, 'proxies.json');

    this.loadCategories();
    this.loadAccounts();
    this.loadProxies();
  }

  // --- CATEGORIES MANAGEMENT ---
  private loadCategories() {
    try {
      if (fs.existsSync(this.categoriesFilePath)) {
        const fileContent = fs.readFileSync(this.categoriesFilePath, 'utf-8');
        this.categories = JSON.parse(fileContent);
      } else {
        this.categories = [
          { id: 'cat_default', name: 'Mặc Định', color: '#6366f1', createdAt: new Date().toISOString() },
          { id: 'cat_nuoi', name: 'Nick Nuôi', color: '#10b981', createdAt: new Date().toISOString() },
          { id: 'cat_seeding', name: 'Nick Seeding', color: '#f59e0b', createdAt: new Date().toISOString() },
        ];
        this.saveCategories();
      }
    } catch (err) {
      console.error('[AccountsService] Failed to load categories file:', err);
      this.categories = [];
    }
  }

  private saveCategories() {
    try {
      fs.writeFileSync(this.categoriesFilePath, JSON.stringify(this.categories, null, 2), 'utf-8');
    } catch (err) {
      console.error('[AccountsService] Failed to save categories file:', err);
    }
  }

  getAllCategories(): AccountCategory[] {
    return this.categories;
  }

  addCategory(name: string, color?: string): AccountCategory {
    const newCat: AccountCategory = {
      id: 'cat_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
      name: name.trim(),
      color: color || '#3b82f6',
      createdAt: new Date().toISOString(),
    };
    this.categories.push(newCat);
    this.saveCategories();
    return newCat;
  }

  deleteCategory(id: string): boolean {
    if (id === 'cat_default') return false; // Prevent deleting default category
    const len = this.categories.length;
    this.categories = this.categories.filter(c => c.id !== id);
    if (this.categories.length !== len) {
      this.saveCategories();
      // Move accounts in this category to cat_default
      this.accounts.forEach(a => {
        if (a.categoryId === id) a.categoryId = 'cat_default';
      });
      this.saveAccounts();
      return true;
    }
    return false;
  }

  // --- ACCOUNTS MANAGEMENT ---
  private isValidTikTokCookie(cookie?: string): boolean {
    if (!cookie) return false;
    const lowerCookie = cookie.toLowerCase();
    return lowerCookie.includes('sessionid=') ||
           lowerCookie.includes('sessionid_ss=') ||
           lowerCookie.includes('sid_tt=') ||
           cookie.includes(';');
  }

  private looksLikeTotpSecret(value?: string): boolean {
    if (!value) return false;
    return /^[A-Z2-7]{16,}$/i.test(value.trim()) && !value.includes('=');
  }

  private normalizeImportedAccount(acc: TikTokAccount): boolean {
    if (acc.cookie && !this.isValidTikTokCookie(acc.cookie) && !acc.twoFactor && this.looksLikeTotpSecret(acc.cookie)) {
      acc.twoFactor = acc.cookie.trim();
      acc.cookie = '';
      acc.status = 'unauthenticated';
      return true;
    }
    if (acc.cookie && !this.isValidTikTokCookie(acc.cookie)) {
      acc.status = 'unauthenticated';
      return true;
    }
    return false;
  }

  private loadAccounts() {
    try {
      if (fs.existsSync(this.accountsFilePath)) {
        const fileContent = fs.readFileSync(this.accountsFilePath, 'utf-8');
        this.accounts = JSON.parse(fileContent);
        let changed = false;
        this.accounts.forEach(acc => {
          changed = this.normalizeImportedAccount(acc) || changed;
        });
        if (changed) this.saveAccounts();
      } else {
        this.accounts = [];
        this.saveAccounts();
      }
    } catch (err) {
      console.error('[AccountsService] Failed to load accounts file:', err);
      this.accounts = [];
    }
  }

  private saveAccounts() {
    try {
      fs.writeFileSync(this.accountsFilePath, JSON.stringify(this.accounts, null, 2), 'utf-8');
    } catch (err) {
      console.error('[AccountsService] Failed to save accounts file:', err);
    }
  }

  private loadProxies() {
    try {
      if (fs.existsSync(this.proxiesFilePath)) {
        const fileContent = fs.readFileSync(this.proxiesFilePath, 'utf-8');
        this.proxies = JSON.parse(fileContent);
      } else {
        this.proxies = [];
        this.saveProxies();
      }
    } catch (err) {
      console.error('[AccountsService] Failed to load proxies file:', err);
      this.proxies = [];
    }
  }

  private saveProxies() {
    try {
      fs.writeFileSync(this.proxiesFilePath, JSON.stringify(this.proxies, null, 2), 'utf-8');
    } catch (err) {
      console.error('[AccountsService] Failed to save proxies file:', err);
    }
  }

  private isValidProxyValue(proxy?: string): boolean {
    return !!proxy && proxy.trim().includes(':');
  }

  getAllProxies(): ProxyEntry[] {
    return this.proxies;
  }

  importProxies(
    rawText: string,
    proxyType: ProxyEntry['proxyType'] = 'http'
  ): { addedCount: number; skippedCount: number; proxies: ProxyEntry[]; skippedLines: { line: number; rawText: string; reason: string }[] } {
    const skippedLines: { line: number; rawText: string; reason: string }[] = [];
    let addedCount = 0;
    let skippedCount = 0;
    const existingValues = new Set(this.proxies.map(p => p.value.trim()));

    rawText.split(/\r?\n/).forEach((rawLine, idx) => {
      const value = rawLine.trim();
      if (!value) return;

      if (!this.isValidProxyValue(value)) {
        skippedCount++;
        skippedLines.push({ line: idx + 1, rawText: rawLine, reason: 'Proxy thiếu ip:port' });
        return;
      }

      if (existingValues.has(value)) {
        skippedCount++;
        skippedLines.push({ line: idx + 1, rawText: rawLine, reason: 'Proxy đã tồn tại' });
        return;
      }

      const proxy: ProxyEntry = {
        id: 'proxy_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
        value,
        proxyType,
        status: 'untested',
        createdAt: new Date().toISOString(),
      };
      this.proxies.push(proxy);
      existingValues.add(value);
      addedCount++;
    });

    if (addedCount > 0) this.saveProxies();
    return { addedCount, skippedCount, proxies: this.proxies, skippedLines };
  }

  deleteProxy(id: string): boolean {
    const proxy = this.proxies.find(p => p.id === id);
    const initialLen = this.proxies.length;
    this.proxies = this.proxies.filter(p => p.id !== id);
    if (this.proxies.length === initialLen) return false;

    if (proxy) {
      let accountsChanged = false;
      this.accounts.forEach(acc => {
        if (acc.proxy === proxy.value) {
          acc.proxy = '';
          acc.proxyType = 'none';
          accountsChanged = true;
        }
      });
      if (accountsChanged) this.saveAccounts();
    }

    this.saveProxies();
    return true;
  }

  assignProxiesToAccounts(
    accountIds: string[],
    proxyIds: string[],
    mode: 'rotate' | 'one-to-one' = 'rotate'
  ): number {
    const selectedProxies = this.proxies.filter(proxy => proxyIds.includes(proxy.id));
    if (accountIds.length === 0 || selectedProxies.length === 0) return 0;

    let updatedCount = 0;
    accountIds.forEach((accountId, idx) => {
      const acc = this.getAccountById(accountId);
      const proxy = mode === 'one-to-one' ? selectedProxies[idx] : selectedProxies[idx % selectedProxies.length];
      if (!acc || !proxy) return;

      acc.proxy = proxy.value;
      acc.proxyType = proxy.proxyType;
      proxy.assignedAccountId = acc.id;
      updatedCount++;
    });

    if (updatedCount > 0) {
      this.saveAccounts();
      this.saveProxies();
    }
    return updatedCount;
  }

  clearAccountProxies(ids: string[]): number {
    let updatedCount = 0;
    ids.forEach(id => {
      const acc = this.getAccountById(id);
      if (!acc) return;
      acc.proxy = '';
      acc.proxyType = 'none';
      this.proxies.forEach(proxy => {
        if (proxy.assignedAccountId === id) proxy.assignedAccountId = undefined;
      });
      updatedCount++;
    });

    if (updatedCount > 0) {
      this.saveAccounts();
      this.saveProxies();
    }
    return updatedCount;
  }

  getAllAccounts(categoryId?: string): TikTokAccount[] {
    if (categoryId && categoryId !== 'all') {
      return this.accounts.filter(a => a.categoryId === categoryId);
    }
    return this.accounts;
  }

  getAccountById(id: string): TikTokAccount | undefined {
    return this.accounts.find(a => a.id === id);
  }

  addAccount(dto: Partial<TikTokAccount>): TikTokAccount {
    const newAcc: TikTokAccount = {
      id: 'acc_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
      username: (dto.username || 'user_' + Date.now()).replace(/^@/, '').trim(),
      password: dto.password || '',
      displayName: dto.displayName?.trim() || dto.username?.trim() || 'TikTok User',
      categoryId: dto.categoryId || 'cat_default',
      notes: dto.notes || '',
      cookie: dto.cookie || '',
      token: dto.token || '',
      email: dto.email || '',
      passMail: dto.passMail || '',
      twoFactor: dto.twoFactor || '',
      proxy: dto.proxy || '',
      proxyType: dto.proxyType || 'http',
      status: dto.status || (this.isValidTikTokCookie(dto.cookie) ? 'authenticated' : 'unauthenticated'),
      createdAt: new Date().toISOString(),
    };
    this.accounts.push(newAcc);
    this.saveAccounts();
    return newAcc;
  }

  updateAccount(id: string, dto: Partial<TikTokAccount>): TikTokAccount | undefined {
    const acc = this.getAccountById(id);
    if (acc) {
      Object.assign(acc, dto);
      this.saveAccounts();
    }
    return acc;
  }

  updateAccountStatus(id: string, status: TikTokAccount['status'], lastUsed?: string): TikTokAccount | undefined {
    const acc = this.getAccountById(id);
    if (acc) {
      acc.status = status;
      if (lastUsed) {
        acc.lastUsed = lastUsed;
      }
      this.saveAccounts();
    }
    return acc;
  }

  deleteAccount(id: string): boolean {
    const initialLen = this.accounts.length;
    this.accounts = this.accounts.filter(a => a.id !== id);
    if (this.accounts.length !== initialLen) {
      this.saveAccounts();
      return true;
    }
    return false;
  }

  // --- BATCH & BULK OPERATIONS ---
  batchImportAccounts(
    rawText: string,
    categoryId: string = 'cat_default',
    defaultProxyType: TikTokAccount['proxyType'] = 'http'
  ): {
    addedCount: number;
    updatedCount: number;
    skippedCount: number;
    skippedLines: { line: number; rawText: string; reason: string }[];
    accounts: TikTokAccount[];
  } {
    const rawLines = rawText.split(/\r?\n/);
    let addedCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    const skippedLines: { line: number; rawText: string; reason: string }[] = [];

    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i].trim();
      if (!line) continue;

      const parts = line.split('|').map(p => p.trim());

      let username = '';
      let password = '';
      let cookie = '';
      let proxy = '';
      let email = '';
      let passMail = '';
      let twoFactor = '';

      // Reject lines with > 7 columns
      if (parts.length > 7) {
        skippedCount++;
        skippedLines.push({
          line: i + 1,
          rawText: line,
          reason: `Dòng có quá 7 cột (${parts.length} cột)`,
        });
        continue;
      }

      const isCol3Cookie = (val?: string) => {
        if (!val) return false;
        const lowerVal = val.toLowerCase();
        return lowerVal.includes('sessionid=') ||
               lowerVal.includes('sessionid_ss=') ||
               lowerVal.includes('sid_tt=') ||
               val.includes(';');
      };

      const hasValidCookie = (val?: string) => isCol3Cookie(val);

      if (parts.length === 7) {
        // User|Pass|Cookie|Email|PassMail|2FA|Proxy
        [username, password, cookie, email, passMail, twoFactor, proxy] = parts;
      } else if (parts.length === 6) {
        if (isCol3Cookie(parts[2])) {
          // User|Pass|Cookie|Email|PassMail|2FA
          [username, password, cookie, email, passMail, twoFactor] = parts;
        } else {
          // User|Pass|2FA|Email|PassMail|Proxy
          [username, password, twoFactor, email, passMail, proxy] = parts;
        }
      } else if (parts.length === 5) {
        if (isCol3Cookie(parts[2])) {
          // User|Pass|Cookie|Email|PassMail
          [username, password, cookie, email, passMail] = parts;
        } else {
          // User|Pass|2FA|Email|PassMail (Target format for user accounts)
          [username, password, twoFactor, email, passMail] = parts;
        }
      } else if (parts.length === 4) {
        if (isCol3Cookie(parts[2])) {
          // User|Pass|Cookie|Proxy
          [username, password, cookie, proxy] = parts;
        } else {
          // User|Pass|2FA|Proxy
          [username, password, twoFactor, proxy] = parts;
        }
      } else if (parts.length === 3) {
        if (isCol3Cookie(parts[2])) {
          // User|Pass|Cookie
          [username, password, cookie] = parts;
        } else {
          // User|Pass|2FA
          [username, password, twoFactor] = parts;
        }
      } else if (parts.length === 2) {
        // User|Pass
        [username, password] = parts;
      } else if (parts.length === 1) {
        if (parts[0].includes('sessionid')) {
          cookie = parts[0];
          username = 'user_' + Math.random().toString(36).substring(2, 8);
        } else {
          username = parts[0];
        }
      }


      username = username.replace(/^@/, '').trim();
      if (!username) {
        skippedCount++;
        skippedLines.push({
          line: i + 1,
          rawText: line,
          reason: 'Thiếu Username',
        });
        continue;
      }

      // Validate email format if provided
      if (email && !email.includes('@')) {
        skippedCount++;
        skippedLines.push({
          line: i + 1,
          rawText: line,
          reason: `Format Email không hợp lệ ("${email}" thiếu ký tự @)`,
        });
        continue;
      }

      // Validate proxy format if provided (must contain : like ip:port or user:pass@ip:port)
      if (proxy && !proxy.includes(':')) {
        skippedCount++;
        skippedLines.push({
          line: i + 1,
          rawText: line,
          reason: `Format Proxy không hợp lệ ("${proxy}" thiếu ip:port)`,
        });
        continue;
      }

      const existingAcc = this.accounts.find(a => a.username.toLowerCase() === username.toLowerCase());
      if (existingAcc) {
        if (password) existingAcc.password = password;
        if (cookie) existingAcc.cookie = cookie;
        if (!cookie && parts.length >= 3 && !isCol3Cookie(parts[2])) existingAcc.cookie = '';
        if (proxy) existingAcc.proxy = proxy;
        if (email) existingAcc.email = email;
        if (passMail) existingAcc.passMail = passMail;
        if (twoFactor) existingAcc.twoFactor = twoFactor;
        if (categoryId) existingAcc.categoryId = categoryId;
        existingAcc.status = hasValidCookie(existingAcc.cookie) ? 'authenticated' : 'unauthenticated';
        updatedCount++;
      } else {
        const newAcc: TikTokAccount = {
          id: 'acc_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
          username,
          password,
          displayName: username,
          categoryId: categoryId || 'cat_default',
          cookie,
          proxy,
          proxyType: defaultProxyType || 'http',
          email,
          passMail,
          twoFactor,
          status: hasValidCookie(cookie) ? 'authenticated' : 'unauthenticated',
          createdAt: new Date().toISOString(),
        };
        this.accounts.push(newAcc);
        addedCount++;
      }
    }


    this.saveAccounts();
    return { addedCount, updatedCount, skippedCount, skippedLines, accounts: this.accounts };
  }


  bulkDeleteAccounts(ids: string[]): number {
    const initialLen = this.accounts.length;
    this.accounts = this.accounts.filter(a => !ids.includes(a.id));
    const deletedCount = initialLen - this.accounts.length;
    if (deletedCount > 0) {
      this.saveAccounts();
    }
    return deletedCount;
  }

  bulkMoveCategory(ids: string[], targetCategoryId: string): number {
    let movedCount = 0;
    this.accounts.forEach(a => {
      if (ids.includes(a.id)) {
        a.categoryId = targetCategoryId;
        movedCount++;
      }
    });
    if (movedCount > 0) {
      this.saveAccounts();
    }
    return movedCount;
  }

  bulkUpdateProxy(ids: string[], proxyList: string[], proxyType: TikTokAccount['proxyType'] = 'http'): number {
    let updatedCount = 0;
    ids.forEach((id, idx) => {
      const acc = this.getAccountById(id);
      if (acc) {
        acc.proxy = proxyList[idx % proxyList.length] || '';
        acc.proxyType = proxyType;
        updatedCount++;
      }
    });
    if (updatedCount > 0) {
      this.saveAccounts();
    }
    return updatedCount;
  }

  // --- CHECK LIVE/DIE STATUS ---
  async checkAccountLiveStatus(id: string): Promise<TikTokAccount['status']> {
    const acc = this.getAccountById(id);
    if (!acc) return 'error';

    return new Promise((resolve) => {
      const options = {
        hostname: 'www.tiktok.com',
        path: `/@${acc.username}`,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
      };

      const req = https.get(options, (res) => {
        acc.lastChecked = new Date().toISOString();
        if (res.statusCode === 200) {
          acc.status = acc.cookie ? 'authenticated' : 'live';
        } else if (res.statusCode === 404) {
          acc.status = 'die';
        } else {
          acc.status = 'checkpoint';
        }
        this.saveAccounts();
        resolve(acc.status);
      });

      req.on('error', () => {
        acc.lastChecked = new Date().toISOString();
        acc.status = 'error';
        this.saveAccounts();
        resolve('error');
      });

      req.setTimeout(5000, () => {
        req.destroy();
        acc.lastChecked = new Date().toISOString();
        acc.status = 'error';
        this.saveAccounts();
        resolve('error');
      });
    });
  }
}
