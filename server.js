const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'sessions.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

app.use(express.json());
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, 'public', 'index.html'))
  ? path.join(__dirname, 'public')
  : __dirname;
app.use(express.static(PUBLIC_DIR));

// ==================== GAME CONSTANTS ====================
const NUM_TEAMS = 8;
const ENDOWMENT = 100;
const GOODS_MULT = 10;

function getStage(wTotal) {
  if (wTotal < 80) return { id: 'peace', alpha: 1.0, beta: 0.0, gamma: 0.0, ko: '평화 (Peace)', en: 'Peace' };
  if (wTotal < 240) return { id: 'conflict', alpha: 0.7, beta: 0.2, gamma: 0.1, ko: '국가간 소규모 분쟁 (Conflict)', en: 'Conflict' };
  if (wTotal < 480) return { id: 'small_war', alpha: 0.45, beta: 0.35, gamma: 0.2, ko: '소규모 전쟁 (Small War)', en: 'Small War' };
  return { id: 'world_war', alpha: 0.2, beta: 0.2, gamma: 0.6, ko: '대규모 전쟁 (World War)', en: 'World War' };
}

function computePayoffs(weaponsByTeam) {
  let wTotal = 0;
  let cTotal = 0;
  let activeCount = 0;
  weaponsByTeam.forEach((w) => {
    if (w !== null) {
      wTotal += w;
      cTotal += (ENDOWMENT - w) * GOODS_MULT;
      activeCount += 1;
    }
  });
  const stage = getStage(wTotal);
  const details = weaponsByTeam.map((w, idx) => {
    if (w === null) {
      return { teamId: idx + 1, absent: true, w: null, k: null, initC: null, retained: null, redistributed: null, finalC: null };
    }
    const k = ENDOWMENT - w;
    const ci = k * GOODS_MULT;
    const retained = stage.alpha * ci;
    const share = wTotal > 0 ? w / wTotal : 0;
    const redistributed = stage.beta * cTotal * share;
    return {
      teamId: idx + 1,
      absent: false,
      w,
      k,
      initC: ci,
      retained: Number(retained.toFixed(2)),
      redistributed: Number(redistributed.toFixed(2)),
      finalC: Number((retained + redistributed).toFixed(2))
    };
  });
  const totalFinalC = Number(details.reduce((a, d) => a + (d.absent ? 0 : d.finalC), 0).toFixed(2));
  const socialLoss = Number((stage.gamma * cTotal).toFixed(2));
  return { wTotal, cTotal, totalFinalC, socialLoss, activeCount, stage, details };
}

// ==================== PERSISTENT HISTORY ====================
function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('Failed to read history:', err);
  }
  return [];
}

function saveSessionToHistory(room) {
  const history = loadHistory();
  const record = {
    roomId: room.id,
    createdAt: room.createdAt,
    completedAt: new Date().toISOString(),
    teams: room.teams.map((t) => ({
      teamId: t.teamId,
      members: t.members.map((m) => ({ name: m.name, studentId: m.studentId, isLeader: m.isLeader }))
    })),
    roundsHistory: room.roundsHistory,
    r3ChatCount: room.chat.length
  };
  const idx = history.findIndex((h) => h.roomId === room.id);
  if (idx >= 0) history[idx] = record;
  else history.unshift(record);
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(0, 50), null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save history:', err);
  }
}

// ==================== IN-MEMORY ROOMS ====================
const rooms = new Map();

function generateRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

function createRoom(customId) {
  const id = (customId || generateRoomId()).toUpperCase();
  const room = {
    id,
    createdAt: new Date().toISOString(),
    phase: 'lobby', // lobby | round1 | result1 | round2 | result2 | round3 | result3 | final
    currentRound: 0,
    timerEndAt: null,
    teams: Array.from({ length: NUM_TEAMS }, (_, i) => ({
      teamId: i + 1,
      members: [], // { socketId, name, studentId, lang, isLeader }
      currentSubmission: null, // integer 0..100 or null
      r3Pledge: null
    })),
    roundsHistory: [],
    chat: [] // { teamId, name, text, timestamp }
  };
  rooms.set(id, room);
  return room;
}

