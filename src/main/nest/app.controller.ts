import { Controller, Get, Post, Body } from '@nestjs/common';
import { AppService } from './app.service';

@Controller('api')
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get('hello')
  getHello() {
    return this.appService.getHello();
  }

  @Get('status')
  getStatus() {
    return this.appService.getStatus();
  }

  @Post('task')
  processTask(@Body() body: { taskName: string; payload?: any }) {
    return this.appService.processTask(body.taskName || 'Default Task', body.payload || {});
  }
}
