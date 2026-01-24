const { s3Health } = require("../upload.js");

async function handler(req, res) {
  try {
    const status = await s3Health();
    console.log("Health check status:", status);
    res.status(status.live ? 200 : 503).json(status);
  } catch (err) {
    res.status(500).json({ live: false, error: (err && err.message) || String(err) });
  }
}

module.exports = handler;
