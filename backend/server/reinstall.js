const express = require('express');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const Docker = require('dockerode');
const https = require('https');
const http = require('http');
const router = express.Router();
const docker = new Docker();
const DATA_DIR = path.resolve(__dirname, '../../data');
const DATA_FILE = path.join(__dirname, '../../data.json');

// Ensure data folder exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Helper to download files
async function downloadFile(url, dest) {
  const proto = url.startsWith('https') ? https : http;
  return new Promise((resolve, reject) => {
    proto.get(url, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`Failed to download '${url}' (${res.statusCode})`));
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', reject);
  });
}

// Convert object to env array
const objectToEnv = (obj) => Object.entries(obj).map(([k, v]) => `${k}=${v}`);

// Load existing data.json
const loadData = () => {
  if (!fs.existsSync(DATA_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } 
  catch { return {}; }
};

// Save data.json
const saveData = async (data) => {
  await fsPromises.writeFile(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
};

/**
 * POST /reinstall/:idt
 * Reinstall a server: moves current files to tmp, downloads new files, restores old files
 */
router.post('/reinstall/:idt', async (req, res) => {
  const { idt } = req.params;

  const data = loadData();
  const existing = data[idt];
  if (!existing) return res.status(404).json({ error: 'Server not found' });

  const volumePath = path.join(DATA_DIR, idt);
  const tmpPath = path.join(DATA_DIR, `${idt}_tmp`);

  try {
    // Stop container if running
    if (existing.containerId) {
      try {
        const container = docker.getContainer(existing.containerId);

        // Stop if running
        try { await container.stop({ t: 5 }); } catch {}

        // Force remove container
        await container.remove({ force: true });
      } catch (e) { 
        console.log('Could not stop/remove container:', e.message); 
      }
    }

    // Move existing files to tmp
    if (fs.existsSync(tmpPath)) await fsPromises.rm(tmpPath, { recursive: true, force: true });
    if (fs.existsSync(volumePath)) await fsPromises.rename(volumePath, tmpPath);

    // Recreate volume folder
    await fsPromises.mkdir(volumePath, { recursive: true });

    // Download files
    for (const file of existing.files) {
      const dest = path.join(volumePath, file.filename);
      await downloadFile(file.url, dest);
    }

    // Move old files from tmp back
    if (fs.existsSync(tmpPath)) {
      const tmpFiles = await fsPromises.readdir(tmpPath);
      for (const file of tmpFiles) {
        const src = path.join(tmpPath, file);
        const dest = path.join(volumePath, file);
        await fsPromises.rename(src, dest);
      }
      await fsPromises.rm(tmpPath, { recursive: true, force: true });
    }

    // Recreate container
    const mergedEnv = { ...existing.env, MEMORY: existing.env.MEMORY || '2G', TID: idt, PORT: existing.port };

    const hostConfig = {
      Binds: [`${volumePath}:/app/data`],
      Memory: existing.ram ? existing.ram * 1024 * 1024 : undefined,
      NanoCPUs: existing.core ? existing.core * 1e9 : undefined,
    };

    const exposedPorts = {};
    if (existing.port) {
      hostConfig.PortBindings = { [`${existing.port}/tcp`]: [{ HostPort: existing.port.toString() }] };
      exposedPorts[`${existing.port}/tcp`] = {};
    }

    // Pull Docker image
    await new Promise((resolve, reject) => {
      docker.pull(existing.dockerimage, (err, stream) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve()));
      });
    });

    const container = await docker.createContainer({
      Image: existing.dockerimage,
      name: `talorix_${idt}`, // same name is fine now because old container is removed
      Env: objectToEnv(mergedEnv),
      HostConfig: hostConfig,
      ExposedPorts: exposedPorts,
      AttachStdout: true,
      AttachStderr: true,
      AttachStdin: true,
      StdinOnce: false, 
      Tty: true,
      OpenStdin: true,
    });

    await container.start();

    // Update data.json
    existing.containerId = container.id;
    existing.env = mergedEnv;
    await saveData(data);

    res.json({ message: 'Server reinstalled successfully', containerId: container.id });

  } catch (err) {
    // Restore from tmp if something fails
    if (fs.existsSync(tmpPath) && !fs.existsSync(volumePath)) await fsPromises.rename(tmpPath, volumePath);
    res.status(500).json({ error: err.message });
    console.log(err);
  }
});

module.exports = router;
