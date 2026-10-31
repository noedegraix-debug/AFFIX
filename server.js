/**
 * AFFIX — serveur complet
 * - Sert l'app (index.html) sur "/"
 * - Reçoit les postbacks Blue Affiliates sur /postback
 * - Stocke comptes, messages, retraits côté serveur (les sous-affiliés se connectent
 *   depuis leur propre téléphone)
 *
 * Stockage : Postgres si DATABASE_URL est défini (recommandé, durable), sinon fichiers
 * JSON dans DATA_DIR (⚠️ effacés à chaque redémarrage sur Render gratuit).
 *
 * Variables : DATABASE_URL (optionnel), code admin par défaut Admin2024 (modifiable dans Paramètres),
 * BLUE_AFFILIATES_SECRET (optionnel : active la vérification de {sig}).
 */
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const webpush = require('web-push');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));

const DATA_DIR = process.env.DATA_DIR || __dirname;
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const EVENTS_FILE = path.join(DATA_DIR, 'events.json');
const SECRET = process.env.BLUE_AFFILIATES_SECRET || '';
const PORT = process.env.PORT || 3000;

let pool = null;
if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  const url = process.env.DATABASE_URL;
  pool = new Pool({
    connectionString: url,
    ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false },
    max: 3
  });
}

/* ================= État ================= */
const defState = () => ({
  settings: {
    adminCode: 'Admin2024', codeReset: true,
    mainLink: '', tgOn: false, tgToken: '', tgChat: '', refComm: 5,
    tiers: [{ ftd: 10, reward: 50 }, { ftd: 100, reward: 500 }, { ftd: 500, reward: 1000 }, { ftd: 1000, reward: 2000 }, { ftd: 2000, reward: 4000 }],
    wDay: 10, param: 'sub1', linkParam: 's1', baSecret: '', signupOn: true, signupApprove: true, signupComm: 30, signupLinks: [], games: [], useful: [], community: [],
    brand: 'AFFIX', colorA: '#ffffff', colorB: '#a1a1aa', logo: '/assets/logo.png', macroL: '{', macroR: '}',
    map: { event: 'event', amount: 'amount', commission: 'commission', tx: 'transaction_id', reg: 'registration', ftd: 'ftd', dep: 'deposit', com: 'commission_paid', qual: 'qualification', rs: 'revshare' }
  },
  subs: [], payments: [], msgs: {}, rewardsClaimed: {}, announce: [], push: {}, adminPush: []
});
let state = defState();
let events = [];

let queue = Promise.resolve();
const enqueue = (fn) => (queue = queue.then(fn).catch((e) => console.error('store error', e)));

async function initStore() {
  if (pool) {
    await pool.query('create table if not exists kv(k text primary key, v jsonb not null)');
    await pool.query('create table if not exists events(id bigserial primary key, data jsonb not null)');
    const s = await pool.query("select v from kv where k='state'");
    if (s.rows[0]) state = Object.assign(defState(), s.rows[0].v);
    const e = await pool.query('select data from events order by id');
    events = e.rows.map((r) => r.data);
  } else {
    try { state = Object.assign(defState(), JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))); } catch (e) {}
    try { events = JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf8')); } catch (e) {}
  }
  const needCodeReset = !state.settings.codeReset;
  state.settings = Object.assign(defState().settings, state.settings);
  // Une seule fois : code admin remis à Admin2024 (modifiable ensuite dans Paramètres)
  if (needCodeReset) { state.settings.adminCode = 'Admin2024'; state.settings.codeReset = true; saveState(); }
  state.settings.map = Object.assign(defState().settings.map, state.settings.map);
  // Migration : ancienne marque Blue Dash -> AFFIX (noir & blanc)
  const st0 = state.settings;
  if (st0.brand === 'Blue Dash' && st0.colorA === '#3b82f6') Object.assign(st0, { brand: 'AFFIX', colorA: '#ffffff', colorB: '#a1a1aa' });
  if (st0.brand === 'AFFIX' && !st0.logo) st0.logo = '/assets/logo.png';
  initPush();
}
const saveState = () => enqueue(async () => {
  if (pool) await pool.query("insert into kv(k,v) values('state',$1) on conflict(k) do update set v=excluded.v", [JSON.stringify(state)]);
  else fs.writeFileSync(STATE_FILE, JSON.stringify(state));
});
const addEvent = (ev) => { events.push(ev); return enqueue(async () => {
  if (pool) await pool.query('insert into events(data) values($1)', [JSON.stringify(ev)]);
  else fs.writeFileSync(EVENTS_FILE, JSON.stringify(events));
}); };
const clearEvents = () => { events = []; return enqueue(async () => {
  if (pool) await pool.query('delete from events'); else fs.writeFileSync(EVENTS_FILE, '[]');
}); };

