(() => {
  'use strict';

  // ---------- State ----------
  let token = localStorage.getItem('orbit_token') || null;
  let me = null;
  let servers = [];
  let currentServerId = null;
  let currentChannelId = null;
  let socket = null;
  let onlineIds = [];
  let typingTimeout = null;

  // ---------- Voice chat state ----------
  const ICE_SERVERS = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
  let localStream = null;
  let inVoice = false;
  let muted = false;
  let voiceMembers = [];
  const peerConnections = new Map(); // socketId -> RTCPeerConnection
  const analysers = new Map();       // socketId -> AnalyserNode

  // ---------- Direct message + video call state ----------
  let currentDmId = null;
  let dmConversations = [];
  let pendingImageFile = null;
  let callPc = null;
  let callLocalStream = null;
  let activeCallSocketId = null;
  let activeCallMuted = false;
  let activeCallVideoOff = false;

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  // ---------- Starfield background ----------
  function initStarfield() {
    const canvas = document.getElementById('starfield');
    const ctx = canvas.getContext('2d');
    let stars = [];
    function resize() {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      const count = Math.floor((canvas.width * canvas.height) / 9000);
      stars = Array.from({ length: count }, () => ({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        r: Math.random() * 1.3 + 0.2,
        s: Math.random() * 0.4 + 0.05,
        p: Math.random() * Math.PI * 2
      }));
    }
    let t = 0;
    function tick() {
      t += 0.016;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const star of stars) {
        const alpha = 0.3 + 0.5 * Math.abs(Math.sin(t * star.s + star.p));
        ctx.beginPath();
        ctx.arc(star.x, star.y, star.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(230,235,255,${alpha})`;
        ctx.fill();
      }
      requestAnimationFrame(tick);
    }
    window.addEventListener('resize', resize);
    resize();
    tick();
  }

  // ---------- 3D tilt ----------
  function initTilt(el, strength = 10) {
    el.addEventListener('mousemove', (e) => {
      const rect = el.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width - 0.5;
      const y = (e.clientY - rect.top) / rect.height - 0.5;
      el.style.transform = `rotateY(${x * strength}deg) rotateX(${-y * strength}deg)`;
    });
    el.addEventListener('mouseleave', () => {
      el.style.transform = 'rotateY(0deg) rotateX(0deg)';
    });
  }

  // ---------- API helpers ----------
  async function api(path, opts = {}) {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(path, Object.assign({}, opts, { headers }));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Something went wrong');
    return data;
  }

  async function uploadImage(file) {
    const fd = new FormData();
    fd.append('image', file);
    const res = await fetch('/api/upload', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: fd
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    return data.url;
  }

  function clearPendingImage() {
    pendingImageFile = null;
    $('#image-input').value = '';
    $('#image-preview').classList.add('hidden');
    $('#image-preview-img').src = '';
  }

  function showToast(msg) {
    const toast = $('#toast');
    toast.textContent = msg;
    toast.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => toast.classList.add('hidden'), 2600);
  }

  function initials(name) {
    return (name || '?').slice(0, 2).toUpperCase();
  }

  function formatTime(iso) {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // ---------- Auth screen ----------
  function initAuthScreen() {
    initTilt($('#auth-card'), 8);

    $$('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        $$('.tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const which = tab.dataset.tab;
        $('#login-form').classList.toggle('hidden', which !== 'login');
        $('#register-form').classList.toggle('hidden', which !== 'register');
      });
    });

    $('#login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const errEl = $('#login-error');
      errEl.textContent = '';
      try {
        const data = await api('/api/login', { method: 'POST', body: JSON.stringify({ username: fd.get('username'), password: fd.get('password') }) });
        onAuthSuccess(data);
      } catch (err) {
        errEl.textContent = err.message;
      }
    });

    $('#register-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const errEl = $('#register-error');
      errEl.textContent = '';
      try {
        const data = await api('/api/register', { method: 'POST', body: JSON.stringify({ username: fd.get('username'), password: fd.get('password') }) });
        onAuthSuccess(data);
      } catch (err) {
        errEl.textContent = err.message;
      }
    });
  }

  function onAuthSuccess(data) {
    token = data.token;
    me = data.user;
    localStorage.setItem('orbit_token', token);
    boot();
  }

  // ---------- App boot ----------
  async function boot() {
    $('#auth-screen').classList.add('hidden');
    $('#app-screen').classList.remove('hidden');

    $('#me-username').textContent = me.username;
    $('#me-avatar').textContent = initials(me.username);
    $('#me-avatar').style.background = `linear-gradient(160deg, ${me.color}, #00e5ff)`;

    connectSocket();
    await loadServers();
    await loadDms();
    initAppInteractions();
  }

  function connectSocket() {
    socket = io({ auth: { token } });

    socket.on('connect_error', (err) => {
      if (err.message === 'Invalid token' || err.message === 'Missing token') logout();
    });

    socket.on('presence_update', ({ online }) => {
      onlineIds = online;
      renderMembers();
    });

    socket.on('new_message', (msg) => {
      if (msg.channelId === currentChannelId) appendMessage(msg);
    });

    socket.on('channel_created', ({ channel }) => {
      const server = servers.find(s => s.id === channel.serverId);
      if (server) {
        server.channels.push(channel);
        if (server.id === currentServerId) renderChannels(server);
      }
    });

    socket.on('member_joined', ({ serverId }) => {
      if (serverId === currentServerId) loadMembers(serverId);
    });

    socket.on('typing', ({ channelId, username }) => {
      if (channelId !== currentChannelId) return;
      const el = $('#typing-indicator');
      el.textContent = `${username} is typing…`;
      clearTimeout(el._t);
      el._t = setTimeout(() => { el.textContent = ''; }, 2000);
    });

    // ---- Voice: WebRTC signaling ----
    socket.on('voice_existing_peers', ({ peers }) => {
      peers.forEach(p => { if (p.socketId !== socket.id) callPeer(p.socketId); });
    });

    socket.on('voice_peers', ({ serverId, peers }) => {
      if (serverId !== currentServerId) return;
      voiceMembers = peers;
      renderVoiceMembers();
      const activeIds = new Set(peers.map(p => p.socketId));
      for (const id of Array.from(peerConnections.keys())) {
        if (!activeIds.has(id)) closePeerConnection(id);
      }
    });

    socket.on('voice_signal', async ({ from, signal }) => {
      if (signal.type === 'offer') {
        const pc = getOrCreatePeerConnection(from);
        await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('voice_signal', { to: from, signal: { type: 'answer', sdp: pc.localDescription } });
      } else if (signal.type === 'answer') {
        const pc = peerConnections.get(from);
        if (pc) await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
      } else if (signal.type === 'candidate' && signal.candidate) {
        const pc = peerConnections.get(from);
        if (pc) { try { await pc.addIceCandidate(new RTCIceCandidate(signal.candidate)); } catch (e) { /* ignore */ } }
      }
    });

    // ---- Direct messages ----
    socket.on('new_dm_message', (msg) => {
      if (msg.conversationId === currentDmId) appendMessage(msg);
    });

    socket.on('dm_notification', ({ from }) => {
      showToast(`New message from ${from}`);
    });

    // ---- 1:1 video/audio calls ----
    socket.on('incoming_call', ({ fromSocketId, fromUsername, conversationId, callType }) => {
      activeCallSocketId = fromSocketId;
      $('#incoming-call-text').textContent = `${fromUsername} is calling (${callType === 'video' ? 'video' : 'audio'})`;
      $('#incoming-call-modal').classList.remove('hidden');

      $('#btn-accept-call').onclick = async () => {
        $('#incoming-call-modal').classList.add('hidden');
        try {
          callLocalStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: callType === 'video' });
        } catch (e) {
          showToast('Camera/microphone access is needed to answer');
          socket.emit('call_response', { toSocketId: fromSocketId, accepted: false, conversationId });
          return;
        }
        $('#call-local-video').srcObject = callLocalStream;
        $('#call-overlay').classList.remove('hidden');
        $('#call-status').textContent = 'Connecting…';
        socket.emit('call_response', { toSocketId: fromSocketId, accepted: true, conversationId });
        setupCallPeerConnection(fromSocketId, false);
      };
      $('#btn-decline-call').onclick = () => {
        $('#incoming-call-modal').classList.add('hidden');
        socket.emit('call_response', { toSocketId: fromSocketId, accepted: false, conversationId });
      };
    });

    socket.on('call_response', async ({ accepted, fromSocketId }) => {
      if (!accepted) {
        showToast('Call declined');
        endCall();
        return;
      }
      activeCallSocketId = fromSocketId;
      $('#call-status').textContent = 'Connecting…';
      await setupCallPeerConnection(fromSocketId, true);
    });

    socket.on('call_signal', async ({ from, signal }) => {
      if (!callPc) return;
      if (signal.type === 'offer') {
        await callPc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        const answer = await callPc.createAnswer();
        await callPc.setLocalDescription(answer);
        socket.emit('call_signal', { to: from, signal: { type: 'answer', sdp: callPc.localDescription } });
      } else if (signal.type === 'answer') {
        await callPc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
      } else if (signal.type === 'candidate' && signal.candidate) {
        try { await callPc.addIceCandidate(new RTCIceCandidate(signal.candidate)); } catch (e) { /* ignore */ }
      }
    });

    socket.on('call_ended', () => { showToast('Call ended'); endCall(); });
  }

  // ---------- Voice chat: WebRTC ----------
  function getOrCreatePeerConnection(peerSocketId) {
    if (peerConnections.has(peerSocketId)) return peerConnections.get(peerSocketId);
    const pc = new RTCPeerConnection(ICE_SERVERS);
    peerConnections.set(peerSocketId, pc);

    if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

    pc.onicecandidate = (e) => {
      if (e.candidate) socket.emit('voice_signal', { to: peerSocketId, signal: { type: 'candidate', candidate: e.candidate } });
    };
    pc.ontrack = (e) => {
      if (e.track.kind === 'video') {
        attachRemoteVideo(peerSocketId, e.streams[0]);
      } else {
        attachRemoteAudio(peerSocketId, e.streams[0]);
        setupSpeakingDetection(peerSocketId, e.streams[0]);
      }
    };
    pc.onconnectionstatechange = () => {
      if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) closePeerConnection(peerSocketId);
    };
    return pc;
  }

  async function callPeer(peerSocketId) {
    const pc = getOrCreatePeerConnection(peerSocketId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('voice_signal', { to: peerSocketId, signal: { type: 'offer', sdp: pc.localDescription } });
  }

  function closePeerConnection(id) {
    const pc = peerConnections.get(id);
    if (pc) { pc.close(); peerConnections.delete(id); }
    const audioEl = document.getElementById('audio-' + id);
    if (audioEl) audioEl.remove();
    analysers.delete(id);
    removeVideoTile(id);
  }

  function attachRemoteAudio(id, stream) {
    let el = document.getElementById('audio-' + id);
    if (!el) {
      el = document.createElement('audio');
      el.id = 'audio-' + id;
      el.autoplay = true;
      $('#audio-container').appendChild(el);
    }
    el.srcObject = stream;
  }

  function setupSpeakingDetection(id, stream) {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const audioCtx = new AudioCtx();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      analysers.set(id, analyser);
    } catch (e) { /* mic/audio analysis unsupported, skip speaking indicator */ }
  }

  // ---- Group video tiles (team voice) ----
  function showVideoStrip() { $('#team-video-strip').classList.remove('hidden'); }
  function hideVideoStripIfEmpty() {
    if (!$('#team-video-strip').children.length) $('#team-video-strip').classList.add('hidden');
  }

  function attachRemoteVideo(id, stream) {
    let tile = document.getElementById('video-tile-' + id);
    if (!tile) {
      tile = document.createElement('div');
      tile.id = 'video-tile-' + id;
      tile.className = 'video-tile';
      const name = (voiceMembers.find(m => m.socketId === id) || {}).username || 'Teammate';
      tile.innerHTML = `<video autoplay playsinline></video><span class="video-tile-name">${escapeHtml(name)}</span>`;
      $('#team-video-strip').appendChild(tile);
      showVideoStrip();
    }
    tile.querySelector('video').srcObject = stream;
  }

  function removeVideoTile(id) {
    const tile = document.getElementById('video-tile-' + id);
    if (tile) tile.remove();
    hideVideoStripIfEmpty();
  }

  function renderLocalVideoTile(stream) {
    let tile = document.getElementById('video-tile-local');
    if (!tile) {
      tile = document.createElement('div');
      tile.id = 'video-tile-local';
      tile.className = 'video-tile';
      tile.innerHTML = `<video autoplay playsinline muted></video><span class="video-tile-name">You</span>`;
      $('#team-video-strip').prepend(tile);
      showVideoStrip();
    }
    tile.querySelector('video').srcObject = stream;
  }

  async function renegotiatePeer(peerSocketId) {
    const pc = peerConnections.get(peerSocketId);
    if (!pc) return;
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('voice_signal', { to: peerSocketId, signal: { type: 'offer', sdp: pc.localDescription } });
    } catch (e) { /* ignore */ }
  }

  let teamCameraOn = false;
  async function toggleTeamCamera() {
    if (!inVoice) return;
    if (!teamCameraOn) {
      let camStream;
      try {
        camStream = await navigator.mediaDevices.getUserMedia({ video: true });
      } catch (e) {
        showToast('Camera access is needed to turn on video');
        return;
      }
      const videoTrack = camStream.getVideoTracks()[0];
      localStream.addTrack(videoTrack);
      renderLocalVideoTile(localStream);
      peerConnections.forEach((pc, peerId) => {
        pc.addTrack(videoTrack, localStream);
        renegotiatePeer(peerId);
      });
      teamCameraOn = true;
      $('#btn-camera').classList.add('on');
      $('#btn-camera').title = 'Turn off camera';
    } else {
      const videoTrack = localStream.getVideoTracks()[0];
      if (videoTrack) { videoTrack.stop(); localStream.removeTrack(videoTrack); }
      const localTile = document.getElementById('video-tile-local');
      if (localTile) localTile.remove();
      hideVideoStripIfEmpty();
      peerConnections.forEach((pc, peerId) => {
        const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
        if (sender) { pc.removeTrack(sender); renegotiatePeer(peerId); }
      });
      teamCameraOn = false;
      $('#btn-camera').classList.remove('on');
      $('#btn-camera').title = 'Turn on camera';
    }
  }

  function speakingDetectionLoop() {
    analysers.forEach((analyser, id) => {
      const data = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteFrequencyData(data);
      const avg = data.reduce((a, b) => a + b, 0) / data.length;
      const row = document.querySelector(`.voice-member-row[data-socket-id="${id}"]`);
      if (row) row.classList.toggle('speaking', avg > 14 && !(id === socket.id && muted));
    });
    requestAnimationFrame(speakingDetectionLoop);
  }

  function renderVoiceMembers() {
    const el = $('#voice-members');
    el.innerHTML = '';
    voiceMembers.forEach(m => {
      const row = document.createElement('div');
      row.className = 'voice-member-row';
      row.dataset.socketId = m.socketId;
      row.innerHTML = `
        <div class="avatar" style="background:${m.color}">${initials(m.username)}</div>
        <span>${escapeHtml(m.username)}${m.userId === me.id ? ' (you)' : ''}</span>
        <span class="mic-state">${m.socketId === socket.id && muted ? '🔇' : '🎙️'}</span>`;
      el.appendChild(row);
    });
  }

  async function joinVoice() {
    if (inVoice || !currentServerId) return;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      showToast('Microphone access is needed to join voice');
      return;
    }
    inVoice = true;
    muted = false;
    setupSpeakingDetection(socket.id, localStream);
    socket.emit('voice_join', currentServerId);

    $('#voice-bar').classList.remove('hidden');
    $('#voice-channel-btn').classList.add('in-call');
    $('#voice-join-state').textContent = 'Connected';
    $('#btn-mute').classList.remove('muted');
    $('#btn-mute').textContent = '🎙️';
  }

  function leaveVoice() {
    if (!inVoice) return;
    inVoice = false;
    socket.emit('voice_leave', currentServerId);
    Array.from(peerConnections.keys()).forEach(closePeerConnection);
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    analysers.delete(socket.id);
    voiceMembers = [];
    renderVoiceMembers();

    teamCameraOn = false;
    $('#btn-camera').classList.remove('on');
    $('#btn-camera').title = 'Turn on camera';
    $('#team-video-strip').innerHTML = '';
    $('#team-video-strip').classList.add('hidden');

    $('#voice-bar').classList.add('hidden');
    $('#voice-channel-btn').classList.remove('in-call');
    $('#voice-join-state').textContent = '';
  }

  function toggleMute() {
    if (!localStream) return;
    muted = !muted;
    localStream.getAudioTracks().forEach(t => { t.enabled = !muted; });
    $('#btn-mute').classList.toggle('muted', muted);
    $('#btn-mute').textContent = muted ? '🔇' : '🎙️';
    renderVoiceMembers();
  }

  async function loadServers() {
    const data = await api('/api/servers');
    servers = data.servers;
    renderServerRail();
    if (servers.length && !currentServerId) {
      selectServer(servers[0].id);
    }
  }

  function renderServerRail() {
    const list = $('#server-list');
    list.innerHTML = '';
    servers.forEach(server => {
      const btn = document.createElement('button');
      btn.className = 'server-icon' + (server.id === currentServerId ? ' active' : '');
      btn.title = server.name;
      btn.innerHTML = `<span class="pip"></span>${initials(server.name)}`;
      btn.addEventListener('click', () => selectServer(server.id));
      list.appendChild(btn);
    });
  }

  function selectServer(serverId) {
    if (inVoice && serverId !== currentServerId) leaveVoice();
    currentServerId = serverId;
    const server = servers.find(s => s.id === serverId);
    if (!server) return;
    renderServerRail();

    $('#current-server-name').textContent = server.name;
    const invitePill = $('#current-server-invite');
    invitePill.textContent = `Invite: ${server.inviteCode}`;
    invitePill.classList.remove('hidden');
    invitePill.onclick = () => {
      navigator.clipboard.writeText(server.inviteCode).then(() => showToast('Invite code copied'));
    };

    socket.emit('join_server', serverId);
    renderChannels(server);
    loadMembers(serverId);

    if (server.channels.length) {
      selectChannel(server.channels[0].id, server.channels[0].name);
    } else {
      currentChannelId = null;
      $('#messages').innerHTML = '';
      setComposerEnabled(false);
    }
  }

  function renderChannels(server) {
    const list = $('#channel-list');
    list.innerHTML = '';
    server.channels.forEach(ch => {
      const div = document.createElement('div');
      div.className = 'channel-item' + (ch.id === currentChannelId ? ' active' : '');
      div.innerHTML = `<span class="hash">#</span><span>${escapeHtml(ch.name)}</span>`;
      div.addEventListener('click', () => selectChannel(ch.id, ch.name));
      list.appendChild(div);
    });
  }

  function setComposerEnabled(enabled) {
    $('#composer-input').disabled = !enabled;
    $('.btn-send').disabled = !enabled;
    $('#btn-attach-image').disabled = !enabled;
  }

  async function selectChannel(channelId, channelName) {
    clearPendingImage();
    if (currentDmId) { socket.emit('leave_dm', currentDmId); currentDmId = null; renderDmList(); }
    if (currentChannelId) socket.emit('leave_channel', currentChannelId);
    currentChannelId = channelId;
    $('#chat-topbar-hash').textContent = '#';
    $('#current-channel-name').textContent = channelName;
    $('#composer-input').placeholder = `Message #${channelName}`;
    $('#btn-start-call').classList.add('hidden');
    setComposerEnabled(true);

    const server = servers.find(s => s.id === currentServerId);
    if (server) renderChannels(server);

    socket.emit('join_channel', channelId);

    const messagesEl = $('#messages');
    messagesEl.innerHTML = '<div class="empty-state"><p>Loading messages…</p></div>';
    const data = await api(`/api/channels/${channelId}/messages`);
    messagesEl.innerHTML = '';
    if (!data.messages.length) {
      messagesEl.innerHTML = `<div class="empty-state"><h3>No messages yet</h3><p>Be the first to say something in #${escapeHtml(channelName)}.</p></div>`;
    } else {
      data.messages.forEach(appendMessage);
    }
  }

  function appendMessage(msg) {
    const messagesEl = $('#messages');
    const empty = messagesEl.querySelector('.empty-state');
    if (empty) empty.remove();

    const row = document.createElement('div');
    row.className = 'msg';
    row.innerHTML = `
      <div class="msg-avatar" style="background:${msg.color}">${initials(msg.username)}</div>
      <div class="msg-body">
        <div class="msg-head">
          <span class="msg-author" style="color:${msg.color}">${escapeHtml(msg.username)}</span>
          <span class="msg-time">${formatTime(msg.createdAt)}</span>
        </div>
        <div class="msg-content"></div>
      </div>`;
    row.querySelector('.msg-content').textContent = msg.content || '';

    if (msg.imageUrl) {
      const img = document.createElement('img');
      img.src = msg.imageUrl;
      img.className = 'msg-image';
      img.alt = 'shared image';
      img.addEventListener('click', () => openLightbox(msg.imageUrl));
      row.querySelector('.msg-body').appendChild(img);
    }

    messagesEl.appendChild(row);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function openLightbox(url) {
    const box = document.createElement('div');
    box.className = 'image-lightbox';
    box.innerHTML = `<img src="${url}" />`;
    box.addEventListener('click', () => box.remove());
    document.body.appendChild(box);
  }

  async function loadMembers(serverId) {
    const data = await api(`/api/servers/${serverId}/members`);
    window._currentMembers = data.members;
    renderMembers();
  }

  function renderMembers() {
    const members = window._currentMembers || [];
    const el = $('#members-online');
    el.innerHTML = '';
    const sorted = [...members].sort((a, b) => {
      const aOn = onlineIds.includes(a.id) ? 0 : 1;
      const bOn = onlineIds.includes(b.id) ? 0 : 1;
      return aOn - bOn || a.username.localeCompare(b.username);
    });
    sorted.forEach(m => {
      const isOnline = onlineIds.includes(m.id);
      const isMe = m.id === me.id;
      const row = document.createElement('div');
      row.className = 'member-row' + (isOnline ? ' is-online' : '');
      row.innerHTML = `
        <div class="avatar" style="background:${m.color}">${initials(m.username)}</div>
        <span class="name">${escapeHtml(m.username)}</span>
        ${(isOnline && !isMe) ? '<button class="member-call-btn" title="Video call">📹</button>' : ''}
        <span class="dot"></span>`;
      if (isOnline && !isMe) {
        row.querySelector('.member-call-btn').addEventListener('click', (e) => {
          e.stopPropagation();
          quickCallMember(m.id);
        });
      }
      el.appendChild(row);
    });
  }

  async function quickCallMember(userId) {
    try {
      const res = await api('/api/dms/start', { method: 'POST', body: JSON.stringify({ userId }) });
      if (!dmConversations.find(c => c.id === res.conversation.id)) dmConversations.push(res.conversation);
      renderDmList();
      startCall(userId, res.conversation.id, 'video');
    } catch (err) {
      showToast(err.message || 'Could not start call');
    }
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ---------- Direct Messages ----------
  async function loadDms() {
    const data = await api('/api/dms');
    dmConversations = data.conversations;
    renderDmList();
  }

  function renderDmList() {
    const list = $('#dm-list');
    list.innerHTML = '';
    dmConversations.forEach(c => {
      if (!c.otherUser) return;
      const row = document.createElement('div');
      row.className = 'dm-item' + (c.id === currentDmId ? ' active' : '');
      row.innerHTML = `<span class="dm-name">${escapeHtml(c.otherUser.username)}</span><button class="call-btn" title="Video call">📹</button>`;
      row.querySelector('.dm-name').addEventListener('click', () => openDm(c));
      row.querySelector('.call-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        startCall(c.otherUser.id, c.id, 'video');
      });
      list.appendChild(row);
    });
  }

  async function openDm(convo) {
    clearPendingImage();
    if (currentDmId) socket.emit('leave_dm', currentDmId);
    currentDmId = convo.id;
    currentChannelId = null;
    renderDmList();

    // Clear "active" highlighting on team channels since we've switched to a DM
    $$('.channel-item').forEach(el => el.classList.remove('active'));

    $('#chat-topbar-hash').textContent = '@';
    $('#current-channel-name').textContent = convo.otherUser.username;
    $('#composer-input').placeholder = `Message ${convo.otherUser.username}`;
    $('#btn-start-call').classList.remove('hidden');
    $('#btn-start-call').onclick = () => startCall(convo.otherUser.id, convo.id, 'video');
    setComposerEnabled(true);

    socket.emit('join_dm', convo.id);

    const messagesEl = $('#messages');
    messagesEl.innerHTML = '<div class="empty-state"><p>Loading messages…</p></div>';
    const data = await api(`/api/dms/${convo.id}/messages`);
    messagesEl.innerHTML = '';
    if (!data.messages.length) {
      messagesEl.innerHTML = `<div class="empty-state"><h3>No messages yet</h3><p>Say hi to ${escapeHtml(convo.otherUser.username)}.</p></div>`;
    } else {
      data.messages.forEach(appendMessage);
    }
  }

  // ---------- 1:1 video/audio calls ----------
  async function startCall(toUserId, conversationId, callType) {
    try {
      callLocalStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: callType === 'video' });
    } catch (e) {
      showToast('Camera/microphone access is needed to start a call');
      return;
    }
    $('#call-local-video').srcObject = callLocalStream;
    $('#call-overlay').classList.remove('hidden');
    $('#call-status').textContent = 'Calling…';
    socket.emit('call_user', { toUserId, conversationId, callType });
  }

  async function setupCallPeerConnection(peerSocketId, isCaller) {
    callPc = new RTCPeerConnection(ICE_SERVERS);
    activeCallSocketId = peerSocketId;
    callLocalStream.getTracks().forEach(t => callPc.addTrack(t, callLocalStream));

    callPc.onicecandidate = (e) => {
      if (e.candidate) socket.emit('call_signal', { to: peerSocketId, signal: { type: 'candidate', candidate: e.candidate } });
    };
    callPc.ontrack = (e) => {
      $('#call-remote-video').srcObject = e.streams[0];
      $('#call-status').textContent = '';
    };

    if (isCaller) {
      const offer = await callPc.createOffer();
      await callPc.setLocalDescription(offer);
      socket.emit('call_signal', { to: peerSocketId, signal: { type: 'offer', sdp: callPc.localDescription } });
    }
  }

  function endCall() {
    if (callPc) { callPc.close(); callPc = null; }
    if (callLocalStream) { callLocalStream.getTracks().forEach(t => t.stop()); callLocalStream = null; }
    if (activeCallSocketId) socket.emit('call_end', { to: activeCallSocketId });
    activeCallSocketId = null;
    activeCallMuted = false;
    activeCallVideoOff = false;
    $('#call-overlay').classList.add('hidden');
    $('#call-remote-video').srcObject = null;
    $('#call-btn-mute').classList.remove('muted');
    $('#call-btn-mute').textContent = '🎙️';
    $('#call-btn-video').textContent = '📷';
  }

  // ---------- App interactions ----------
  function initAppInteractions() {
    $('#btn-logout').addEventListener('click', logout);

    $('#composer').addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = $('#composer-input');
      const content = input.value.trim();
      if (!content && !pendingImageFile) return;

      let imageUrl = null;
      if (pendingImageFile) {
        try {
          imageUrl = await uploadImage(pendingImageFile);
        } catch (err) {
          showToast(err.message || 'Image upload failed');
          return;
        }
      }

      if (currentDmId) {
        socket.emit('send_dm', { conversationId: currentDmId, content, imageUrl });
      } else if (currentChannelId) {
        socket.emit('send_message', { channelId: currentChannelId, content, imageUrl });
      } else {
        return;
      }
      input.value = '';
      clearPendingImage();
    });

    $('#btn-attach-image').addEventListener('click', () => {
      if ($('#btn-attach-image').disabled) return;
      $('#image-input').click();
    });

    $('#image-input').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > 8 * 1024 * 1024) { showToast('Image must be under 8MB'); e.target.value = ''; return; }
      pendingImageFile = file;
      const reader = new FileReader();
      reader.onload = () => {
        $('#image-preview-img').src = reader.result;
        $('#image-preview').classList.remove('hidden');
      };
      reader.readAsDataURL(file);
    });

    $('#image-preview-remove').addEventListener('click', clearPendingImage);

    $('#composer-input').addEventListener('input', () => {
      if (!currentChannelId) return;
      clearTimeout(typingTimeout);
      socket.emit('typing', { channelId: currentChannelId });
      typingTimeout = setTimeout(() => {}, 1000);
    });

    // Create/join server modal
    $('#btn-add-server').addEventListener('click', () => $('#modal-backdrop').classList.remove('hidden'));
    $('#modal-close').addEventListener('click', () => $('#modal-backdrop').classList.add('hidden'));
    $('#modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'modal-backdrop') $('#modal-backdrop').classList.add('hidden'); });

    $('#form-create-server').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        const data = await api('/api/servers', { method: 'POST', body: JSON.stringify({ name: fd.get('name') }) });
        servers.push(data.server);
        $('#modal-backdrop').classList.add('hidden');
        e.target.reset();
        selectServer(data.server.id);
        showToast(`Team "${data.server.name}" created`);
      } catch (err) { showToast(err.message); }
    });

    $('#form-join-server').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        const data = await api('/api/servers/join', { method: 'POST', body: JSON.stringify({ inviteCode: fd.get('inviteCode') }) });
        if (!servers.find(s => s.id === data.server.id)) servers.push(data.server);
        $('#modal-backdrop').classList.add('hidden');
        e.target.reset();
        selectServer(data.server.id);
        showToast(`Joined "${data.server.name}"`);
      } catch (err) { showToast(err.message); }
    });

    // Create channel modal
    $('#btn-add-channel').addEventListener('click', () => {
      if (!currentServerId) return showToast('Select a team first');
      $('#channel-modal-backdrop').classList.remove('hidden');
    });
    $('#channel-modal-close').addEventListener('click', () => $('#channel-modal-backdrop').classList.add('hidden'));
    $('#channel-modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'channel-modal-backdrop') $('#channel-modal-backdrop').classList.add('hidden'); });

    $('#form-create-channel').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        const data = await api(`/api/servers/${currentServerId}/channels`, { method: 'POST', body: JSON.stringify({ name: fd.get('name') }) });
        const server = servers.find(s => s.id === currentServerId);
        if (server && !server.channels.find(c => c.id === data.channel.id)) server.channels.push(data.channel);
        renderChannels(server);
        $('#channel-modal-backdrop').classList.add('hidden');
        e.target.reset();
        selectChannel(data.channel.id, data.channel.name);
      } catch (err) { showToast(err.message); }
    });

    // Tilt on server icons container for a subtle premium feel
    initTilt($('#server-rail'), 3);

    // Voice controls
    $('#voice-channel-btn').addEventListener('click', () => { if (!inVoice) joinVoice(); });
    $('#btn-mute').addEventListener('click', toggleMute);
    $('#btn-camera').addEventListener('click', toggleTeamCamera);
    $('#btn-leave-voice').addEventListener('click', leaveVoice);

    // Direct message search
    $('#dm-search-input').addEventListener('input', async (e) => {
      const q = e.target.value.trim();
      const results = $('#dm-search-results');
      if (!q) { results.innerHTML = ''; return; }
      try {
        const data = await api('/api/users/search?q=' + encodeURIComponent(q));
        results.innerHTML = '';
        data.users.forEach(u => {
          const row = document.createElement('div');
          row.className = 'dm-search-result';
          row.textContent = u.username;
          row.addEventListener('click', async () => {
            const res = await api('/api/dms/start', { method: 'POST', body: JSON.stringify({ userId: u.id }) });
            if (!dmConversations.find(c => c.id === res.conversation.id)) dmConversations.push(res.conversation);
            renderDmList();
            openDm(res.conversation);
            $('#dm-search-input').value = '';
            results.innerHTML = '';
          });
          results.appendChild(row);
        });
      } catch (err) { /* ignore search errors */ }
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.dm-search')) $('#dm-search-results').innerHTML = '';
    });

    // Video call controls
    $('#call-btn-end').addEventListener('click', endCall);
    $('#call-btn-mute').addEventListener('click', () => {
      if (!callLocalStream) return;
      activeCallMuted = !activeCallMuted;
      callLocalStream.getAudioTracks().forEach(t => { t.enabled = !activeCallMuted; });
      $('#call-btn-mute').classList.toggle('muted', activeCallMuted);
      $('#call-btn-mute').textContent = activeCallMuted ? '🔇' : '🎙️';
    });
    $('#call-btn-video').addEventListener('click', () => {
      if (!callLocalStream) return;
      activeCallVideoOff = !activeCallVideoOff;
      callLocalStream.getVideoTracks().forEach(t => { t.enabled = !activeCallVideoOff; });
      $('#call-btn-video').textContent = activeCallVideoOff ? '🚫' : '📷';
    });
  }

  function logout() {
    if (inVoice) leaveVoice();
    if (callPc || callLocalStream) endCall();
    currentDmId = null;
    dmConversations = [];
    localStorage.removeItem('orbit_token');
    token = null;
    me = null;
    servers = [];
    currentServerId = null;
    currentChannelId = null;
    if (socket) socket.disconnect();
    $('#app-screen').classList.add('hidden');
    $('#auth-screen').classList.remove('hidden');
  }

  // ---------- Init ----------
  initStarfield();
  initAuthScreen();
  requestAnimationFrame(speakingDetectionLoop);

  if (token) {
    api('/api/me').then(data => { me = data.user; boot(); }).catch(() => { localStorage.removeItem('orbit_token'); token = null; });
  }
})();
