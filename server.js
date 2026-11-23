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
const HISTORY_FILE = path.join(DATA_DIR, 'sessions_7groups.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

app.use(express.json());
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, 'public', 'index.html'))
  ? path.join(__dirname, 'public')
  : __dirname;
app.use(express.static(PUBLIC_DIR));

// ==================== GAME CONSTANTS ====================
const NUM_GROUPS = 7;     // 7 independent War Game rooms (1조 ~ 7조) => 7 samples
const NUM_GOVS = 8;       // 8 players per group (A ~ H)
const GOV_CODES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const ENDOWMENT = 100;
const GOODS_MULT = 10;

function getStage(wTotal) {
  if (wTotal < 80) return { id: 'peace', alpha: 1.0, beta: 0.0, gamma: 0.0, ko: '평화 (Peace)', en: 'Peace' };
  if (wTotal < 240) return { id: 'conflict', alpha: 0.7, beta: 0.2, gamma: 0.1, ko: '국가간 소규모 분쟁 (Conflict)', en: 'Conflict' };
  if (wTotal < 480) return { id: 'small_war', alpha: 0.45, beta: 0.35, gamma: 0.2, ko: '소규모 전쟁 (Small War)', en: 'Small War' };
  return { id: 'world_war', alpha: 0.2, beta: 0.2, gamma: 0.6, ko: '대규모 전쟁 (World War)', en: 'World War' };
}

function computeGroupPayoffs(weaponsByGov) {
  let wTotal = 0;
  let cTotal = 0;
  let activeCount = 0;
  weaponsByGov.forEach((w) => {
    if (w !== null) {
      wTotal += w;
      cTotal += (ENDOWMENT - w) * GOODS_MULT;
      activeCount += 1;
    }
  });
  const stage = getStage(wTotal);
  const details = weaponsByGov.map((w, idx) => {
    if (w === null) {
      return { govId: idx + 1, absent: true, w: null, k: null, initC: null, retained: null, redistributed: null, finalC: null };
    }
    const k = ENDOWMENT - w;
    const ci = k * GOODS_MULT;
    const retained = stage.alpha * ci;
    const share = wTotal > 0 ? w / wTotal : 0;
    const redistributed = stage.beta * cTotal * share;
    return {
      govId: idx + 1,
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

// ==================== SESSION STATE (7 INDEPENDENT GROUPS) ====================
function createFreshSession() {
  return {
    id: 'TEAM06',
    createdAt: new Date().toISOString(),
    phase: 'lobby', // lobby | round1 | result1 | round2 | result2 | round3 | result3 | final
    currentRound: 0,
    timerEndAt: null,
    groups: Array.from({ length: NUM_GROUPS }, (_, gIdx) => ({
      groupId: gIdx + 1, // 1조 ~ 7조
      seats: Array.from({ length: NUM_GOVS }, (_, sIdx) => ({
        govId: sIdx + 1, // 정부 #1 ~ #8
        socketId: null,
        name: null,
        studentId: null,
        lastName: null,
        lastStudentId: null,
        lang: 'ko',
        currentSubmission: null
      })),
      roundsHistory: [],
      chat: [] // isolated per-group Round 3 negotiation chat
    }))
  };
}

let session = createFreshSession();

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch (e) {}
  return [];
}

function saveSessionSnapshot() {
  const history = loadHistory();
  const snap = {
    savedAt: new Date().toISOString(),
    groups: session.groups.map((g) => ({
      groupId: g.groupId,
      seats: g.seats.map((s) => ({ govId: s.govId, name: s.name, studentId: s.studentId })),
      roundsHistory: g.roundsHistory,
      chat: g.chat.slice(-100)
    }))
  };
  history.unshift(snap);
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(0, 30), null, 2), 'utf8');
  } catch (e) {}
}

function getHostState() {
  return {
    id: session.id,
    phase: session.phase,
    currentRound: session.currentRound,
    timerEndAt: session.timerEndAt,
    groups: session.groups.map((g) => ({
      groupId: g.groupId,
      playerCount: g.seats.filter((s) => s.socketId !== null).length,
      submittedCount: g.seats.filter((s) => s.currentSubmission !== null).length,
      seats: g.seats.map((s) => ({
        govId: s.govId,
        occupied: s.socketId !== null,
        name: s.name || s.lastName,
        studentId: s.studentId || s.lastStudentId,
        submitted: s.currentSubmission !== null
      })),
      roundsHistory: g.roundsHistory,
      chat: g.chat.slice(-100)
    }))
  };
}