/* ================= Utilitaires ================= */
const uid = () => crypto.randomBytes(5).toString('hex');
const h = (v) => crypto.createHash('sha256').update(String(v)).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(h(a), h(b));
const isActive = (s) => !s.status || s.status === 'active';
const hashPass = (p) => { const salt = crypto.randomBytes(8).toString('hex'); return salt + ':' + crypto.scryptSync(p, salt, 32).toString('hex'); };
const passCache = new Map();
// Compte créé par l'admin : le code d'accès sert de mot de passe. Compte inscrit seul : mot de passe haché (le code ne sert qu'au tracking).
const passOk = (sub, p) => {
  if (!sub.pass) return safeEq(sub.code, p);
  const k = crypto.createHash('sha256').update(sub.id + '|' + sub.pass + '|' + p).digest('hex');
  if (passCache.get(k)) return true;
  const [salt, hh] = String(sub.pass).split(':');
  if (!salt || !hh) return false;
  let ok = false;
  try { ok = safeEq(crypto.scryptSync(p, salt, 32).toString('hex'), hh); } catch (e) { ok = false; }
  if (ok) passCache.set(k, true);
  return ok;
};
const str = (v, n = 300) => String(v ?? '').slice(0, n);
const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);
const parisDay = () => parseInt(new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: 'numeric' }).format(new Date()), 10);

async function tg(text) {
  const s = state.settings;
  if (!s.tgOn || !s.tgToken || !s.tgChat) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${s.tgToken}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: s.tgChat, text })
    });
    return r.ok;
  } catch (e) { return false; }
}

