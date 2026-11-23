# War Game Simulation · 실시간 멀티플레이어 서버 (게임이론 6조)

수업 시간에 여러 명이 휴대폰으로 동시접속해 **8개 조(1조~8조) · 3라운드 전쟁 게임**을 진행하고, 진행자(호스트) 화면에서 실시간 제출 현황과 최종 결과를 확인·CSV 다운로드할 수 있는 프로젝트입니다.

## 주요 기능
- **실시간 동시접속 (Socket.io):** 여러 참가자가 휴대폰으로 접속해 `언어 선택(한국어/영어) → 이름·학번 입력 → 1조~8조 선택(또는 자동 배정)` 후 함께 플레이합니다.
- **진행자 대시보드 (`/host`):** 새 방 만들기, 8개 조 접속/제출 현황 실시간 확인, 1·2·3라운드 시작 및 정산 제어, 3라운드 협상 채팅 모니터링, 최종 순위표 및 **CSV 결과 다운로드**를 지원합니다.
- **결과 기록 보관:** 3라운드가 끝나면 `data/sessions.json`에 세션 결과가 자동 저장되어 호스트 화면의 **이전 게임 기록**에서 다시 열어보고 CSV로 내려받을 수 있습니다.

## 1. 내 컴퓨터에서 바로 실행하기
```bash
npm install
npm start
```
- 참가자 접속 화면: `http://localhost:3000`
- 진행자(호스트) 화면: `http://localhost:3000/host` (기본 방 코드: `TEAM06`)

## 2. Render에 무료 배포하기 (`spears-rice-practice.onrender.com` 방식)
1. 이 폴더의 파일들을 GitHub 저장소(Repository)에 업로드합니다.
2. [Render](https://render.com)에 로그인 후 **New + → Web Service**를 선택해 GitHub 저장소를 연결합니다.
3. 설정 확인 (`render.yaml`이 포함되어 있어 자동 인식됩니다):
   - **Environment:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Plan:** `Free`
4. 배포가 완료되면 발급된 URL(`https://your-app.onrender.com`)을 학생들에게 QR코드로 공유하고, 발표자는 `https://your-app.onrender.com/host`에서 라운드를 진행하면 됩니다.
