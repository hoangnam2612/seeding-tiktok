import { Controller, Get, Post, Put, Delete, Body, Param, Query } from '@nestjs/common';
import { AccountsService } from './accounts.service';
import { MailOtpService } from './mail-otp.service';
import { generateTotpToken } from './totp.helper';
import { ProxyEntry, TikTokAccount } from './account.interface';


@Controller('api/accounts')
export class AccountsController {
  constructor(
    private readonly accountsService: AccountsService,
    private readonly mailOtpService: MailOtpService
  ) {}

  // --- CATEGORIES ---
  @Get('categories')
  getCategories() {
    return { success: true, data: this.accountsService.getAllCategories() };
  }

  @Post('categories')
  addCategory(@Body() body: { name: string; color?: string }) {
    const newCat = this.accountsService.addCategory(body.name, body.color);
    return { success: true, data: newCat };
  }

  @Delete('categories/:id')
  deleteCategory(@Param('id') id: string) {
    const success = this.accountsService.deleteCategory(id);
    return { success };
  }

  // --- PROXY POOL ---
  @Get('proxies')
  getProxies() {
    return { success: true, data: this.accountsService.getAllProxies() };
  }

  @Post('proxies/import')
  importProxies(@Body() body: { rawText: string; proxyType?: ProxyEntry['proxyType'] }) {
    const result = this.accountsService.importProxies(body.rawText || '', body.proxyType || 'http');
    return { success: true, data: result };
  }

  @Post('proxies/assign')
  assignProxies(@Body() body: { accountIds: string[]; proxyIds: string[]; mode?: 'rotate' | 'one-to-one' }) {
    const updatedCount = this.accountsService.assignProxiesToAccounts(
      body.accountIds || [],
      body.proxyIds || [],
      body.mode || 'rotate'
    );
    return { success: true, updatedCount };
  }

  @Post('proxies/clear-accounts')
  clearAccountProxies(@Body() body: { accountIds: string[] }) {
    const updatedCount = this.accountsService.clearAccountProxies(body.accountIds || []);
    return { success: true, updatedCount };
  }

  @Delete('proxies/:id')
  deleteProxy(@Param('id') id: string) {
    const success = this.accountsService.deleteProxy(id);
    return { success };
  }

  // --- ACCOUNTS ---
  @Put('proxies/:id')
  updateProxy(@Param('id') id: string, @Body() dto: Partial<ProxyEntry>) {
    const data = this.accountsService.updateProxy(id, dto);
    return { success: !!data, data };
  }

  // --- ACCOUNTS ---
  @Get()
  getAccounts(@Query('categoryId') categoryId?: string) {
    return { success: true, data: this.accountsService.getAllAccounts(categoryId) };
  }

  @Get(':id')
  getAccount(@Param('id') id: string) {
    const acc = this.accountsService.getAccountById(id);
    return { success: !!acc, data: acc };
  }

  @Post()
  addAccount(@Body() dto: Partial<TikTokAccount>) {
    const newAcc = this.accountsService.addAccount(dto);
    return { success: true, data: newAcc };
  }

  @Put(':id')
  updateAccount(@Param('id') id: string, @Body() dto: Partial<TikTokAccount>) {
    const updated = this.accountsService.updateAccount(id, dto);
    return { success: !!updated, data: updated };
  }

  @Delete(':id')
  deleteAccount(@Param('id') id: string) {
    const success = this.accountsService.deleteAccount(id);
    return { success };
  }

  // --- BATCH & BULK OPERATIONS ---
  @Post('batch-import')
  batchImport(@Body() body: { rawText: string; categoryId?: string; proxyType?: TikTokAccount['proxyType']; format?: string }) {
    const result = this.accountsService.batchImportAccounts(body.rawText, body.categoryId, body.proxyType, body.format);
    return { success: true, data: result };
  }

  @Post('bulk-delete')
  bulkDelete(@Body() body: { ids: string[] }) {
    const count = this.accountsService.bulkDeleteAccounts(body.ids || []);
    return { success: true, deletedCount: count };
  }

  @Post('bulk-move')
  bulkMove(@Body() body: { ids: string[]; targetCategoryId: string }) {
    const count = this.accountsService.bulkMoveCategory(body.ids || [], body.targetCategoryId);
    return { success: true, movedCount: count };
  }

  @Post('bulk-proxy')
  bulkProxy(@Body() body: { ids: string[]; proxyList: string[]; proxyType?: TikTokAccount['proxyType'] }) {
    const count = this.accountsService.bulkUpdateProxy(body.ids || [], body.proxyList || [], body.proxyType || 'http');
    return { success: true, updatedCount: count };
  }

  @Post('check-live/:id')
  async checkLive(@Param('id') id: string) {
    const status = await this.accountsService.checkAccountLiveStatus(id);
    return { success: true, status };
  }

  // --- MAIL OTP ---
  @Post('fetch-otp')
  async fetchOtp(@Body() body: { email: string; passMail: string; host?: string; requestedAt?: number }) {
    const result = await this.mailOtpService.fetchTikTokOtp(body.email, body.passMail, {
      host: body.host,
      sinceTimestamp: body.requestedAt,
    });
    return result;
  }


  // --- 2FA TOTP GENERATOR ---
  @Post('totp')
  generateTotp(@Body() body: { twoFactor: string }) {
    const code = generateTotpToken(body.twoFactor);
    return { success: !!code, code };
  }
}

