const { app, BrowserWindow } = require('electron');

app.whenReady().then(async () => {
  console.log('Testing CDP Input.dispatchMouseEvent...');

  const win = new BrowserWindow({
    width: 500,
    height: 400,
    show: false,
    webPreferences: { nodeIntegration: true }
  });

  await win.loadURL('data:text/html,<html><body><button id="btn" onclick="window.clicked=true">Click Me</button></body></html>');

  try {
    win.webContents.debugger.attach('1.3');
    console.log('✓ CDP Debugger attached successfully');

    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: 30,
      y: 20,
      button: 'left',
      clickCount: 1
    });

    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: 30,
      y: 20,
      button: 'left'
    });

    const isClicked = await win.webContents.executeJavaScript('window.clicked');
    console.log('✓ CDP Mouse Click Result:', isClicked);
  } catch (err) {
    console.error('CDP Error:', err);
  } finally {
    win.close();
    app.quit();
  }
});
