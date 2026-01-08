const express = require('express');
const fs = require('fs');
const router = express.Router();
const DATA_FILE = '../../data.json';

const loadData = () => {
  if (!fs.existsSync(DATA_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return {};
  }
};

router.get('/list', async (req, res) => {
  const data = loadData();
  res.json({ servers: data });
});

module.exports = router;
