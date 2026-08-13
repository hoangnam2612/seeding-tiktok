import { Injectable } from '@nestjs/common';
import { SeedingTaskConfig, TaskLogItem } from './automation.interface';

@Injectable()
export class AutomationService {
  private isRunning: boolean = false;
  private currentTask: SeedingTaskConfig | null = null;
  private logs: TaskLogItem[] = [];

  isTaskRunning(): boolean {
    return this.isRunning;
  }

  getCurrentTask(): SeedingTaskConfig | null {
    return this.currentTask;
  }

  getLogs(): TaskLogItem[] {
    return this.logs;
  }

  clearLogs() {
    this.logs = [];
  }

  addLog(log: Omit<TaskLogItem, 'id' | 'timestamp'>) {
    const item: TaskLogItem = {
      id: 'log_' + Date.now() + '_' + Math.random().toString(36).substring(2, 5),
      timestamp: new Date().toLocaleTimeString(),
      ...log,
    };
    this.logs.unshift(item); // top-newest
    if (this.logs.length > 500) {
      this.logs.pop();
    }
  }

  setRunning(running: boolean, task?: SeedingTaskConfig) {
    this.isRunning = running;
    if (running && task) {
      this.currentTask = task;
    } else if (!running) {
      this.currentTask = null;
    }
  }
}
