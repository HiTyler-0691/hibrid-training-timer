# Hybrid Training Timer

AMRAP / EMOM / TIME CAP / FOR TIME 블록을 카트처럼 담아 순서를 정하고,
Spotify(목업) · 심박수(Web Bluetooth) · 친구 그룹 심박 공유까지 붙인 운동 타이머 프로토타입.

## 로컬에서 실행하기

```bash
npm install
npm run dev
```

터미널에 뜨는 주소(기본 `http://localhost:5173`)를 데스크톱 브라우저로 열면 바로 확인할 수 있어요.

아이폰에서 같은 와이파이로 접속해서 테스트하려면:

```bash
npm run dev -- --host
```

터미널에 뜨는 `Network:` 주소(`http://192.168.x.x:5173` 형태)를 아이폰 사파리에서 열면 됩니다.
단, **Web Bluetooth(심박 연동)는 HTTPS(보안 컨텍스트)에서만 동작**하므로 로컬 IP 주소에서는
심박 연결 버튼이 실패할 수 있어요. 이 기능까지 테스트하려면 아래 배포 단계를 거쳐 실제 HTTPS
주소에서 열어야 합니다.

## 배포하기 (Vercel 예시)

1. 이 폴더를 GitHub 저장소로 올리기
2. [vercel.com](https://vercel.com)에서 GitHub 계정으로 로그인 → 저장소 Import
3. 프레임워크는 자동으로 Vite로 인식됩니다. Build Command `npm run build`, Output Directory `dist` 그대로 두고 Deploy
4. 발급된 `https://your-app.vercel.app` 주소가 실제 사용 주소예요

Netlify도 거의 동일합니다 (Build command: `npm run build`, Publish directory: `dist`).

## 아이폰 홈 화면에 앱처럼 추가하기

배포된 주소를 아이폰 사파리로 연 뒤, 공유 버튼 → **홈 화면에 추가**를 누르면
아이콘을 탭해서 브라우저 주소창 없이 앱처럼 열 수 있어요.

## 지금 남아있는 목업/제약 (다음 단계)

이 구조는 "배포 가능한 프로젝트 뼈대"까지만 잡은 상태예요. 실제 서비스로 쓰려면 아래가 더 필요합니다.

- **Spotify 연동**: `src/App.jsx`의 `SpotifyPanel`은 아직 목업이에요. [developer.spotify.com](https://developer.spotify.com)에서
  본인 앱을 등록(Client ID 발급)하고, Authorization Code with PKCE 플로우 + Web API/Web Playback SDK 호출을 붙여야 합니다.
- **친구 그룹 심박 공유**: `pushGroupHR` / `fetchGroupRoster` 함수는 원래 Claude 아티팩트 전용 저장소(`window.storage`)를 쓰도록
  만들어졌는데, 이 프로젝트에서는 같은 기기 안에서만 동작하는 `localStorage`로 대체해뒀어요(친구의 다른 기기와는 공유 안 됨).
  실제로 여러 사람이 함께 쓰려면 Firebase Realtime Database나 Supabase 같은 실시간 백엔드로 교체해야 해요.
- **아이폰에서 Web Bluetooth**: 사파리는 기본적으로 Web Bluetooth를 지원하지 않아요. Bluefy 같은 블루투스 지원 브라우저나
  beacio 계열 Safari 확장을 설치해야 심박 연결 버튼이 동작합니다.
- **화면 꺼짐 방지**: 운동 중 화면이 꺼지면 타이머가 멈출 수 있어요. Wake Lock API(`navigator.wakeLock`)를 추가하면 개선됩니다.

## 폴더 구조

```
hybrid-training-timer/
├── index.html
├── package.json
├── vite.config.js
└── src/
    ├── main.jsx
    └── App.jsx     ← 타이머, 블록 빌더, Spotify(목업), 심박 연동 전체 로직
```
