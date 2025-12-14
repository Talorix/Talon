const express = require('express');
const fs = require('fs');
const path = require('path');
const Docker = require('dockerode');

const router = express.Router();
const docker = new Docker();
const DATA_FILE =  path.join(__dirname, '../../data.json');

if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({}), 'utf8');

const loadData = () => JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
const saveData = (data) => fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));

// DELETE /server/delete/:idt
router.delete('delete/:idt', async (req, res) => {
  try {
    const { idt } = req.params;
    const data = loadData();

    if (!data[idt]) return res.status(404).json({ error: 'Unknown ID' });

    const container = docker.getContainer(data[idt].containerId);

    // Stop the container if running
    try {
      const info = await container.inspect();
      if (info.State.Running) {
        await container.stop();
      }
    } catch (err) {
      // ignore if container already stopped or doesn't exist
    }

    // Remove the container
    await container.remove({ force: true });

    // Delete associated data folder
    const containerDataPath = path.resolve('../../data', idt);
    if (fs.existsSync(containerDataPath)) {
      fs.rmSync(containerDataPath, { recursive: true, force: true });
    }

    // Remove from data.json
    delete data[idt];
    saveData(data);

    res.json({ status: 'ok', idt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
