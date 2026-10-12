const { readQuota } = require('./quota.cjs');
readQuota().then(data => console.log(JSON.stringify(data, null, 2)))
  .catch(error => { console.error(error.message); process.exitCode = 1; });
