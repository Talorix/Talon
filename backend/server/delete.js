const fs = require('fs').promises; // use promises for async
const path = require('path');
const Docker = require('dockerode');

const router = require('express').Router();
const docker = new Docker();
const DATA_FILE = path.join(__dirname, '../../data.json');

// Ensure data file exists
async function ensureDataFile() {
  try {
    await fs.access(DATA_FILE);
  } catch {
    await fs.writeFile(DATA_FILE, JSON.stringify({}), 'utf8');
  }
}

const loadData = async () => {
  await ensureDataFile();
  const raw = await fs.readFile(DATA_FILE, 'utf8');
  return JSON.parse(raw || '{}');
};

const saveData = async (data) => {
  await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
};

async function deletesrvdata(idt) {
  const containerDataPath = path.join(__dirname, `../../data/${idt}`);
  try {
    await fs.rm(containerDataPath, { recursive: true, force: true });
  } catch (err) {
    console.error(`Failed to delete container data at ${containerDataPath}:`, err);
  }
}

// delete /server/delete/:idt
router.delete('/delete/:idt', async (req, res) => {
  try {
    const { idt } = req.params;
    const data = await loadData();

    if (!data[idt]) return res.status(404).json({ error: 'Unknown ID' });

    // Delete container folder
    await deletesrvdata(idt);

    const container = docker.getContainer(data[idt].containerId);

    // Stop container if running
    try {
      const info = await container.inspect();
      if (info.State.Running) {
        await container.stop();
      }
    } catch {
      // ignore
    }

    // Remove container
    try {
      await container.remove({ force: true });
    } catch {
      // ignore if already removed
    }

    // Remove from data.json
    delete data[idt];
    await saveData(data);

    res.json({ status: 'ok', idt });
  } catch (err) {
    console.error('Error deleting server:', err);
    res.status(500).json({ error: err.message });
  }
});
module.exports = router;
