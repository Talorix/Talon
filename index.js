const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const Docker = require("dockerode");
const docker = new Docker();
const os = require("os");
const path = require("path");
const fsPromises = require("fs").promises;
const fs = require('fs');
const ar = require("./backend/server/deploy.js");
const br = require("./backend/server/info.js");
const cr = require("./backend/server/action.js");
const dr = require("./backend/server/delete.js");
const er = require("./backend/server/filesystem.js");
const fr = require("./backend/server/reinstall.js");
const gr = require("./backend/server/network.js");

const dataPath = path.join(__dirname, "data.json");
const DATA_PATH = path.join(__dirname, "data.json"); // why i hate niggas
const config = require("./config.json");


let writeLock = Promise.resolve();

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
 * Atomic write + in-memory update + serialized via writeLock
 * newData must be a plain object
 */
async function writeData(newData) {
  // serialize writes
  writeLock = writeLock.then(async () => {
    const tmp = DATA_PATH + ".tmp";
    await fsPromises.writeFile(tmp, JSON.stringify(newData, null, 2), "utf8");
    await fsPromises.rename(tmp, DATA_PATH);
    // update in-memory reference only after successful disk write
    data = newData;
  }, async (err) => {
    // In case previous writeLock rejected, still run this write
    const tmp = DATA_PATH + ".tmp";
    await fsPromises.writeFile(tmp, JSON.stringify(newData, null, 2), "utf8");
    await fsPromises.rename(tmp, DATA_PATH);
    data = newData;
  });

  await writeLock;
}
function ensureDataFile() {
  return new Promise((resolve, reject) => {
    fs.access(dataPath, (err) => {
      if (err) {
        fs.writeFile(dataPath, JSON.stringify({}, null, 2), "utf8", (err) => {
          if (err) return reject(err);
          resolve("File created");
        });
      } else {
        resolve("File exists"); 
      }
    });
  });
}
let data;
(async () => {
  try {
    await ensureDataFile(); 
    data = await readData();
  } catch (err) {
    process.exit(1);
  }
})();

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

const app = express();
app.use(express.json());

const ANSI = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};
function ansi(tag, color, message) {
  return `${ANSI[color] || ""}[${tag}]${ANSI.reset} ${message}`;
}

// --- Docker health helper ---
async function isDockerRunning() {
  try {
    await docker.ping();
    return true;
  } catch {
    return false;
  }
}

async function isPanelRunning(panelUrl) {
  try {
    const response = await fetch(panelUrl, { method: "GET", timeout: 5000 });
    return true;
  } catch (err) {
    console.error(
      "\x1b[31mPanel is not reachable is the Talorix panel online?"
    );
    process.exit(1);
  }
}

isPanelRunning(config.panel);
/**
 * Recreate container for a given TID:
 * - pull latest image
 * - stop & remove old container (if any)
 * - create a new container bound to the same volume + ports + env
 * - update data.json.containerId
 *
 * IMPORTANT: callers should cleanup log/stat streams for previous containerId
 * BEFORE calling this function to avoid races.
 */
async function recreateContainer(tid) {
  const current = await readData();
  const entry = current[tid];
  if (!entry) throw new Error("Data entry not found");

  const volumePath = path.join(__dirname, "data", tid);

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
      await old.stop().catch(() => {});
      await old.remove({ force: true }).catch(() => {});
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

  const container = await docker.createContainer({
    Image: entry.dockerimage,
    name: `talorix_${tid}`,
    Env: Object.entries(entry.env || {}).map(([k, v]) => `${k}=${v}`),
    HostConfig: hostConfig,
    ExposedPorts: exposedPorts,
    Tty: true,
    OpenStdin: true,
  });

  await container.start();

  const latest = await readData();
  if (!latest[tid]) latest[tid] = entry; 
  latest[tid].containerId = container.id;
  await writeData(latest);

  return container;
}

// API key middleware
app.use((req, res, next) => {
  if (req.query.key !== config.key)
    return res.status(401).json({ error: "Invalid key" });
  next();
});

