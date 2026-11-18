// Servidor de TAG: administra las salas y las reglas (quién la tiene, tiempo, puntos, portales).
// Cada jugador mueve su propio personaje en su pantalla y manda su posición; el servidor la reparte
// a los demás. Así cada jugador tiene un solo viaje hasta el servidor (el menor ping posible).
const http = require('http');
const { WebSocketServer } = require('ws');
const { WW, WH, S, PW, PH, MAXP, PT_EVERY, MAPS, SPAWNS } = require('./shared.js');

const srv = http.createServer((q, r) => {
  r.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  r.end('TAG server ok');
});
const wss = new WebSocketServer({ server: srv, maxPayload: 2048, perMessageDeflate: false });
const rooms = new Map();
const RD = [20, 30, 40, 60, 90, 120], PD = [5, 10, 15, 20, 30];
const ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const send = (w, o) => { if (w.readyState === 1) w.send(JSON.stringify(o)); };
const cnt = r => r.pl.filter(Boolean).length;
const clean = (s, n) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);
const pwOf = s => String(s || '').slice(0, 20);

function mkRoom(nm, pw, rd, pd) {
  let code;
  do { code = Array.from({ length: 4 }, () => ABC[Math.random() * ABC.length | 0]).join(''); } while (rooms.has(code));
  return { code, nm, pw, rd, pd, pl: Array(MAXP).fill(null), hs: -1, ph: 'lobby', map: 0, tf: 0, lo: -1, rn: 0,
           po: [], pt: 0, pcn: 0, cd: 0, ow: 0, sd: 1, pdirty: 0, sc2: 0 };
}
function pickIt(r) {
  const o = r.pl.filter(Boolean);
  o.forEach(p => (p.it = 0));
  o[Math.random() * o.length | 0].it = 1;
}
function startRound(r) {
  r.map = Math.random() * MAPS.length | 0; r.rn++; r.po = []; r.pt = 240;
  r.tf = r.rd * 60; r.cd = 90; r.lo = -1; r.ph = 'play';
  r.pl.forEach((p, i) => { if (p) { p.x = SPAWNS[i][0]; p.y = SPAWNS[i][1]; } });
  pickIt(r); r.sd = 1; r.pdirty = 1;
}
function portalSpot(r, avoid) {
  const o = MAPS[r.map], fl = o.r.filter(q => q[2] >= 50 && q[3] <= 30), bad = o.h.concat(o.s);
  for (let t = 0; t < 60; t++) {
    const q = fl[Math.random() * fl.length | 0], x = q[0] + 4 + Math.random() * (q[2] - PW - 8), y = q[1] - PH;
    if (avoid.some(a => Math.hypot(a[0] - x, a[1] - y) < 450)) continue;
    if (bad.some(z => x < z[0] + z[2] + 10 && x + PW > z[0] - 10 && y < z[1] + z[3] && y + PH > z[1])) continue;
    if (r.po.some(w => Math.hypot(w[0] - x, w[1] - y) < 80 || Math.hypot(w[2] - x, w[3] - y) < 80)) continue;
    if (r.pl.some(p => p && Math.abs(p.x - x) < 90 && Math.abs(p.y - y) < 90)) continue;
    return [x, y];
  }
  return null;
}
function newPortals(r) {
  const a = portalSpot(r, []); if (!a) return;
  const b = portalSpot(r, [a]); if (!b) return;
  r.po.push([a[0], a[1], b[0], b[1], 0, r.pd * 60, r.pcn++ % 3]); r.sd = 1;
}
function tickRoom(r) {
  if (r.ph === 'lobby') return;
  if (r.ph === 'play' && --r.pt <= 0) { r.pt = PT_EVERY; if (r.po.length < 3) newPortals(r); }
  r.po.forEach(q => { q[4]++; q[5]--; });
  const L = r.po.length; r.po = r.po.filter(q => q[5] > 0); if (r.po.length !== L) r.sd = 1;
  if (r.ph === 'play') {
    if (r.cd > 0) r.cd--;
    else {
      const a = r.pl.find(p => p && p.it);
      if (a) for (const q of r.pl) {
        if (q && q !== a && Math.abs(q.x - a.x) < S + 2 && Math.abs(q.y - a.y) < S + 2) { a.it = 0; q.it = 1; r.cd = 60; r.sd = 1; break; }
      }
    }
    if (--r.tf <= 0) {
      r.lo = r.pl.findIndex(p => p && p.it);
      r.pl.forEach(p => { if (p && !p.it) p.sc++; });
      r.ph = 'over'; r.ow = 200; r.sd = 1;
    }
  } else if (--r.ow <= 0) {
    if (cnt(r) >= 2) startRound(r); else { r.ph = 'lobby'; r.po = []; r.sd = 1; }
  }
}
const stateMsg = r => JSON.stringify({
  t: 's', ph: r.ph, map: r.map, tf: Math.max(0, r.tf), lo: r.lo, rn: r.rn, hs: r.hs,
  on: r.pl.map(p => (p ? 1 : 0)), it: r.pl.map(p => (p && p.it ? 1 : 0)), sc: r.pl.map(p => (p ? p.sc : 0)),
  po: r.po.map(q => [q[0] | 0, q[1] | 0, q[2] | 0, q[3] | 0, q[4], q[5], q[6]])
});
const posMsg = r => JSON.stringify({ t: 'p', a: r.pl.flatMap(p => (p ? [Math.round(p.x), Math.round(p.y)] : [0, 0])) });
function bcast(r, s, isPos) {
  for (const p of r.pl) {
    if (p && p.ws.readyState === 1 && (!isPos || p.ws.bufferedAmount < 16384)) p.ws.send(s); // si un jugador va atrasado, se saltea este cuadro
  }
}
function flush(r) {
  if (r.sd || ++r.sc2 >= 30) { r.sd = 0; r.sc2 = 0; bcast(r, stateMsg(r), false); }
  if (r.pdirty) { r.pdirty = 0; bcast(r, posMsg(r), true); }
}
function enter(ws, r) {
  const i = r.pl.findIndex(p => !p);
  r.pl[i] = { ws, x: SPAWNS[i][0], y: SPAWNS[i][1], it: 0, sc: 0 };
  if (r.hs < 0 || !r.pl[r.hs]) r.hs = i;
  ws.room = { r, i };
  send(ws, { t: 'hi', i, code: r.code, nm: r.nm, lk: r.pw ? 1 : 0, rd: r.rd, pd: r.pd });
  r.sd = 1; r.pdirty = 1;
}
function leave(ws) {
  const a = ws.room; if (!a) return;
  ws.room = null;
  const r = a.r, p = r.pl[a.i];
  r.pl[a.i] = null;
  if (!cnt(r)) { rooms.delete(r.code); return; }
  if (r.hs === a.i) r.hs = r.pl.findIndex(Boolean);
  if (cnt(r) < 2 && r.ph !== 'lobby') { r.ph = 'lobby'; r.po = []; }
  else if (p && p.it && r.ph === 'play') pickIt(r);
  r.sd = 1; r.pdirty = 1;
}

