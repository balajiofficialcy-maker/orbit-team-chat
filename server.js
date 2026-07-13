const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { Server } = require('socket.io');
const multer = require('multer');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const UPLOAD_DIR = path.join(__dirname, 'data', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).slice(0, 8);
      cb(null, `${uuidv4()}${ext}`);
    }
  }),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_IMAGE_TYPES.includes(file.mimetype)) return cb(new Error('Only image files are allowed'));
    cb(null, true);
  }
});

const PORT = process.env.PORT || 3000;
// Random secret generated at boot. Fine for a hackathon deployment where the
// server process stays up; set JWT_SECRET env var yourself for production use.
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

const AVATAR_COLORS = ['#7C5CFC', '#00E5FF', '#FF6B9D', '#5CE1E6', '#FFB84C', '#6BFFA0', '#C77DFF'];
function pickColor() { return AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)]; }

function makeInviteCode() {
  return crypto.randomBytes(4).toString('hex'); // 8 chars, e.g. "a1b2c3d4"
}

function publicUser(u) {
  return { id: u.id, username: u.username, color: u.color, createdAt: u.createdAt };
}

function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
}

// ---------- Middleware ----------
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.id;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function isMember(data, serverId, userId) {
  return data.members.some(m => m.serverId === serverId && m.userId === userId);
}

// ---------- Auth routes ----------
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });
  if (username.length < 3 || username.length > 20) return res.status(400).json({ error: 'Username must be 3-20 characters' });
  if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });

  const data = db.read();
  if (data.users.some(u => u.username.toLowerCase() === username.toLowerCase())) {
    return res.status(409).json({ error: 'That username is already taken' });
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const user = {
    id: uuidv4(),
    username,
    passwordHash,
    color: pickColor(),
    createdAt: new Date().toISOString()
  };
  await db.transact(d => { d.users.push(user); });

  const token = signToken(user);
  res.json({ token, user: publicUser(user) });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });

  const data = db.read();
  const user = data.users.find(u => u.username.toLowerCase() === username.toLowerCase());
  if (!user) return res.status(401).json({ error: 'Invalid username or password' });
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Invalid username or password' });

  const token = signToken(user);
  res.json({ token, user: publicUser(user) });
});

app.get('/api/me', authMiddleware, (req, res) => {
  const data = db.read();
  const user = data.users.find(u => u.id === req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user: publicUser(user) });
});

// ---------- Server (team space) routes ----------
app.get('/api/servers', authMiddleware, (req, res) => {
  const data = db.read();
  const myServerIds = data.members.filter(m => m.userId === req.userId).map(m => m.serverId);
  const servers = data.servers
    .filter(s => myServerIds.includes(s.id))
    .map(s => ({
      ...s,
      channels: data.channels.filter(c => c.serverId === s.id),
      memberCount: data.members.filter(m => m.serverId === s.id).length
    }));
  res.json({ servers });
});

app.post('/api/servers', authMiddleware, (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Server name is required' });

  const data = db.read();
  const server = {
    id: uuidv4(),
    name: name.trim().slice(0, 40),
    inviteCode: makeInviteCode(),
    ownerId: req.userId,
    createdAt: new Date().toISOString()
  };
  const generalChannel = { id: uuidv4(), serverId: server.id, name: 'general', createdAt: new Date().toISOString() };
  const ideasChannel = { id: uuidv4(), serverId: server.id, name: 'ideas', createdAt: new Date().toISOString() };

  db.transact(d => {
    d.servers.push(server);
    d.channels.push(generalChannel, ideasChannel);
    d.members.push({ serverId: server.id, userId: req.userId, role: 'owner' });
  }).then(() => {
    res.json({ server: { ...server, channels: [generalChannel, ideasChannel], memberCount: 1 } });
  });
});

