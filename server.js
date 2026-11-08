// Entry point for GoDaddy Node.js Hosting (and `npm start` locally).
const db = require("./server/db");
const { createApp } = require("./server/app");

const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

db.connect()
  .then(() => {
    createApp().listen(PORT, HOST, () => console.log(`Serenity Place running on http://${HOST}:${PORT}`));
  })
  .catch((err) => {
    console.error("Failed to start:", err && err.message ? err.message : err);
    if (process.env.DATABASE_URL) {
      console.error("Check the DATABASE_URL secret in GoDaddy (Settings → Secrets): it must be the full Neon connection string.");
    }
    process.exit(1);
  });