wss.on('connection', ws => {
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    switch (m.t) {
      case 'u': { // posición del propio jugador
        const a = ws.room; if (!a) return;
        const r = a.r, p = r.pl[a.i];
        if (!p || m.r !== r.rn) return;
        const x = +m.x, y = +m.y; if (!isFinite(x) || !isFinite(y)) return;
        p.x = Math.max(0, Math.min(WW - S, x)); p.y = Math.max(-200, Math.min(WH + 100, y));
        r.pdirty = 1; break;
      }
      case 'ping': send(ws, { t: 'pong', ts: +m.ts || 0 }); break;
      case 'list': send(ws, { t: 'rooms', r: [...rooms.values()].map(r => [r.code, r.nm, r.pw ? 1 : 0, cnt(r), MAXP]) }); break;
      case 'create': {
        if (ws.room) leave(ws);
        if (rooms.size >= 60) return send(ws, { t: 'err', m: 'many' });
        const nm = clean(m.nm, 24); if (!nm) return send(ws, { t: 'err', m: 'inv' });
        const r = mkRoom(nm, pwOf(m.pw), RD.includes(+m.rd) ? +m.rd : 40, PD.includes(+m.pd) ? +m.pd : 15);
        rooms.set(r.code, r); enter(ws, r); break;
      }
      case 'join': {
        if (ws.room) leave(ws);
        const r = rooms.get(String(m.code || '').toUpperCase());
        if (!r) return send(ws, { t: 'err', m: 'nf' });
        if (r.pw && pwOf(m.pw) !== r.pw) { if ((ws.bad = (ws.bad || 0) + 1) > 8) ws.close(); return send(ws, { t: 'err', m: 'bad' }); }
        if (cnt(r) >= MAXP) return send(ws, { t: 'err', m: 'full' });
        enter(ws, r); break;
      }
      case 'start': {
        const a = ws.room; if (!a) return;
        const r = a.r;
        if (r.hs === a.i && r.ph === 'lobby' && cnt(r) >= 2) startRound(r);
        break;
      }
      case 'leave': leave(ws); break;
    }
  });
  ws.on('close', () => leave(ws));
  ws.on('error', () => {});
});

// Reloj del juego: 60 pasos por segundo, y se reparten las posiciones en cada paso
const DT = 1000 / 60;
let last = performance.now(), acc = 0;
setInterval(() => {
  const now = performance.now(); acc += Math.min(now - last, 200); last = now;
  let ticked = false;
  while (acc >= DT) { acc -= DT; rooms.forEach(tickRoom); ticked = true; }
  if (ticked) rooms.forEach(flush);
}, 5);

// Mantiene vivas las conexiones y limpia las muertas
setInterval(() => {
  wss.clients.forEach(w => { if (!w.alive) return w.terminate(); w.alive = false; w.ping(); });
}, 20000);

srv.listen(process.env.PORT || 8080, () => console.log('TAG server listo'));
