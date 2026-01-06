const express = require('express');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const Docker = require('dockerode');
const router = express.Router();
const http = require('http');
const https = require('https');
const docker = new Docker();
const DATA_DIR = path.resolve(__dirname, '../../data');
const DATA_FILE = path.join(__dirname, '../../data.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const crypto = require('crypto');

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

const objectToEnv = (obj) => Object.entries(obj).map(([k, v]) => `${k}=${v}`);
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

async function replacePlaceholders(filePath, env) {
  const ext = path.extname(filePath).toLowerCase();
  if (!['.txt', '.json', '.properties'].includes(ext)) return;
  let content = await fsPromises.readFile(filePath, 'utf8');
  content = content.replace(/{{(.*?)}}/g, (_, key) => env[key] ?? `{{${key}}}`);
  await fsPromises.writeFile(filePath, content, 'utf8');
}

function genPass(length = 12) {
  const chars = 'abcdef0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

const si = new Set();

/**
 * Create a new container entry
 * Body expected:
 * {
 *   dockerimage: string,
 *   env?: object,
 *   name?: string,
 *   ram?: number,                    // in MB
 *   core?: number,                   // number of CPUs (float accepted)
 *   disk?: number,
 *   port?: number|string,
 *   files?: [{ filename, url }]      // files to download into the volume
 * }
 */
router.post('/create', async (req, res) => {
  const idt = Math.random().toString(36).substring(2, 12);
  const volumePath = path.join(DATA_DIR, idt);
  const fcid = 'pending_' + crypto.randomBytes(16).toString('hex');
  const ftpPassword = genPass();
  si.add(idt);
  res.json({
    containerId: fcid,
    idt,
    ftppass: ftpPassword,
    message: 'Container Creation Started!'
  });

  (async () => {
    try {
      await fsPromises.mkdir(volumePath, { recursive: true });

      const { dockerimage, env = {}, name, ram, core, disk, port, files = [] } = req.body;
      const containerEnv = { ...env, MEMORY: `${ram}M`, TID: idt, PORT: port };
      for (const file of files) {
        const resolvedUrl = file.url.replace(/{{(.*?)}}/g, (_, key) =>
          containerEnv[key] ?? `{{${key}}}`
        );
        const dest = path.join(volumePath, file.filename);
        await downloadFile(resolvedUrl, dest);
        await replacePlaceholders(dest, containerEnv);
      }

      const hostConfig = {
        Binds: [`${volumePath}:/app/data`],
        Memory: ram ? ram * 1024 * 1024 : undefined,
        NanoCPUs: core ? core * 1e9 : undefined,
      };

      const exposedPorts = {};
      if (port) {
        hostConfig.PortBindings = {
          [`${port}/tcp`]: [{ HostPort: port.toString() }]
        };
        exposedPorts[`${port}/tcp`] = {};
      }
      await new Promise((resolve, reject) => {
        docker.pull(dockerimage, (err, stream) => {
          if (err) return reject(err);
          docker.modem.followProgress(stream, err =>
            err ? reject(err) : resolve()
          );
        });
      });

      // Create container
      const container = await docker.createContainer({
        Image: dockerimage,
        name: `talorix_${idt}`,
        Env: objectToEnv(containerEnv),
        HostConfig: hostConfig,
        ExposedPorts: exposedPorts,
        Tty: true,
        Cmd: ['sh', '-c', startupCommand],
        OpenStdin: true,
      });
      await container.start();
      const data = loadData();

      data[idt] = {
        containerId: container.id,
        dockerimage,
        ftpPassword,
        startCmd,
        stopCmd,
        env: containerEnv,
        name,
        ram,
        core,
        disk,
        port,
        files,
        status: 'running'
      };
      await saveData(data);
      si.delete(idt); //installed
    } catch (err) {
      if (fs.existsSync(volumePath)) {
        fs.rmSync(volumePath, { recursive: true, force: true });
      }

      const data = loadData();
      data[idt] = {
        containerId: fcid,
        ftpPassword,
        status: 'failed',
        error: err.message
      };
      console.log('DEBUG: Saving error state for', idt);
      await saveData(data);
      console.log('DEBUG: Error state saved for', idt);
      si.delete(idt);
    }
  })();
});

router.get('/:idt/state', (req, res) => {
  const { idt } = req.params;
  if (si.has(idt)) {
    return res.json({
      idt,
      state: 'installing'
    });
  }
  const data = loadData();
  const container = data[idt];

  if (!container) {
    return res.status(404).json({
      idt,
      state: 'not_found'
    });
  }
  res.json({
    idt,
    state: container.status // 'failed,running,installing'
  });
});

/**
 * Edit an existing container entry (files, image, env, resources, port, name, etc.)
 * Body expected:
 * {
 *   idt: string,                     // required: id of existing entry
 *   dockerimage?: string,
 *   env?: object,
 *   name?: string,
 *   ram?: number,                    // in MB
 *   core?: number,                   // number of CPUs (float accepted)
 *   disk?: number,
 *   port?: number|string,
 *   files?: [{ filename, url }]      // files to add/overwrite in the volume
 * }
 */
router.post('/edit', async (req, res) => {
  const {
    idt,
    dockerimage: newImage,
    env: newEnv = {},
    name: newName,
    ram: newRam,
    core: newCore,
    disk: newDisk,
    port: newPort,
    files: newFiles = []
  } = req.body;

  if (!idt) return res.status(400).json({ error: 'Missing idt in request body' });

  const data = loadData();
  const existing = data[idt];
  if (!existing) return res.status(404).json({ error: `No entry found for id ${idt}` });

  const volumePath = path.join(DATA_DIR, idt);
  if (!fs.existsSync(volumePath)) await fsPromises.mkdir(volumePath, { recursive: true });

  try {
    // Merge/decide final values (use provided values or fall back to existing)
    const finalDockerImage = newImage || existing.dockerimage;
    const finalRam = typeof newRam !== 'undefined' ? newRam : existing.ram;
    const finalCore = typeof newCore !== 'undefined' ? newCore : existing.core;
    const finalPort = typeof newPort !== 'undefined' ? newPort : existing.port;
    const finalName = typeof newName !== 'undefined' ? newName : existing.name;
    const finalDisk = typeof newDisk !== 'undefined' ? newDisk : existing.disk;

    // Merge env: newEnv overrides existing.env
    const mergedEnv = { ...(existing.env || {}), ...(newEnv || {}) };
    // Ensure MEMORY, TID, PORT are set/updated
    if (finalRam) mergedEnv.MEMORY = `${finalRam}M`;
    mergedEnv.TID = idt;
    if (finalPort) mergedEnv.PORT = finalPort;

    // Process files: download/overwrite any files provided in newFiles
    for (const file of newFiles) {
      const resolvedUrl = file.url.replace(/{{(.*?)}}/g, (_, key) => mergedEnv[key] ?? `{{${key}}}`);
      const dest = path.join(volumePath, file.filename);
      await downloadFile(resolvedUrl, dest);
      await replacePlaceholders(dest, mergedEnv);
    }

    // Prepare hostConfig and exposedPorts for new container
    const hostConfig = {
      Binds: [`${volumePath}:/app/data`],
      Memory: finalRam ? finalRam * 1024 * 1024 : undefined,
      NanoCPUs: finalCore ? finalCore * 1e9 : undefined,
    };

    const exposedPorts = {};
    if (finalPort) {
      hostConfig.PortBindings = { [`${finalPort}/tcp`]: [{ HostPort: finalPort.toString() }] };
      exposedPorts[`${finalPort}/tcp`] = {};
    }

    // Pull the desired image (pull even if same image to ensure latest local copy)
    await new Promise((resolve, reject) => {
      docker.pull(finalDockerImage, (err, stream) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve()));
      });
    });

    // Stop and remove existing container if it exists
    if (existing.containerId) {
      try {
        const oldContainer = docker.getContainer(existing.containerId);
        // Stop (ignore errors) then remove
        await oldContainer.stop().catch(() => { });
        await oldContainer.remove({ force: true }).catch(() => { });
      } catch (err) {
        // log and continue; might be already removed
        console.warn(`Failed to stop/remove previous container ${existing.containerId}:`, err.message);
      }
    }

    // Create new container with same name
    const container = await docker.createContainer({
      Image: finalDockerImage,
      name: `talorix_${idt}`,
      Env: objectToEnv(mergedEnv),
      HostConfig: hostConfig,
      ExposedPorts: exposedPorts,
      Cmd: ['sh', '-c', startCmd],
      Tty: true,
      OpenStdin: true,
    });

    await container.start();

    // Update stored metadata
    data[idt] = {
      containerId: container.id,
      dockerimage: finalDockerImage,
      env: mergedEnv,
      name: finalName,
      startCmd: existing.startCmd,
      ftpPassword: existing.ftpPassword,
      stopCmd: existing.stopCmd,
      ram: finalRam,
      core: finalCore,
      disk: finalDisk,
      port: finalPort,
      // Merge file lists: prefer newFiles info for updated entries, otherwise keep existing.files
      files: (() => {
        const existingFiles = Array.isArray(existing.files) ? existing.files : [];
        if (!Array.isArray(newFiles) || newFiles.length === 0) return existingFiles;
        // Create map of filename->file for existing then overwrite with new
        const map = Object.fromEntries(existingFiles.map(f => [f.filename, f]));
        for (const f of newFiles) map[f.filename] = f;
        return Object.values(map);
      })()
    };

    await saveData(data);

    res.json({ containerId: container.id, idt, message: 'Container edited, new container started and saved' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
