const { app, BrowserWindow } = require('electron');

app.whenReady().then(async () => {
  console.log('Testing CDP Drag on a Zoomed Slider...');

  const win = new BrowserWindow({
    width: 600,
    height: 400,
    show: false,
    webPreferences: { nodeIntegration: true }
  });

  const html = `
    <html>
    <head>
      <style>
        #track { width: 300px; height: 40px; background: #333; position: relative; margin: 50px auto; border-radius: 20px; }
        #slider { width: 40px; height: 40px; background: #00f; position: absolute; left: 0; top: 0; border-radius: 20px; cursor: pointer; }
      </style>
    </head>
    <body>
      <div id="track">
        <div id="slider"></div>
      </div>
      <script>
        window.draggedTo = 0;
        const slider = document.getElementById('slider');
        const track = document.getElementById('track');
        let isDown = false;
        let startX = 0;
        let startLeft = 0;

        function onDown(e) {
          isDown = true;
          startX = e.clientX;
          startLeft = parseInt(slider.style.left || '0', 10);
        }
        function onMove(e) {
          if (!isDown) return;
          const dx = e.clientX - startX;
          const newLeft = Math.max(0, Math.min(260, startLeft + dx));
          slider.style.left = newLeft + 'px';
          window.draggedTo = newLeft;
        }
        function onUp(e) {
          isDown = false;
        }

        slider.addEventListener('mousedown', onDown);
        slider.addEventListener('pointerdown', onDown);
        window.addEventListener('mousemove', onMove);
        window.addEventListener('pointermove', onMove);
        window.addEventListener('mouseup', onUp);
        window.addEventListener('pointerup', onUp);
      </script>
    </body>
    </html>
  `;

  await win.loadURL('data:text/html,' + encodeURIComponent(html));
  const zoom = 0.52;
  win.webContents.setZoomFactor(zoom);

  win.webContents.debugger.attach('1.3');

  const rect = await win.webContents.executeJavaScript(`
    (() => {
      const s = document.getElementById('slider').getBoundingClientRect();
      return { x: s.left + s.width/2, y: s.top + s.height/2 };
    })()
  `);

  console.log('Slider CSS position:', rect);

  // Test 1: Using rect * zoom
  const startX = Math.round(rect.x * zoom);
  const startY = Math.round(rect.y * zoom);
  const endX = Math.round((rect.x + 150) * zoom);
  const endY = startY;

  console.log(`Dragging from (${startX}, ${startY}) to (${endX}, ${endY})...`);

  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: startX,
    y: startY
  });
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: startX,
    y: startY,
    button: 'left',
    buttons: 1,
    clickCount: 1
  });

  for (let i = 1; i <= 20; i++) {
    const curX = Math.round(startX + (endX - startX) * (i / 20));
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: curX,
      y: startY,
      button: 'left',
      buttons: 1
    });
  }

  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: endX,
    y: endY,
    button: 'left',
    buttons: 0
  });

  const dragged = await win.webContents.executeJavaScript('window.draggedTo');
  console.log('Result draggedTo:', dragged);

  if (dragged > 0) {
    console.log('✓ CDP Dragging with Zoom successfully moved the slider!');
  } else {
    // Try CSS direct coordinates (unzoomed)
    console.log('Trying unzoomed CSS coordinates...');
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      button: 'left',
      buttons: 1,
      clickCount: 1
    });
    for (let i = 1; i <= 20; i++) {
      const curX = Math.round(rect.x + 150 * (i / 20));
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: curX,
        y: Math.round(rect.y),
        button: 'left',
        buttons: 1
      });
    }
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: Math.round(rect.x + 150),
      y: Math.round(rect.y),
      button: 'left',
      buttons: 0
    });
    const dragged2 = await win.webContents.executeJavaScript('window.draggedTo');
    console.log('Result draggedTo with unzoomed:', dragged2);
  }

  win.close();
  app.quit();
});
