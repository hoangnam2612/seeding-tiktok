import { Module } from '@nestjs/common';
import { AccountsService } from './accounts.service';
import { AccountsController } from './accounts.controller';
import { MailOtpService } from './mail-otp.service';

@Module({
  controllers: [AccountsController],
  providers: [AccountsService, MailOtpService],
  exports: [AccountsService, MailOtpService],
})
export class AccountsModule {}
