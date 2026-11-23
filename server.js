const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

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
  const escCsv = (v) => {
    const str = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const pushRow = (arr) => rows.push(arr.map(escCsv).join(','));
  const stageKo = (st) => (st && st.ko ? st.ko.split(' (')[0] : '');

  const rows = [];
  const nowStr = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

  pushRow(['[게임이론 6조] 전쟁 게임(War Game) 전체 결과 보고서', `추출 시각: ${nowStr}`]);
  pushRow([]);

  // 1. 7개 조(표본) 라운드별 요약
  pushRow(['1. 7개 조(표본) 라운드별 종합 요약']);
  pushRow([
    '조', '라운드', '참여 인원(명)', '전체 무기 합계(W_total)', '평균 무기(W)',
    '전세 단계', '자국 보존율(α)', '재분배율(β)', '전쟁 손실률(γ)',
    '초기 소비재 합계(C_total)', '최종 소비재 합계', '전쟁 손실(파괴된 소비재)', '완전 평화 대비 효율(%)'
  ]);
  session.groups.forEach((g) => {
    g.roundsHistory
      .slice()
      .sort((a, b) => a.round - b.round)
      .forEach((r) => {
        const avgW = r.activeCount > 0 ? (r.wTotal / r.activeCount).toFixed(1) : '';
        const peaceMax = r.activeCount * 1000;
        const eff = peaceMax > 0 ? ((r.totalFinalC / peaceMax) * 100).toFixed(1) + '%' : '';
        pushRow([
          `${g.groupId}조`,
          `${r.round}라운드`,
          r.activeCount,
          r.wTotal,
          avgW,
          r.activeCount > 0 ? stageKo(r.stage) : '미참여',
          `${Math.round(r.stage.alpha * 100)}%`,
          `${Math.round(r.stage.beta * 100)}%`,
          `${Math.round(r.stage.gamma * 100)}%`,
          r.cTotal,
          r.totalFinalC.toFixed(1),
          r.socialLoss.toFixed(1),
          eff
        ]);
      });
  });

  pushRow([]);
  pushRow(['2. 조별 개인 누적 순위 및 라운드별 변화 (1~7조 · A~H)']);
  pushRow([
    '조', '조 내 순위', '정부', '이름', '학번',
    '1R 무기(W)', '1R 점수(Cᵢ)', '2R 무기(W)', '2R 점수(Cᵢ)', '3R 무기(W)', '3R 점수(Cᵢ)',
    '3라운드 누적 점수(Cᵢ)', '개인 평균 무기(W)'
  ]);
  session.groups.forEach((g) => {
    const r1 = g.roundsHistory.find((x) => x.round === 1);
    const r2 = g.roundsHistory.find((x) => x.round === 2);
    const r3 = g.roundsHistory.find((x) => x.round === 3);

    const players = g.seats.map((seat, idx) => {
      const d1 = r1?.details[idx];
      const d2 = r2?.details[idx];
      const d3 = r3?.details[idx];
      const activeDs = [d1, d2, d3].filter((d) => d && !d.absent);
      const totalC = activeDs.reduce((acc, d) => acc + d.finalC, 0);
      const avgW = activeDs.length > 0 ? (activeDs.reduce((acc, d) => acc + d.w, 0) / activeDs.length).toFixed(1) : '';
      const name = seat.name || seat.lastName || d3?.name || d2?.name || d1?.name || '';
      const sid = seat.studentId || seat.lastStudentId || d3?.studentId || d2?.studentId || d1?.studentId || '';
      return {
        gov: GOV_CODES[idx],
        name,
        sid,
        d1, d2, d3,
        played: activeDs.length > 0,
        totalC,
        avgW
      };
    });

    const ranked = players.filter((p) => p.played).sort((a, b) => b.totalC - a.totalC);
    const unplayed = players.filter((p) => !p.played);

    ranked.forEach((p, rIdx) => {
      pushRow([
        `${g.groupId}조`,
        `${rIdx + 1}위`,
        `정부 ${p.gov}`,
        p.name,
        p.sid,
        p.d1 && !p.d1.absent ? p.d1.w : '',
        p.d1 && !p.d1.absent ? p.d1.finalC.toFixed(1) : '',
        p.d2 && !p.d2.absent ? p.d2.w : '',
        p.d2 && !p.d2.absent ? p.d2.finalC.toFixed(1) : '',
        p.d3 && !p.d3.absent ? p.d3.w : '',
        p.d3 && !p.d3.absent ? p.d3.finalC.toFixed(1) : '',
        p.totalC.toFixed(1),
        p.avgW
      ]);
    });
    unplayed.forEach((p) => {
      if (p.name || p.sid) {
        pushRow([`${g.groupId}조`, '미제출', `정부 ${p.gov}`, p.name, p.sid, '', '', '', '', '', '', '', '']);
      }
    });
  });

  pushRow([]);
  pushRow(['3. 전체 상세 정산 원시 데이터 (통계 분석용)']);
  pushRow([
    '조', '라운드', '정부', '참여 여부', '이름', '학번',
    '무기(Wᵢ)', '소비재 투입(Kᵢ)', '초기 소비재(Cᵢ)', '자국 보존(α·Cᵢ)', '재분배 획득(β 몫)',
    '최종 소비재 점수(Final Cᵢ)', '전세 단계', '조 무기 합계(W_total)'
  ]);
  session.groups.forEach((g) => {
    g.roundsHistory
      .slice()
      .sort((a, b) => a.round - b.round)
      .forEach((r) => {
        r.details.forEach((d, idx) => {
          const seat = g.seats[idx];
          const name = d.name || seat?.name || seat?.lastName || '';
          const sid = d.studentId || seat?.studentId || seat?.lastStudentId || '';
          pushRow([
            `${g.groupId}조`,
            `${r.round}라운드`,
            `정부 ${GOV_CODES[idx]}`,
            d.absent ? '미참여' : '참여',
            name,
            sid,
            d.absent ? '' : d.w,
            d.absent ? '' : d.k,
            d.absent ? '' : d.initC,
            d.absent ? '' : d.retained.toFixed(1),
            d.absent ? '' : d.redistributed.toFixed(1),
            d.absent ? '' : d.finalC.toFixed(1),
            stageKo(r.stage),
            r.wTotal
          ]);
        });
      });
  });

  pushRow([]);
  pushRow(['4. 3라운드 조별 자유 토의 채팅 기록']);
  pushRow(['조', '시각', '정부', '이름', '협상 메시지']);
  session.groups.forEach((g) => {
    g.chat.forEach((m) => {
      const tStr = m.timestamp ? new Date(m.timestamp).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul' }) : '';
      pushRow([`${g.groupId}조`, tStr, `정부 ${GOV_CODES[m.govId - 1]}`, m.name || '', m.text || '']);
    });
  });

  const csv = '\uFEFF' + rows.join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="war_game_results_kr.csv"');
  res.send(csv);
});