// Create a default room on boot so immediate testing works
const defaultRoom = createRoom('TEAM06');

function getPublicRoomState(room) {
  return {
    id: room.id,
    phase: room.phase,
    currentRound: room.currentRound,
    timerEndAt: room.timerEndAt,
    teams: room.teams.map((t) => ({
      teamId: t.teamId,
      memberCount: t.members.length,
      members: t.members.map((m) => ({ name: m.name, studentId: m.studentId, isLeader: m.isLeader })),
      submitted: t.currentSubmission !== null,
      r3Pledge: t.r3Pledge
    })),
    roundsHistory: room.roundsHistory,
    chat: room.chat.slice(-100)
  };
}

function broadcastRoom(room) {
  io.to(room.id).emit('room:state', getPublicRoomState(room));
}

// ==================== REST ENDPOINTS ====================
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('/host', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'host.html')));
app.get('/r/:roomId', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

app.post('/api/rooms', (req, res) => {
  const room = createRoom();
  res.json({ roomId: room.id });
});

app.get('/api/rooms/:roomId', (req, res) => {
  const room = rooms.get(req.params.roomId.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json(getPublicRoomState(room));
});

app.get('/api/history', (req, res) => {
  res.json(loadHistory());
});

app.get('/api/rooms/:roomId/export.csv', (req, res) => {
  const roomId = req.params.roomId.toUpperCase();
  const live = rooms.get(roomId);
  const archived = !live ? loadHistory().find((h) => h.roomId === roomId) : null;
  const source = live || archived;
  if (!source) return res.status(404).send('Room not found');

  const rows = [['RoomID', 'Round', 'Team_No', 'Members', 'Weapons_W', 'GoodsInput_K', 'Init_C', 'WarStage', 'W_total', 'Final_C']];
  source.roundsHistory.forEach((r) => {
    r.details.forEach((d) => {
      const t = source.teams.find((x) => x.teamId === d.teamId);
      const memberStr = t ? t.members.map((m) => `${m.name}(${m.studentId})`).join(' / ') : '';
      rows.push([
        roomId,
        r.round,
        d.teamId,
        `"${memberStr.replace(/"/g, '""')}"`,
        d.absent ? '' : d.w,
        d.absent ? '' : d.k,
        d.absent ? '' : d.initC,
        r.stage.id,
        r.wTotal,
        d.absent ? '' : d.finalC
      ]);
    });
  });

  const csv = '\uFEFF' + rows.map((r) => r.join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="war_game_${roomId}.csv"`);
  res.send(csv);
});

// ==================== SOCKET.IO EVENTS ====================
io.on('connection', (socket) => {
  socket.on('host:join', ({ roomId }) => {
    const id = (roomId || defaultRoom.id).toUpperCase();
    const room = rooms.get(id) || createRoom(id);
    socket.join(room.id);
    socket.emit('room:state', getPublicRoomState(room));
  });

  socket.on('player:join', ({ roomId, name, studentId, teamId, lang }) => {
    const id = (roomId || defaultRoom.id).toUpperCase();
    const room = rooms.get(id);
    if (!room) {
      socket.emit('player:error', { message: 'Room not found.' });
      return;
    }

    // Auto-assign to least populated team if teamId not specified
    let chosenId = Number(teamId);
    if (!chosenId || chosenId < 1 || chosenId > NUM_TEAMS) {
      const sorted = room.teams.slice().sort((a, b) => a.members.length - b.members.length);
      chosenId = sorted[0].teamId;
    }

    // Remove previous membership if rejoining
    room.teams.forEach((t) => {
      t.members = t.members.filter((m) => m.socketId !== socket.id);
    });

    const team = room.teams[chosenId - 1];
    const isLeader = team.members.length === 0;
    team.members.push({
      socketId: socket.id,
      name: String(name || '').trim().slice(0, 20),
      studentId: String(studentId || '').trim().slice(0, 20),
      lang: lang === 'en' ? 'en' : 'ko',
      isLeader
    });

    socket.data = { roomId: room.id, teamId: chosenId, name, studentId, isLeader };
    socket.join(room.id);
    socket.emit('player:joined', { roomId: room.id, teamId: chosenId, isLeader });
    broadcastRoom(room);
  });

  socket.on('player:submit', ({ roomId, w }) => {
    const room = rooms.get(String(roomId || '').toUpperCase());
    if (!room || !socket.data?.teamId) return;
    if (!['round1', 'round2', 'round3'].includes(room.phase)) return;

    const val = Math.max(0, Math.min(100, Math.round(Number(w))));
    const team = room.teams[socket.data.teamId - 1];
    team.currentSubmission = val;
    broadcastRoom(room);
  });

  socket.on('player:chat', ({ roomId, text, pledgeW }) => {
    const room = rooms.get(String(roomId || '').toUpperCase());
    if (!room || !socket.data?.teamId || room.phase !== 'round3') return;
    const clean = String(text || '').trim().slice(0, 160);
    if (!clean) return;

    if (pledgeW !== undefined && pledgeW !== null) {
      room.teams[socket.data.teamId - 1].r3Pledge = Math.max(0, Math.min(100, Math.round(Number(pledgeW))));
    }

    room.chat.push({
      teamId: socket.data.teamId,
      name: socket.data.name,
      text: clean,
      timestamp: new Date().toISOString()
    });
    broadcastRoom(room);
  });

  socket.on('host:startRound', ({ roomId, roundNum }) => {
    const room = rooms.get(String(roomId || '').toUpperCase());
    if (!room) return;
    const r = Number(roundNum);
    if (![1, 2, 3].includes(r)) return;

    room.currentRound = r;
    room.phase = `round${r}`;
    const durationSec = r === 3 ? 180 : 90;
    room.timerEndAt = Date.now() + durationSec * 1000;
    room.teams.forEach((t) => {
      t.currentSubmission = null;
      if (r === 3) t.r3Pledge = null;
    });
    broadcastRoom(room);
  });

  socket.on('host:settleRound', ({ roomId }) => {
    const room = rooms.get(String(roomId || '').toUpperCase());
    if (!room || !['round1', 'round2', 'round3'].includes(room.phase)) return;

    // Absent / unsubmitted teams stay null (never filled with AI or fake averages)
    const weapons = room.teams.map((t) => (t.currentSubmission !== null ? t.currentSubmission : null));
    const result = computePayoffs(weapons);
    result.round = room.currentRound;
    room.roundsHistory = room.roundsHistory.filter((x) => x.round !== room.currentRound);
    room.roundsHistory.push(result);
    room.phase = `result${room.currentRound}`;
    room.timerEndAt = null;

    if (room.currentRound === 3) {
      saveSessionToHistory(room);
    }
    broadcastRoom(room);
  });

  socket.on('host:showFinal', ({ roomId }) => {
    const room = rooms.get(String(roomId || '').toUpperCase());
    if (!room) return;
    room.phase = 'final';
    saveSessionToHistory(room);
    broadcastRoom(room);
  });

  socket.on('disconnect', () => {
    if (!socket.data?.roomId) return;
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    const team = room.teams[socket.data.teamId - 1];
    if (!team) return;
    team.members = team.members.filter((m) => m.socketId !== socket.id);
    if (team.members.length > 0 && !team.members.some((m) => m.isLeader)) {
      team.members[0].isLeader = true;
    }
    broadcastRoom(room);
  });
});

server.listen(PORT, () => {
  console.log(`War Game Multiplayer Server running on http://localhost:${PORT}`);
  console.log(`Default Room: ${defaultRoom.id} | Host Dashboard: http://localhost:${PORT}/host`);
});