app.post('/api/servers/join', authMiddleware, (req, res) => {
  const { inviteCode } = req.body || {};
  if (!inviteCode) return res.status(400).json({ error: 'Invite code is required' });

  const data = db.read();
  const server = data.servers.find(s => s.inviteCode.toLowerCase() === String(inviteCode).trim().toLowerCase());
  if (!server) return res.status(404).json({ error: 'No team found with that invite code' });

  if (isMember(data, server.id, req.userId)) {
    return res.json({ server: { ...server, channels: data.channels.filter(c => c.serverId === server.id) } });
  }

  db.transact(d => { d.members.push({ serverId: server.id, userId: req.userId, role: 'member' }); }).then(() => {
    const fresh = db.read();
    io.to(`server:${server.id}`).emit('member_joined', { serverId: server.id });
    res.json({
      server: {
        ...server,
        channels: fresh.channels.filter(c => c.serverId === server.id),
        memberCount: fresh.members.filter(m => m.serverId === server.id).length
      }
    });
  });
});

app.get('/api/servers/:id/members', authMiddleware, (req, res) => {
  const data = db.read();
  if (!isMember(data, req.params.id, req.userId)) return res.status(403).json({ error: 'Not a member of this team' });
  const memberIds = data.members.filter(m => m.serverId === req.params.id).map(m => m.userId);
  const members = data.users.filter(u => memberIds.includes(u.id)).map(publicUser);
  res.json({ members });
});

app.post('/api/servers/:id/channels', authMiddleware, (req, res) => {
  const { name } = req.body || {};
  const data = db.read();
  if (!isMember(data, req.params.id, req.userId)) return res.status(403).json({ error: 'Not a member of this team' });
  if (!name || !name.trim()) return res.status(400).json({ error: 'Channel name is required' });

  const channel = {
    id: uuidv4(),
    serverId: req.params.id,
    name: name.trim().toLowerCase().replace(/\s+/g, '-').slice(0, 30),
    createdAt: new Date().toISOString()
  };
  db.transact(d => { d.channels.push(channel); }).then(() => {
    io.to(`server:${req.params.id}`).emit('channel_created', { channel });
    res.json({ channel });
  });
});

// ---------- Messages ----------
app.get('/api/channels/:id/messages', authMiddleware, (req, res) => {
  const data = db.read();
  const channel = data.channels.find(c => c.id === req.params.id);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  if (!isMember(data, channel.serverId, req.userId)) return res.status(403).json({ error: 'Not a member of this team' });

  const messages = data.messages
    .filter(m => m.channelId === req.params.id)
    .slice(-100)
    .map(m => {
      const user = data.users.find(u => u.id === m.userId);
      return { ...m, username: user ? user.username : 'unknown', color: user ? user.color : '#888' };
    });
  res.json({ messages });
});

// ---------- Image uploads ----------
app.post('/api/upload', authMiddleware, (req, res) => {
  upload.single('image')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
    if (!req.file) return res.status(400).json({ error: 'No image provided' });
    res.json({ url: `/uploads/${req.file.filename}` });
  });
});

// ---------- Direct Messages ----------
function dmRoomId(userA, userB) {
  return [userA, userB].sort().join('__dm__');
}

app.get('/api/dms', authMiddleware, (req, res) => {
  const data = db.read();
  const myDms = data.dms || [];
  const conversations = myDms.filter(d => d.participants.includes(req.userId));
  const result = conversations.map(c => {
    const otherId = c.participants.find(p => p !== req.userId);
    const other = data.users.find(u => u.id === otherId);
    return { id: c.id, otherUser: other ? publicUser(other) : null };
  });
  res.json({ conversations: result });
});

app.post('/api/dms/start', authMiddleware, (req, res) => {
  const { userId: targetId } = req.body || {};
  if (!targetId || targetId === req.userId) return res.status(400).json({ error: 'Invalid target user' });

  const data = db.read();
  const target = data.users.find(u => u.id === targetId);
  if (!target) return res.status(404).json({ error: 'User not found' });

  const roomId = dmRoomId(req.userId, targetId);

  db.transact(d => {
    if (!d.dms) d.dms = [];
    if (!d.dms.find(x => x.id === roomId)) {
      d.dms.push({ id: roomId, participants: [req.userId, targetId], createdAt: new Date().toISOString() });
    }
  }).then(() => {
    res.json({ conversation: { id: roomId, otherUser: publicUser(target) } });
  });
});

