// Removes the Windrow Windows service installed by scripts/service-install.js.
// Must be run from an elevated (Administrator) terminal, same as install. Run once:
//   npm run service:uninstall
const path = require('path');
const { Service } = require('node-windows');

const svc = new Service({
  name: 'Windrow',
  script: path.join(__dirname, '..', 'server', 'index.js'),
});

svc.on('uninstall', () => {
  console.log(`Service "${svc.name}" uninstalled.`);
});

svc.on('error', (err) => {
  console.error('Service uninstall error:', err);
  process.exitCode = 1;
});

console.log(`Uninstalling Windows service "${svc.name}"...`);
svc.uninstall();
