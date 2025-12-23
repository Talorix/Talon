#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

// Path to root config.json
const configPath = path.join(__dirname, '..', 'config.json');

// Read existing config or create empty
let config = {};
if (fs.existsSync(configPath)) {
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (err) {
    console.error('Error parsing config.json, starting with empty config.');
    config = {};
  }
}

// Helper to get CLI arguments
const args = process.argv.slice(2);
const getArg = (name) => {
  const index = args.indexOf(`--${name}`);
  return index !== -1 ? args[index + 1] : undefined;
};

// Read CLI arguments
const key = getArg('key');
const panel = getArg('panel');
const port = getArg('port');

// At least one argument should be provided
if (!key && !panel && !port) {
  console.error('Usage: npm run configure -- [--key {key}] [--panel {panelUrl}] [--port {port}]');
  process.exit(1);
}

if (key) config.key = key;
if (panel) config.panel = panel;
if (port) config.port = port;

fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log('Configuration have been updated successfully!');
console.log(config);