// REST routers
app.use("/server", ar);
app.use("/server", br);
app.use("/server", cr);
app.use("/server", dr);
app.use("/server/fs", er);
app.use("/server", fr);
app.use("/server/network", gr);
// HTTP + WS server
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

// Client/stream bookkeeping
const clients = new Map(); // map TID -> Set(ws)
const logStreams = new Map(); // containerId -> { stream, refCount }
const statsIntervals = new Map(); // containerId -> { intervalId, refCount }

// --- Disk helpers (async) ---
async function getFolderSize(dir) {
  let total = 0;
  try {
    const entries = await fsPromises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) total += await getFolderSize(full);
      else if (entry.isFile()) total += (await fsPromises.stat(full)).size;
    }
  } catch (err) {
    // don't spam on missing directories — just return 0
    // (but log for debugging)
    if (err.code !== "ENOENT") console.error("getFolderSize error:", err);
  }
  return total;
}

/**
 * Resolve the TID / data.json entry for either:
 * - Docker container ID (full ID)
 * - or TID key passed directly
 */
function findDataEntryByContainerOrTid(containerOrTid) {
  const found = Object.entries(data).find(
    ([_, entry]) =>
      entry.containerId &&
      (entry.containerId === containerOrTid ||
        entry.containerId.startsWith(containerOrTid))
  );

  if (found) return { tid: found[0], entry: found[1] };
  if (data[containerOrTid])
    return { tid: containerOrTid, entry: data[containerOrTid] };
  return null;
}

/**
 * return GB used (number)
 */
async function getContainerDiskUsage(containerIdOrTid) {
  const resolved = findDataEntryByContainerOrTid(containerIdOrTid);
  if (!resolved) {
    console.warn(
      `[disk-check] data.json entry not found for '${containerIdOrTid}'`
    );
    return 0;
  }
  const { tid } = resolved;
  const dir = path.join(__dirname, "data", tid);
  const bytes = await getFolderSize(dir);
  return bytes / 1e9;
}

// --- WS helpers ---
function sendEvent(ws, event, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify({ event, payload, ts: new Date().toISOString() }));
  } catch (e) {
    // swallow send errors
    console.error("sendEvent error:", e);
  }
}

function broadcastToContainer(containerTidOrId, event, payload) {
  const recipients = new Set();
  const directSet = clients.get(containerTidOrId);
  if (directSet) for (const ws of directSet) recipients.add(ws);
  const resolved = findDataEntryByContainerOrTid(containerTidOrId);
  if (resolved) {
    const resolvedSet = clients.get(resolved.tid);
    if (resolvedSet) for (const ws of resolvedSet) recipients.add(ws);
  }
  for (const ws of recipients) sendEvent(ws, event, payload);
}

function addClientKey(key, ws) {
  // key should be the TID the client will use consistently
  const set = clients.get(key) || new Set();
  set.add(ws);
  clients.set(key, set);
}

function removeClient(ws) {
  for (const [key, set] of clients.entries()) {
    if (set.has(ws)) {
      set.delete(ws);
      if (set.size === 0) {
        clients.delete(key);
        cleanupLogStreamsByKey(key);
        cleanupStatsByKey(key);
      }
    }
  }
}

// Cleanup helpers keyed by containerId
function cleanupLogStreamsByContainerId(containerId) {
  const entry = logStreams.get(containerId);
  if (!entry) return;
  try {
    entry.stream.destroy();
  } catch (e) {}
  logStreams.delete(containerId);
}

function cleanupStatsByContainerId(containerId) {
  const entry = statsIntervals.get(containerId);
  if (!entry) return;
  clearInterval(entry.intervalId);
  statsIntervals.delete(containerId);
}

// Cleanup helpers which accept either TID or containerId
function cleanupLogStreamsByKey(key) {
  // if key is a containerId
  const entry = logStreams.get(key);
  if (entry) {
    entry.refCount--;
    if (entry.refCount <= 0) {
      try {
        entry.stream.destroy();
      } catch (e) {}
      logStreams.delete(key);
    }
    return;
  }

  // otherwise if key is TID, find its containerId and decrement that
  const resolved = findDataEntryByContainerOrTid(key);
  if (resolved) {
    const cid = resolved.entry.containerId;
    const e2 = logStreams.get(cid);
    if (e2) {
      e2.refCount--;
      if (e2.refCount <= 0) {
        try {
          e2.stream.destroy();
        } catch (e) {}
        logStreams.delete(cid);
      }
    }
  }
}

