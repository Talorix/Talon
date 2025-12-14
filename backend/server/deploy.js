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
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return {};
  }
};

// Save data.json
const saveData = async (data) => {
  await fsPromises.writeFile(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
};

async function replacePlaceholders(filePath, env) {
  // Only process small text-based files
  const ext = path.extname(filePath).toLowerCase();
  if (!['.txt', '.json', '.properties'].includes(ext)) return;

  let content = await fsPromises.readFile(filePath, 'utf8');

  // Replace {{KEY}} with env.KEY if exists
  content = content.replace(/{{(.*?)}}/g, (_, key) => env[key] ?? `{{${key}}}`);

  await fsPromises.writeFile(filePath, content, 'utf8');
}
router.post('/create', async (req, res) => {
  const idt = Math.random().toString(36).substring(2, 12);
  const volumePath = path.join(DATA_DIR, idt);

  try {
    await fsPromises.mkdir(volumePath, { recursive: true });

    const { dockerimage, env = {}, name, ram, core, port, files = [] } = req.body;

    for (const file of files) {
      const dest = path.join(volumePath, file.filename);
      await downloadFile(file.url, dest);
      await replacePlaceholders(dest, { ...env, MEMORY: `${ram}M`, TID: idt, PORT: port });
    }

    const containerEnv = { ...env, MEMORY: `${ram}M`, TID: idt, PORT: port };

    const hostConfig = {
      Binds: [`${volumePath}:/app/data`],
      Memory: ram ? ram * 1024 * 1024 : undefined,
      NanoCPUs: core ? core * 1e9 : undefined,
    };

    const exposedPorts = {};
    if (port) {
      hostConfig.PortBindings = { [`${port}/tcp`]: [{ HostPort: port.toString() }] };
      exposedPorts[`${port}/tcp`] = {};
    }

    // Pull Docker image
    await new Promise((resolve, reject) => {
      docker.pull(dockerimage, (err, stream) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve()));
      });
    });

    // Create container
    const container = await docker.createContainer({
      Image: dockerimage,
      name: `talorix_${idt}`,
      Env: objectToEnv(containerEnv),
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

    // Save to data.json
    const data = loadData();
    data[idt] = {
      containerId: container.id,
      dockerimage,
      env: containerEnv,
      name,
      ram,
      core,
      port,
      files
    };
    await saveData(data);

    res.json({ containerId: container.id, idt, message: 'Container started and saved successfully' });
  } catch (err) {
    if (fs.existsSync(volumePath)) fs.rmSync(volumePath, { recursive: true, force: true });
    res.status(500).json({ error: err.message });
    console.log(err)
  }
});

module.exports = router;
