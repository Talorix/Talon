const express = require('express');
const fs = require('fs');
const Docker = require('dockerode');

const router = express.Router();
const docker = new Docker();
const DATA_FILE = './data.json';

// Load data.json safely
const loadData = () => {
  if (!fs.existsSync(DATA_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return {};
  }
};

router.get('/action/:containerId', async (req, res) => {
  try {
    const { containerId } = req.params;
    const { action } = req.query;
    const data = loadData();

    // Find container in data.json by containerId
    const containerEntry = Object.values(data).find(c => c.containerId === containerId);
    if (!containerEntry) {
      // Early return if container not found
      return res.status(404).json({ error: `Container ID "${containerId}" not found in data.json` });
    }

    const container = docker.getContainer(containerId);

    if (action === 'start') await container.start();
    else if (action === 'stop') await container.stop();
    else if (action === 'restart') await container.restart();
    else return res.status(400).json({ error: 'Invalid action' });

    res.json({ status: 'ok', action, containerId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
