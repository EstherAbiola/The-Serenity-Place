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
    console.error("Failed to start:", err);
    process.exit(1);
  });
