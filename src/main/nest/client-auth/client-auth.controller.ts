import { Body, Controller, Get, Post } from '@nestjs/common';
import { ClientAuthService } from './client-auth.service';

@Controller('api/client-auth')
export class ClientAuthController {
  constructor(private readonly clientAuthService: ClientAuthService) {}

  @Get('state')
  getState() {
    return { success: true, data: this.clientAuthService.getPublicState() };
  }

  @Post('bootstrap')
  bootstrap() {
    return this.clientAuthService.bootstrap();
  }

  @Post('send-otp')
  sendOtp(@Body() body: { email: string; purpose?: 'register' | 'forgot-password' }) {
    return this.clientAuthService.sendOtp(body.email || '', body.purpose || 'register');
  }

  @Post('register')
  register(@Body() body: { username: string; email: string; password: string; otpCode: string }) {
    return this.clientAuthService.register(body);
  }

  @Post('login')
  login(@Body() body: { username: string; password: string }) {
    return this.clientAuthService.login(body.username || '', body.password || '');
  }

  @Post('me')
  me() {
    return this.clientAuthService.getMe();
  }

  @Post('activate')
  activate(@Body() body: { keyCode: string }) {
    return this.clientAuthService.activateLicense(body.keyCode || '');
  }

  @Post('logout')
  logout() {
    return { success: true, data: this.clientAuthService.logout() };
  }

  @Post('telemetry')
  telemetry(@Body() body: { actionType?: string; details?: string }) {
    return this.clientAuthService.reportTelemetry(body.actionType || 'client', body.details || '');
  }

  @Get('webhook/config')
  getWebhookConfig() {
    return this.clientAuthService.getWebhookConfig();
  }

  @Post('webhook/config')
  saveWebhookConfig(@Body() body: {
    name?: string;
    webhookUrl: string;
    secretKey?: string;
    isEnabled?: boolean;
    events?: string[];
  }) {
    return this.clientAuthService.saveWebhookConfig({
      name: body.name,
      webhookUrl: body.webhookUrl || '',
      secretKey: body.secretKey,
      isEnabled: body.isEnabled !== false,
      events: body.events?.length ? body.events : ['user.banned', 'license.expired', 'session.kicked', 'user.activated'],
    });
  }

  @Post('webhook/test')
  testWebhook() {
    return this.clientAuthService.testWebhook();
  }

  @Get('update')
  update() {
    return this.clientAuthService.checkUpdate();
  }
}
