import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";

// The API authenticates with per-node mTLS client certificates rather than a bearer token
// (docs/design/per-node-enrollment-credentials.md). The dev proxy presents a certificate on the
// browser's behalf, exactly as it used to attach a token — so `npm run dev` still needs nothing
// installed in the browser, which matters because a browser can only present a client certificate
// that has been imported into the OS certificate store.
//
// The credential is created by enrolling, not by copying a secret:
//   node -e "require('./server/enrollment/client').enroll({name:'dev', \
//     baseUrl:'https://localhost:4443', enrollmentToken:'<token>'})"
const CRED_DIR = path.resolve(__dirname, "../server/data/credentials");

function readDevCredential():
  | { key: string; cert: string; ca: string }
  | undefined {
  try {
    return {
      key: fs.readFileSync(path.join(CRED_DIR, "dev-key.pem"), "utf8"),
      cert: fs.readFileSync(path.join(CRED_DIR, "dev-cert.pem"), "utf8"),
      ca: fs.readFileSync(path.join(CRED_DIR, "dev-ca.pem"), "utf8"),
    };
  } catch {
    return undefined;
  }
}

const devCredential = readDevCredential();
if (!devCredential) {
  // A warning rather than a hard failure: `vite build` does not proxy anything, so a missing dev
  // credential must not break the production build.
  console.warn(
    `[vite] no dev credential in ${CRED_DIR} — API requests through the dev proxy will 401. ` +
      "Enroll one with server/enrollment/client.js (see the comment above).",
  );
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        // The mTLS listener, not the plaintext one — :4000 only ever grants `agent` scope, which
        // is the hook credential, so the dashboard could not read anything through it.
        target: "https://localhost:4443",
        changeOrigin: true,
        // `secure` stays true: the CA below is our own enrollment root, so the proxy verifies the
        // server properly rather than skipping the check the way a self-signed setup usually does.
        secure: true,
        ...(devCredential
          ? {
              agent: new https.Agent({
                key: devCredential.key,
                cert: devCredential.cert,
                ca: devCredential.ca,
                keepAlive: true,
                servername: "localhost",
              }),
            }
          : {}),
      },
    },
  },
});
