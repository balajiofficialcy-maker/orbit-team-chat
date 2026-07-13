// Tiny file-based database. No native modules, no external DB server needed.
// Everything lives in data/db.json so the whole app runs with `npm install && npm start`.
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'db.json');

const DEFAULT_DATA = {
  users: [],       // { id, username, passwordHash, color, createdAt }
  servers: [],      // { id, name, inviteCode, ownerId, createdAt }
  members: [],      // { serverId, userId, role }
  channels: [],      // { id, serverId, name, createdAt }
  messages: [],       // { id, channelId, userId, content, createdAt }
  dms: [],              // { id, participants: [userId, userId], createdAt }
  dmMessages: []          // { id, conversationId, userId, content, createdAt }
};

function ensureFile() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify(DEFAULT_DATA, null, 2));
  }
}

function read() {
  ensureFile();
  const raw = fs.readFileSync(DB_PATH, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    return JSON.parse(JSON.stringify(DEFAULT_DATA));
  }
}

function write(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// Simple mutex-ish queue so rapid concurrent writes don't clobber each other
let queue = Promise.resolve();
function transact(fn) {
  queue = queue.then(() => {
    const data = read();
    const result = fn(data);
    write(data);
    return result;
  });
  return queue;
}

module.exports = { read, write, transact };