function cleanupStatsByKey(key) {
  const entry = statsIntervals.get(key);
  if (entry) {
    entry.refCount--;
    if (entry.refCount <= 0) {
      clearInterval(entry.intervalId);
      statsIntervals.delete(key);
    }
    return;
  }
  const resolved = findDataEntryByContainerOrTid(key);
  if (resolved) {
    const cid = resolved.entry.containerId;
    const e2 = statsIntervals.get(cid);
    if (e2) {
      e2.refCount--;
      if (e2.refCount <= 0) {
        clearInterval(e2.intervalId);
        statsIntervals.delete(cid);
      }
    }
  }
}

// --- Streams & actions ---
// Stream logs: the guy who sends log to the panel ;3
async function streamLogs(ws, container, requestedContainerId) {
  // requestedContainerId may be a TID or containerId; resolve to tid + current containerId
  const resolved = findDataEntryByContainerOrTid(requestedContainerId);
  const tid = resolved ? resolved.tid : requestedContainerId;
  const currentContainerId = resolved
    ? resolved.entry.containerId
    : requestedContainerId;

  // always use current container object (it may differ from 'container' passed in)
  container = docker.getContainer(currentContainerId);

  // Disk check BEFORE attaching logs
  const usage = await getContainerDiskUsage(tid);
  const allowed =
    resolved && resolved.entry && typeof resolved.entry.disk === "number"
      ? resolved.entry.disk
      : Infinity;
  console.log(
    `[disk-check] streamLogs for ${currentContainerId} (tid=${tid}): usage=${usage.toFixed(
      3
    )}GB allowed=${allowed === Infinity ? "∞" : allowed}`
  );

  addClientKey(tid, ws);

  if (usage >= allowed) {
    const info = await container.inspect().catch(() => null);
    if (info && info.State && info.State.Running) {
      // stop the container and broadcast to all clients for tid
      try {
        await container.kill();
      } catch (e) {
        /* ignore kill errors */
      }
      broadcastToContainer(
        tid,
        "power",
        ansi("Node", "red", "Server disk exceed — container stopped.")
      );
    } else {
      // just notify clients
      broadcastToContainer(
        tid,
        "power",
        ansi("Node", "red", "Server disk exceed — container blocked.")
      );
    }
    return;
  }

  // if already streaming for current container, bump refCount and return
  if (logStreams.has(currentContainerId)) {
    logStreams.get(currentContainerId).refCount++;
    return;
  }

  // Attach logs and broadcast raw chunks to all clients for that tid.
  // IMPORTANT: we deliberately broadcast raw chunk strings (not JSON) to preserve existing client behavior.
  container.logs(
    { follow: true, stdout: true, stderr: true, tail: 100 },
    (err, stream) => {
      if (err)
        return sendEvent(
          ws,
          "error",
          `Failed to attach logs: ${err.message || err}`
        );

      // store stream in map
      logStreams.set(currentContainerId, {
        stream,
        refCount: (clients.get(tid) || new Set()).size,
      });

      // broadcast to all clients connected to this tid as raw text
      const onData = (chunk) => {
        const raw = chunk.toString("utf8");
        const set = clients.get(tid) || new Set();
        for (const client of set) {
          if (client.readyState === WebSocket.OPEN) {
            try {
              client.send(raw);
            } catch (e) {
              // ignore per-client send errors
            }
          }
        }
      };

      stream.on("data", onData);

      stream.on("error", (err) =>
        broadcastToContainer(tid, "error", `Log error: ${err.message}`)
      );

      stream.on("end", () => {
        // stream ended — notify clients
        broadcastToContainer(
          tid,
          "power",
          ansi("Node", "gray", "Log stream ended.")
        );
        // remove from map if present (cleanup will also handle refcounts)
        if (logStreams.has(currentContainerId))
          logStreams.delete(currentContainerId);
      });

      if (!logStreams.get(currentContainerId).stopped) {
        logStreams.get(currentContainerId).stopped = true;
      }

      // when this ws closes, let general cleanup handle refcounts and possibly destroy the stream
      ws.once("close", () => cleanupLogStreamsByKey(tid));
    }
  );
}

