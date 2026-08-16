// Registers the combined backend+frontend (`npm start` at the repo root — server/index.js,
// which serves the API and the built client/dist together on one port) as a Windows service, so
// it starts on boot and restarts on crash instead of only running in a terminal someone leaves
// open. Uses node-windows, which wraps the target script with a small native service host
// (winsw) and talks to the Windows Service Control Manager under the hood.
//
// Must be run from an elevated (Run as Administrator) terminal — the SCM refuses
// CreateService/OpenSCManager calls from a non-admin process. Run once:
//   npm run service:install
const os = require('os');
const path = require('path');
const { Service } = require('node-windows');

const svc = new Service({
  name: 'Windrow',
  description:
    'Windrow: backend API + built frontend served together on one port ' +
    '(http://localhost:4000).',
  script: path.join(__dirname, '..', 'server', 'index.js'),
  nodeOptions: [],
  env: [
    { name: 'PORT', value: process.env.PORT || '4000' },
    // The service itself runs as LocalSystem, whose os.homedir() resolves to
    // C:\WINDOWS\system32\config\systemprofile — not the real user's ~/.claude, ~/.gemini, etc.
    // Capture the real home dir here, while the installer is still running under the actual
    // user's own (elevated) session, and hand it to the service explicitly. See
    // server/config.js's userHomeDir().
    { name: 'WINDROW_USER_HOME', value: os.homedir() },
  ],
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
