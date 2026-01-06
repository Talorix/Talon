const path = require("path");
const fsPromises = require("fs").promises;
const Docker = require("dockerode");
const docker = new Docker();

const DATA_PATH = path.join(__dirname, "../data.json");

let data = null;
let writeLock = Promise.resolve();
/**
 * Atomic write + in-memory update + serialized via writeLock
 * newData must be a plain object
 */
async function writeData(newData) {
  writeLock = writeLock.then(async () => {
    const tmp = DATA_PATH + ".tmp";
    await fsPromises.writeFile(tmp, JSON.stringify(newData, null, 2), "utf8");
    await fsPromises.rename(tmp, DATA_PATH);
    data = newData;
  }, async (err) => {
    const tmp = DATA_PATH + ".tmp";
    await fsPromises.writeFile(tmp, JSON.stringify(newData, null, 2), "utf8");
    await fsPromises.rename(tmp, DATA_PATH);
    data = newData;
  });

  await writeLock;
}

async function readData() {
  try {
    const content = await fsPromises.readFile(DATA_PATH, "utf8");
    return content ? JSON.parse(content) : {};
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
}

/**
 * Recreate container for a given IDT:
 * - pull latest image
 * - stop & remove old container (if any)
 * - create a new container bound to the same volume + ports + env
 * - update data.json.containerId
 *
 * IMPORTANT: callers should cleanup log/stat streams for previous containerId
 * BEFORE calling this function to avoid races.
 */
async function recreateContainer(idt) {
  const current = await readData();
  const entry = current[idt];
  if (!entry) throw new Error("Data entry not found");
  const DATA_DIR = path.resolve(__dirname, '../data');
  const volumePath = path.join(DATA_DIR, idt);

  // pull latest image
  await new Promise((resolve, reject) => {
    docker.pull(entry.dockerimage, (err, stream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (err) =>
        err ? reject(err) : resolve()
      );
    });
  });

  // remove old container if exists (recreate caller should have cleaned streams)
  if (entry.containerId) {
    try {
      const old = docker.getContainer(entry.containerId);
      await old.stop().catch(() => { });
      await old.remove({ force: true }).catch(() => { });
    } catch (e) {
      // ignore; might already be gone
    }
  }

  // build host config
  const hostConfig = {
    Binds: [`${volumePath}:/app/data`],
    Memory: entry.ram ? entry.ram * 1024 * 1024 : undefined,
    NanoCPUs: entry.core ? entry.core * 1e9 : undefined,
  };

  const exposedPorts = {};
  const portBindings = {};

  // use ports[] if present, otherwise fallback to single port
  const ports =
    Array.isArray(entry.ports) && entry.ports.length
      ? entry.ports
      : entry.port
        ? [entry.port]
        : [];

  for (const p of ports) {
    exposedPorts[`${p}/tcp`] = {};
    portBindings[`${p}/tcp`] = [{ HostPort: String(p) }];
  }

  if (ports.length) {
    hostConfig.PortBindings = portBindings;
  }
  const startupCommand = entry.startCmd.replace(/{{(.*?)}}/g, (_, key) => entry.env[key] ?? `{{${key}}}`);
  const container = await docker.createContainer({
    Image: entry.dockerimage,
    name: `talorix_${idt}`,
    Env: Object.entries(entry.env || {}).map(([k, v]) => `${k}=${v}`),
    HostConfig: hostConfig,
    ExposedPorts: exposedPorts,
    Tty: true,
    Cmd: ['sh', '-c', startupCommand],
    OpenStdin: true,
  });

  await container.start();

  const latest = await readData();
  if (!latest[idt]) latest[idt] = entry;
  latest[idt].containerId = container.id;
  await writeData(latest);

  return container;
}

setInterval(async () => {
  try {
    const diskData = await readData();
    if (JSON.stringify(diskData) !== JSON.stringify(data)) {
      data = diskData;
    }
  } catch (err) {
    console.error("reloadData error:", err);
  }
}, 5000);

module.exports = {
  readData,
  recreateContainer,
};