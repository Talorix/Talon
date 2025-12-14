// Alpha Release v1, Report bugs to ma5z_
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const Docker = require("dockerode");
const docker = new Docker();
const os = require('os');


const ar = require('./backend/server/deploy.js');
const br = require('./backend/server/info.js');
const cr = require('./backend/server/action.js');
const dr = require('./backend/server/delete.js');
const er = require('./backend/server/filesystem.js');
const fr = require('./backend/server/reinstall.js');

const app = express();
app.use(express.json());

const config = require('./config.json');

// --- Helper: Check if Docker is running ---
async function isDockerRunning() {
  try { await docker.ping(); return true; } 
  catch { return false; }
}

// --- API Key Middleware ---
app.use((req, res, next) => {
  if (req.query.key !== config.key) return res.status(401).json({ error: 'Invalid key' });
  next();
});

// --- REST routers ---
app.use('/server', ar);
app.use('/server', br);
app.use('/server', cr);
app.use('/server', dr);
app.use('/server/fs', er);
app.use('/server', fr);

// --- HTTP server ---
const server = http.createServer(app);

// --- WebSocket server ---
const wss = new WebSocket.Server({ noServer: true });
const clients = {}; // connected clients per container

wss.on('connection', ws => {
  ws.isAuthenticated = false;

  ws.on('message', async message => {
    let data;
    try { data = JSON.parse(message); } 
    catch { return ws.send(JSON.stringify({ event: 'error', payload: 'Invalid JSON' })); }

    // --- Authenticate ---
    if (!ws.isAuthenticated) {
      if (data.event === 'auth' && data.payload?.key === config.key) {
        ws.isAuthenticated = true;
        ws.send(JSON.stringify({ event: 'auth', success: true }));
        return;
      } else {
        ws.close(1008, "Unauthorized");
        return;
      }
    }

    const { event, payload } = data;
    if (!payload?.containerId) return ws.send(JSON.stringify({ event: 'error', payload: 'containerId is required' }));

    const container = docker.getContainer(payload.containerId);

    switch (event) {
      case 'logs': streamLogs(ws, container, payload.containerId); break;
      case 'stats': streamStats(ws, container, payload.containerId); break;
      case 'cmd': executeCommand(ws, container, payload.command); break;
      case 'power:start': case 'power:stop': case 'power:restart':
        performPower(ws, container, event.split(':')[1]);
        break;
      default: ws.send(JSON.stringify({ event: 'error', payload: 'Unknown event' }));
    }
  });

  ws.on('close', () => {
    Object.values(clients).forEach(arr => {
      const idx = arr.indexOf(ws);
      if (idx !== -1) arr.splice(idx, 1);
    });
  });

  ws.on('error', err => console.error('WS Error:', err));
});

// --- Upgrade HTTP to WebSocket ---
server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

// --- WebSocket helpers ---
function addClient(containerId, ws) {
  if (!clients[containerId]) clients[containerId] = [];
  clients[containerId].push(ws);
}

function streamLogs(ws, container, containerId) {
  addClient(containerId, ws);

  container.logs(
    {
      follow: true,
      stdout: true,
      stderr: true,
      tail: 100,
    },
    (err, stream) => {
      if (err) {
        ws.send(JSON.stringify({ event: 'error', payload: err.message }));
        return;
      }

      stream.on('data', chunk => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(chunk.toString('utf8'));
        }
      });

      stream.on('error', err => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ event: 'error', payload: err.message }));
        }
      });

      ws.on('close', () => {
        stream.destroy();
      });
    }
  );
}


async function streamStats(ws, container, containerId) {
  addClient(containerId, ws);

  const interval = setInterval(async () => {
    if (ws.readyState !== WebSocket.OPEN) return clearInterval(interval);

    try {
      // Fetch stats
      const stats = await new Promise((resolve, reject) => {
        container.stats({ stream: false }, (err, s) => err ? reject(err) : resolve(s));
      });

      // Fetch status
      const containerInfo = await container.inspect();
      const status = containerInfo.State.Status; // e.g., "running", "exited"

      ws.send(JSON.stringify({
        event: 'stats',
        payload: {
          stats,
        }
      }));

    } catch (err) {
      ws.send(JSON.stringify({ event: 'error', payload: err.message }));
    }
  }, 2000);

  ws.on('close', () => clearInterval(interval));
}

async function executeCommand(ws, container, command) {
  try {
    const stream = await container.attach({
      stream: true,
      stdin: true,
      stdout: true,
      stderr: false,
      hijack: true,
    });

    stream.on("data", chunk => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ event: 'cmd', payload: chunk.toString('utf8') }));
      }
    });

    stream.on("error", err => {
      ws.send(JSON.stringify({ event: 'error', payload: err.message }));
    });

    stream.write(command + "\n");
    stream.end();
  } catch (err) {
    ws.send(JSON.stringify({ event: 'error', payload: err.message }));
  }
}

async function performPower(ws, container, action) {
  try {
    const info = await container.inspect();

    if (action === "start") {
      if (info.State.Running) return ws.send(JSON.stringify({ event: 'power', payload: 'Container already running' }));
      await container.start();
      ws.send(JSON.stringify({ event: 'power', payload: 'Container started' }));
      waitForRunning(container, ws);

    } else if (action === "stop") {
      if (!info.State.Running) return ws.send(JSON.stringify({ event: 'power', payload: 'Container already stopped' }));
      await container.kill();
      ws.send(JSON.stringify({ event: 'power', payload: 'Container stopped' }));

    } else if (action === "restart") {
      await container.restart();
      ws.send(JSON.stringify({ event: 'power', payload: 'Container restarted' }));
      waitForRunning(container, ws);

    } else throw new Error("Invalid power action");

  } catch (err) { ws.send(JSON.stringify({ event: 'error', payload: err.message })); }
}

async function waitForRunning(container, ws) {
  try {
    let info;
    do { await new Promise(r => setTimeout(r, 500)); info = await container.inspect(); }
    while (!info.State.Running);
    streamLogs(ws, container, container.id);
  } catch (err) { ws.send(JSON.stringify({ event: 'error', payload: `Failed to attach logs: ${err.message}` })); }
}

// --- REST endpoints ---
app.get('/health', async (req, res) => {
  const dockerRunning = await isDockerRunning();
  res.json({ status: dockerRunning ? "online" : "dockernotrunning", uptime: process.uptime(), node: "alive" });
});

app.get('/stats', async (req, res) => {
  try {
    const totalRam = os.totalmem();
    const freeRam = os.freemem();
    const usedRam = totalRam - freeRam;
    const totalCpu = os.cpus().length;
    res.json({ totalRamGB: (totalRam/1e9).toFixed(2), usedRamGB: (usedRam/1e9).toFixed(2), totalCpuCores: totalCpu });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Start server ---
server.listen(3000, () => console.log('Talorix API + WS running on port 3000'));
