const fs = require('fs');
const path = require('path');

const appPath = path.join(__dirname, '..', 'src', 'renderer', 'src', 'App.tsx');
let content = fs.readFileSync(appPath, 'utf8');

const regex = /<button\s+className="btn-primary"\s+style=\{\{\s*marginTop:\s*'1rem',\s*padding:\s*'1rem',\s*fontSize:\s*'1rem'\s*\}\}\s+disabled=\{isTaskExecuting\}[\s\S]*?\{isTaskExecuting \? '⏳ Đang khởi chạy Seeding\.\.\.' : '🚀 Bắt đầu Seeding ngay \(' \+ selectedAccountIds\.length \+ ' Acc\)'\}\s*<\/button>/;

const replacement = `{isTaskExecuting ? (
                <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1rem' }}>
                  <button
                    className="btn-primary"
                    style={{ flex: 1, padding: '1rem', fontSize: '1rem', opacity: 0.85, cursor: 'not-allowed' }}
                    disabled={true}
                  >
                    ⏳ Đang chạy Seeding ({selectedAccountIds.length} Acc)...
                  </button>
                  <button
                    className="btn-danger"
                    style={{
                      padding: '1rem 1.5rem',
                      fontSize: '1rem',
                      background: '#ef4444',
                      color: '#fff',
                      borderRadius: '8px',
                      border: 'none',
                      cursor: 'pointer',
                      fontWeight: 'bold',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.5rem',
                      whiteSpace: 'nowrap'
                    }}
                    onClick={async () => {
                      try {
                        if (window.electronAPI?.closeAllBrowserWindows) {
                          await window.electronAPI.closeAllBrowserWindows();
                        }
                      } finally {
                        setIsTaskExecuting(false);
                      }
                    }}
                  >
                    🛑 Dừng ngay
                  </button>
                </div>
              ) : (
                <button
                  className="btn-primary"
                  style={{ marginTop: '1rem', padding: '1rem', fontSize: '1rem' }}
                  onClick={async () => {
                    if (selectedAccountIds.length === 0) {
                      alert('Vui lòng chọn ít nhất 1 tài khoản ở Tab 1!');
                      return;
                    }
                    setIsTaskExecuting(true);
                    setActiveTab('logs');
                    try {
                      if (window.electronAPI?.executeSeedingTask) {
                        const selectedAccs = accounts.filter(a => selectedAccountIds.includes(a.id));
                        const seedingThreadCount = seedingThreads === 0 ? selectedAccountIds.length : seedingThreads;
                        await window.electronAPI.executeSeedingTask(
                          {
                            targetUrl,
                            targetType,
                            accountIds: selectedAccountIds,
                            likeEnabled,
                            comments: commentsInput.split('\\n').filter(c => c.trim().length > 0),
                            delaySeconds,
                            maxThreads: seedingThreadCount,
                            liveDurationSeconds,
                            muteBrowserAudio,
                          },
                          selectedAccs
                        );
                      }
                    } catch (err) {
                      console.error('Seeding task failed:', err);
                    } finally {
                      setIsTaskExecuting(false);
                    }
                  }}
                >
                  🚀 Bắt đầu Seeding ngay ({selectedAccountIds.length} Acc)
                </button>
              )}`;

if (regex.test(content)) {
  content = content.replace(regex, replacement);
  fs.writeFileSync(appPath, content, 'utf8');
  console.log('Successfully patched App.tsx!');
} else {
  console.error('Regex did not match in App.tsx');
  process.exit(1);
}