app.get('/api/export.xlsx', async (req, res) => {
  try {
    const wb = new ExcelJS.Workbook();
    wb.creator = '게임이론 6조 War Game';
    wb.created = new Date();

    const stageKo = (st) => (st && st.ko ? st.ko.split(' (')[0] : '미참여');
    const stageFill = (id) => {
      if (id === 'peace') return { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD1FAE5' } };
      if (id === 'conflict') return { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };
      if (id === 'small_war') return { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFEDD5' } };
      if (id === 'world_war') return { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
      return { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } };
    };

    const headerStyle = (row) => {
      row.height = 26;
      row.eachCell((cell) => {
        cell.font = { name: '맑은 고딕', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A8A' } };
        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
          bottom: { style: 'medium', color: { argb: 'FF1E3A8A' } },
          left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
          right: { style: 'thin', color: { argb: 'FFCBD5E1' } }
        };
      });
    };

    const bodyBorder = {
      top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
      bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
      left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
      right: { style: 'thin', color: { argb: 'FFE2E8F0' } }
    };

    // ==================== 시트 1: 7조 종합 요약 ====================
    const ws1 = wb.addWorksheet('1. 7조 종합 요약', { views: [{ state: 'frozen', ySplit: 3 }] });
    ws1.mergeCells('A1:M1');
    const title1 = ws1.getCell('A1');
    title1.value = '⚔️ 게임이론 6조 전쟁 게임(War Game) — 7개 조(표본) 라운드별 종합 요약';
    title1.font = { name: '맑은 고딕', size: 14, bold: true, color: { argb: 'FF0F172A' } };
    title1.alignment = { vertical: 'middle', horizontal: 'left' };
    ws1.getRow(1).height = 30;

    ws1.mergeCells('A2:M2');
    const sub1 = ws1.getCell('A2');
    sub1.value = `추출 시각: ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}  |  구조: 7개 조 × A~H (빈 자리는 미참여 처리)`;
    sub1.font = { name: '맑은 고딕', size: 9, color: { argb: 'FF64748B' } };
    ws1.getRow(2).height = 20;

    const h1 = ws1.addRow([
      '조', '라운드', '참여 인원', '무기 합계(W_total)', '평균 무기(W)',
      '전세 단계', '보존율(α)', '재분배율(β)', '손실률(γ)',
      '초기 소비재(C_total)', '최종 소비재 합계', '전쟁 손실(γ)', '평화 대비 효율(%)'
    ]);
    headerStyle(h1);
    ws1.columns = [
      { width: 9 }, { width: 11 }, { width: 11 }, { width: 17 }, { width: 13 },
      { width: 20 }, { width: 11 }, { width: 11 }, { width: 11 },
      { width: 17 }, { width: 16 }, { width: 15 }, { width: 16 }
    ];

    session.groups.forEach((g) => {
      g.roundsHistory.slice().sort((a, b) => a.round - b.round).forEach((r) => {
        const avgW = r.activeCount > 0 ? Number((r.wTotal / r.activeCount).toFixed(1)) : null;
        const peaceMax = r.activeCount * 1000;
        const eff = peaceMax > 0 ? Number(((r.totalFinalC / peaceMax) * 100).toFixed(1)) : null;
        const row = ws1.addRow([
          `${g.groupId}조`, `${r.round}라운드`, r.activeCount, r.wTotal, avgW,
          r.activeCount > 0 ? stageKo(r.stage) : '미참여',
          `${Math.round(r.stage.alpha * 100)}%`,
          `${Math.round(r.stage.beta * 100)}%`,
          `${Math.round(r.stage.gamma * 100)}%`,
          r.cTotal, Number(r.totalFinalC.toFixed(1)), Number(r.socialLoss.toFixed(1)),
          eff !== null ? `${eff}%` : '-'
        ]);
        row.height = 22;
        row.eachCell((cell, colNum) => {
          cell.font = { name: '맑은 고딕', size: 10, bold: colNum === 1 || colNum === 6 };
          cell.alignment = { vertical: 'middle', horizontal: colNum <= 3 || colNum === 6 || (colNum >= 7 && colNum <= 9) || colNum === 13 ? 'center' : 'right' };
          cell.border = bodyBorder;
          if (colNum === 6) cell.fill = stageFill(r.activeCount > 0 ? r.stage.id : 'none');
        });
      });
    });

    // ==================== 시트 2: 조별 개인 순위 ====================
    const ws2 = wb.addWorksheet('2. 조별 개인 순위', { views: [{ state: 'frozen', ySplit: 2 }] });
    ws2.mergeCells('A1:M1');
    const title2 = ws2.getCell('A1');
    title2.value = '🏆 조별 개인 누적 순위 및 라운드별 전략 변화 (이름 · 학번 포함)';
    title2.font = { name: '맑은 고딕', size: 13, bold: true, color: { argb: 'FF0F172A' } };
    ws2.getRow(1).height = 28;

    const h2 = ws2.addRow([
      '조', '순위', '정부', '이름', '학번',
      '1R 무기', '1R 점수', '2R 무기', '2R 점수', '3R 무기', '3R 점수',
      '3R 누적 점수(Cᵢ)', '평균 무기(W)'
    ]);
    headerStyle(h2);
    ws2.columns = [
      { width: 9 }, { width: 9 }, { width: 10 }, { width: 14 }, { width: 14 },
      { width: 10 }, { width: 11 }, { width: 10 }, { width: 11 }, { width: 10 }, { width: 11 },
      { width: 16 }, { width: 13 }
    ];

    session.groups.forEach((g) => {
      const r1 = g.roundsHistory.find((x) => x.round === 1);
      const r2 = g.roundsHistory.find((x) => x.round === 2);
      const r3 = g.roundsHistory.find((x) => x.round === 3);

      const players = g.seats.map((seat, idx) => {
        const d1 = r1?.details[idx], d2 = r2?.details[idx], d3 = r3?.details[idx];
        const activeDs = [d1, d2, d3].filter((d) => d && !d.absent);
        const totalC = activeDs.reduce((acc, d) => acc + d.finalC, 0);
        const avgW = activeDs.length > 0 ? Number((activeDs.reduce((acc, d) => acc + d.w, 0) / activeDs.length).toFixed(1)) : null;
        const name = seat.name || seat.lastName || d3?.name || d2?.name || d1?.name || '';
        const sid = seat.studentId || seat.lastStudentId || d3?.studentId || d2?.studentId || d1?.studentId || '';
        return { gov: GOV_CODES[idx], name, sid, d1, d2, d3, played: activeDs.length > 0, totalC, avgW };
      });

      const ranked = players.filter((p) => p.played).sort((a, b) => b.totalC - a.totalC);
      ranked.forEach((p, rIdx) => {
        const row = ws2.addRow([
          `${g.groupId}조`, `${rIdx + 1}위`, `정부 ${p.gov}`, p.name, p.sid,
          p.d1 && !p.d1.absent ? p.d1.w : '-', p.d1 && !p.d1.absent ? Number(p.d1.finalC.toFixed(1)) : '-',
          p.d2 && !p.d2.absent ? p.d2.w : '-', p.d2 && !p.d2.absent ? Number(p.d2.finalC.toFixed(1)) : '-',
          p.d3 && !p.d3.absent ? p.d3.w : '-', p.d3 && !p.d3.absent ? Number(p.d3.finalC.toFixed(1)) : '-',
          Number(p.totalC.toFixed(1)), p.avgW
        ]);
        row.height = 21;
        row.eachCell((cell, colNum) => {
          cell.font = { name: '맑은 고딕', size: 10, bold: rIdx === 0 || colNum === 12 };
          cell.alignment = { vertical: 'middle', horizontal: colNum <= 5 ? 'center' : 'right' };
          cell.border = bodyBorder;
          if (rIdx === 0) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF9C3' } };
        });
      });
    });

    // ==================== 시트 3: 전체 원시 데이터 ====================
    const ws3 = wb.addWorksheet('3. 전체 원시 데이터', { views: [{ state: 'frozen', ySplit: 1 }] });
    const h3 = ws3.addRow([
      '조', '라운드', '정부', '참여 여부', '이름', '학번',
      '무기(Wᵢ)', '소비재 투입(Kᵢ)', '초기 소비재(Cᵢ)', '자국 보존(α·Cᵢ)', '재분배 획득(β)',
      '최종 점수(Final Cᵢ)', '전세 단계', '조 무기 합계(W_total)'
    ]);
    headerStyle(h3);
    ws3.columns = [
      { width: 9 }, { width: 10 }, { width: 10 }, { width: 10 }, { width: 13 }, { width: 14 },
      { width: 11 }, { width: 14 }, { width: 14 }, { width: 15 }, { width: 14 },
      { width: 16 }, { width: 18 }, { width: 17 }
    ];

    session.groups.forEach((g) => {
      g.roundsHistory.slice().sort((a, b) => a.round - b.round).forEach((r) => {
        r.details.forEach((d, idx) => {
          const seat = g.seats[idx];
          const name = d.name || seat?.name || seat?.lastName || '';
          const sid = d.studentId || seat?.studentId || seat?.lastStudentId || '';
          const row = ws3.addRow([
            `${g.groupId}조`, `${r.round}라운드`, `정부 ${GOV_CODES[idx]}`, d.absent ? '미참여' : '참여',
            name, sid,
            d.absent ? '' : d.w, d.absent ? '' : d.k, d.absent ? '' : d.initC,
            d.absent ? '' : Number(d.retained.toFixed(1)), d.absent ? '' : Number(d.redistributed.toFixed(1)),
            d.absent ? '' : Number(d.finalC.toFixed(1)), stageKo(r.stage), r.wTotal
          ]);
          row.height = 20;
          row.eachCell((cell, colNum) => {
            cell.font = { name: '맑은 고딕', size: 9.5, color: { argb: d.absent ? 'FF94A3B8' : 'FF1E293B' } };
            cell.alignment = { vertical: 'middle', horizontal: colNum <= 6 || colNum === 13 ? 'center' : 'right' };
            cell.border = bodyBorder;
          });
        });
      });
    });

    // ==================== 시트 4: 3R 협상 채팅 ====================
    const ws4 = wb.addWorksheet('4. 3R 협상 채팅', { views: [{ state: 'frozen', ySplit: 1 }] });
    const h4 = ws4.addRow(['조', '시각', '정부', '이름', '협상 메시지']);
    headerStyle(h4);
    ws4.columns = [{ width: 9 }, { width: 14 }, { width: 10 }, { width: 14 }, { width: 65 }];

    session.groups.forEach((g) => {
      g.chat.forEach((m) => {
        const tStr = m.timestamp ? new Date(m.timestamp).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul' }) : '';
        const row = ws4.addRow([`${g.groupId}조`, tStr, `정부 ${GOV_CODES[m.govId - 1]}`, m.name || '', m.text || '']);
        row.height = 21;
        row.eachCell((cell, colNum) => {
          cell.font = { name: '맑은 고딕', size: 10 };
          cell.alignment = { vertical: 'middle', horizontal: colNum === 5 ? 'left' : 'center', wrapText: true };
          cell.border = bodyBorder;
        });
      });
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="war_game_report.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('XLSX export error:', err);
    res.status(500).send('Failed to generate Excel report');
  }
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