app.get('/api/dms/:id/messages', authMiddleware, (req, res) => {
  const data = db.read();
  const convo = (data.dms || []).find(d => d.id === req.params.id);
  if (!convo || !convo.participants.includes(req.userId)) return res.status(403).json({ error: 'Not part of this conversation' });

  const messages = (data.dmMessages || [])
    .filter(m => m.conversationId === req.params.id)
    .slice(-100)
    .map(m => {
      const user = data.users.find(u => u.id === m.userId);
      return { ...m, username: user ? user.username : 'unknown', color: user ? user.color : '#888' };
    });
  res.json({ messages });
});

// Search users to start a DM with
app.get('/api/users/search', authMiddleware, (req, res) => {
  const q = String(req.query.q || '').toLowerCase().trim();
  if (!q) return res.json({ users: [] });
  const data = db.read();
  const matches = data.users
    .filter(u => u.id !== req.userId && u.username.toLowerCase().includes(q))
    .slice(0, 8)
    .map(publicUser);
  res.json({ users: matches });
});

// ---------- Socket.io realtime ----------
const onlineUsers = new Map(); // userId -> Set of socketIds
const voiceRooms = new Map(); // serverId -> Map(socketId -> { userId, username, color })

function voiceRoomList(serverId) {
  const room = voiceRooms.get(serverId);
  if (!room) return [];
  return Array.from(room.entries()).map(([socketId, info]) => ({ socketId, ...info }));
}

function leaveVoiceRoom(socket) {
  for (const [serverId, room] of voiceRooms.entries()) {
    if (room.has(socket.id)) {
      room.delete(socket.id);
      if (room.size === 0) voiceRooms.delete(serverId);
      io.to(`server:${serverId}`).emit('voice_peers', { serverId, peers: voiceRoomList(serverId) });
    }
  }
}

io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  if (!token) return next(new Error('Missing token'));
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    socket.userId = payload.id;
    socket.username = payload.username;
    next();
  } catch (e) {
    next(new Error('Invalid token'));
  }
});