/* ================= Notifications push (Web Push / VAPID) ================= */
// Les clés VAPID sont générées une seule fois puis stockées avec le reste de l'état (aucune config requise).
// On peut les imposer via VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY.
function initPush() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) state.vapid = { pub: process.env.VAPID_PUBLIC_KEY, priv: process.env.VAPID_PRIVATE_KEY };
  else if (!state.vapid || !state.vapid.pub || !state.vapid.priv) {
    const k = webpush.generateVAPIDKeys();
    state.vapid = { pub: k.publicKey, priv: k.privateKey };
    saveState();
  }
  if (!state.push || typeof state.push !== 'object') state.push = {};
  if (!Array.isArray(state.adminPush)) state.adminPush = [];
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@affix.app', state.vapid.pub, state.vapid.priv);
}
const PUSH_HOSTS = ['googleapis.com', 'mozilla.com', 'mozaws.net', 'apple.com', 'windows.com', 'microsoft.com'];
const pushEndpointOk = (u) => {
  try { const x = new URL(u); return x.protocol === 'https:' && PUSH_HOSTS.some((d) => x.hostname === d || x.hostname.endsWith('.' + d)); } catch (e) { return false; }
};
const MAX_DEVICES = 8;
const pushList = (auth) => (auth.role === 'a' ? state.adminPush : state.push[auth.sub.id] || []);
function removeEndpoints(set) {
  if (!set.size) return;
  state.adminPush = state.adminPush.filter((d) => !set.has(d.endpoint));
  for (const id of Object.keys(state.push)) { state.push[id] = state.push[id].filter((d) => !set.has(d.endpoint)); if (!state.push[id].length) delete state.push[id]; }
  saveState();
}
// Envoie à une liste d'appareils ; retire ceux que le navigateur a supprimés (404/410). Retourne le nombre d'envois réussis.
async function sendPush(list, p) {
  const payload = JSON.stringify({ title: str(p.title || state.settings.brand, 80), body: str(p.body, 160), page: p.page || 'home', tag: p.tag || p.page || '' });
  const dead = new Set(); let ok = 0;
  await Promise.all(list.map(async (d) => {
    try { await webpush.sendNotification({ endpoint: d.endpoint, keys: d.keys }, payload, { TTL: 86400, urgency: 'high' }); ok++; }
    catch (e) { if (e.statusCode === 404 || e.statusCode === 410) dead.add(d.endpoint); else console.warn('push échoué', e.statusCode || '', String(e.body || e.message || '').slice(0, 120)); }
  }));
  removeEndpoints(dead);
  return ok;
}
const pushMember = (id, p) => { const l = state.push[id]; if (l && l.length) sendPush(l.slice(), p).catch(() => {}); };
const pushAdmin = (p) => { if (state.adminPush.length) sendPush(state.adminPush.slice(), p).catch(() => {}); };
const pushAllMembers = (p) => { for (const s of state.subs) if (isActive(s)) pushMember(s.id, p); };
// Alerte admin : Telegram (si configuré) + push sur ses appareils
const alertAdmin = (tgText, title, body, page) => { tg(tgText); pushAdmin({ title, body, page }); };
const eurS = (n) => (Math.round((+n || 0) * 100) / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';

// Anti brute-force : 15 échecs / 10 min / IP
const fails = new Map();
const blocked = (ip) => { const f = fails.get(ip); return f && f.n >= 15 && Date.now() - f.t < 600000; };
const fail = (ip) => { const f = fails.get(ip); if (!f || Date.now() - f.t > 600000) fails.set(ip, { n: 1, t: Date.now() }); else { f.n++; } };

function authenticate(req) {
  const role = req.get('x-role');
  let code = '', name = '';
  try { code = decodeURIComponent(req.get('x-code') || ''); name = decodeURIComponent(req.get('x-name') || ''); } catch (e) {}
  if (role === 'a') return safeEq(code, state.settings.adminCode) ? { role: 'a' } : null;
  if (role === 'm') {
    const n = name.trim().toLowerCase();
    const sub = state.subs.find((x) => x.name.trim().toLowerCase() === n && isActive(x) && passOk(x, code));
    return sub ? { role: 'm', sub } : null;
  }
  return null;
}
const need = (role) => (req, res, next) => {
  if (blocked(req.ip)) return res.status(429).json({ error: 'Trop de tentatives, réessaie dans 10 minutes' });
  const a = authenticate(req);
  if (!a || (role && a.role !== role)) { fail(req.ip); return res.status(401).json({ error: 'Identifiants invalides' }); }
  req.auth = a; next();
};

/* ================= Stats depuis les postbacks ================= */
function computeStats() {
  const by = {}; const seen = new Set();
  for (const e of events) {
    if (!e.code) continue;
    if (e.tx) { const k = e.type + '|' + e.tx; if (seen.has(k)) continue; seen.add(k); }
    const c = (by[e.code] = by[e.code] || { inscriptions: 0, ftd: 0, qualifs: 0, deposits: 0, ca: 0, rs: 0, events: [] });
    if (e.type === 'registration') c.inscriptions++;
    if (e.type === 'ftd') c.ftd++;
    if (e.type === 'qualification') c.qualifs++;
    if (e.type === 'revshare') c.rs += e.commission || 0; // projection par joueur (peut être négative) — le payé reste le relevé mensuel
    if (e.type === 'deposit') c.deposits += e.amount || 0;
    if (e.type === 'commission_paid') { c.ca += e.commission || 0; c.events.push({ t: e.t, type: e.type, commission: e.commission || 0 }); }
  }
  return by;
}
const withStats = (s, by) => {
  const x = by[s.code];
  const { pass, ...rest } = s;
  return { ...rest, hasPass: !!pass, stats: x ? { inscriptions: x.inscriptions, ftd: x.ftd, qualifs: x.qualifs, deposits: x.deposits, ca: x.ca, rs: x.rs } : {}, events: x ? x.events : [] };
};
const publicSettings = (s) => ({ tiers: s.tiers, wDay: s.wDay, refComm: s.refComm, param: s.param, linkParam: s.linkParam, games: s.games, useful: s.useful, community: s.community, brand: s.brand, colorA: s.colorA, colorB: s.colorB, logo: s.logo });

function adminView() {
  const by = computeStats();
  const { adminCode, ...settings } = state.settings;
  return { pb: { count: events.length, last: events.length ? events[events.length - 1].t : 0 }, defaultCode: safeEq(state.settings.adminCode, 'Admin2024'), settings, pending: state.subs.filter((s) => !isActive(s)).map((s) => ({ id: s.id, name: s.name, status: s.status, created: s.created, parent: (state.subs.find((x) => x.id === s.referrer) || {}).name || '' })), subs: state.subs.filter(isActive).map((s) => withStats(s, by)), payments: state.payments, msgs: state.msgs, rewardsClaimed: state.rewardsClaimed, announce: state.announce };
}
function memberView(sub) {
  const by = computeStats();
  const own = withStats(sub, by);
  const fil = state.subs.filter((x) => isActive(x) && x.referrer === sub.id).map((x) => {
    const w = withStats(x, by);
    return { id: x.id, name: x.name, created: x.created, referrer: x.referrer, stats: w.stats };
  });
  return {
    settings: publicSettings(state.settings),
    subs: [own, ...fil],
    payments: state.payments.filter((p) => p.subId === sub.id),
    msgs: { [sub.id]: state.msgs[sub.id] || [] },
    rewardsClaimed: { [sub.id]: state.rewardsClaimed[sub.id] || [] },
    announce: state.announce.slice(0, 3)
  };
}
const earnedOf = (sub) => { const x = computeStats()[sub.code]; return (x ? x.ftd : 0) * (+sub.commission || 0); };
const withdrawnOf = (id) => state.payments.filter((p) => p.subId === id && p.type === 'w' && p.status !== 'refused').reduce((a, p) => a + p.amount, 0);

/* ================= Auth / état ================= */
app.post('/api/login', (req, res) => {
  if (blocked(req.ip)) return res.status(429).json({ error: 'Trop de tentatives, réessaie dans 10 minutes' });
  const { role, name, code } = req.body || {};
  if (role === 'a') {
    if (safeEq(str(code), state.settings.adminCode)) return res.json({ ok: true, role: 'a' });
  } else {
    const n = str(name).trim().toLowerCase();
    const sub = state.subs.find((x) => x.name.trim().toLowerCase() === n && passOk(x, str(code)));
    if (sub && !isActive(sub)) return res.status(403).json({ error: sub.status === 'refused' ? 'Ton inscription n\'a pas été acceptée.' : 'Ton inscription est en attente de validation. Reviens un peu plus tard.', pending: sub.status !== 'refused' });
    if (sub) return res.json({ ok: true, role: 'm', id: sub.id });
  }
  fail(req.ip);
  res.status(401).json({ error: role === 'a' ? 'Code admin incorrect' : 'Nom ou code incorrect' });
});

app.get('/api/state', need(), (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(req.auth.role === 'a' ? adminView() : memberView(req.auth.sub));
});

/* ================= Admin ================= */
const cleanLinks = (a) => (Array.isArray(a) ? a : []).slice(0, 50).map((l) => ({ name: str(l && l.name, 80), url: str(l && l.url, 600) }));

app.put('/api/config', need('a'), async (req, res) => {
  const b = req.body || {};
  if (b.settings && typeof b.settings === 'object') {
    const s = b.settings, cur = state.settings;
    cur.mainLink = str(s.mainLink, 600);
    cur.tgOn = !!s.tgOn; cur.tgToken = str(s.tgToken, 200); cur.tgChat = str(s.tgChat, 100);
    cur.refComm = num(s.refComm, 5);
    cur.wDay = Math.min(31, Math.max(1, num(s.wDay, 10)));
    cur.param = str(s.param, 30).replace(/[^\w-]/g, '') || 'sub1';
    if (typeof s.baSecret === 'string') cur.baSecret = str(s.baSecret, 200).trim();
    cur.linkParam = str(s.linkParam, 30).replace(/[^\w-]/g, '') || 's1';
    if (Array.isArray(s.tiers)) cur.tiers = s.tiers.slice(0, 30).map((t) => ({ ftd: num(t.ftd), reward: num(t.reward) }));
    cur.brand = str(s.brand, 40).trim() || 'AFFIX';
    if (/^#[0-9a-f]{6}$/i.test(str(s.colorA))) cur.colorA = s.colorA;
    if (/^#[0-9a-f]{6}$/i.test(str(s.colorB))) cur.colorB = s.colorB;
    const lg = str(s.logo, 600).trim(); cur.logo = /^(https:\/\/\S+|\/assets\/[\w.-]+)$/.test(lg) ? lg : '';
    cur.macroL = str(s.macroL, 3) || '{'; cur.macroR = str(s.macroR, 3) || '}';
    if (s.map && typeof s.map === 'object') for (const k of Object.keys(cur.map)) { const v = str(s.map[k], 40).trim().replace(/[^\w.\- ]/g, ''); if (v) cur.map[k] = v; }
    if (typeof s.signupOn === 'boolean') cur.signupOn = s.signupOn;
    if (typeof s.signupApprove === 'boolean') cur.signupApprove = s.signupApprove;
    if (s.signupComm !== undefined) cur.signupComm = num(s.signupComm, 30);
    if (Array.isArray(s.signupLinks)) cur.signupLinks = cleanLinks(s.signupLinks);
    cur.games = cleanLinks(s.games); cur.useful = cleanLinks(s.useful); cur.community = cleanLinks(s.community);
  }
  if (Array.isArray(b.subs)) {
    const seenId = new Set(), seenCode = new Set(), out = [];
    for (const x of b.subs.slice(0, 2000)) {
      const id = str(x.id, 40) || uid(), code = str(x.code, 60).trim(), name = str(x.name, 80).trim();
      if (!name || !code) return res.status(400).json({ error: 'Nom et code requis' });
      if (seenId.has(id) || seenCode.has(code)) return res.status(400).json({ error: 'Code ou identifiant en double : ' + code });
      seenId.add(id); seenCode.add(code);
      const prev = state.subs.find((p) => p.id === id) || {};
      let pass = prev.pass;
      if (typeof x.newPass === 'string' && x.newPass.length >= 6) pass = hashPass(x.newPass.slice(0, 100));
      out.push({ ...(pass ? { pass } : {}), ...(prev.selfReg ? { selfReg: true } : {}), id, name, code, links: cleanLinks(x.links), commission: num(x.commission, 30), landing: str(x.landing, 600), referrer: seenId.has(x.referrer) || b.subs.some((y) => y.id === x.referrer) ? str(x.referrer, 40) : '', created: num(x.created, Date.now()) });
    }
    if (Array.isArray(b.seen)) { // inscrits arrivés depuis la dernière synchro de l'admin : on les garde
      const inP = new Set(out.map((s) => s.id)), seen = new Set(b.seen.map(String));
      for (const s of state.subs) if (!inP.has(s.id) && !seen.has(s.id)) out.push(s);
    }
    const keep = new Set(out.map((s) => s.id));
    for (const id of Object.keys(state.msgs)) if (!keep.has(id)) delete state.msgs[id];
    for (const id of Object.keys(state.rewardsClaimed)) if (!keep.has(id)) delete state.rewardsClaimed[id];
    state.subs = out;
  }
  let newAnn = [];
  if (Array.isArray(b.announce)) {
    const had = new Set(state.announce.map((a) => a.t + '|' + a.text));
    state.announce = b.announce.slice(0, 20).map((a) => ({ text: str(a.text, 1000), t: num(a.t, Date.now()) }));
    newAnn = state.announce.filter((a) => a.text && !had.has(a.t + '|' + a.text));
  }
  if (Array.isArray(b.subs)) { for (const id of Object.keys(state.push)) if (!state.subs.some((x) => x.id === id)) delete state.push[id]; }
  await saveState();
  res.json({ ok: true });
  if (newAnn.length) pushAllMembers({ title: '📣 Annonce', body: newAnn[0].text, page: 'home' });
});

app.post('/api/msg/:id', need('a'), async (req, res) => {
  const sub = state.subs.find((s) => s.id === req.params.id);
  const text = str(req.body && req.body.text, 2000).trim();
  if (!sub || !text) return res.status(400).json({ error: 'Message invalide' });
  (state.msgs[sub.id] = state.msgs[sub.id] || []).push({ from: 'a', text, t: Date.now() });
  await saveState(); res.json({ ok: true });
  pushMember(sub.id, { title: '💬 Nouveau message', body: text, page: 'msg' });
});
app.post('/api/pay/:id/paid', need('a'), async (req, res) => {
  const p = state.payments.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Introuvable' });
  p.status = 'paid'; p.paidAt = Date.now();
  await saveState(); res.json({ ok: true });
  pushMember(p.subId, { title: '✅ Paiement effectué', body: (p.type === 'r' ? (p.label || 'Reward') : 'Ton retrait') + ' de ' + eurS(p.amount) + ' a été payé.', page: p.type === 'r' ? 'rew' : 'bal' });
});
app.delete('/api/pay/:id', need('a'), async (req, res) => {
  state.payments = state.payments.filter((x) => x.id !== req.params.id);
  await saveState(); res.json({ ok: true });
});
app.post('/api/admin-code', need('a'), async (req, res) => {
  const { old, next } = req.body || {};
  if (!safeEq(str(old), state.settings.adminCode)) return res.status(400).json({ error: 'Code actuel incorrect' });
  if (!str(next).trim() || str(next).length < 4) return res.status(400).json({ error: 'Nouveau code trop court (4 caractères min.)' });
  state.settings.adminCode = str(next, 100);
  await saveState(); res.json({ ok: true });
});
app.post('/api/import', need('a'), async (req, res) => {
  const d = req.body && req.body.state;
  if (!d || typeof d !== 'object') return res.status(400).json({ error: 'Fichier invalide' });
  const code = state.settings.adminCode;
  const base = defState();
  const keepVapid = state.vapid, keepAdminPush = state.adminPush, oldPush = state.push;
  state = {
    vapid: keepVapid, adminPush: keepAdminPush, push: {},
    settings: Object.assign(base.settings, d.settings || {}, { adminCode: code }),
    subs: (Array.isArray(d.subs) ? d.subs : []).map((x) => ({ id: str(x.id, 40) || uid(), name: str(x.name, 80), code: str(x.code, 60), links: cleanLinks(x.links), commission: num(x.commission, 30), landing: str(x.landing, 600), referrer: str(x.referrer, 40), created: num(x.created, Date.now()) })),
    payments: Array.isArray(d.payments) ? d.payments : [],
    msgs: d.msgs && typeof d.msgs === 'object' ? d.msgs : {},
    rewardsClaimed: d.rewardsClaimed && typeof d.rewardsClaimed === 'object' ? d.rewardsClaimed : {},
    announce: Array.isArray(d.announce) ? d.announce : []
  };
  for (const x of state.subs) if (oldPush[x.id]) state.push[x.id] = oldPush[x.id];
  await saveState(); res.json({ ok: true });
});
app.post('/api/reset', need('a'), async (req, res) => {
  const code = state.settings.adminCode, keepVapid = state.vapid, keepAdminPush = state.adminPush;
  state = defState(); state.settings.adminCode = code; state.vapid = keepVapid; state.adminPush = keepAdminPush;
  await saveState(); await clearEvents(); res.json({ ok: true });
});
app.post('/api/tg-test', need('a'), async (req, res) => {
  const ok = await tg('✅ Test ' + state.settings.brand);
  res.status(ok ? 200 : 400).json(ok ? { ok: true } : { error: 'Échec : vérifie le token, le chat ID et que les notifications sont activées (enregistre d\'abord)' });
});

/* ================= Notifications push : appareils ================= */
app.get('/api/push/key', (_, res) => res.json({ key: state.vapid.pub }));
app.post('/api/push/status', need(), (req, res) => {
  const ep = str(req.body && req.body.endpoint, 1200);
  res.json({ on: pushList(req.auth).some((d) => d.endpoint === ep) });
});
app.post('/api/push/subscribe', need(), async (req, res) => {
  const sb = (req.body && req.body.subscription) || {};
  const endpoint = str(sb.endpoint, 1200), k = sb.keys || {};
  const p256dh = str(k.p256dh, 200), authK = str(k.auth, 100);
  if (!pushEndpointOk(endpoint) || !p256dh || !authK) return res.status(400).json({ error: 'Abonnement invalide' });
  removeEndpoints(new Set([endpoint])); // un appareil n'appartient qu'à un seul compte
  const dev = { endpoint, keys: { p256dh, auth: authK }, ua: str(req.get('user-agent'), 120), t: Date.now() };
  let list;
  if (req.auth.role === 'a') list = state.adminPush; else list = (state.push[req.auth.sub.id] = state.push[req.auth.sub.id] || []);
  list.push(dev);
  while (list.length > MAX_DEVICES) list.shift();
  await saveState();
  const delivered = (await sendPush([dev], { title: state.settings.brand, body: '✅ Notifications activées sur cet appareil', page: 'home', tag: 'welcome' })) > 0;
  res.json({ ok: true, delivered });
});
app.post('/api/push/unsubscribe', need(), async (req, res) => {
  removeEndpoints(new Set([str(req.body && req.body.endpoint, 1200)].filter((e) => pushList(req.auth).some((d) => d.endpoint === e))));
  await saveState(); res.json({ ok: true });
});
app.post('/api/push/test', need(), async (req, res) => {
  const list = pushList(req.auth).slice();
  if (!list.length) return res.status(400).json({ error: 'Aucun appareil enregistré : active d\'abord les notifications' });
  const n = await sendPush(list, { title: state.settings.brand, body: '🔔 Notification de test : tout fonctionne !', page: 'home', tag: 'test' });
  if (!n) return res.status(502).json({ error: 'Envoi impossible. Désactive puis réactive les notifications sur cet appareil.' });
  res.json({ ok: true, sent: n });
});

/* ================= Membre ================= */
app.post('/api/me/msg', need('m'), async (req, res) => {
  const sub = req.auth.sub, text = str(req.body && req.body.text, 2000).trim();
  if (!text) return res.status(400).json({ error: 'Message vide' });
  (state.msgs[sub.id] = state.msgs[sub.id] || []).push({ from: 'm', text, t: Date.now() });
  await saveState(); alertAdmin(`💬 Nouveau message de ${sub.name}`, '💬 Nouveau message', `${sub.name} : ${text}`, 'msg'); res.json({ ok: true });
});
app.post('/api/me/withdraw', need('m'), async (req, res) => {
  const sub = req.auth.sub, details = str(req.body && req.body.details, 500).trim();
  if (!details) return res.status(400).json({ error: 'Coordonnées de paiement requises' });
  if (parisDay() !== state.settings.wDay) return res.status(400).json({ error: `Les retraits sont ouverts le ${state.settings.wDay} de chaque mois` });
  if (state.payments.some((p) => p.subId === sub.id && p.type === 'w' && p.status === 'pending')) return res.status(400).json({ error: 'Tu as déjà une demande en attente' });
  const amount = Math.round((earnedOf(sub) - withdrawnOf(sub.id)) * 100) / 100;
  if (amount <= 0) return res.status(400).json({ error: 'Solde insuffisant' });
  state.payments.push({ id: uid(), subId: sub.id, type: 'w', amount, date: Date.now(), details, status: 'pending' });
  await saveState(); alertAdmin(`💸 Demande de retrait ${amount.toFixed(2)} € — ${sub.name}`, '💸 Demande de retrait', `${sub.name} — ${eurS(amount)}`, 'pay'); res.json({ ok: true });
});
app.post('/api/me/claim', need('m'), async (req, res) => {
  const sub = req.auth.sub, ftd = num(req.body && req.body.ftd, -1), details = str(req.body && req.body.details, 500).trim();
  const tier = state.settings.tiers.find((t) => t.ftd === ftd);
  if (!tier) return res.status(400).json({ error: 'Palier inconnu' });
  if (!details) return res.status(400).json({ error: 'Coordonnées de paiement requises' });
  const x = computeStats()[sub.code];
  if (((x && x.ftd) || 0) < tier.ftd) return res.status(400).json({ error: 'Palier pas encore atteint' });
  const cl = (state.rewardsClaimed[sub.id] = state.rewardsClaimed[sub.id] || []);
  if (cl.includes(ftd)) return res.status(400).json({ error: 'Reward déjà demandé' });
  cl.push(ftd);
  state.payments.push({ id: uid(), subId: sub.id, type: 'r', label: 'Bonus ' + ftd + ' FTD', amount: tier.reward, date: Date.now(), details, status: 'pending' });
  await saveState(); alertAdmin(`🎁 Reward ${tier.reward} € demandé — ${sub.name}`, '🎁 Reward demandé', `${sub.name} — ${eurS(tier.reward)}`, 'pay'); res.json({ ok: true });
});

/* ================= Postbacks Blue Affiliates ================= */
// {sig} = HMAC-SHA256 de la query string canonicalisée (clés triées, hors sig).
// Si le test Blue Affiliates échoue, ajuste seulement canonical().
const canonical = (q) => Object.keys(q).filter((k) => k !== 'sig').sort().map((k) => `${k}=${q[k]}`).join('&');
const canonicalEnc = (q) => Object.keys(q).filter((k) => k !== 'sig').sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(q[k])}`).join('&');
// Variantes acceptées (clés triées brutes / encodées / ordre d'origine de la query string) : toutes exigent le secret.
function sigCandidates(q, req) {
  const out = [canonical(q), canonicalEnc(q)];
  const raw = (req.originalUrl.split('?')[1] || '').split('&').filter((x) => x && !/^sig=/.test(x));
  out.push(raw.join('&'), raw.slice().sort().join('&'));
  return out;
}
const secret = () => state.settings.baSecret || SECRET;
function sigOk(q, req) {
  const SEC = secret();
  if (!SEC) return true;
  if (!q.sig) return false;
  const got = Buffer.from(String(q.sig).toLowerCase());
  return sigCandidates(q, req).some((c) => {
    const exp = Buffer.from(crypto.createHmac('sha256', SEC).update(c).digest('hex'));
    return got.length === exp.length && crypto.timingSafeEqual(got, exp);
  });
}
app.get('/postback', async (req, res) => {
  const q = req.query;
  if (!sigOk(q, req)) { console.warn('postback: signature invalide (event=' + str(q.event, 30) + ')'); return res.status(401).send('invalid signature'); }
  const st = state.settings, m = st.map, p = st.param || 'sub1';
  const raw = str(q[m.event], 40).trim().toLowerCase();
  const type = raw === m.reg.toLowerCase() ? 'registration' : raw === m.ftd.toLowerCase() ? 'ftd' : raw === m.dep.toLowerCase() ? 'deposit' : raw === m.com.toLowerCase() ? 'commission_paid' : raw === (m.qual || 'qualification').toLowerCase() ? 'qualification' : raw === (m.rs || 'revshare').toLowerCase() ? 'revshare' : (raw || 'unknown');
  const clean = (v) => /^\{.*\}$/.test(String(v || '')) ? '' : String(v || ''); // macro non remplacée -> vide
  const tx0 = str(q[m.tx], 80);
  if (tx0 && events.some((e) => e.type === type && e.tx === tx0)) return res.send('ok'); // doublon (retry du réseau)
  await addEvent({
    t: Date.now(), type, code: str(q[p] || q.sub1 || q.sub, 60).trim(),
    clickid: str(q.clickid, 80), tx: str(q[m.tx], 80),
    amount: parseFloat(q[m.amount]) || 0, commission: parseFloat(q[m.commission]) || 0, country: str(q.country, 10),
    currency: str(clean(q.currency), 6), campaign: str(clean(q.campaign_slug), 60), player: str(clean(q.player_token), 80), username: str(clean(q.username), 60), s2: str(clean(q.sub2), 60), s3: str(clean(q.sub3), 60)
  });
  res.send('ok');
  if (type === 'registration' || type === 'ftd') {
    const code = str(q[p] || q.sub1 || q.sub, 60).trim();
    const sub = code && state.subs.find((x) => x.code === code && isActive(x));
    if (sub) {
      if (type === 'registration') pushMember(sub.id, { title: '👤 Nouvelle inscription', body: 'Un joueur vient de s\'inscrire avec ton lien.', page: 'home' });
      else {
        pushMember(sub.id, { title: '🎉 Nouveau FTD !', body: '+' + eurS(sub.commission) + ' de commission', page: 'home' });
        const parent = sub.referrer && state.subs.find((x) => x.id === sub.referrer && isActive(x));
        if (parent) pushMember(parent.id, { title: '🎉 FTD d\'un filleul', body: sub.name + ' vient de générer un FTD (+' + eurS(state.settings.refComm) + ').', page: 'ref' });
      }
    }
  }
});

/* ================= Test de réception (admin) ================= */
// Envoie un vrai postback signé à ce même serveur (code « TEST », sans effet sur les gains) puis permet de l'effacer.
app.post('/api/pb-test', need('a'), async (req, res) => {
  const st = state.settings, m = st.map;
  const q = { [m.event]: m.reg, clickid: 'TEST', [st.param || 'sub1']: 'TEST', [m.tx]: 'TEST-' + Date.now(), [m.amount]: '10', [m.commission]: '1', country: 'FR' };
  const SEC = secret();
  const base = Object.keys(q).sort().map((k) => k + '=' + q[k]).join('&');
  const qs = Object.keys(q).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(q[k])).join('&') + (SEC ? '&sig=' + crypto.createHmac('sha256', SEC).update(base).digest('hex') : '');
  try {
    const r = await fetch('http://127.0.0.1:' + PORT + '/postback?' + qs);
    res.json({ ok: r.status === 200, status: r.status, signed: !!SEC, total: events.length });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});
app.post('/api/pb-test/clear', need('a'), async (req, res) => {
  const before = events.length;
  events = events.filter((e) => !String(e.tx || '').startsWith('TEST-'));
  await enqueue(async () => {
    if (pool) await pool.query("delete from events where data->>'tx' like 'TEST-%'");
    else fs.writeFileSync(EVENTS_FILE, JSON.stringify(events));
  });
  res.json({ ok: true, removed: before - events.length });
});

/* ================= App ================= */
const escHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
app.get('/assets/:f', (req, res, next) => {
  const f = req.params.f;
  if (!/^[\w.-]+\.(png|webp|ico|svg)$/.test(f) || f.includes('..')) return next();
  for (const dir of [path.join(__dirname, 'assets'), __dirname]) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) { res.set('Cache-Control', 'public, max-age=604800'); return res.sendFile(p); }
  }
  next();
});
// Service worker : installable + notifications push
app.get('/sw.js', (_, res) => {
  res.set({ 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' }).type('application/javascript').send(
`const C='shell-v2';
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('fetch',e=>{const r=e.request;if(r.method!=='GET'||r.mode!=='navigate')return;
e.respondWith(fetch(r).then(x=>{const c=x.clone();caches.open(C).then(k=>k.put('/',c));return x}).catch(()=>caches.match('/').then(m=>m||new Response('Hors ligne',{status:503}))))});
self.addEventListener('push',e=>{
 let d={};try{d=e.data?e.data.json():{}}catch(x){d={body:e.data?e.data.text():''}}
 e.waitUntil(self.registration.showNotification(d.title||'Notification',{body:d.body||'',icon:'/assets/icon-192.png',badge:'/assets/mark.png',tag:d.tag||undefined,renotify:!!d.tag,data:{page:d.page||'home'}}))});
self.addEventListener('notificationclick',e=>{
 e.notification.close();const pg=(e.notification.data&&e.notification.data.page)||'home';
 e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(cs=>{
  for(const c of cs){if('focus' in c){c.postMessage({type:'go',page:pg});return c.focus()}}
  return self.clients.openWindow('/?p='+pg)}))});`);
});

/* ================= Inscription publique & parrainage ================= */
const regHits = new Map();
app.get('/api/ref/:id', (req, res) => {
  const s = state.subs.find((x) => isActive(x) && x.id.toLowerCase() === String(req.params.id || '').trim().toLowerCase());
  if (!s) return res.status(404).json({ error: 'Lien de parrainage introuvable' });
  res.json({ name: s.name });
});
app.post('/api/register', async (req, res) => {
  const st = state.settings;
  if (st.signupOn === false) return res.status(403).json({ error: 'Les inscriptions sont fermées' });
  const now = Date.now(), hits = (regHits.get(req.ip) || []).filter((t) => now - t < 3600000);
  if (hits.length >= 5) return res.status(429).json({ error: 'Trop d\'inscriptions depuis cette connexion, réessaie plus tard' });
  const { name, pass, ref } = req.body || {};
  const nm = str(name, 40).trim().replace(/\s+/g, ' ');
  if (nm.length < 2) return res.status(400).json({ error: 'Nom trop court (2 caractères min.)' });
  if (typeof pass !== 'string' || pass.length < 6) return res.status(400).json({ error: 'Mot de passe trop court (6 caractères min.)' });
  if (state.subs.length >= 2000) return res.status(503).json({ error: 'Inscriptions indisponibles pour le moment' });
  if (state.subs.some((x) => x.name.trim().toLowerCase() === nm.toLowerCase())) return res.status(409).json({ error: 'Ce nom est déjà pris' });
  const refIn = str(ref, 40).trim().toLowerCase();
  const parent = refIn ? state.subs.find((x) => isActive(x) && x.id.toLowerCase() === refIn) : null;
  if (refIn && !parent) return res.status(400).json({ error: 'Code de parrainage invalide' });
  let code;
  do { code = crypto.randomBytes(5).toString('hex').toUpperCase().slice(0, 8); } while (state.subs.some((x) => x.code === code));
  const approve = st.signupApprove !== false;
  const sub = { id: uid(), name: nm, code, pass: hashPass(pass.slice(0, 100)), selfReg: true, ...(approve ? { status: 'pending' } : {}), links: cleanLinks(st.signupLinks), commission: num(st.signupComm, 30), landing: '', referrer: parent ? parent.id : '', created: now };
  hits.push(now); regHits.set(req.ip, hits);
  state.subs.push(sub);
  await saveState();
  alertAdmin((approve ? '🆕 Nouvelle inscription à valider : ' : '🆕 Nouvelle inscription : ') + nm + (parent ? ' (parrainé par ' + parent.name + ')' : ''), approve ? '🆕 Inscription à valider' : '🆕 Nouvelle inscription', nm + (parent ? ' — parrainé par ' + parent.name : ''), 'subs');
  res.json({ ok: true, id: sub.id, pending: approve });
});

// Admin : accepter / refuser / supprimer une inscription
const pendingSub = (id) => state.subs.find((x) => x.id === id && !isActive(x));
app.post('/api/signup/:id/accept', need('a'), async (req, res) => {
  const s = pendingSub(req.params.id);
  if (!s) return res.status(404).json({ error: 'Inscription introuvable' });
  delete s.status; await saveState();
  tg('✅ Inscription acceptée : ' + s.name);
  res.json({ ok: true });
});
app.post('/api/signup/:id/refuse', need('a'), async (req, res) => {
  const s = pendingSub(req.params.id);
  if (!s) return res.status(404).json({ error: 'Inscription introuvable' });
  s.status = 'refused'; await saveState(); res.json({ ok: true });
});
app.delete('/api/signup/:id', need('a'), async (req, res) => {
  const s = pendingSub(req.params.id);
  if (!s) return res.status(404).json({ error: 'Inscription introuvable' });
  state.subs = state.subs.filter((x) => x.id !== s.id);
  delete state.msgs[s.id]; delete state.rewardsClaimed[s.id]; delete state.push[s.id];
  await saveState(); res.json({ ok: true });
});
app.get('/favicon.ico', (_, res) => res.redirect(301, '/assets/favicon-32.png'));
app.get('/manifest.webmanifest', (_, res) => {
  const st = state.settings;
  res.type('application/manifest+json').json({
    id: '/', name: st.brand, short_name: st.brand.slice(0, 12), start_url: '/', orientation: 'any', scope: '/', display: 'standalone',
    background_color: '#000000', theme_color: '#000000', lang: 'fr',
    icons: [
      { src: '/assets/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/assets/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/assets/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
    ]
  });
});
app.get('/', (_, res) => {
  const st = state.settings;
  let html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const b = { brand: st.brand, colorA: st.colorA, colorB: st.colorB, logo: st.logo, signupOn: st.signupOn !== false };
  html = html.replace('<title>AFFIX</title>', '<title>' + escHtml(st.brand) + '</title>')
    .replace('</head>', '<style>:root{--a:' + st.colorA + ';--b:' + st.colorB + '}</style><script>window.BRAND=' + JSON.stringify(b).replace(/</g, '\\u003c') + '</script></head>');
  res.set('Cache-Control', 'no-cache'); res.type('html').send(html);
});
app.get('/health', (_, res) => res.json({ ok: true, storage: pool ? 'postgres' : 'fichier', subs: state.subs.length, events: events.length }));

initStore().then(() => {
  app.listen(PORT, () => console.log('AFFIX OK — stockage : ' + (pool ? 'Postgres' : 'fichiers')));
}).catch((e) => { console.error('Init échouée', e); process.exit(1); });