function getGroupPublicState(groupId) {
  const g = session.groups[groupId - 1];
  if (!g) return null;
  return {
    phase: session.phase,
    currentRound: session.currentRound,
    timerEndAt: session.timerEndAt,
    groupId: g.groupId,
    seats: g.seats.map((s) => ({
      govId: s.govId,
      occupied: s.socketId !== null,
      name: s.name,
      studentId: s.studentId,
      submitted: s.currentSubmission !== null
    })),
    roundsHistory: g.roundsHistory,
    chat: g.chat.slice(-100)
  };
}

function broadcastAll() {
  io.to('host').emit('host:state', getHostState());
  for (let gId = 1; gId <= NUM_GROUPS; gId++) {
    io.to(`group:${gId}`).emit('group:state', getGroupPublicState(gId));
  }
}

// ==================== REST ENDPOINTS ====================
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('/r/:roomId', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('/host', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'host.html')));

app.get('/api/groups/summary', (req, res) => {
  res.json(
    session.groups.map((g) => ({
      groupId: g.groupId,
      playerCount: g.seats.filter((s) => s.socketId !== null).length,
      openGovs: g.seats.filter((s) => s.socketId === null).map((s) => s.govId)
    }))
  );
});

app.get('/api/export.csv', (req, res) => {
  const rows = [
    ['Group_No', 'Round', 'Gov_Code', 'Status', 'Name', 'StudentID', 'Weapons_W', 'GoodsInput_K', 'Init_C', 'WarStage', 'Group_W_total', 'Group_Active_Count', 'Final_C']
  ];
  session.groups.forEach((g) => {
    g.roundsHistory.forEach((r) => {
      r.details.forEach((d) => {
        const seat = g.seats[d.govId - 1];
        rows.push([
          g.groupId,
          r.round,
          GOV_CODES[d.govId - 1],
          d.absent ? 'ABSENT' : 'ACTIVE',
          (d.name || seat?.name || seat?.lastName) ? `"${String(d.name || seat?.name || seat?.lastName).replace(/"/g, '""')}"` : '',
          (d.studentId || seat?.studentId || seat?.lastStudentId) ? `"${String(d.studentId || seat?.studentId || seat?.lastStudentId).replace(/"/g, '""')}"` : '',
          d.absent ? '' : d.w,
          d.absent ? '' : d.k,
          d.absent ? '' : d.initC,
          r.stage.id,
          r.wTotal,
          r.activeCount,
          d.absent ? '' : d.finalC
        ]);
      });
    });
  });

  const csv = '\uFEFF' + rows.map((row) => row.join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="war_game_7groups_results.csv"');
  res.send(csv);
});

// ==================== SOCKET.IO EVENTS ====================
io.on('connection', (socket) => {
  socket.on('host:join', () => {
    socket.join('host');
    socket.emit('host:state', getHostState());
  });

  socket.on('player:join', ({ name, studentId, groupId, govId, lang }) => {
    const gId = Number(groupId);
    if (!gId || gId < 1 || gId > NUM_GROUPS) {
      socket.emit('player:error', { message: lang === 'en' ? 'Please select a valid group (1–7).' : '1조~7조 중 하나를 선택해 주세요.' });
      return;
    }
    const group = session.groups[gId - 1];

    // Release any previous seat held by this socket
    session.groups.forEach((g) => {
      g.seats.forEach((s) => {
        if (s.socketId === socket.id) {
          s.socketId = null;
          s.name = null;
          s.studentId = null;
          s.currentSubmission = null;
        }
      });
    });

    // Pick requested Gov #1~8 or auto-assign first open seat in that group
    let chosenSeat = null;
    const reqGov = Number(govId);
    if (reqGov >= 1 && reqGov <= NUM_GOVS) {
      const candidate = group.seats[reqGov - 1];
      if (candidate.socketId === null) {
        chosenSeat = candidate;
      } else {
        socket.emit('player:error', {
          message: lang === 'en'
            ? `Group ${gId} Gov ${GOV_CODES[reqGov - 1]} is already taken. Choose another letter or Auto-assign.`
            : `${gId}조의 ${GOV_CODES[reqGov - 1]} 자리는 이미 사용 중입니다. 다른 알파벳이나 자동 배정을 선택해 주세요.`
        });
        return;
      }
    } else {
      chosenSeat = group.seats.find((s) => s.socketId === null);
    }

    if (!chosenSeat) {
      socket.emit('player:error', {
        message: lang === 'en'
          ? `Group ${gId} is full (8/8). Please pick another group.`
          : `${gId}조 정원(8명)이 모두 찼습니다. 다른 조를 선택해 주세요.`
      });
      return;
    }

    chosenSeat.socketId = socket.id;
    chosenSeat.name = String(name || '').trim().slice(0, 20);
    chosenSeat.studentId = String(studentId || '').trim().slice(0, 20);
    chosenSeat.lastName = chosenSeat.name;
    chosenSeat.lastStudentId = chosenSeat.studentId;
    chosenSeat.lang = lang === 'en' ? 'en' : 'ko';

    socket.data = { groupId: gId, govId: chosenSeat.govId, name: chosenSeat.name, studentId: chosenSeat.studentId };
    socket.join(`group:${gId}`);
    socket.emit('player:joined', { groupId: gId, govId: chosenSeat.govId });
    broadcastAll();
  });

  socket.on('player:submit', ({ w }) => {
    if (!socket.data?.groupId || !socket.data?.govId) return;
    if (!['round1', 'round2', 'round3'].includes(session.phase)) return;
    const group = session.groups[socket.data.groupId - 1];
    const seat = group.seats[socket.data.govId - 1];
    if (!seat || seat.socketId !== socket.id) return;
    seat.currentSubmission = Math.max(0, Math.min(100, Math.round(Number(w) || 0)));
    broadcastAll();
  });

  socket.on('player:chat', ({ text }) => {
    if (!socket.data?.groupId || !socket.data?.govId || session.phase !== 'round3') return;
    const clean = String(text || '').trim().slice(0, 160);
    if (!clean) return;
    const group = session.groups[socket.data.groupId - 1];
    group.chat.push({
      govId: socket.data.govId,
      name: socket.data.name,
      text: clean,
      timestamp: new Date().toISOString()
    });
    broadcastAll();
  });

  socket.on('host:startRound', ({ roundNum }) => {
    const r = Number(roundNum);
    if (![1, 2, 3].includes(r)) return;
    session.currentRound = r;
    session.phase = `round${r}`;
    session.timerEndAt = Date.now() + (r === 3 ? 180 : 90) * 1000;
    session.groups.forEach((g) => {
      g.seats.forEach((s) => {
        s.currentSubmission = null;
        if (!s.socketId) { s.lastName = null; s.lastStudentId = null; }
      });
    });
    broadcastAll();
  });

  socket.on('host:settleRound', () => {
    if (!['round1', 'round2', 'round3'].includes(session.phase)) return;
    session.groups.forEach((g) => {
      // No AI bots: unsubmitted/empty seats stay null (ABSENT)
      const weapons = g.seats.map((s) => (s.currentSubmission !== null ? s.currentSubmission : null));
      const res = computeGroupPayoffs(weapons);
      res.round = session.currentRound;
      res.details.forEach((d, idx) => {
        const seat = g.seats[idx];
        d.name = seat.name || seat.lastName || '';
        d.studentId = seat.studentId || seat.lastStudentId || '';
      });
      g.roundsHistory = g.roundsHistory.filter((x) => x.round !== session.currentRound);
      g.roundsHistory.push(res);
    });
    session.phase = `result${session.currentRound}`;
    session.timerEndAt = null;
    if (session.currentRound === 3) saveSessionSnapshot();
    broadcastAll();
  });

  socket.on('host:showFinal', () => {
    session.phase = 'final';
    saveSessionSnapshot();
    broadcastAll();
  });

  socket.on('host:resetAll', () => {
    // Keep currently connected players in their seats, reset rounds/chat/submissions
    session.phase = 'lobby';
    session.currentRound = 0;
    session.timerEndAt = null;
    session.groups.forEach((g) => {
      g.roundsHistory = [];
      g.chat = [];
      g.seats.forEach((s) => { s.currentSubmission = null; });
    });
    broadcastAll();
  });

  socket.on('disconnect', () => {
    if (!socket.data?.groupId || !socket.data?.govId) return;
    const group = session.groups[socket.data.groupId - 1];
    const seat = group?.seats[socket.data.govId - 1];
    if (seat && seat.socketId === socket.id) {
      seat.socketId = null;
      seat.name = null;
      seat.studentId = null;
      seat.currentSubmission = null;
      broadcastAll();
    }
  });
});

server.listen(PORT, () => {
  console.log(`War Game (7 Groups x 8 Govs) Server running on http://localhost:${PORT}`);
});