const fs = require('fs');
const path = require('path');

const runnerPath = path.join(__dirname, '..', 'src', 'main', 'automation-runner.ts');
let content = fs.readFileSync(runnerPath, 'utf8');

// 1. Update requestSeedingCancel to flush pending interactions
const oldCancelFunc = /function requestSeedingCancel\(reason: string\) \{[\s\S]*?function isSeedingCancelRequested/;
const newCancelFunc = `function requestSeedingCancel(reason: string) {
  if (currentSeedingRun && !currentSeedingRun.cancelRequested) {
    currentSeedingRun.cancelRequested = true;
    currentSeedingRun.reason = reason;
  }
  while (pendingSeedingInteractions.length > 0) {
    const next = pendingSeedingInteractions.shift();
    if (next) {
      try { next(); } catch {}
    }
  }
}

function isSeedingCancelRequested`;

content = content.replace(oldCancelFunc, newCancelFunc);

// 2. Update waitForSeedingDelay to actively poll cancel & window destroyed every 100ms
const oldDelayFunc = /function waitForSeedingDelay\(ms: number, win\?: BrowserWindow\): Promise<void> \{[\s\S]*?async function runSeedingInteraction/;
const newDelayFunc = `function waitForSeedingDelay(ms: number, win?: BrowserWindow): Promise<void> {
  if (isSeedingCancelRequested()) {
    return Promise.reject(new SeedingCancelledError(currentSeedingRun?.reason || 'Seeding task was cancelled.'));
  }
  if (win && win.isDestroyed()) {
    return Promise.reject(new SeedingCancelledError('Seeding browser window was closed.'));
  }

  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | null = null;
    let interval: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (interval) clearInterval(interval);
      if (win && !win.isDestroyed()) {
        try { win.removeListener('closed', onClosed); } catch {}
      }
    };

    const onClosed = () => {
      cleanup();
      reject(new SeedingCancelledError('Seeding browser window was closed.'));
    };

    interval = setInterval(() => {
      if (isSeedingCancelRequested() || (win && win.isDestroyed())) {
        cleanup();
        reject(new SeedingCancelledError(currentSeedingRun?.reason || 'Seeding task was cancelled.'));
      }
    }, 100);

    timer = setTimeout(() => {
      cleanup();
      if (isSeedingCancelRequested() || (win && win.isDestroyed())) {
        reject(new SeedingCancelledError(currentSeedingRun?.reason || 'Seeding task was cancelled.'));
      } else {
        resolve();
      }
    }, ms);

    if (win && !win.isDestroyed()) {
      win.once('closed', onClosed);
    }
  });
}

async function runSeedingInteraction`;

content = content.replace(oldDelayFunc, newDelayFunc);

// 3. Update execute-seeding-task worker catch and finally blocks
const oldWorkerCatch = /} catch \(err: any\) \{[\s\S]*?if \(err instanceof SeedingCancelledError\) \{[\s\S]*?}\s*if \(queue\.length > 0 && effectiveMaxThreads/;
const newWorkerCatch = `} catch (err: any) {
            if (err instanceof SeedingCancelledError || isSeedingCancelRequested()) {
              requestSeedingCancel(err?.message || 'Tác vụ Seeding đã bị dừng.');
              onLog({
                accountId: acc.id,
                accountUsername: acc.username,
                level: 'warning',
                message: \`[Worker \${workerIndex + 1}] Đã dừng seeding cho @\${acc.username}: \${err?.message || 'Đã đóng cửa sổ hoặc hủy tác vụ'}\`,
              });
              return;
            }

            completedCount++;
            onLog({
              accountId: acc.id,
              accountUsername: acc.username,
              level: 'error',
              message: \`Lỗi thực hiện tác vụ cho @\${acc.username}: \${err.message || err}\`,
            });
          }

          if (queue.length > 0 && effectiveMaxThreads`;

content = content.replace(oldWorkerCatch, newWorkerCatch);

// 4. Update execute-seeding-task finally cleanup block
const oldSeedingFinally = /try \{\s*await Promise\.all\(workers\);\s*\} finally \{[\s\S]*?return \{ success: true \};\s*\}\s*\);/m;
const newSeedingFinally = `try {
        await Promise.all(workers);
      } finally {
        const wasCancelled = isSeedingCancelRequested();
        const cancelReason = currentSeedingRun?.reason;
        currentSeedingRun = null;

        for (const w of Array.from(seedingWindows)) {
          if (!w.isDestroyed()) {
            try { w.close(); } catch {}
          }
        }
        seedingWindows.clear();

        if (wasCancelled) {
          onLog({
            level: 'warning',
            message: \`Tác vụ Seeding đã dừng: \${cancelReason || 'Người dùng đã đóng trình duyệt hoặc hủy tác vụ.'}\`,
          });
          return { success: false, canceled: true };
        }
      }

      onLog({
        level: 'success',
        message: \`🎉 Tác vụ Seeding đã hoàn thành toàn bộ \${selectedAccounts.length} tài khoản!\`,
      });

      return { success: true };
    }
  );`;

content = content.replace(oldSeedingFinally, newSeedingFinally);

fs.writeFileSync(runnerPath, content, 'utf8');
console.log('Successfully patched runner cancel handling!');