io.on('connection', (socket) => {
  if (!onlineUsers.has(socket.userId)) onlineUsers.set(socket.userId, new Set());
  onlineUsers.get(socket.userId).add(socket.id);
  io.emit('presence_update', { online: Array.from(onlineUsers.keys()) });

  socket.on('join_server', (serverId) => {
    const data = db.read();
    if (isMember(data, serverId, socket.userId)) socket.join(`server:${serverId}`);
  });

  socket.on('join_channel', (channelId) => {
    const data = db.read();
    const channel = data.channels.find(c => c.id === channelId);
    if (channel && isMember(data, channel.serverId, socket.userId)) {
      socket.join(`channel:${channelId}`);
    }
  });

  socket.on('leave_channel', (channelId) => {
    socket.leave(`channel:${channelId}`);
  });

  socket.on('typing', ({ channelId }) => {
    socket.to(`channel:${channelId}`).emit('typing', { channelId, username: socket.username, userId: socket.userId });
  });

  socket.on('send_message', async ({ channelId, content, imageUrl }) => {
    if ((!content || !content.trim()) && !imageUrl) return;
    if (!channelId) return;
    const data = db.read();
    const channel = data.channels.find(c => c.id === channelId);
    if (!channel || !isMember(data, channel.serverId, socket.userId)) return;

    const message = {
      id: uuidv4(),
      channelId,
      userId: socket.userId,
      content: (content || '').trim().slice(0, 4000),
      imageUrl: imageUrl && imageUrl.startsWith('/uploads/') ? imageUrl : null,
      createdAt: new Date().toISOString()
    };
    await db.transact(d => { d.messages.push(message); });

    const user = data.users.find(u => u.id === socket.userId);
    io.to(`channel:${channelId}`).emit('new_message', {
      ...message,
      username: user ? user.username : socket.username,
      color: user ? user.color : '#888'
    });
  });

  // ---- Voice chat (WebRTC signaling; server just relays, audio is peer-to-peer) ----
  socket.on('voice_join', (serverId) => {
    const data = db.read();
    if (!isMember(data, serverId, socket.userId)) return;
    const user = data.users.find(u => u.id === socket.userId);
    if (!user) return;

    if (!voiceRooms.has(serverId)) voiceRooms.set(serverId, new Map());
    const room = voiceRooms.get(serverId);

    // Tell the newly-joined socket who else is already in the room, so it can
    // initiate WebRTC offers to each existing peer.
    socket.emit('voice_existing_peers', { serverId, peers: voiceRoomList(serverId) });

    room.set(socket.id, { userId: socket.userId, username: user.username, color: user.color });
    socket.join(`voice:${serverId}`);
    io.to(`server:${serverId}`).emit('voice_peers', { serverId, peers: voiceRoomList(serverId) });
  });

  socket.on('voice_leave', (serverId) => {
    const room = voiceRooms.get(serverId);
    if (room && room.has(socket.id)) {
      room.delete(socket.id);
      if (room.size === 0) voiceRooms.delete(serverId);
    }
    socket.leave(`voice:${serverId}`);
    io.to(`server:${serverId}`).emit('voice_peers', { serverId, peers: voiceRoomList(serverId) });
  });

  // Relay WebRTC offers/answers/ICE candidates directly to the target peer.
  socket.on('voice_signal', ({ to, signal }) => {
    if (!to || !signal) return;
    io.to(to).emit('voice_signal', { from: socket.id, signal });
  });

  // ---- Direct messages ----
  socket.on('join_dm', (conversationId) => {
    const data = db.read();
    const convo = (data.dms || []).find(d => d.id === conversationId);
    if (convo && convo.participants.includes(socket.userId)) {
      socket.join(`dm:${conversationId}`);
    }
  });

  socket.on('leave_dm', (conversationId) => {
    socket.leave(`dm:${conversationId}`);
  });

  socket.on('send_dm', async ({ conversationId, content, imageUrl }) => {
    if ((!content || !content.trim()) && !imageUrl) return;
    if (!conversationId) return;
    const data = db.read();
    const convo = (data.dms || []).find(d => d.id === conversationId);
    if (!convo || !convo.participants.includes(socket.userId)) return;

    const message = {
      id: uuidv4(),
      conversationId,
      userId: socket.userId,
      content: (content || '').trim().slice(0, 4000),
      imageUrl: imageUrl && imageUrl.startsWith('/uploads/') ? imageUrl : null,
      createdAt: new Date().toISOString()
    };
    await db.transact(d => {
      if (!d.dmMessages) d.dmMessages = [];
      d.dmMessages.push(message);
    });

    const user = data.users.find(u => u.id === socket.userId);
    io.to(`dm:${conversationId}`).emit('new_dm_message', {
      ...message,
      username: user ? user.username : socket.username,
      color: user ? user.color : '#888'
    });

    const otherId = convo.participants.find(p => p !== socket.userId);
    const otherSockets = onlineUsers.get(otherId);
    if (otherSockets) {
      otherSockets.forEach(sId => {
        io.to(sId).emit('dm_notification', { conversationId, from: user ? user.username : 'Someone' });
      });
    }
  });

  // ---- 1:1 video/audio calls (separate from team voice rooms) ----
  socket.on('call_user', ({ toUserId, conversationId, callType }) => {
    const targets = onlineUsers.get(toUserId);
    if (targets) {
      targets.forEach(sId => io.to(sId).emit('incoming_call', {
        fromSocketId: socket.id, fromUserId: socket.userId, fromUsername: socket.username, conversationId, callType
      }));
    }
  });

  socket.on('call_response', ({ toSocketId, accepted, conversationId }) => {
    io.to(toSocketId).emit('call_response', { accepted, fromSocketId: socket.id, conversationId });
  });

  socket.on('call_signal', ({ to, signal }) => {
    if (!to || !signal) return;
    io.to(to).emit('call_signal', { from: socket.id, signal });
  });

  socket.on('call_end', ({ to }) => {
    if (to) io.to(to).emit('call_ended');
  });

  socket.on('disconnect', () => {
    const set = onlineUsers.get(socket.userId);
    if (set) {
      set.delete(socket.id);
      if (set.size === 0) onlineUsers.delete(socket.userId);
    }
    io.emit('presence_update', { online: Array.from(onlineUsers.keys()) });
    leaveVoiceRoom(socket);
  });
});

server.listen(PORT, () => {
  console.log(`\n  Orbit is live -> http://localhost:${PORT}\n`);
});