// Stream stats
// the guy who is unemployed
// Stream stats — now includes container uptime
async function streamStats(ws, container, requestedContainerId) {
  const resolved = findDataEntryByContainerOrTid(requestedContainerId);
  const tid = resolved ? resolved.tid : requestedContainerId;
  const currentContainerId = resolved ? resolved.entry.containerId : requestedContainerId;

  // always use current container object
  container = docker.getContainer(currentContainerId);

  addClientKey(tid, ws);

  // if interval already exists for this container id, increment refCount and return
  if (statsIntervals.has(currentContainerId)) {
    statsIntervals.get(currentContainerId).refCount++;
    return;
  }

  // helper to format seconds -> "1h 2m 3s"
  function formatUptime(seconds) {
    seconds = Math.max(0, Math.floor(seconds));
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    const parts = [];
    if (h) parts.push(`${h}h`);
    if (m) parts.push(`${m}m`);
    parts.push(`${s}s`);
    return parts.join(" ");
  }

  const intervalId = setInterval(async () => {
    const set = clients.get(tid);
    if (!set || set.size === 0) return;

    try {
      // get non-streaming stats
      const stats = await new Promise((resolve, reject) =>
        container.stats({ stream: false }, (err, s) => (err ? reject(err) : resolve(s)))
      );

      // inspect container to get StartedAt (for uptime)
      let uptimeSeconds = 0;
      let uptime = "0s";
      try {
        const info = await container.inspect();
        const startedAt = info?.State?.StartedAt;
        if (startedAt && startedAt !== "0001-01-01T00:00:00Z") {
          const startedMs = Date.parse(startedAt);
          if (!Number.isNaN(startedMs)) {
            uptimeSeconds = Math.floor((Date.now() - startedMs) / 1000);
            if (uptimeSeconds < 0) uptimeSeconds = 0;
            uptime = formatUptime(uptimeSeconds);
          }
        }
      } catch (inspectErr) {
        // ignore inspect error but include error field if needed
        // console.error("inspect error for uptime:", inspectErr.message);
      }

      // broadcast structured stats (client expects 'stats' event)
      broadcastToContainer(tid, "stats", {
        stats,
        uptimeSeconds,
        uptime, // human readable
      });
    } catch (err) {
      // if container no longer exists, cleanup this interval
      if (err && err.statusCode === 404) {
        cleanupStatsByContainerId(currentContainerId);
        return;
      }
      broadcastToContainer(tid, "error", `Stats error: ${err.message}`);
    }
  }, 2000);

  statsIntervals.set(currentContainerId, {
    intervalId,
    refCount: (clients.get(tid) || new Set()).size,
  });

  // ensure interval cleared when ws closes
  ws.on("close", () => {
    cleanupStatsByKey(tid);
  });
}

// Execute a single command inside container — block if disk exceeded
// the guy who executes /sex true
async function executeCommand(ws, container, command, requestedContainerId) {
  try {
    // resolve to tid/current container
    const resolved = findDataEntryByContainerOrTid(requestedContainerId);
    const tid = resolved ? resolved.tid : requestedContainerId;
    const currentContainerId = resolved
      ? resolved.entry.containerId
      : requestedContainerId;
    container = docker.getContainer(currentContainerId);

    const usage = await getContainerDiskUsage(tid);
    const allowed =
      resolved && resolved.entry && typeof resolved.entry.disk === "number"
        ? resolved.entry.disk
        : Infinity;
    console.log(
      `[disk-check] exec for ${currentContainerId} (tid=${tid}): usage=${usage.toFixed(
        3
      )}GB allowed=${allowed === Infinity ? "∞" : allowed}`
    );

    const info = await container.inspect().catch(() => null);
    if (usage >= allowed) {
      if (info && info.State && info.State.Running) {
        try {
          await container.kill();
        } catch (e) {}
      }
      // notify all clients for tid
      broadcastToContainer(
        tid,
        "power",
        ansi("Node", "red", "Server disk exceed — commands blocked.")
      );
      return;
    }

    const stream = await container.attach({
      stream: true,
      stdin: true,
      stdout: true,
      stderr: true,
      hijack: true,
    });
    stream.on("data", (chunk) => {
      sendEvent(ws, "cmd", chunk.toString("utf8"));
    });
    stream.on("error", (err) =>
      sendEvent(ws, "error", `Exec stream error: ${err.message}`)
    );
    stream.write(command + "\n");
    stream.end();
  } catch (err) {
    sendEvent(ws, "error", `Failed to exec command: ${err.message}`);
  }
}

