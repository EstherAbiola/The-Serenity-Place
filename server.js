// Entry point for GoDaddy Node.js Hosting (and `npm start` locally).
// The website starts straight away; the database connects in the background and retries,
// so a database problem shows a clear message instead of crashing the app.
const db = require("./server/db");
const auth = require("./server/auth");
const { createApp } = require("./server/app");

const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";
const RETRY_SECONDS = 15;

createApp().listen(PORT, HOST, () => console.log(`Serenity Place running on http://${HOST}:${PORT}`));

let attempt = 0;
async function connectDb() {
  attempt++;
  try {
    await db.connect();
    await auth.prepareOwnerSetup();
    console.error(`[db] Connected${attempt > 1 ? ` after ${attempt} attempts` : ""}.`);
  } catch (err) {
    const detail = [err && err.message, err && err.code && `code ${err.code}`, err && err.cause && err.cause.message]
      .filter(Boolean).join(" · ");
    console.error(`[db] Connection attempt ${attempt} failed: ${detail}`);
    if (attempt === 1 && process.env.DATABASE_URL) {
      console.error("[db] Check the DATABASE_URL secret in GoDaddy (Settings → Secrets). Paste only the link itself, starting with postgresql://");
    }
    setTimeout(connectDb, RETRY_SECONDS * 1000);
  }
}
connectDb();
