const apiKey = 'OMO_K6HK5MYXHNNL40SGFNED313GBDGSI3HNIHIDHFHGT30GLJYXYIEJIZC5BBY12P1778741607';

async function checkTask(taskId) {
  const res = await fetch('https://api.omocaptcha.com/v2/getTaskResult', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientKey: apiKey, taskId })
  });
  return res.json();
}

(async () => {
  // Let's check recent task IDs from user's logs
  const taskIds = [
    '3527322e-7aa6-4c07-84b8-eb1a4d6d490d',
    '98cfc183-0af2-454a-9b03-855361d0709c',
    '620ffb61-0f17-4e9d-870f-972dc443e265'
  ];

  for (const id of taskIds) {
    const r = await checkTask(id);
    console.log(`Task ${id}:`, JSON.stringify(r));
  }
})();
