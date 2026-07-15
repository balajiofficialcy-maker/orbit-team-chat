(() => {
  'use strict';

  let token = localStorage.getItem('orbit_token') || null;
  let me = null;
  let servers = [];
  let currentServerId = null;
  let currentChannelId = null;
  let socket = null;
  let onlineIds = [];
  let typingTimeout = null;
  let googleClientId = null;

  const ICE_SERVERS = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
  let localStream = null;
  let inVoice = false;
  let muted = false;
  let voiceMembers = [];
  const peerConnections = new Map();
  const analysers = new Map();

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

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('orbit_theme', theme);
    $$('.theme-card').forEach(c => c.classList.toggle('active', c.dataset.theme === theme));
    const canvas = $('#starfield');
    if (canvas) canvas.style.display = theme === 'light' ? 'none' : 'block';
  }

  function applyWallpaper(wallpaper) {
    document.documentElement.setAttribute('data-wallpaper', wallpaper);
    localStorage.setItem('orbit_wallpaper', wallpaper);
    $$('.wallpaper-card').forEach(c => c.classList.toggle('active', c.dataset.wallpaper === wallpaper));
    const wpEl = $('#wallpaper');
    if (wallpaper === 'custom') {
      const customUrl = localStorage.getItem('orbit_wallpaper_custom');
      if (customUrl) wpEl.style.backgroundImage = 'url(' + customUrl + ')';
    } else {
      wpEl.style.backgroundImage = '';
    }
  }

  function loadThemeAndWallpaper() {
    const theme = localStorage.getItem('orbit_theme') || 'cyber';
    const wallpaper = localStorage.getItem('orbit_wallpaper') || 'none';
    applyTheme(theme);
    applyWallpaper(wallpaper);
  }

  function initStarfield() {
    const canvas = document.getElementById('starfield');
    if (!canvas) return;
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
        ctx.fillStyle = 'rgba(230,235,255,' + alpha + ')';
        ctx.fill();
      }
      requestAnimationFrame(tick);
    }
    window.addEventListener('resize', resize);
    resize();
    tick();
  }

  function initTilt(el, strength) {
    strength = strength || 10;
    if (!el || window.innerWidth < 768) return;
    el.addEventListener('mousemove', function(e) {
      const rect = el.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width - 0.5;
      const y = (e.clientY - rect.top) / rect.height - 0.5;
      el.style.transform = 'rotateY(' + (x * strength) + 'deg) rotateX(' + (-y * strength) + 'deg)';
    });
    el.addEventListener('mouseleave', function() {
      el.style.transform = 'rotateY(0deg) rotateX(0deg)';
    });
  }

  async function api(path, opts) {
    opts = opts || {};
    const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const res = await fetch(path, Object.assign({}, opts, { headers: headers }));
    const data = await res.json().catch(function() { return {}; });
    if (!res.ok) throw new Error(data.error || 'Something went wrong');
    return data;
  }

  async function uploadImage(file) {
    const fd = new FormData();
    fd.append('image', file);
    const res = await fetch('/api/upload', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token },
      body: fd
    });
    const data = await res.json().catch(function() { return {}; });
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
    toast._t = setTimeout(function() { toast.classList.add('hidden'); }, 2600);
  }

  function initials(name) {
    return (name || '?').slice(0, 2).toUpperCase();
  }

  function formatTime(iso) {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function avatarHtml(user) {
    var cls = '';
    if (user.avatarUrl) {
      return '<img src="' + escapeHtml(user.avatarUrl) + '" class="msg-avatar avatar-img ' + cls + '" alt="' + escapeHtml(user.username) + '" onerror="this.remove();this.nextElementSibling&&this.nextElementSibling.classList.remove(\'hidden\')" /><div class="msg-avatar hidden" style="background:' + user.color + '">' + initials(user.username) + '</div>';
    }
    return '<div class="msg-avatar ' + cls + '" style="background:' + user.color + '">' + initials(user.username) + '</div>';
  }

  function updateMyAvatar() {
    var avatarDiv = $('#me-avatar');
    var avatarImg = $('#me-avatar-img');
    if (me && me.avatarUrl) {
      avatarDiv.classList.add('hidden');
      avatarImg.src = me.avatarUrl;
      avatarImg.classList.remove('hidden');
      avatarImg.alt = me.username;
    } else {
      avatarDiv.classList.remove('hidden');
      avatarImg.classList.add('hidden');
      avatarDiv.textContent = initials(me ? me.username : '?');
      if (me) avatarDiv.style.background = 'linear-gradient(160deg, ' + me.color + ', #00e5ff)';
    }
  }

  async function initGoogleSignIn() {
    try {
      const data = await fetch('/api/google-config').then(function(r) { return r.json(); });
      if (!data.enabled || !data.clientId) return;
      googleClientId = data.clientId;
      var area = $('#google-signin-area');
      area.classList.remove('hidden');
      area.innerHTML = '<div class="auth-divider"><span>or</span></div><button type="button" id="btn-google-signin" class="btn-primary" style="background:#fff;color:#333;box-shadow:0 4px 12px rgba(0,0,0,0.15);margin-top:4px"><svg width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg> Sign in with Google</button>';
      document.getElementById('btn-google-signin').addEventListener('click', function() {
        try {
          var g = window.google;
          if (!g || !g.accounts) { showToast('Google Sign-In library not loaded'); return; }
          g.accounts.id.initialize({ client_id: googleClientId, callback: handleGoogleCredential });
          g.accounts.id.prompt();
        } catch (e) { showToast('Google Sign-In not available'); }
      });
      if (!document.getElementById('google-gsi-script')) {
        var script = document.createElement('script');
        script.id = 'google-gsi-script';
        script.src = 'https://accounts.google.com/gsi/client';
        script.async = true;
        script.defer = true;
        document.head.appendChild(script);
      }
    } catch (e) {}
  }

  async function handleGoogleCredential(response) {
    try {
      const data = await api('/api/google-login', { method: 'POST', body: JSON.stringify({ token: response.credential }) });
      onAuthSuccess(data);
    } catch (err) { showToast(err.message || 'Google sign-in failed'); }
  }

  function initAuthScreen() {
    initTilt($('#auth-card'), 8);
    $$('.tab').forEach(function(tab) {
      tab.addEventListener('click', function() {
        $$('.tab').forEach(function(t) { t.classList.remove('active'); });
        tab.classList.add('active');
        var which = tab.dataset.tab;
        $('#login-form').classList.toggle('hidden', which !== 'login');
        $('#register-form').classList.toggle('hidden', which !== 'register');
      });
    });
    var secSelect = $('select[name="questionIndex"]');
    var secLabel = $('#sec-answer-label');
    if (secSelect && secLabel) {
      secSelect.addEventListener('change', function() { secLabel.classList.toggle('hidden', !secSelect.value); });
    }
    $('#login-form').addEventListener('submit', async function(e) {
      e.preventDefault();
      var fd = new FormData(e.target);
      var errEl = $('#login-error');
      errEl.textContent = '';
      try {
        var data = await api('/api/login', { method: 'POST', body: JSON.stringify({ username: fd.get('username'), password: fd.get('password') }) });
        onAuthSuccess(data);
      } catch (err) { errEl.textContent = err.message; }
    });
    $('#register-form').addEventListener('submit', async function(e) {
      e.preventDefault();
      var fd = new FormData(e.target);
      var errEl = $('#register-error');
      errEl.textContent = '';
      try {
        var body = { username: fd.get('username'), password: fd.get('password') };
        if (fd.get('questionIndex')) { body.questionIndex = parseInt(fd.get('questionIndex')); body.securityAnswer = fd.get('securityAnswer'); }
        var data = await api('/api/register', { method: 'POST', body: JSON.stringify(body) });
        onAuthSuccess(data);
      } catch (err) { errEl.textContent = err.message; }
    });
    $('#btn-forgot-password').addEventListener('click', function() {
      $('#forgot-modal-backdrop').classList.remove('hidden');
      $('#forgot-step-1').classList.remove('hidden');
      $('#forgot-step-2').classList.add('hidden');
      $('#forgot-error-1').textContent = '';
      $('#forgot-error-2').textContent = '';
    });
    $('#forgot-modal-close').addEventListener('click', function() { $('#forgot-modal-backdrop').classList.add('hidden'); });
    $('#forgot-modal-backdrop').addEventListener('click', function(e) { if (e.target.id === 'forgot-modal-backdrop') $('#forgot-modal-backdrop').classList.add('hidden'); });
    var forgotUsername = '';
    $('#form-forgot-step1').addEventListener('submit', async function(e) {
      e.preventDefault();
      var fd = new FormData(e.target);
      var errEl = $('#forgot-error-1');
      errEl.textContent = '';
      try {
        var data = await api('/api/forgot-password', { method: 'POST', body: JSON.stringify({ username: fd.get('username') }) });
        if (!data.hasSecurityQuestion) { errEl.textContent = 'No security question set for this account. Contact the server admin.'; return; }
        forgotUsername = fd.get('username');
        $('#forgot-question-text').textContent = data.question;
        $('#forgot-step-1').classList.add('hidden');
        $('#forgot-step-2').classList.remove('hidden');
      } catch (err) { errEl.textContent = err.message; }
    });
    $('#form-forgot-step2').addEventListener('submit', async function(e) {
      e.preventDefault();
      var fd = new FormData(e.target);
      var errEl = $('#forgot-error-2');
      errEl.textContent = '';
      try {
        var data = await api('/api/forgot-password/verify', { method: 'POST', body: JSON.stringify({ username: forgotUsername, answer: fd.get('answer'), newPassword: fd.get('newPassword') }) });
        $('#forgot-modal-backdrop').classList.add('hidden');
        onAuthSuccess(data);
        showToast('Password reset successful!');
      } catch (err) { errEl.textContent = err.message; }
    });
    initGoogleSignIn();
  }

  function onAuthSuccess(data) {
    token = data.token;
    me = data.user;
    localStorage.setItem('orbit_token', token);
    boot();
  }

  async function boot() {
    $('#auth-screen').classList.add('hidden');
    $('#app-screen').classList.remove('hidden');
    $('#me-username').textContent = me.username;
    updateMyAvatar();
    connectSocket();
    await loadServers();
    await loadDms();
    initAppInteractions();
    initSettingsModal();
  }

  function connectSocket() {
    socket = io({ auth: { token: token } });
    socket.on('connect_error', function(err) { if (err.message === 'Invalid token' || err.message === 'Missing token') logout(); });
    socket.on('presence_update', function(d) { onlineIds = d.online; renderMembers(); });
    socket.on('new_message', function(msg) { if (msg.channelId === currentChannelId) appendMessage(msg); });
    socket.on('channel_created', function(d) { var server = servers.find(function(s) { return s.id === d.channel.serverId; }); if (server) { server.channels.push(d.channel); if (server.id === currentServerId) renderChannels(server); } });
    socket.on('member_joined', function(d) { if (d.serverId === currentServerId) loadMembers(d.serverId); });
    socket.on('typing', function(d) { if (d.channelId !== currentChannelId) return; var el = $('#typing-indicator'); el.textContent = d.username + ' is typing…'; clearTimeout(el._t); el._t = setTimeout(function() { el.textContent = ''; }, 2000); });
    socket.on('voice_existing_peers', function(d) { d.peers.forEach(function(p) { if (p.socketId !== socket.id) callPeer(p.socketId); }); });
    socket.on('voice_peers', function(d) { if (d.serverId !== currentServerId) return; voiceMembers = d.peers; renderVoiceMembers(); var activeIds = new Set(d.peers.map(function(p) { return p.socketId; })); for (var id of Array.from(peerConnections.keys())) { if (!activeIds.has(id)) closePeerConnection(id); } });
    socket.on('voice_signal', async function(d) { if (d.signal.type === 'offer') { var pc = getOrCreatePeerConnection(d.from); await pc.setRemoteDescription(new RTCSessionDescription(d.signal.sdp)); var answer = await pc.createAnswer(); await pc.setLocalDescription(answer); socket.emit('voice_signal', { to: d.from, signal: { type: 'answer', sdp: pc.localDescription } }); } else if (d.signal.type === 'answer') { var pc = peerConnections.get(d.from); if (pc) await pc.setRemoteDescription(new RTCSessionDescription(d.signal.sdp)); } else if (d.signal.type === 'candidate' && d.signal.candidate) { var pc = peerConnections.get(d.from); if (pc) { try { await pc.addIceCandidate(new RTCIceCandidate(d.signal.candidate)); } catch (e) {} } } });
    socket.on('new_dm_message', function(msg) { if (msg.conversationId === currentDmId) appendMessage(msg); });
    socket.on('dm_notification', function(d) { showToast('New message from ' + d.from); });
    socket.on('incoming_call', function(d) {
      activeCallSocketId = d.fromSocketId;
      $('#incoming-call-text').textContent = d.fromUsername + ' is calling (' + (d.callType === 'video' ? 'video' : 'audio') + ')';
      $('#incoming-call-modal').classList.remove('hidden');
      document.getElementById('btn-accept-call').onclick = async function() {
        $('#incoming-call-modal').classList.add('hidden');
        try { callLocalStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: d.callType === 'video' }); } catch (e) { showToast('Camera/microphone access is needed to answer'); socket.emit('call_response', { toSocketId: d.fromSocketId, accepted: false, conversationId: d.conversationId }); return; }
        $('#call-local-video').srcObject = callLocalStream;
        $('#call-overlay').classList.remove('hidden');
        $('#call-status').textContent = 'Connecting…';
        socket.emit('call_response', { toSocketId: d.fromSocketId, accepted: true, conversationId: d.conversationId });
        setupCallPeerConnection(d.fromSocketId, false);
      };
      document.getElementById('btn-decline-call').onclick = function() { $('#incoming-call-modal').classList.add('hidden'); socket.emit('call_response', { toSocketId: d.fromSocketId, accepted: false, conversationId: d.conversationId }); };
    });
    socket.on('call_response', async function(d) { if (!d.accepted) { showToast('Call declined'); endCall(); return; } activeCallSocketId = d.fromSocketId; $('#call-status').textContent = 'Connecting…'; await setupCallPeerConnection(d.fromSocketId, true); });
    socket.on('call_signal', async function(d) { if (!callPc) return; if (d.signal.type === 'offer') { await callPc.setRemoteDescription(new RTCSessionDescription(d.signal.sdp)); var answer = await callPc.createAnswer(); await callPc.setLocalDescription(answer); socket.emit('call_signal', { to: d.from, signal: { type: 'answer', sdp: callPc.localDescription } }); } else if (d.signal.type === 'answer') { await callPc.setRemoteDescription(new RTCSessionDescription(d.signal.sdp)); } else if (d.signal.type === 'candidate' && d.signal.candidate) { try { await callPc.addIceCandidate(new RTCIceCandidate(d.signal.candidate)); } catch (e) {} } });
    socket.on('call_ended', function() { showToast('Call ended'); endCall(); });
  }

  function getOrCreatePeerConnection(peerSocketId) {
    if (peerConnections.has(peerSocketId)) return peerConnections.get(peerSocketId);
    var pc = new RTCPeerConnection(ICE_SERVERS);
    peerConnections.set(peerSocketId, pc);
    if (localStream) localStream.getTracks().forEach(function(t) { pc.addTrack(t, localStream); });
    pc.onicecandidate = function(e) { if (e.candidate) socket.emit('voice_signal', { to: peerSocketId, signal: { type: 'candidate', candidate: e.candidate } }); };
    pc.ontrack = function(e) { if (e.track.kind === 'video') attachRemoteVideo(peerSocketId, e.streams[0]); else { attachRemoteAudio(peerSocketId, e.streams[0]); setupSpeakingDetection(peerSocketId, e.streams[0]); } };
    pc.onconnectionstatechange = function() { if (['disconnected', 'failed', 'closed'].indexOf(pc.connectionState) !== -1) closePeerConnection(peerSocketId); };
    return pc;
  }
  async function callPeer(peerSocketId) { var pc = getOrCreatePeerConnection(peerSocketId); var offer = await pc.createOffer(); await pc.setLocalDescription(offer); socket.emit('voice_signal', { to: peerSocketId, signal: { type: 'offer', sdp: pc.localDescription } }); }
  function closePeerConnection(id) { var pc = peerConnections.get(id); if (pc) { pc.close(); peerConnections.delete(id); } var audioEl = document.getElementById('audio-' + id); if (audioEl) audioEl.remove(); analysers.delete(id); removeVideoTile(id); }
  function attachRemoteAudio(id, stream) { var el = document.getElementById('audio-' + id); if (!el) { el = document.createElement('audio'); el.id = 'audio-' + id; el.autoplay = true; $('#audio-container').appendChild(el); } el.srcObject = stream; }
  function setupSpeakingDetection(id, stream) { try { var AudioCtx = window.AudioContext || window.webkitAudioContext; var audioCtx = new AudioCtx(); var source = audioCtx.createMediaStreamSource(stream); var analyser = audioCtx.createAnalyser(); analyser.fftSize = 512; source.connect(analyser); analysers.set(id, analyser); } catch (e) {} }
  function showVideoStrip() { $('#team-video-strip').classList.remove('hidden'); }
  function hideVideoStripIfEmpty() { if (!$('#team-video-strip').children.length) $('#team-video-strip').classList.add('hidden'); }
  function attachRemoteVideo(id, stream) { var tile = document.getElementById('video-tile-' + id); if (!tile) { tile = document.createElement('div'); tile.id = 'video-tile-' + id; tile.className = 'video-tile'; var name = (voiceMembers.find(function(m) { return m.socketId === id; }) || {}).username || 'Teammate'; tile.innerHTML = '<video autoplay playsinline></video><span class="video-tile-name">' + escapeHtml(name) + '</span>'; $('#team-video-strip').appendChild(tile); showVideoStrip(); } tile.querySelector('video').srcObject = stream; }
  function removeVideoTile(id) { var tile = document.getElementById('video-tile-' + id); if (tile) tile.remove(); hideVideoStripIfEmpty(); }
  function renderLocalVideoTile(stream) { var tile = document.getElementById('video-tile-local'); if (!tile) { tile = document.createElement('div'); tile.id = 'video-tile-local'; tile.className = 'video-tile'; tile.innerHTML = '<video autoplay playsinline muted></video><span class="video-tile-name">You</span>'; $('#team-video-strip').prepend(tile); showVideoStrip(); } tile.querySelector('video').srcObject = stream; }
  async function renegotiatePeer(peerSocketId) { var pc = peerConnections.get(peerSocketId); if (!pc) return; try { var offer = await pc.createOffer(); await pc.setLocalDescription(offer); socket.emit('voice_signal', { to: peerSocketId, signal: { type: 'offer', sdp: pc.localDescription } }); } catch (e) {} }
  var teamCameraOn = false;
  async function toggleTeamCamera() {
    if (!inVoice) return;
    if (!teamCameraOn) {
      var camStream; try { camStream = await navigator.mediaDevices.getUserMedia({ video: true }); } catch (e) { showToast('Camera access is needed'); return; }
      var videoTrack = camStream.getVideoTracks()[0]; localStream.addTrack(videoTrack); renderLocalVideoTile(localStream);
      peerConnections.forEach(function(pc, peerId) { pc.addTrack(videoTrack, localStream); renegotiatePeer(peerId); });
      teamCameraOn = true; $('#btn-camera').classList.add('on');
    } else {
      var videoTrack = localStream.getVideoTracks()[0]; if (videoTrack) { videoTrack.stop(); localStream.removeTrack(videoTrack); }
      var localTile = document.getElementById('video-tile-local'); if (localTile) localTile.remove(); hideVideoStripIfEmpty();
      peerConnections.forEach(function(pc, peerId) { var sender = pc.getSenders().find(function(s) { return s.track && s.track.kind === 'video'; }); if (sender) { pc.removeTrack(sender); renegotiatePeer(peerId); } });
      teamCameraOn = false; $('#btn-camera').classList.remove('on');
    }
  }
  function speakingDetectionLoop() { analysers.forEach(function(analyser, id) { var data = new Uint8Array(analyser.frequencyBinCount); analyser.getByteFrequencyData(data); var avg = data.reduce(function(a, b) { return a + b; }, 0) / data.length; var row = document.querySelector('.voice-member-row[data-socket-id="' + id + '"]'); if (row) row.classList.toggle('speaking', avg > 14 && !(id === socket.id && muted)); }); requestAnimationFrame(speakingDetectionLoop); }
  function renderVoiceMembers() { var el = $('#voice-members'); el.innerHTML = ''; voiceMembers.forEach(function(m) { var row = document.createElement('div'); row.className = 'voice-member-row'; row.dataset.socketId = m.socketId; row.innerHTML = '<div class="avatar" style="background:' + m.color + '">' + initials(m.username) + '</div><span>' + escapeHtml(m.username) + (m.userId === me.id ? ' (you)' : '') + '</span><span class="mic-state">' + (m.socketId === socket.id && muted ? '🔇' : '🎙️') + '</span>'; el.appendChild(row); }); }
  async function joinVoice() { if (inVoice || !currentServerId) return; try { localStream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (e) { showToast('Microphone access is needed to join voice'); return; } inVoice = true; muted = false; setupSpeakingDetection(socket.id, localStream); socket.emit('voice_join', currentServerId); $('#voice-bar').classList.remove('hidden'); $('#voice-channel-btn').classList.add('in-call'); $('#voice-join-state').textContent = 'Connected'; $('#btn-mute').classList.remove('muted'); $('#btn-mute').textContent = '🎙️'; }
  function leaveVoice() { if (!inVoice) return; inVoice = false; socket.emit('voice_leave', currentServerId); Array.from(peerConnections.keys()).forEach(closePeerConnection); if (localStream) { localStream.getTracks().forEach(function(t) { t.stop(); }); localStream = null; } analysers.delete(socket.id); voiceMembers = []; renderVoiceMembers(); teamCameraOn = false; $('#btn-camera').classList.remove('on'); $('#team-video-strip').innerHTML = ''; $('#team-video-strip').classList.add('hidden'); $('#voice-bar').classList.add('hidden'); $('#voice-channel-btn').classList.remove('in-call'); $('#voice-join-state').textContent = ''; }
  function toggleMute() { if (!localStream) return; muted = !muted; localStream.getAudioTracks().forEach(function(t) { t.enabled = !muted; }); $('#btn-mute').classList.toggle('muted', muted); $('#btn-mute').textContent = muted ? '🔇' : '🎙️'; renderVoiceMembers(); }
  async function loadServers() { var data = await api('/api/servers'); servers = data.servers; renderServerRail(); if (servers.length && !currentServerId) selectServer(servers[0].id); }
  function renderServerRail() { var list = $('#server-list'); list.innerHTML = ''; servers.forEach(function(server) { var btn = document.createElement('button'); btn.className = 'server-icon' + (server.id === currentServerId ? ' active' : ''); btn.title = server.name; btn.innerHTML = '<span class="pip"></span>' + initials(server.name); btn.addEventListener('click', function() { selectServer(server.id); }); list.appendChild(btn); }); }
  function selectServer(serverId) {
    if (inVoice && serverId !== currentServerId) leaveVoice();
    currentServerId = serverId;
    var server = servers.find(function(s) { return s.id === serverId; });
    if (!server) return;
    renderServerRail();
    var nameEl = $('#current-server-name');
    nameEl.textContent = server.name;
    nameEl.title = 'Click to rename';
    nameEl.onclick = function() { promptRenameServer(server); };
    var invitePill = $('#current-server-invite');
    invitePill.textContent = 'Invite: ' + server.inviteCode;
    invitePill.classList.remove('hidden');
    invitePill.onclick = function() { navigator.clipboard.writeText(server.inviteCode).then(function() { showToast('Invite code copied'); }); };
    socket.emit('join_server', serverId);
    renderChannels(server);
    loadMembers(serverId);
    if (server.channels.length) selectChannel(server.channels[0].id, server.channels[0].name);
    else { currentChannelId = null; $('#messages').innerHTML = ''; setComposerEnabled(false); }
    closeMobileSidebar();
  }
  async function promptRenameServer(server) { var newName = prompt('Rename team:', server.name); if (!newName || !newName.trim() || newName.trim() === server.name) return; try { var data = await api('/api/servers/' + server.id, { method: 'PATCH', body: JSON.stringify({ name: newName.trim() }) }); server.name = data.server.name; $('#current-server-name').textContent = server.name; renderServerRail(); showToast('Team renamed!'); } catch (err) { showToast(err.message); } }
  function renderChannels(server) { var list = $('#channel-list'); list.innerHTML = ''; server.channels.forEach(function(ch) { var div = document.createElement('div'); div.className = 'channel-item' + (ch.id === currentChannelId ? ' active' : ''); div.innerHTML = '<span class="hash">#</span><span>' + escapeHtml(ch.name) + '</span>'; div.addEventListener('click', function() { selectChannel(ch.id, ch.name); }); list.appendChild(div); }); }
  function setComposerEnabled(enabled) { $('#composer-input').disabled = !enabled; $('.btn-send').disabled = !enabled; $('#btn-attach-image').disabled = !enabled; }
  async function selectChannel(channelId, channelName) {
    clearPendingImage();
    if (currentDmId) { socket.emit('leave_dm', currentDmId); currentDmId = null; renderDmList(); }
    if (currentChannelId) socket.emit('leave_channel', currentChannelId);
    currentChannelId = channelId;
    $('#chat-topbar-hash').textContent = '#';
    $('#current-channel-name').textContent = channelName;
    $('#composer-input').placeholder = 'Message #' + channelName;
    $('#btn-start-call').classList.add('hidden');
    setComposerEnabled(true);
    var server = servers.find(function(s) { return s.id === currentServerId; });
    if (server) renderChannels(server);
    socket.emit('join_channel', channelId);
    var messagesEl = $('#messages');
    messagesEl.innerHTML = '<div class="empty-state"><p>Loading messages…</p></div>';
    var data = await api('/api/channels/' + channelId + '/messages');
    messagesEl.innerHTML = '';
    if (!data.messages.length) messagesEl.innerHTML = '<div class="empty-state"><h3>No messages yet</h3><p>Be the first to say something in #' + escapeHtml(channelName) + '.</p></div>';
    else data.messages.forEach(appendMessage);
  }
  function appendMessage(msg) {
    var messagesEl = $('#messages');
    var empty = messagesEl.querySelector('.empty-state');
    if (empty) empty.remove();
    var row = document.createElement('div');
    row.className = 'msg';
    row.innerHTML = avatarHtml(msg) + '<div class="msg-body"><div class="msg-head"><span class="msg-author" style="color:' + msg.color + '">' + escapeHtml(msg.username) + '</span><span class="msg-time">' + formatTime(msg.createdAt) + '</span></div><div class="msg-content"></div></div>';
    row.querySelector('.msg-content').textContent = msg.content || '';
    if (msg.imageUrl) { var img = document.createElement('img'); img.src = msg.imageUrl; img.className = 'msg-image'; img.alt = 'shared image'; img.addEventListener('click', function() { openLightbox(msg.imageUrl); }); row.querySelector('.msg-body').appendChild(img); }
    messagesEl.appendChild(row);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
  function openLightbox(url) { var box = document.createElement('div'); box.className = 'image-lightbox'; box.innerHTML = '<img src="' + url + '" />'; box.addEventListener('click', function() { box.remove(); }); document.body.appendChild(box); }
  async function loadMembers(serverId) { var data = await api('/api/servers/' + serverId + '/members'); window._currentMembers = data.members; renderMembers(); }
  function renderMembers() {
    var members = window._currentMembers || [];
    var el = $('#members-online');
    el.innerHTML = '';
    var sorted = members.slice().sort(function(a, b) { var aOn = onlineIds.indexOf(a.id) !== -1 ? 0 : 1; var bOn = onlineIds.indexOf(b.id) !== -1 ? 0 : 1; return aOn - bOn || a.username.localeCompare(b.username); });
    sorted.forEach(function(m) {
      var isOnline = onlineIds.indexOf(m.id) !== -1; var isMe = m.id === me.id;
      var row = document.createElement('div'); row.className = 'member-row' + (isOnline ? ' is-online' : '');
      row.innerHTML = '<div class="avatar" style="background:' + m.color + '">' + initials(m.username) + '</div><span class="name">' + escapeHtml(m.username) + '</span>' + (isOnline && !isMe ? '<button class="member-call-btn" title="Video call">📹</button>' : '') + '<span class="dot"></span>';
      if (isOnline && !isMe) row.querySelector('.member-call-btn').addEventListener('click', function(e) { e.stopPropagation(); quickCallMember(m.id); });
      el.appendChild(row);
    });
  }
  async function quickCallMember(userId) { try { var res = await api('/api/dms/start', { method: 'POST', body: JSON.stringify({ userId: userId }) }); if (!dmConversations.find(function(c) { return c.id === res.conversation.id; })) dmConversations.push(res.conversation); renderDmList(); startCall(userId, res.conversation.id, 'video'); } catch (err) { showToast(err.message || 'Could not start call'); } }
  function escapeHtml(str) { var div = document.createElement('div'); div.textContent = str; return div.innerHTML; }
  async function loadDms() { var data = await api('/api/dms'); dmConversations = data.conversations; renderDmList(); }
  function renderDmList() { var list = $('#dm-list'); list.innerHTML = ''; dmConversations.forEach(function(c) { if (!c.otherUser) return; var row = document.createElement('div'); row.className = 'dm-item' + (c.id === currentDmId ? ' active' : ''); row.innerHTML = '<span class="dm-name">' + escapeHtml(c.otherUser.username) + '</span><button class="call-btn" title="Video call">📹</button>'; row.querySelector('.dm-name').addEventListener('click', function() { openDm(c); }); row.querySelector('.call-btn').addEventListener('click', function(e) { e.stopPropagation(); startCall(c.otherUser.id, c.id, 'video'); }); list.appendChild(row); }); }
  async function openDm(convo) {
    clearPendingImage(); if (currentDmId) socket.emit('leave_dm', currentDmId); currentDmId = convo.id; currentChannelId = null; renderDmList();
    $$('.channel-item').forEach(function(el) { el.classList.remove('active'); });
    $('#chat-topbar-hash').textContent = '@'; $('#current-channel-name').textContent = convo.otherUser.username; $('#composer-input').placeholder = 'Message ' + convo.otherUser.username;
    $('#btn-start-call').classList.remove('hidden'); $('#btn-start-call').onclick = function() { startCall(convo.otherUser.id, convo.id, 'video'); };
    setComposerEnabled(true); socket.emit('join_dm', convo.id);
    var messagesEl = $('#messages'); messagesEl.innerHTML = '<div class="empty-state"><p>Loading messages…</p></div>';
    var data = await api('/api/dms/' + convo.id + '/messages'); messagesEl.innerHTML = '';
    if (!data.messages.length) messagesEl.innerHTML = '<div class="empty-state"><h3>No messages yet</h3><p>Say hi to ' + escapeHtml(convo.otherUser.username) + '.</p></div>';
    else data.messages.forEach(appendMessage);
    closeMobileSidebar();
  }
  async function startCall(toUserId, conversationId, callType) { try { callLocalStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: callType === 'video' }); } catch (e) { showToast('Camera/microphone access is needed'); return; } $('#call-local-video').srcObject = callLocalStream; $('#call-overlay').classList.remove('hidden'); $('#call-status').textContent = 'Calling…'; socket.emit('call_user', { toUserId: toUserId, conversationId: conversationId, callType: callType }); }
  async function setupCallPeerConnection(peerSocketId, isCaller) {
    callPc = new RTCPeerConnection(ICE_SERVERS); activeCallSocketId = peerSocketId;
    callLocalStream.getTracks().forEach(function(t) { callPc.addTrack(t, callLocalStream); });
    callPc.onicecandidate = function(e) { if (e.candidate) socket.emit('call_signal', { to: peerSocketId, signal: { type: 'candidate', candidate: e.candidate } }); };
    callPc.ontrack = function(e) { $('#call-remote-video').srcObject = e.streams[0]; $('#call-status').textContent = ''; };
    if (isCaller) { var offer = await callPc.createOffer(); await callPc.setLocalDescription(offer); socket.emit('call_signal', { to: peerSocketId, signal: { type: 'offer', sdp: callPc.localDescription } }); }
  }
  function endCall() { if (callPc) { callPc.close(); callPc = null; } if (callLocalStream) { callLocalStream.getTracks().forEach(function(t) { t.stop(); }); callLocalStream = null; } if (activeCallSocketId) socket.emit('call_end', { to: activeCallSocketId }); activeCallSocketId = null; activeCallMuted = false; activeCallVideoOff = false; $('#call-overlay').classList.add('hidden'); $('#call-remote-video').srcObject = null; $('#call-btn-mute').classList.remove('muted'); $('#call-btn-mute').textContent = '🎙️'; $('#call-btn-video').textContent = '📷'; }

  function initSettingsModal() {
    $('#btn-settings').addEventListener('click', async function() {
      $('#settings-modal-backdrop').classList.remove('hidden');
      try {
        var data = await api('/api/user/profile'); var user = data.user;
        $('#settings-username').value = user.username;
        var settingsInitials = $('#settings-avatar-initials'); var settingsImg = $('#settings-avatar-img');
        if (user.avatarUrl) { settingsInitials.classList.add('hidden'); settingsImg.src = user.avatarUrl; settingsImg.classList.remove('hidden'); $('#btn-remove-avatar').classList.remove('hidden'); }
        else { settingsInitials.classList.remove('hidden'); settingsInitials.textContent = initials(user.username); settingsInitials.style.background = 'linear-gradient(160deg, ' + user.color + ', #00e5ff)'; settingsImg.classList.add('hidden'); $('#btn-remove-avatar').classList.add('hidden'); }
        var secqStatus = $('#secq-status');
        if (user.hasSecurityQuestion) { secqStatus.textContent = '✅ Set: "' + user.securityQuestion + '"'; secqStatus.style.color = '#4ade80'; }
        else { secqStatus.textContent = '⚠️ Not set (needed for password reset)'; secqStatus.style.color = 'var(--accent-pink)'; }
      } catch (err) {}
    });
    $('#settings-modal-close').addEventListener('click', function() { $('#settings-modal-backdrop').classList.add('hidden'); });
    $('#settings-modal-backdrop').addEventListener('click', function(e) { if (e.target.id === 'settings-modal-backdrop') $('#settings-modal-backdrop').classList.add('hidden'); });
    $$('.settings-tab').forEach(function(tab) { tab.addEventListener('click', function() { $$('.settings-tab').forEach(function(t) { t.classList.remove('active'); }); tab.classList.add('active'); var which = tab.dataset.stab; $('#settings-profile').classList.toggle('hidden', which !== 'profile'); $('#settings-appearance').classList.toggle('hidden', which !== 'appearance'); }); });
    $('#form-update-username').addEventListener('submit', async function(e) {
      e.preventDefault(); var fd = new FormData(e.target); var errEl = $('#settings-username-error'); errEl.textContent = '';
      try { var data = await api('/api/user/profile', { method: 'PUT', body: JSON.stringify({ username: fd.get('username') }) }); me = data.user; $('#me-username').textContent = me.username; updateMyAvatar(); if (socket) socket.username = me.username; showToast('Username updated!'); } catch (err) { errEl.textContent = err.message; }
    });
    $('#form-set-secq').addEventListener('submit', async function(e) {
      e.preventDefault(); var fd = new FormData(e.target); var errEl = $('#secq-error'); errEl.textContent = '';
      if (!fd.get('questionIndex') || !fd.get('answer').trim()) { errEl.textContent = 'Choose a question and type an answer'; return; }
      try { await api('/api/security-question', { method: 'POST', body: JSON.stringify({ questionIndex: parseInt(fd.get('questionIndex')), answer: fd.get('answer') }) }); showToast('Security question set!'); $('#secq-status').textContent = '✅ Set'; $('#secq-status').style.color = '#4ade80'; e.target.reset(); } catch (err) { errEl.textContent = err.message; }
    });
    $('#btn-upload-avatar').addEventListener('click', function() { $('#avatar-upload-input').click(); });
    $('#avatar-upload-input').addEventListener('change', async function(e) {
      var file = e.target.files[0]; if (!file) return;
      if (file.size > 8 * 1024 * 1024) { showToast('Image must be under 8MB'); e.target.value = ''; return; }
      try { showToast('Uploading avatar...'); var url = await uploadImage(file); var data = await api('/api/user/profile', { method: 'PUT', body: JSON.stringify({ avatarUrl: url }) }); me = data.user; updateMyAvatar(); var si = $('#settings-avatar-initials'); var simg = $('#settings-avatar-img'); si.classList.add('hidden'); simg.src = url; simg.classList.remove('hidden'); $('#btn-remove-avatar').classList.remove('hidden'); showToast('Avatar updated!'); } catch (err) { showToast(err.message || 'Upload failed'); }
      e.target.value = '';
    });
    $('#btn-remove-avatar').addEventListener('click', async function() {
      try { var data = await api('/api/user/profile', { method: 'PUT', body: JSON.stringify({ avatarUrl: null }) }); me = data.user; updateMyAvatar(); var si = $('#settings-avatar-initials'); var simg = $('#settings-avatar-img'); si.classList.remove('hidden'); si.textContent = initials(me.username); si.style.background = 'linear-gradient(160deg, ' + me.color + ', #00e5ff)'; simg.classList.add('hidden'); $('#btn-remove-avatar').classList.add('hidden'); showToast('Avatar removed'); } catch (err) { showToast(err.message); }
    });
    $$('.theme-card').forEach(function(card) { card.addEventListener('click', function() { applyTheme(card.dataset.theme); }); });
    $$('.wallpaper-card').forEach(function(card) { card.addEventListener('click', function() { var wp = card.dataset.wallpaper; if (wp === 'custom') $('#wallpaper-upload-input').click(); else applyWallpaper(wp); }); });
    $('#wallpaper-upload-input').addEventListener('change', async function(e) {
      var file = e.target.files[0]; if (!file) return;
      if (file.size > 8 * 1024 * 1024) { showToast('Image must be under 8MB'); e.target.value = ''; return; }
      try { var url = await uploadImage(file); localStorage.setItem('orbit_wallpaper_custom', url); applyWallpaper('custom'); showToast('Wallpaper set!'); } catch (err) { showToast(err.message || 'Upload failed'); }
      e.target.value = '';
    });
  }

  function openMobileSidebar() { $('#channel-sidebar').classList.add('mobile-open'); $('#server-rail').classList.add('mobile-open'); $('#sidebar-overlay').classList.remove('hidden'); $('#btn-mobile-menu').classList.add('open'); }
  function closeMobileSidebar() { $('#channel-sidebar').classList.remove('mobile-open'); $('#server-rail').classList.remove('mobile-open'); $('#sidebar-overlay').classList.add('hidden'); $('#btn-mobile-menu').classList.remove('open'); }

  function initAppInteractions() {
    $('#btn-logout').addEventListener('click', logout);
    $('#btn-mobile-menu').addEventListener('click', function() { var sidebar = $('#channel-sidebar'); if (sidebar.classList.contains('mobile-open')) closeMobileSidebar(); else openMobileSidebar(); });
    $('#sidebar-overlay').addEventListener('click', closeMobileSidebar);
    $('#composer').addEventListener('submit', async function(e) {
      e.preventDefault(); var input = $('#composer-input'); var content = input.value.trim(); if (!content && !pendingImageFile) return;
      var imageUrl = null; if (pendingImageFile) { try { imageUrl = await uploadImage(pendingImageFile); } catch (err) { showToast(err.message || 'Image upload failed'); return; } }
      if (currentDmId) socket.emit('send_dm', { conversationId: currentDmId, content: content, imageUrl: imageUrl });
      else if (currentChannelId) socket.emit('send_message', { channelId: currentChannelId, content: content, imageUrl: imageUrl });
      else return;
      input.value = ''; clearPendingImage();
    });
    $('#btn-attach-image').addEventListener('click', function() { if ($('#btn-attach-image').disabled) return; $('#image-input').click(); });
    $('#image-input').addEventListener('change', function(e) {
      var file = e.target.files[0]; if (!file) return;
      if (file.size > 8 * 1024 * 1024) { showToast('Image must be under 8MB'); e.target.value = ''; return; }
      pendingImageFile = file; var reader = new FileReader(); reader.onload = function() { $('#image-preview-img').src = reader.result; $('#image-preview').classList.remove('hidden'); }; reader.readAsDataURL(file);
    });
    $('#image-preview-remove').addEventListener('click', clearPendingImage);
    $('#composer-input').addEventListener('input', function() { if (!currentChannelId) return; clearTimeout(typingTimeout); socket.emit('typing', { channelId: currentChannelId }); typingTimeout = setTimeout(function() {}, 1000); });
    $('#btn-add-server').addEventListener('click', function() { $('#modal-backdrop').classList.remove('hidden'); });
    $('#modal-close').addEventListener('click', function() { $('#modal-backdrop').classList.add('hidden'); });
    $('#modal-backdrop').addEventListener('click', function(e) { if (e.target.id === 'modal-backdrop') $('#modal-backdrop').classList.add('hidden'); });
    $('#form-create-server').addEventListener('submit', async function(e) {
      e.preventDefault(); var fd = new FormData(e.target);
      try { var data = await api('/api/servers', { method: 'POST', body: JSON.stringify({ name: fd.get('name') }) }); servers.push(data.server); $('#modal-backdrop').classList.add('hidden'); e.target.reset(); selectServer(data.server.id); showToast('Team "' + data.server.name + '" created'); } catch (err) { showToast(err.message); }
    });
    $('#form-join-server').addEventListener('submit', async function(e) {
      e.preventDefault(); var fd = new FormData(e.target);
      try { var data = await api('/api/servers/join', { method: 'POST', body: JSON.stringify({ inviteCode: fd.get('inviteCode') }) }); if (!servers.find(function(s) { return s.id === data.server.id; })) servers.push(data.server); $('#modal-backdrop').classList.add('hidden'); e.target.reset(); selectServer(data.server.id); showToast('Joined "' + data.server.name + '"'); } catch (err) { showToast(err.message); }
    });
    $('#btn-add-channel').addEventListener('click', function() { if (!currentServerId) return showToast('Select a team first'); $('#channel-modal-backdrop').classList.remove('hidden'); });
    $('#channel-modal-close').addEventListener('click', function() { $('#channel-modal-backdrop').classList.add('hidden'); });
    $('#channel-modal-backdrop').addEventListener('click', function(e) { if (e.target.id === 'channel-modal-backdrop') $('#channel-modal-backdrop').classList.add('hidden'); });
    $('#form-create-channel').addEventListener('submit', async function(e) {
      e.preventDefault(); var fd = new FormData(e.target);
      try { var data = await api('/api/servers/' + currentServerId + '/channels', { method: 'POST', body: JSON.stringify({ name: fd.get('name') }) }); var server = servers.find(function(s) { return s.id === currentServerId; }); if (server && !server.channels.find(function(c) { return c.id === data.channel.id; })) server.channels.push(data.channel); renderChannels(server); $('#channel-modal-backdrop').classList.add('hidden'); e.target.reset(); selectChannel(data.channel.id, data.channel.name); } catch (err) { showToast(err.message); }
    });
    initTilt($('#server-rail'), 3);
    $('#voice-channel-btn').addEventListener('click', function() { if (!inVoice) joinVoice(); });
    $('#btn-mute').addEventListener('click', toggleMute);
    $('#btn-camera').addEventListener('click', toggleTeamCamera);
    $('#btn-leave-voice').addEventListener('click', leaveVoice);
    $('#dm-search-input').addEventListener('input', async function(e) {
      var q = e.target.value.trim(); var results = $('#dm-search-results'); if (!q) { results.innerHTML = ''; return; }
      try { var data = await api('/api/users/search?q=' + encodeURIComponent(q)); results.innerHTML = ''; data.users.forEach(function(u) { var row = document.createElement('div'); row.className = 'dm-search-result'; row.textContent = u.username; row.addEventListener('click', async function() { var res = await api('/api/dms/start', { method: 'POST', body: JSON.stringify({ userId: u.id }) }); if (!dmConversations.find(function(c) { return c.id === res.conversation.id; })) dmConversations.push(res.conversation); renderDmList(); openDm(res.conversation); $('#dm-search-input').value = ''; results.innerHTML = ''; }); results.appendChild(row); }); } catch (err) {}
    });
    document.addEventListener('click', function(e) { if (!e.target.closest('.dm-search')) $('#dm-search-results').innerHTML = ''; });
    $('#call-btn-end').addEventListener('click', endCall);
    $('#call-btn-mute').addEventListener('click', function() { if (!callLocalStream) return; activeCallMuted = !activeCallMuted; callLocalStream.getAudioTracks().forEach(function(t) { t.enabled = !activeCallMuted; }); $('#call-btn-mute').classList.toggle('muted', activeCallMuted); $('#call-btn-mute').textContent = activeCallMuted ? '🔇' : '🎙️'; });
    $('#call-btn-video').addEventListener('click', function() { if (!callLocalStream) return; activeCallVideoOff = !activeCallVideoOff; callLocalStream.getVideoTracks().forEach(function(t) { t.enabled = !activeCallVideoOff; }); $('#call-btn-video').textContent = activeCallVideoOff ? '🚫' : '📷'; });
  }

  function logout() {
    if (inVoice) leaveVoice(); if (callPc || callLocalStream) endCall();
    currentDmId = null; dmConversations = []; localStorage.removeItem('orbit_token');
    token = null; me = null; servers = []; currentServerId = null; currentChannelId = null;
    if (socket) socket.disconnect();
    $('#app-screen').classList.add('hidden'); $('#auth-screen').classList.remove('hidden');
  }

  loadThemeAndWallpaper();
  initStarfield();
  initAuthScreen();
  requestAnimationFrame(speakingDetectionLoop);

  if (token) {
    api('/api/me').then(function(data) { me = data.user; boot(); }).catch(function() { localStorage.removeItem('orbit_token'); token = null; });
  }
})();
