// Builds the client with the server's real bearer token baked in, so `npm run build` at the repo
// root produces a `client/dist` the combined service (server/app.js) can serve standalone —
// nobody has to remember to set VITE_GOVERNANCE_API_TOKEN by hand. Plain `env VAR=x cmd` isn't
// portable to Windows' default npm shell, hence a small script instead of an inline env prefix in
// package.json.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TOKEN_PATH = path.join(__dirname, '..', 'server', 'data', 'api-token');

let token;
try {
  token = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
} catch (err) {
  console.error(
    `Could not read ${TOKEN_PATH} (${err.message}). Run the server at least once (or ` +
      '`npm run seed --prefix server`) to generate a token before building the client.'
  );
  process.exit(1);
}

const result = spawnSync('npm', ['run', 'build'], {
  cwd: path.join(__dirname, '..', 'client'),
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, VITE_GOVERNANCE_API_TOKEN: token },
});

process.exit(result.status ?? 1);
