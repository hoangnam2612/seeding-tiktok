import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import { parseImportFormat } from '../../../shared/account-import-format';
import * as fs from 'fs';
import * as path from 'path';
import { TikTokAccount, AccountCategory, ProxyEntry } from './account.interface';
import https from 'https';
import { ensurePersistentDataDir } from '../../data-dir';
import { decryptSecret, encryptSecret, hasEncryptedSecret } from '../../secret-json';

const ACCOUNT_SECRET_FIELDS: Array<keyof TikTokAccount> = [
  'password',
  'cookie',
  'token',
  'email',
  'passMail',
  'refreshToken',
  'twoFactor',
  'proxy',
  'recoveryMail',
];
const ACCOUNT_STATUSES: TikTokAccount['status'][] = [
  'live',
  'die',
  'unauthenticated',
  'authenticated',
  'checkpoint',
  'active',
  'error',
];
const PROXY_TYPES: NonNullable<TikTokAccount['proxyType']>[] = ['none', 'http', 'socks5', 'tmproxy', 'tinsoft'];

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
        this.accounts = JSON.parse(fileContent).map((acc: TikTokAccount) => this.decryptAccountForMemory(acc));
        let changed = false;
        this.accounts.forEach(acc => {
          changed = this.hasPlainAccountSecrets(acc) || this.normalizeImportedAccount(acc) || changed;
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
      const storageAccounts = this.accounts.map(acc => this.encryptAccountForStorage(acc));
      fs.writeFileSync(this.accountsFilePath, JSON.stringify(storageAccounts, null, 2), 'utf-8');
    } catch (err) {
      console.error('[AccountsService] Failed to save accounts file:', err);
    }
  }

  private loadProxies() {
    try {
      if (fs.existsSync(this.proxiesFilePath)) {
        const fileContent = fs.readFileSync(this.proxiesFilePath, 'utf-8');
        this.proxies = JSON.parse(fileContent).map((proxy: ProxyEntry) => this.decryptProxyForMemory(proxy));
        if (this.proxies.some(proxy => proxy.value && !hasEncryptedSecret(proxy.value))) {
          this.saveProxies();
        }
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
      const storageProxies = this.proxies.map(proxy => this.encryptProxyForStorage(proxy));
      fs.writeFileSync(this.proxiesFilePath, JSON.stringify(storageProxies, null, 2), 'utf-8');
    } catch (err) {
      console.error('[AccountsService] Failed to save proxies file:', err);
    }
  }

  private isValidProxyValue(proxy?: string): boolean {
    return !!proxy && proxy.trim().includes(':');
  }

  private hasPlainAccountSecrets(acc: TikTokAccount): boolean {
    return ACCOUNT_SECRET_FIELDS.some(field => {
      const value = acc[field];
      return typeof value === 'string' && value.length > 0 && !hasEncryptedSecret(value);
    });
  }

  private decryptAccountForMemory(acc: TikTokAccount): TikTokAccount {
    const next = { ...acc };
    ACCOUNT_SECRET_FIELDS.forEach(field => {
      const value = next[field];
      if (typeof value === 'string') {
        (next as any)[field] = decryptSecret(value);
      }
    });
    return next;
  }

  private encryptAccountForStorage(acc: TikTokAccount): TikTokAccount {
    const next = { ...acc };
    ACCOUNT_SECRET_FIELDS.forEach(field => {
      const value = next[field];
      if (typeof value === 'string') {
        (next as any)[field] = encryptSecret(value);
      }
    });
    return next;
  }

  private decryptProxyForMemory(proxy: ProxyEntry): ProxyEntry {
    return {
      ...proxy,
      value: decryptSecret(proxy.value),
    };
  }

  private encryptProxyForStorage(proxy: ProxyEntry): ProxyEntry {
    return {
      ...proxy,
      value: encryptSecret(proxy.value),
    };
  }

  private sanitizeAccountDto(dto: Partial<TikTokAccount>): Partial<TikTokAccount> {
    const clean: Partial<TikTokAccount> = {};
    for (const key of ['uid', 'recoveryMail', 'userAgent', 'bio', 'avatarUrl', 'lastAction', 'lastActionAt', 'message'] as const) {
      if (typeof dto[key] === 'string') clean[key] = dto[key];
    }
    for (const key of ['followerCount', 'followingCount', 'likesCount'] as const) {
      if (Number.isFinite(dto[key]) && dto[key] >= 0) clean[key] = dto[key];
    }
    if (typeof dto.username === 'string') clean.username = dto.username.replace(/^@/, '').trim();
    if (typeof dto.password === 'string') clean.password = dto.password;
    if (typeof dto.displayName === 'string') clean.displayName = dto.displayName.trim();
    if (typeof dto.notes === 'string') clean.notes = dto.notes;
    if (typeof dto.categoryId === 'string') clean.categoryId = dto.categoryId;
    if (typeof dto.cookie === 'string') clean.cookie = dto.cookie;
    if (typeof dto.token === 'string') clean.token = dto.token;
    if (typeof dto.email === 'string') clean.email = dto.email.trim();
    if (typeof dto.passMail === 'string') clean.passMail = dto.passMail;
    if (typeof dto.refreshToken === 'string') clean.refreshToken = dto.refreshToken;
    if (typeof dto.clientId === 'string') clean.clientId = dto.clientId;
    if (typeof dto.twoFactor === 'string') clean.twoFactor = dto.twoFactor.trim();
    if (typeof dto.proxy === 'string') clean.proxy = dto.proxy.trim();
    if (dto.proxyType && PROXY_TYPES.includes(dto.proxyType)) clean.proxyType = dto.proxyType;
    if (dto.status && ACCOUNT_STATUSES.includes(dto.status)) clean.status = dto.status;
    return clean;
  }

  getAllProxies(): ProxyEntry[] {
    return this.proxies;
  }

  updateProxy(id: string, dto: Partial<ProxyEntry>): ProxyEntry | undefined {
    const proxy = this.proxies.find(p => p.id === id);
    if (!proxy) return undefined;
    const oldValue = proxy.value;
    if (typeof dto.value === 'string' && this.isValidProxyValue(dto.value)) proxy.value = dto.value.trim();
    if (dto.proxyType && PROXY_TYPES.includes(dto.proxyType)) proxy.proxyType = dto.proxyType;
    if (typeof dto.label === 'string') proxy.label = dto.label;
    if (dto.status && ['untested', 'active', 'error'].includes(dto.status)) proxy.status = dto.status;
    if (typeof dto.lastChecked === 'string') proxy.lastChecked = dto.lastChecked;
    this.accounts.forEach(account => {
      if (account.proxy === oldValue) { account.proxy = proxy.value; account.proxyType = proxy.proxyType; }
    });
    this.saveProxies(); this.saveAccounts();
    return proxy;
  }

  importProxies(
    rawText: string,
    proxyType: ProxyEntry['proxyType'] = 'http'
  ): { addedCount: number; skippedCount: number; proxies: ProxyEntry[]; skippedLines: { line: number; rawText: string; reason: string }[] } {
    const skippedLines: { line: number; rawText: string; reason: string }[] = [];
    let addedCount = 0;
    let skippedCount = 0;
    const identity = (value: string) => {
      try {
        const parts = value.split(':');
        const text = !value.includes('://') && !value.includes('@') && parts.length === 4 ? encodeURIComponent(parts[2]) + ':' + encodeURIComponent(parts[3]) + '@' + parts[0] + ':' + parts[1] : value;
        const url = new URL(text.includes('://') ? text : 'http://' + text);
        return [url.hostname, url.port || '80', decodeURIComponent(url.username)].join('|').toLowerCase();
      } catch { return value.trim().toLowerCase(); }
    };
    const existingValues = new Set(this.proxies.map(p => identity(p.value)));

    rawText.split(/\r?\n/).forEach((rawLine, idx) => {
      const value = rawLine.trim();
      if (!value) return;

      if (!this.isValidProxyValue(value)) {
        skippedCount++;
        skippedLines.push({ line: idx + 1, rawText: rawLine, reason: 'Proxy thiếu ip:port' });
        return;
      }

      if (existingValues.has(identity(value))) {
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
      existingValues.add(identity(value));
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

    accountIds.forEach(accountId => {
      this.proxies.forEach(proxy => {
        if (proxy.assignedAccountId === accountId) proxy.assignedAccountId = undefined;
      });
    });

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
    const clean = this.sanitizeAccountDto(dto);
    const newAcc: TikTokAccount = {
      ...clean,
      id: 'acc_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
      username: clean.username || 'user_' + Date.now(),
      password: clean.password || '',
      displayName: clean.displayName || clean.username || 'TikTok User',
      categoryId: clean.categoryId || 'cat_default',
      notes: clean.notes || '',
      cookie: clean.cookie || '',
      token: clean.token || '',
      email: clean.email || '',
      passMail: clean.passMail || '',
      twoFactor: clean.twoFactor || '',
      proxy: clean.proxy || '',
      proxyType: clean.proxyType || 'http',
      status: clean.status || (this.isValidTikTokCookie(clean.cookie) ? 'authenticated' : 'unauthenticated'),
      createdAt: new Date().toISOString(),
    };
    this.accounts.push(newAcc);
    this.saveAccounts();
    return newAcc;
  }

  updateAccount(id: string, dto: Partial<TikTokAccount>): TikTokAccount | undefined {
    const acc = this.getAccountById(id);
    if (acc) {
      Object.assign(acc, this.sanitizeAccountDto(dto));
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
      this.proxies.forEach(proxy => {
        if (proxy.assignedAccountId === id) proxy.assignedAccountId = undefined;
      });
      this.saveAccounts();
      this.saveProxies();
      return true;
    }
    return false;
  }

  // --- BATCH & BULK OPERATIONS ---
  batchImportAccounts(
    rawText: string,
    categoryId: string = 'cat_default',
    defaultProxyType: TikTokAccount['proxyType'] = 'http',
    format: string = 'auto'
  ): {
    addedCount: number;
    updatedCount: number;
    skippedCount: number;
    skippedLines: { line: number; rawText: string; reason: string }[];
    accounts: TikTokAccount[];
  } {
    let formatColumns: ReturnType<typeof parseImportFormat>;
    try {
      formatColumns = parseImportFormat(format);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Định dạng không hợp lệ.');
    }
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
      let refreshToken = '';
      let clientId = '';
      let recoveryMail = '';
      let twoFactor = '';

      // Automatic detection supports up to eight columns; explicit formats define their own count.
      if (!formatColumns && parts.length > 8) {
        skippedCount++;
        skippedLines.push({
          line: i + 1,
          rawText: line,
          reason: `Dòng có quá 8 cột (${parts.length} cột)`,
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

      if (formatColumns) {
        if (parts.length !== formatColumns.length) {
          skippedCount++;
          skippedLines.push({ line: i + 1, rawText: line, reason: `Cần ${formatColumns.length} cột theo định dạng đã chọn, nhận được ${parts.length} cột.` });
          continue;
        }
        const values: Record<string, string> = {};
        formatColumns.forEach((field, index) => { values[field] = parts[index]; });
        ({ username = '', password = '', cookie = '', proxy = '', email = '', passMail = '', twoFactor = '', refreshToken = '', clientId = '', recoveryMail = '' } = values);
      } else if (parts.length === 8) {
        const isEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
        if (!isEmail(parts[2]) || (parts[6] && !isEmail(parts[6])) || (parts[7] && !isCol3Cookie(parts[7]))) {
          skippedCount++;
          skippedLines.push({ line: i + 1, rawText: line, reason: 'Không nhận diện được định dạng 8 cột. Hãy chọn định dạng hoặc nhập định dạng tùy chỉnh.' });
          continue;
        }
        [username, password, email, passMail, refreshToken, clientId, recoveryMail, cookie] = parts;
      } else if (parts.length === 7) {
        // User|Pass|Cookie|Email|PassMail|2FA|Proxy
        [username, password, cookie, email, passMail, twoFactor, proxy] = parts;
      } else if (parts.length === 6) {
        if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(parts[2])) {
          [username, password, email, passMail, refreshToken, clientId] = parts;
        } else if (isCol3Cookie(parts[2])) {
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
        if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(parts[2])) {
          // User|Pass|Mail|PassMail
          [username, password, email, passMail] = parts;
        } else if (isCol3Cookie(parts[2])) {
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

      if (recoveryMail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recoveryMail)) {
        skippedCount++;
        skippedLines.push({ line: i + 1, rawText: line, reason: 'Email khôi phục không hợp lệ.' });
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
        if (!formatColumns && !cookie && parts.length >= 3 && !isCol3Cookie(parts[2]) && !([4, 6, 8].includes(parts.length) && email && !twoFactor)) existingAcc.cookie = '';
        if (proxy) existingAcc.proxy = proxy;
        if (email) existingAcc.email = email;
        if (passMail) existingAcc.passMail = passMail;
        if (refreshToken) existingAcc.refreshToken = refreshToken;
        if (clientId) existingAcc.clientId = clientId;
        if (recoveryMail) existingAcc.recoveryMail = recoveryMail;
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
          refreshToken,
          clientId,
          recoveryMail,
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
      this.proxies.forEach(proxy => {
        if (proxy.assignedAccountId && ids.includes(proxy.assignedAccountId)) proxy.assignedAccountId = undefined;
      });
      this.saveAccounts();
      this.saveProxies();
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
    const cleanProxyList = proxyList.map(proxy => proxy.trim()).filter(proxy => this.isValidProxyValue(proxy));
    if (ids.length === 0 || cleanProxyList.length === 0) return 0;

    let updatedCount = 0;
    ids.forEach((id, idx) => {
      const acc = this.getAccountById(id);
      if (acc) {
        acc.proxy = cleanProxyList[idx % cleanProxyList.length] || '';
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