//the guy who turns on ur jenny mod server
async function performPower(ws, container, action, requestedContainerId) {
  try {
    // resolve TID and entry
    const resolved = findDataEntryByContainerOrTid(requestedContainerId);
    const tid = resolved ? resolved.tid : requestedContainerId;
    const entry = resolved ? resolved.entry : null;

    if (!entry) {
      return sendEvent(ws, "error", "Data entry not found");
    }

    const currentContainerId = entry.containerId;
    container = docker.getContainer(currentContainerId);

    const usage = await getContainerDiskUsage(tid);
    const allowed = entry?.disk ?? Infinity;

    const info = await container.inspect().catch(() => null);

    if ((action === "start" || action === "restart") && usage >= allowed) {
      broadcastToContainer(
        tid,
        "power",
        ansi(
          "Node",
          "red",
          "Server disk exceed — container will not be started."
        )
      );
      return;
    }

    if (action === "start" || action === "restart") {
      broadcastToContainer(
        tid,
        "power",
        ansi("Node", "yellow", "Pulling the latest docker image...")
      );

      // CLEANUP: destroy old log streams and stats bound to the previous container id
      if (currentContainerId) {
        cleanupLogStreamsByContainerId(currentContainerId);
        cleanupStatsByContainerId(currentContainerId);
      }

      // recreate the container (pull -> create -> start) and update data.json
      const newContainer = await recreateContainer(tid);

      // attach logs for all connected clients (this will create a fresh log stream)
      for (const c of clients.get(tid) || []) {
        streamLogs(c, newContainer, newContainer.id);
      }

      // attach stats for all connected clients (fresh interval)
      for (const c of clients.get(tid) || []) {
        streamStats(c, newContainer, newContainer.id);
      }

      broadcastToContainer(
        tid,
        "power",
        ansi("Node", "green", "Starting the container.")
      );
    } else if (action === "stop") {
      if (!info?.State?.Running) {
        sendEvent(
          ws,
          "power",
          ansi("Node", "red", "Container already stopped.")
        );
        return;
      }
      await container.kill();
      broadcastToContainer(
        tid,
        "power",
        ansi("Node", "red", "Container stopped.")
      );
    }
  } catch (err) {
    sendEvent(ws, "error", `Power action failed: ${err.message}`);
  }
}

