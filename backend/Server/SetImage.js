const express = require('express');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const router = express.Router();
const DATA_DIR = path.resolve(__dirname, '../../data');
const DATA_FILE = path.join(__dirname, '../../data.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const loadData = () => {
  if (!fs.existsSync(DATA_FILE)) return {};
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return (typeof data === 'object' && !Array.isArray(data)) ? data : {};
  } catch {
    return {};
  }
};

const saveData = async (data) => {
  try {
    await fsPromises.writeFile(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    console.error('Failed to save data:', error);
    throw error;
  }
};  
router.post('/:idt/set-image', async (req, res) => {
    const { idt } = req.params;
    const { dockerImage } = req.body;

    if (!dockerImage) {
        return res.status(400).json({ error: 'Docker image field is required' });
    }
    let data = loadData();
    const server = data[idt];
    if (!server) {
        return res.status(404).json({ error: 'Server not found' });
    }
    server.dockerimage = dockerImage;
    data[idt] = server;

    try {
        await saveData(data);
        res.json({ message: 'Image updated successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to update image' });
    }
});
module.exports = router;
