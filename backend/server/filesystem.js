const express = require('express');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const router = express.Router();
const multer = require('multer');

const DATA_DIR = path.resolve(__dirname, '../../data');
const upload = multer({ storage: multer.memoryStorage() });

// Utility to resolve a path safely within a container's data folder
function resolvePath(idt, relPath) {
  const base = path.join(DATA_DIR, idt);
  const fullPath = path.join(base, relPath);
  if (!fullPath.startsWith(base)) {
    throw new Error('Invalid path'); // Prevent path traversal
  }
  return fullPath;
}

async function getFolderSize(folderPath) {
  let total = 0;
  const items = await fsPromises.readdir(folderPath, { withFileTypes: true });
  for (const item of items) {
    const itemPath = path.join(folderPath, item.name);
    if (item.isDirectory()) {
      total += await getFolderSize(itemPath); // recursive
    } else {
      const stats = await fsPromises.stat(itemPath);
      total += stats.size;
    }
  }
  return total;
}

router.get('/:idt/files', async (req, res) => {
  const { idt } = req.params;
  const relPath = req.query.path || '/';
  try {
    const dirPath = resolvePath(idt, relPath);
    const items = await fsPromises.readdir(dirPath, { withFileTypes: true });

    const result = await Promise.all(items.map(async (item) => {
      const itemPath = path.join(dirPath, item.name);
      let size = null;
      if (item.isFile()) {
        const stats = await fsPromises.stat(itemPath);
        size = stats.size;
      } else if (item.isDirectory()) {
        size = await getFolderSize(itemPath);
      }

      const stats = await fsPromises.stat(itemPath);
      return {
        name: item.name,
        type: item.isDirectory() ? 'folder' : 'file',
        createdAt: stats.birthtime,
        size,
        extension: item.isFile() ? path.extname(item.name) : null
      };
    }));

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create new file
router.post('/:idt/file/new', async (req, res) => {
  const { idt } = req.params;
  const relPath = req.query.path || '/';
  const { content = '', filename } = req.body;
  if (!filename) return res.status(400).json({ error: 'filename is required' });

  try {
    const filePath = resolvePath(idt, path.join(relPath, filename));
    await fsPromises.writeFile(filePath, content, 'utf8');
    res.json({ message: 'File created', location: filePath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create new folder
router.post('/:idt/folder/new', async (req, res) => {
  const { idt } = req.params;
  const relPath = req.query.path || '/';
  const { filename } = req.body;
  if (!filename) return res.status(400).json({ error: 'filename is required' });

  try {
    const folderPath = resolvePath(idt, path.join(relPath, filename));
    await fsPromises.mkdir(folderPath, { recursive: true });
    res.json({ message: 'Folder created', location: folderPath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get file content
router.get('/:idt/file/content', async (req, res) => {
  const { idt } = req.params;
  const relPath = req.query.location;
  if (!relPath) return res.status(400).json({ error: 'location query param is required' });

  try {
    const filePath = resolvePath(idt, relPath);
    const content = await fsPromises.readFile(filePath, 'utf8');
    res.json({ content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete file
router.delete('/:idt/file/delete', async (req, res) => {
  const { idt } = req.params;
  const relPath = req.query.location;
  if (!relPath) return res.status(400).json({ error: 'location query param is required' });

  try {
    const filePath = resolvePath(idt, relPath);
    await fsPromises.unlink(filePath);
    res.json({ message: 'File deleted', location: filePath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete folder
router.delete('/:idt/folder/delete', async (req, res) => {
  const { idt } = req.params;
  const relPath = req.query.location;
  if (!relPath) return res.status(400).json({ error: 'location query param is required' });

  try {
    const folderPath = resolvePath(idt, relPath);
    await fsPromises.rm(folderPath, { recursive: true, force: true });
    res.json({ message: 'Folder deleted', location: folderPath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Rename file
router.post('/:idt/file/rename', async (req, res) => {
  const { idt } = req.params;
  const { location, newName } = req.body;
  if (!location) return res.status(400).json({ error: 'location is required' });
  if (!newName) return res.status(400).json({ error: 'newName is required' });

  try {
    const oldPath = resolvePath(idt, location);
    const dir = path.dirname(location); // <- relative, not absolute
    const newPath = resolvePath(idt, path.join(dir, newName));

    await fsPromises.rename(oldPath, newPath);
    res.json({ message: 'File renamed', oldLocation: location, newLocation: path.join(dir, newName) });
  } catch (err) {
    console.log(err);
    res.status(500).json({ error: err.message });
  }
});

// Rename folder
router.post('/:idt/folder/rename', async (req, res) => {
  const { idt } = req.params;
  const { location, newName } = req.body;
  if (!location) return res.status(400).json({ error: 'location is required' });
  if (!newName) return res.status(400).json({ error: 'newName is required' });

  try {
    const oldPath = resolvePath(idt, location);
    const dir = path.dirname(location); // <- relative, not absolute
    const newPath = resolvePath(idt, path.join(dir, newName));

    await fsPromises.rename(oldPath, newPath);
    res.json({ message: 'Folder renamed', oldLocation: location, newLocation: path.join(dir, newName) });
  } catch (err) {
    console.log(err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/:idt/file/upload', upload.single('file'), async (req, res) => {
  const { idt } = req.params;
  const relPath = req.query.path || '/'; 

  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  try {
    // Resolve full path inside container
    const uploadPath = resolvePath(idt, path.join(relPath, req.file.originalname));

    // Write file from buffer
    await fsPromises.writeFile(uploadPath, req.file.buffer);

    res.json({ message: 'File uploaded', location: uploadPath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
module.exports = router;
