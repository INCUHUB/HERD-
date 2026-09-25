/* Run the app against the mock, with no Square token and no password.
   Everything on screen is invented — see tools/mock-square.js. */
const { spawn } = require("child_process");
const path = require("path");

const mock = spawn(process.execPath, [path.join(__dirname, "mock-square.js")], { stdio: "inherit" });

setTimeout(() => {
  const app = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    stdio: "inherit",
    env: {
      ...process.env,
      SQUARE_API: `http://127.0.0.1:${process.env.MOCK_PORT || 4000}/v2`,
      SQUARE_ACCESS_TOKEN: "demo-token",
      SHOPIFY_STORE: "herd-demo.myshopify.com",
      SHOPIFY_CLIENT_ID: "demo", SHOPIFY_CLIENT_SECRET: "demo",
      SHOPIFY_API_BASE: `http://127.0.0.1:${process.env.MOCK_PORT || 4000}`,
      ALLOW_OPEN: "1",
      DATA_DIR: path.join(__dirname, "..", "data"),
      OPENED_ON: "2026-06-20",
      PORT: process.env.PORT || 3000,
    },
  });
  const bye = () => { mock.kill(); app.kill(); process.exit(0); };
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
}, 600);
