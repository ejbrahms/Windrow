// Registers the combined backend+frontend (`npm start` at the repo root — server/index.js,
// which serves the API and the built client/dist together on one port) as a Windows service, so
// it starts on boot and restarts on crash instead of only running in a terminal someone leaves
// open. Uses node-windows, which wraps the target script with a small native service host
// (winsw) and talks to the Windows Service Control Manager under the hood.
//
// Must be run from an elevated (Run as Administrator) terminal — the SCM refuses
// CreateService/OpenSCManager calls from a non-admin process. Run once:
//   npm run service:install
const path = require('path');
const { Service } = require('node-windows');

const svc = new Service({
  name: 'Windrow',
  description:
    'Windrow: backend API + built frontend served together on one port ' +
    '(http://localhost:4000).',
  script: path.join(__dirname, '..', 'server', 'index.js'),
  nodeOptions: [],
  env: [{ name: 'PORT', value: process.env.PORT || '4000' }],
});

svc.on('install', () => {
  console.log(`Service "${svc.name}" installed. Starting it now...`);
  svc.start();
});

svc.on('alreadyinstalled', () => {
  console.log(`Service "${svc.name}" is already installed.`);
});

svc.on('start', () => {
  console.log(`Service "${svc.name}" is running: http://localhost:${process.env.PORT || 4000}/api`);
});

svc.on('error', (err) => {
  console.error('Service install/start error:', err);
  process.exitCode = 1;
});

console.log(
  `Installing Windows service "${svc.name}" -> node ${svc.script}\n` +
    'This requires an elevated (Administrator) terminal.'
);
svc.install();
