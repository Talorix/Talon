// index.js — Talorix API + WS (cleaned + fixed disk-check + consistent events)
// Alpha Release v1, Report bugs to ma5z_

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const Docker = require("dockerode");
const docker = new Docker();
const os = require("os");
const path = require("path");
const fsPromises = require("fs").promises;

const ar = require("./backend/server/deploy.js");
const br = require("./backend/server/info.js");
const cr = require("./backend/server/action.js");
const dr = require("./backend/server/delete.js");
const er = require("./backend/server/filesystem.js");
const fr = require("./backend/server/reinstall.js");

const data = require("./data.json");
const config = require("./config.json");

const app = express();
app.use(express.json());

// ANSI helpers (for payloads)
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

// HTTP + WS server
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

// Client/stream bookkeeping
const clients = new Map(); // map TID/containerId -> Set(ws)
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
  // if passed a TID key that exists directly in data.json
  if (data[containerOrTid])
    return { tid: containerOrTid, entry: data[containerOrTid] };

  // try to find by containerId value
  const found = Object.entries(data).find(
    ([tid, entry]) => entry.containerId === containerOrTid
  );
  if (found) return { tid: found[0], entry: found[1] };

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

function broadcastToContainer(containerIdOrTid, event, payload) {
  // When broadcasting we allow containerId or TID as the key used in clients map
  const set = clients.get(containerIdOrTid) || new Set();
  for (const ws of set) sendEvent(ws, event, payload);
}

