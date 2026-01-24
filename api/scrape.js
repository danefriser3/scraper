const { scrapeAndUpload } = require("../upload.js");

async function handler(req, res) {
  try {
    const result = await scrapeAndUpload();
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err && err.message) || String(err) });
  }
}

module.exports = handler;
module.exports.config = {
  maxDuration: 60,
};
