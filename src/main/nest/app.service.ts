import { Injectable } from '@nestjs/common';
import * as os from 'os';

@Injectable()
export class AppService {
  getHello(): { message: string; timestamp: string } {
    return {
      message: 'Xin chào! NestJS Backend đang chạy mượt mà bên trong Electron Main Process! 🚀',
      timestamp: new Date().toISOString(),
    };
  }

  getStatus() {
    return {
      status: 'online',
      framework: 'NestJS v10',
      runtime: `Node.js ${process.version}`,
      platform: process.platform,
      arch: process.arch,
      uptimeSeconds: Math.floor(process.uptime()),
      memoryUsage: {
        rssMB: (process.memoryUsage().rss / 1024 / 1024).toFixed(2),
        heapTotalMB: (process.memoryUsage().heapTotal / 1024 / 1024).toFixed(2),
        heapUsedMB: (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2),
      },
      system: {
        totalMemGB: (os.totalmem() / 1024 / 1024 / 1024).toFixed(2),
        freeMemGB: (os.freemem() / 1024 / 1024 / 1024).toFixed(2),
        cpus: os.cpus().length,
        hostname: os.hostname(),
      },
    };
  }

  processTask(taskName: string, payload: any) {
    return {
      success: true,
      taskId: `TASK-${Math.floor(Math.random() * 899999 + 100000)}`,
      receivedTask: taskName,
      payload,
      processedAt: new Date().toISOString(),
    };
  }
}