function addClientKey(key, ws) {
  // key should be the containerId or TID the client will use consistently
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

function cleanupLogStreamsByKey(key) {
  // logStreams map is keyed by containerId (Docker ID). We will attempt both lookups.
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
  // try to find by data.json mapping (if key is TID)
  const resolved = findDataEntryByContainerOrTid(key);
  if (resolved) {
    const { entry } = resolved;
    const cid = entry.containerId;
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
// Stream logs: we send log lines as JSON events 'cmd' so client handles them in the cmd branch.
async function streamLogs(ws, container, containerId) {
  // containerId is Docker container ID, clients may have registered with the TID or containerId key
  const resolved = findDataEntryByContainerOrTid(containerId);
  const tid = resolved ? resolved.tid : containerId;

  // Disk check BEFORE attaching logs
  const usage = await getContainerDiskUsage(containerId);
  const allowed =
    resolved && resolved.entry && typeof resolved.entry.disk === "number"
      ? resolved.entry.disk
      : Infinity;
  console.log(
    `[disk-check] streamLogs for ${containerId} (tid=${tid}): usage=${usage.toFixed(
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

  // if already streaming, increase refCount and return
  if (logStreams.has(containerId)) {
    logStreams.get(containerId).refCount++;
    return;
  }

  // Attach logs and broadcast 'cmd' events
  container.logs(
    { follow: true, stdout: true, stderr: true, tail: 100 },
    (err, stream) => {
      if (err)
        return sendEvent(
          ws,
          "error",
          `Failed to attach logs: ${err.message || err}`
        );

      logStreams.set(containerId, {
        stream,
        refCount: (clients.get(tid) || new Set()).size,
      });

       stream.on("data", (chunk) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(chunk.toString("utf8"));
        }
      });


      stream.on("error", (err) =>
        broadcastToContainer(tid, "error", `Log error: ${err.message}`)
      );
      if (!logStreams.get(containerId).stopped) {
        broadcastToContainer(tid, "power", ansi("Node", "yellow", "Server marked as stopped"));
        logStreams.get(containerId).stopped = true;
      }


      ws.once("close", () => cleanupLogStreamsByKey(tid));
    }
  );
}

// Stream stats (reused interval per container)
async function streamStats(ws, container, containerId) {
  const resolved = findDataEntryByContainerOrTid(containerId);
  const tid = resolved ? resolved.tid : containerId;

  addClientKey(tid, ws);
  if (statsIntervals.has(containerId)) {
    statsIntervals.get(containerId).refCount++;
    return;
  }

  const intervalId = setInterval(async () => {
    // if nobody listening, let the key cleanup handle it
    const set = clients.get(tid);
    if (!set || set.size === 0) return;

    try {
      const stats = await new Promise((resolve, reject) =>
        container.stats({ stream: false }, (err, s) =>
          err ? reject(err) : resolve(s)
        )
      );
      // broadcast structured stats (client expects 'stats' event)
      broadcastToContainer(tid, "stats", { stats });
    } catch (err) {
      broadcastToContainer(tid, "error", `Stats error: ${err.message}`);
    }
  }, 2000);

  statsIntervals.set(containerId, {
    intervalId,
    refCount: (clients.get(tid) || new Set()).size,
  });
  ws.on("close", () => clearInterval(intervalId));
}

// Execute a single command inside container — block if disk exceeded
async function executeCommand(ws, container, command) {
  const containerId = container.id;
  const resolved = findDataEntryByContainerOrTid(containerId);
  const tid = resolved ? resolved.tid : containerId;

  const usage = await getContainerDiskUsage(containerId);
  const allowed =
    resolved && resolved.entry && typeof resolved.entry.disk === "number"
      ? resolved.entry.disk
      : Infinity;
  console.log(
    `[disk-check] exec for ${containerId} (tid=${tid}): usage=${usage.toFixed(
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

  try {
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

async function performPower(ws, container, action, containerId) {
  const resolved = findDataEntryByContainerOrTid(containerId);
  const tid = resolved ? resolved.tid : containerId;

  const usage = await getContainerDiskUsage(containerId);
  const allowed =
    resolved?.entry?.disk ?? Infinity;

  const info = await container.inspect().catch(() => null);

  if ((action === "start" || action === "restart") && usage >= allowed) {
    broadcastToContainer(
      tid,
      "power",
      ansi("Node", "red", "Server disk exceed — container will not be started.")
    );
    return;
  }

  try {
    if (action === "start") {
      if (info?.State?.Running) {
        sendEvent(ws, "power", ansi("Node", "green", "Container already running."));
        return;
      }
      broadcastToContainer(tid, "power", ansi("Node", "yellow", "Starting container..."));
      await container.start();
      logStreams.delete(container.id);
      await waitForRunning(container, ws);
      

      // Attach logs for all clients after start
      for (const c of clients.get(tid) || []) {
        streamLogs(c, container, container.id, true); // `true` = force attach without disk check
      }

    } else if (action === "restart") {
      broadcastToContainer(tid, "power", ansi("Node", "yellow", "Restarting container..."));
      await container.restart();
      logStreams.delete(container.id);
      await waitForRunning(container, ws);

      for (const c of clients.get(tid) || []) {
        streamLogs(c, container, container.id, true);
      }

    } else if (action === "stop") {
      if (!info?.State?.Running) {
        sendEvent(ws, "power", ansi("Node", "red", "Container already stopped."));
        return;
      }
      await container.kill();
      broadcastToContainer(tid, "power", ansi("Node", "red", "Container stopped."));
    }
  } catch (err) {
    sendEvent(ws, "error", `Power action failed: ${err.message}`);
  }
}
async function waitForRunning(container, ws) {
  try {
    let info;
    do {
      await new Promise((r) => setTimeout(r, 500));
      info = await container.inspect();
    } while (!info.State.Running);

    const resolved = findDataEntryByContainerOrTid(container.id);
    const tid = resolved ? resolved.tid : container.id;

    for (const c of clients.get(tid) || []) {
      streamLogs(c, container, container.id);
    }
  } catch (err) {
    ws.send(
      JSON.stringify({
        event: "error",
        payload: `Failed to attach logs: ${err.message}`,
      })
    );
  }
}

// WebSocket connection lifecycle
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
    const containerId = payload?.containerId;
    if (!containerId) return sendEvent(ws, "error", "containerId required");

    // validation
    if (
      typeof containerId !== "string" ||
      !/^[a-zA-Z0-9_.-]+$/.test(containerId)
    )
      return sendEvent(ws, "error", "Invalid containerId");

    const container = docker.getContainer(containerId);

    try {
      switch (event) {
        case "logs":
          await streamLogs(ws, container, containerId);
          break;
        case "stats":
          await streamStats(ws, container, containerId);
          break;
        case "cmd":
          await executeCommand(ws, container, payload.command);
          break;
        case "power:start":
        case "power:stop":
        case "power:restart":
          await performPower(ws, container, event.split(":")[1], containerId);
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

// Heartbeat
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    try {
      ws.ping();
    } catch (e) {}
  });
}, 30000);

// HTTP upgrade
server.on("upgrade", (req, socket, head) =>
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req))
);

// REST routes
app.get("/health", async (req, res) => {
  const dockerRunning = await isDockerRunning();
  res.json({
    status: dockerRunning ? "online" : "dockernotrunning",
    uptime: process.uptime(),
    node: "alive",
  });
});
app.get("/stats", (req, res) => {
  try {
    const totalRam = os.totalmem();
    const freeRam = os.freemem();
    res.json({
      totalRamGB: (totalRam / 1e9).toFixed(2),
      usedRamGB: ((totalRam - freeRam) / 1e9).toFixed(2),
      totalCpuCores: os.cpus().length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// start
server.listen(3000, () => console.log("Talorix API + WS running on port 3000"));