// the guy who wait for you for no reason hes unemployed anyways
async function waitForRunning(container, ws) {
  const resolved = findDataEntryByContainerOrTid(container.id);
  const tid = resolved ? resolved.tid : container.id;

  let info;
  try {
    for (let attempts = 0; attempts < 20; attempts++) {
      try {
        info = await container.inspect();
        if (info.State && info.State.Running) break;
      } catch (err) {
        console.error("waitForRunning inspect failed:", err.message);
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    if (!info || !info.State.Running) {
      broadcastToContainer(
        tid,
        "error",
        "Container failed to reach running state."
      );
      return;
    }

    // Attach logs safely
    for (const c of clients.get(tid) || []) {
      try {
        streamLogs(c, container, container.id);
      } catch (err) {
        console.error("Failed to stream logs:", err);
      }
    }
  } catch (err) {
    console.error("waitForRunning fatal error:", err);
  }
}

// the guy who is a guy
const AUTH_TIMEOUT = 5000;
wss.on("connection", (ws) => {
  ws.isAuthenticated = false;
  ws.isAlive = true;

  const authTimer = setTimeout(() => {
    if (!ws.isAuthenticated) ws.terminate();
  }, AUTH_TIMEOUT);
  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return sendEvent(ws, "error", "Invalid JSON");
    }

    if (!ws.isAuthenticated) {
      if (msg.event === "auth" && msg.payload?.key === config.key) {
        ws.isAuthenticated = true;
        clearTimeout(authTimer);
        return sendEvent(ws, "auth", { success: true });
      } else {
        ws.close(1008, "Unauthorized");
        return;
      }
    }

    const { event, payload } = msg;
    const providedContainerId = payload?.containerId;
    if (!providedContainerId)
      return sendEvent(ws, "error", "containerId required");

    // validation
    if (
      typeof providedContainerId !== "string" ||
      !/^[a-zA-Z0-9_.-]+$/.test(providedContainerId)
    )
      return sendEvent(ws, "error", "Invalid containerId");

    // Resolve TID + authoritative current containerId before calling handlers.
    const resolved = findDataEntryByContainerOrTid(providedContainerId);
    const tid = resolved ? resolved.tid : providedContainerId;
    const currentContainerId = resolved
      ? resolved.entry.containerId
      : providedContainerId;
    const container = docker.getContainer(currentContainerId);

    try {
      switch (event) {
        case "logs":
          await streamLogs(ws, container, providedContainerId);
          break;
        case "stats":
          await streamStats(ws, container, providedContainerId);
          break;
        case "cmd":
          await executeCommand(
            ws,
            container,
            payload.command,
            providedContainerId
          );
          break;
        case "power:start":
        case "power:stop":
        case "power:restart":
          await performPower(
            ws,
            container,
            event.split(":")[1],
            providedContainerId
          );
          break;
        default:
          sendEvent(ws, "error", "Unknown event");
      }
    } catch (err) {
      sendEvent(ws, "error", `Handler error: ${err.message}`);
    }
  });

  ws.on("close", () => removeClient(ws));
  ws.on("error", () => removeClient(ws));
});

// Heartbeat ehh? these guys have heartbeat, we dont even have a heart
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    try {
      ws.ping();
    } catch (e) {}
  });
}, 30000);

// HTTP upgrade, like your blowjob going to missionary
server.on("upgrade", (req, socket, head) =>
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req))
);

// REST routes, these are employed by mucrosuft cumpany
app.get("/health", async (req, res) => {
  const dockerRunning = await isDockerRunning();
  res.json({
    status: dockerRunning ? "online" : "dockernotrunning",
    uptime: process.uptime(),
    node: "alive",
  });
});
app.get("/version", async (req, res) => {
  const version = "0.1-alpha-dev";
  res.json({ version });
});
app.get("/stats", (req, res) => {
  try {
    const totalRam = os.totalmem();
    const freeRam = os.freemem();
    const cpus = os.cpus();
    const load = os.loadavg(); // 1, 5, 15 minutes
    const uptime = os.uptime(); // seconds

    res.json({
      stats: {
        totalRamGB: (totalRam / 1e9).toFixed(2),
        usedRamGB: ((totalRam - freeRam) / 1e9).toFixed(2),
        totalCpuCores: cpus.length,
        cpuModel: cpus[0]?.model || "unknown",
        cpuSpeed: cpus[0]?.speed || "unknown",
        osType: os.type(),
        osPlatform: os.platform(),
        osArch: os.arch(),
        osRelease: os.release(),
        uptime: `${Math.floor(uptime / 3600)}h ${Math.floor(
          (uptime % 3600) / 60
        )}m`,
        load1: load[0].toFixed(2),
        load5: load[1].toFixed(2),
        load15: load[2].toFixed(2),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// start, setup the goon chair jarvis
server.listen(config.port, () =>
  console.log("Talorix API + WS running on port " + config.port)
);

// YOU FELL FOR IT LIKE A FUCKING STUPID FISH
