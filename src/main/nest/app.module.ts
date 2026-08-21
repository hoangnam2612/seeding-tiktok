import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AccountsModule } from './accounts/accounts.module';
import { AutomationModule } from './automation/automation.module';
import { ClientAuthModule } from './client-auth/client-auth.module';

@Module({
  imports: [AccountsModule, AutomationModule, ClientAuthModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
