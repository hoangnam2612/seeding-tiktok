import { Controller, Get, Post, Body, Delete } from '@nestjs/common';
import { AutomationService } from './automation.service';
import { SeedingTaskConfig } from './automation.interface';

@Controller('api/automation')
export class AutomationController {
  constructor(private readonly automationService: AutomationService) {}

  @Get('status')
  getStatus() {
    return {
      success: true,
      data: {
        isRunning: this.automationService.isTaskRunning(),
        currentTask: this.automationService.getCurrentTask(),
      },
    };
  }

  @Get('logs')
  getLogs() {
    return {
      success: true,
      data: this.automationService.getLogs(),
    };
  }

  @Delete('logs')
  clearLogs() {
    this.automationService.clearLogs();
    return { success: true };
  }
}
