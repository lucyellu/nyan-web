// multiplayer.js — Firebase Realtime Database lobby + race sync
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getDatabase, ref, set, update, get, onValue, off, remove } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js';

// ── Persistent identity ───────────────────────────────────────────────────────
const myUid = (() => {
    let id = localStorage.getItem('nyan_uid');
    if (!id) { id = Math.random().toString(36).slice(2, 10); localStorage.setItem('nyan_uid', id); }
    return id;
})();

// ── State ─────────────────────────────────────────────────────────────────────
let db = null;
let roomId = null;
let isHost = false;
let myColor = '#00ff88';
let opponentUid = null;
let roomListener = null;
let syncInterval = null;
let countdownTimer = null;

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const makeCode = () => Array.from({length: 4}, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
const el = id => document.getElementById(id);

// ── Firebase init ─────────────────────────────────────────────────────────────
async function initFirebase() {
    try {
        const cfg = await fetch('config.json').then(r => r.json());
        if (!cfg.firebase) throw new Error('no firebase key in config.json');
        const app = initializeApp(cfg.firebase);
        db = getDatabase(app);
        console.log('[MP] Firebase ready');
    } catch (e) {
        console.warn('[MP] Firebase init failed:', e.message);
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function setStatus(id, msg, color) {
    const e = el(id); if (e) { e.textContent = msg; e.style.color = color || '#aaa'; }
}
function showStep(step) {
    ['mpJoinStep','mpRoomStep'].forEach(id => el(id)?.classList.add('hidden'));
    el(step)?.classList.remove('hidden');
}

// ── Open / close lobby ────────────────────────────────────────────────────────
function openLobby() {
    el('mpLobby')?.classList.remove('hidden');
    prepareJoinStep(new URLSearchParams(location.search).get('room'));
}

function closeLobby() {
    el('mpLobby')?.classList.add('hidden');
    leaveRoom();
}

function prepareJoinStep(prefillCode) {
    el('mpNameInput').value = localStorage.getItem('nyan_mp_name') || '';
    if (prefillCode) el('mpCodeInput').value = prefillCode.toUpperCase();
    showStep('mpJoinStep');
    setStatus('mpJoinStatus', '');
}

// ── Room create / join ────────────────────────────────────────────────────────
async function createRoom() {
    if (!db) { setStatus('mpJoinStatus', 'Firebase not connected — check console', '#ff4444'); return; }
    const name = el('mpNameInput').value.trim() || 'Player 1';
    localStorage.setItem('nyan_mp_name', name);
    myColor = '#00ff88'; isHost = true;
    let code = makeCode();
    const snap = await get(ref(db, `rooms/${code}/status`));
    if (snap.exists()) code = makeCode();
    roomId = code;
    await set(ref(db, `rooms/${roomId}`), {
        status: 'lobby', host: myUid, createdAt: Date.now(),
        players: { [myUid]: playerRecord(name, myColor) },
    });
    enterRoom();
}

async function joinRoom() {
    const code = el('mpCodeInput').value.trim().toUpperCase().slice(0,4);
    if (code.length !== 4) { setStatus('mpJoinStatus', 'Enter a 4-letter room code', '#ff4444'); return; }
    if (!db) { setStatus('mpJoinStatus', 'Firebase not connected', '#ff4444'); return; }
    const name = el('mpNameInput').value.trim() || 'Player 2';
    localStorage.setItem('nyan_mp_name', name);
    setStatus('mpJoinStatus', 'Joining…', '#ffaa00');
    const snap = await get(ref(db, `rooms/${code}`));
    if (!snap.exists()) { setStatus('mpJoinStatus', 'Room not found', '#ff4444'); return; }
    const room = snap.val();
    if (room.status !== 'lobby') { setStatus('mpJoinStatus', 'Room already in progress', '#ff4444'); return; }
    if (Object.keys(room.players || {}).length >= 2) { setStatus('mpJoinStatus', 'Room is full', '#ff4444'); return; }
    isHost = false; myColor = '#ffaa00'; roomId = code;
    await set(ref(db, `rooms/${roomId}/players/${myUid}`), playerRecord(name, myColor));
    enterRoom();
}

function playerRecord(name, color) {
    return { name, color, catY: 300, pct: 0, alive: true, ready: false, eliminated: false };
}

// ── Enter room ────────────────────────────────────────────────────────────────
function enterRoom() {
    el('mpRoomCode').textContent = roomId;
    const btn = el('mpReadyBtn');
    btn.textContent = 'Ready ✓'; btn.disabled = false; btn.classList.remove('mp-ready-done');
    showStep('mpRoomStep');
    setStatus('mpLobbyStatus', 'Waiting for players…');

    const shareUrl = new URL(location.href);
    shareUrl.searchParams.set('room', roomId);
    history.replaceState({}, '', shareUrl.toString());
    el('mpCopyLinkBtn').onclick = () =>
        navigator.clipboard.writeText(shareUrl.toString())
            .then(() => { el('mpCopyLinkBtn').textContent = '✓ Copied!'; setTimeout(() => el('mpCopyLinkBtn').textContent = '📋 Copy link', 2000); })
            .catch(() => prompt('Share this link:', shareUrl.toString()));

    const rRef = ref(db, `rooms/${roomId}`);
    if (roomListener) off(rRef);
    roomListener = onValue(rRef, snap => {
        if (!snap.exists()) { setStatus('mpLobbyStatus', 'Room closed', '#ff4444'); return; }
        onRoomUpdate(snap.val());
    });
}

// ── Room update handler ───────────────────────────────────────────────────────
function onRoomUpdate(room) {
    const players = room.players || {};
    const uids = Object.keys(players);

    // Render player list (only if lobby is visible)
    if (!el('mpLobby')?.classList.contains('hidden')) {
        el('mpPlayerList').innerHTML = uids.map(uid => {
            const p = players[uid], isMe = uid === myUid;
            return `<div class="mp-player-row" style="--pc:${p.color}">
                <span style="color:${p.color}">●</span>
                <span class="mp-player-name">${p.name}${isMe ? ' <em>(you)</em>' : ''}</span>
                <span class="mp-player-ready" style="color:${p.ready ? '#00ff88':'#444'}">${p.ready ? '✓ Ready':'…'}</span>
            </div>`;
        }).join('') + (uids.length < 2 ? `<div class="mp-waiting">Waiting for opponent…</div>` : '');
    }

    // Update opponent cat position always (even after lobby closes)
    opponentUid = uids.find(u => u !== myUid) || null;
    if (opponentUid && players[opponentUid]) {
        const op = players[opponentUid];
        window.gameAPI?.setOpponent({ catY: op.catY, pct: op.pct, alive: op.alive, name: op.name, color: op.color });
    }

    // Host triggers countdown when all ready
    if (isHost && room.status === 'lobby' && uids.length >= 2 && uids.every(u => players[u]?.ready))
        update(ref(db, `rooms/${roomId}`), { status: 'countdown', countdownStart: Date.now() });

    if (room.status === 'countdown' && !countdownTimer) runCountdown(room.countdownStart);
    if (room.status === 'active'    && !syncInterval)   startGame();
    if (room.status === 'ended')                        onRaceEnd();
}

async function setReady() {
    if (!roomId) return;
    await update(ref(db, `rooms/${roomId}/players/${myUid}`), { ready: true });
    el('mpReadyBtn').textContent = '✓ Ready!'; el('mpReadyBtn').disabled = true; el('mpReadyBtn').classList.add('mp-ready-done');
    setStatus('mpLobbyStatus', 'Waiting for opponent to ready up…', '#ffaa00');
}

// ── Countdown ─────────────────────────────────────────────────────────────────
function runCountdown(startMs) {
    if (countdownTimer) return;
    const tick = () => {
        const left = 3 - Math.floor((Date.now() - startMs) / 1000);
        if (left > 0) {
            setStatus('mpLobbyStatus', `Starting in ${left}…`, '#ffff00');
            countdownTimer = setTimeout(tick, 400);
        } else {
            countdownTimer = null;
            if (isHost) update(ref(db, `rooms/${roomId}`), { status: 'active', startTs: Date.now() });
        }
    };
    tick();
}

// ── Game running ──────────────────────────────────────────────────────────────
function startGame() {
    el('mpLobby')?.classList.add('hidden');
    window.mpOnGameEnd = onSelfEliminated;

    // Guest reads host's live price
    if (!isHost)
        onValue(ref(db, `rooms/${roomId}/gameState/price`), snap => {
            if (snap.exists()) window.gameAPI?.setLivePrice(snap.val());
        });

    syncInterval = setInterval(() => {
        if (!roomId || !window.gameAPI) return;
        const s = window.gameAPI.getState();
        update(ref(db, `rooms/${roomId}/players/${myUid}`), { catY: Math.round(s.catY), pct: +s.pct.toFixed(2), alive: s.alive });
        if (isHost && window.gameAPI.currentPrice)
            update(ref(db, `rooms/${roomId}/gameState`), { price: window.gameAPI.currentPrice });
    }, 120);
}

async function onSelfEliminated() {
    if (!roomId) return;
    await update(ref(db, `rooms/${roomId}/players/${myUid}`), { eliminated: true, alive: false });
    if (!isHost) return;
    const snap = await get(ref(db, `rooms/${roomId}/players`));
    if (snap.exists() && Object.values(snap.val()).every(p => p.eliminated))
        update(ref(db, `rooms/${roomId}`), { status: 'ended', endTs: Date.now(), reason: 'eliminated' });
}

function onRaceEnd() {
    stopSync();
    if (!window.gameAPI?.isGameOver) window.gameAPI?.endGame('Race Over!');
    if (isHost) setTimeout(() => remove(ref(db, `rooms/${roomId}`)).catch(() => {}), 30000);
}

function stopSync() {
    if (syncInterval) { clearInterval(syncInterval); syncInterval = null; }
    if (countdownTimer) { clearTimeout(countdownTimer); countdownTimer = null; }
    window.mpOnGameEnd = null;
}

// ── Leave / cleanup ───────────────────────────────────────────────────────────
async function leaveRoom() {
    stopSync();
    if (roomId) {
        off(ref(db, `rooms/${roomId}`));
        await remove(ref(db, `rooms/${roomId}/players/${myUid}`)).catch(() => {});
    }
    window.gameAPI?.setOpponent(null);
    roomId = null; isHost = false; opponentUid = null; roomListener = null;
    const url = new URL(location.href);
    url.searchParams.delete('room');
    history.replaceState({}, '', url.toString());
}

// ── Wire DOM ──────────────────────────────────────────────────────────────────
el('mpCreateBtn')   ?.addEventListener('click', createRoom);
el('mpJoinBtn')     ?.addEventListener('click', joinRoom);
el('mpReadyBtn')    ?.addEventListener('click', setReady);
el('mpLeaveBtn')    ?.addEventListener('click', closeLobby);
el('mpCodeInput')   ?.addEventListener('input',   e => { e.target.value = e.target.value.toUpperCase(); });
el('mpCodeInput')   ?.addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });
el('mpLobby')       ?.addEventListener('click',   e => { if (e.target === el('mpLobby')) closeLobby(); });
window.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !el('mpLobby')?.classList.contains('hidden')) closeLobby();
});

window.openMpLobby  = openLobby;
window.closeMpLobby = closeLobby;

// ── Init ──────────────────────────────────────────────────────────────────────
await initFirebase();
const urlRoom = new URLSearchParams(location.search).get('room');
if (urlRoom) openLobby();
