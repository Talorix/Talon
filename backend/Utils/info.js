const express = require('express');
const fs = require('fs');
const Docker = require('dockerode');
const path = require('path');
const router = express.Router();
const docker = new Docker();
const DATA_FILE =  path.join(__dirname, '../../data.json');

const loadData = () => JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));

// INFO
// GET /server/info/:Id
router.get('/info/:Id', async (req, res) => {
  try {
    const { Id } = req.params;
    const data = loadData();

    if (!data[Id]) return res.status(404).json({ error: 'Unknown ID' });

    const container = docker.getContainer(data[Id].containerId);
    const info = await container.inspect();

    res.json(info);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
