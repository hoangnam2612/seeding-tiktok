const apiKey = 'OMO_K6HK5MYXHNNL40SGFNED313GBDGSI3HNIHIDHFHGT30GLJYXYIEJIZC5BBY12P1778741607';

async function testRotateSchema() {
  console.log('Testing TiktokRotateWebTask with imageBase64s [inner, outer]...');
  // 1x1 transparent png for schema validation test
  const dummyBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const res = await fetch('https://api.omocaptcha.com/v2/createTask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientKey: apiKey,
      task: {
        type: 'TiktokRotateWebTask',
        imageBase64s: [dummyBase64, dummyBase64]
      }
    })
  });
  const json = await res.json();
  console.log('Rotate createTask result:', json);
}

async function test3DSchema() {
  console.log('\nTesting Tiktok3DSelectObjectWebTask with question, widthView, heightView...');
  const dummyBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const res = await fetch('https://api.omocaptcha.com/v2/createTask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientKey: apiKey,
      task: {
        type: 'Tiktok3DSelectObjectWebTask',
        imageBase64: dummyBase64,
        widthView: 340,
        heightView: 212,
        question: 'Select 2 objects with the same shape'
      }
    })
  });
  const json = await res.json();
  console.log('3D createTask result:', json);
}

async function testSliderSchema() {
  console.log('\nTesting TiktokSliderWebTask with imageBase64, widthView...');
  const dummyBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const res = await fetch('https://api.omocaptcha.com/v2/createTask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientKey: apiKey,
      task: {
        type: 'TiktokSliderWebTask',
        imageBase64: dummyBase64,
        widthView: 340
      }
    })
  });
  const json = await res.json();
  console.log('Slider createTask result:', json);
}

(async () => {
  await testRotateSchema();
  await test3DSchema();
  await testSliderSchema();
})();
