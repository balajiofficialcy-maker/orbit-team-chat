# 🪐 Orbit — real-time team chat for your hackathon squad

A Discord-style chat app: teams (servers), channels, live messaging, invite codes,
online presence, typing indicators — with a premium dark "mission control" 3D look.
Full backend included. No paid services, no external database to set up.

---

## 1. Requirements

- [Node.js](https://nodejs.org) version 18 or newer (that's it — nothing else to install on your machine).

Check you have it:
```bash
node -v
```

## 2. Run it (copy-paste these two commands)

Unzip this folder, open a terminal inside it, then run:

```bash
npm install
npm start
```

Then open **http://localhost:3000** in your browser. That's the whole setup.

Everyone on your team can use it in one of two ways:
- **Same WiFi**: find your computer's local IP (e.g. `ipconfig`/`ifconfig` → something like `192.168.1.23`) and have teammates open `http://192.168.1.23:3000`.
- **Public URL for the weekend**: run `npx localtunnel --port 3000` (or use ngrok) to get a public link you can share — no deployment needed.

## 3. How to use it

1. Create an account (top-right tab on the sign-in card).
2. Click the **+** icon on the left rail to create a team, or join one with an invite code a teammate shares with you.
3. Each team starts with `#general` and `#ideas` channels — add more with the **+** next to "Text channels."
4. Click the invite pill under your team name to copy the invite code and send it to teammates.
5. Chat in real time — messages, presence (green dot = online), and typing indicators all sync instantly over WebSockets.

## 4. Voice & video chat 🎙️🎥

Every team has one "Team Voice" room (see the **Voice** section in the sidebar, under
your text channels):

1. Click **🔊 Team Voice** — your browser will ask for microphone permission, allow it.
2. You'll see everyone currently in the call listed, with a green glow around their
   avatar when they're actively talking.
3. Use the bar at the bottom of the sidebar to **mute/unmute** (🎙️/🔇), **turn your camera
   on/off** (🎥, turns blue when active), or **leave** (📞) the call.
4. When anyone turns their camera on, a strip of video tiles appears above the messages —
   this is a shared group video call for the whole team, not just 1:1.

This is peer-to-peer audio/video (WebRTC) — the server only relays connection setup, never
the media itself, so there's nothing extra to configure. It works great on the same WiFi/LAN.
If teammates are joining from very different networks (e.g. through a strict corporate
firewall), some peer connections may fail to establish since only a public STUN server is
used and no TURN relay is configured — for a hackathon on shared WiFi this is rarely an
issue, but if you hit it, look into adding a TURN server (e.g. via [Twilio](https://www.twilio.com/docs/stun-turn) or [Metered](https://www.metered.ca/tools/openrelay/)) to `ICE_SERVERS` in `public/app.js`.

## 5. Direct messages & 1:1 video calls 💬📹

- Click **Direct Messages** at the top of the sidebar, search for a teammate by username, and click their name to start a private 1:1 chat — separate from any team channel.
- Start a video call two ways:
  - Click the 📹 button next to any teammate's name in the **Team** list on the right (works even if you haven't messaged them before — it starts a DM automatically).
  - Or click the 📹 icon next to a DM in the sidebar, or in the chat topbar once that DM is open.
- The other person gets an accept/decline prompt, then you're both in a full-screen call view with mute, camera, and end-call controls.
- Calls are peer-to-peer WebRTC, same as voice chat — the server just relays the initial handshake, never the audio/video itself.

## 6. Image sharing 📎

Click the 📎 icon in the message box (in any channel or DM) to attach an image (PNG/JPG/GIF/WEBP,
up to 8MB). You'll see a small preview before sending — click the ✕ on it to remove it. Sent images
show inline in the chat and can be clicked to view full-size. Uploaded files are saved to
`data/uploads/` on the server.

## 7. Where your data lives

Everything (accounts, teams, channels, messages) is stored in a plain file at `data/db.json`,
created automatically the first time you run the app. Nothing leaves your machine — there's no
external database or cloud service involved. To wipe all data, stop the server and delete `data/db.json`.

## 8. Project structure

```
orbit/
├── server.js          # Express REST API + Socket.io real-time backend
├── db.js               # Tiny file-based database (data/db.json)
├── package.json
├── data/                # created automatically, holds db.json
└── public/
    ├── index.html       # app shell (auth screen + main app)
    ├── style.css         # the "premium 3D space" visual design
    └── app.js             # frontend logic: auth, sockets, rendering
```

## 9. Notes for judges / customizing further

- Auth uses JWT + bcrypt password hashing — passwords are never stored in plain text.
- Real-time layer is Socket.io: message send/receive, presence, typing indicators, and
  live channel/member updates all happen over WebSockets, no polling.
- The visual design uses CSS 3D transforms (perspective, rotateX/Y) for the tilting
  login card and server icons, plus an animated starfield canvas background.
- Voice chat is peer-to-peer WebRTC audio; the server (`server.js`) only relays
  offers/answers/ICE candidates over Socket.io (`voice_join`, `voice_signal`, `voice_leave`).
- Want to add video, file uploads, or roles/permissions next? The data model in
  `db.js` (`users`, `servers`, `members`, `channels`, `messages`) is a clean starting
  point to extend — e.g. add a `role` field on `members` for admin/mod permissions.
- To run on a different port: `PORT=4000 npm start`.

Good luck at the hackathon 🚀
