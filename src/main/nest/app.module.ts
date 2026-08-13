import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AccountsModule } from './accounts/accounts.module';
import { AutomationModule } from './automation/automation.module';

@Module({
  imports: [AccountsModule, AutomationModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
