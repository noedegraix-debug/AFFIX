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

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));

const DATA_DIR = process.env.DATA_DIR || __dirname;
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const EVENTS_FILE = path.join(DATA_DIR, 'events.json');
const SECRET = process.env.BLUE_AFFILIATES_SECRET || '';

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
    wDay: 10, param: 'sub1', linkParam: 's1', baSecret: '', games: [], useful: [], community: [],
    brand: 'AFFIX', colorA: '#ffffff', colorB: '#a1a1aa', logo: '/assets/logo.png', macroL: '{', macroR: '}',
    map: { event: 'event', amount: 'amount', commission: 'commission', tx: 'transaction_id', reg: 'registration', ftd: 'ftd', dep: 'deposit', com: 'commission_paid', qual: 'qualification', rs: 'revshare' }
  },
  subs: [], payments: [], msgs: {}, rewardsClaimed: {}, announce: []
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
    const sub = state.subs.find((x) => x.name.trim().toLowerCase() === n && safeEq(x.code, code));
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
  return { ...s, stats: x ? { inscriptions: x.inscriptions, ftd: x.ftd, qualifs: x.qualifs, deposits: x.deposits, ca: x.ca, rs: x.rs } : {}, events: x ? x.events : [] };
};
const publicSettings = (s) => ({ tiers: s.tiers, wDay: s.wDay, refComm: s.refComm, param: s.param, linkParam: s.linkParam, games: s.games, useful: s.useful, community: s.community, brand: s.brand, colorA: s.colorA, colorB: s.colorB, logo: s.logo });

function adminView() {
  const by = computeStats();
  const { adminCode, ...settings } = state.settings;
  return { pb: { count: events.length, last: events.length ? events[events.length - 1].t : 0 }, defaultCode: safeEq(state.settings.adminCode, 'Admin2024'), settings, subs: state.subs.map((s) => withStats(s, by)), payments: state.payments, msgs: state.msgs, rewardsClaimed: state.rewardsClaimed, announce: state.announce };
}
function memberView(sub) {
  const by = computeStats();
  const own = withStats(sub, by);
  const fil = state.subs.filter((x) => x.referrer === sub.id).map((x) => {
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
    const sub = state.subs.find((x) => x.name.trim().toLowerCase() === n && safeEq(x.code, str(code)));
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
    cur.games = cleanLinks(s.games); cur.useful = cleanLinks(s.useful); cur.community = cleanLinks(s.community);
  }
  if (Array.isArray(b.subs)) {
    const seenId = new Set(), seenCode = new Set(), out = [];
    for (const x of b.subs.slice(0, 2000)) {
      const id = str(x.id, 40) || uid(), code = str(x.code, 60).trim(), name = str(x.name, 80).trim();
      if (!name || !code) return res.status(400).json({ error: 'Nom et code requis' });
      if (seenId.has(id) || seenCode.has(code)) return res.status(400).json({ error: 'Code ou identifiant en double : ' + code });
      seenId.add(id); seenCode.add(code);
      out.push({ id, name, code, links: cleanLinks(x.links), commission: num(x.commission, 30), landing: str(x.landing, 600), referrer: seenId.has(x.referrer) || b.subs.some((y) => y.id === x.referrer) ? str(x.referrer, 40) : '', created: num(x.created, Date.now()) });
    }
    const keep = new Set(out.map((s) => s.id));
    for (const id of Object.keys(state.msgs)) if (!keep.has(id)) delete state.msgs[id];
    for (const id of Object.keys(state.rewardsClaimed)) if (!keep.has(id)) delete state.rewardsClaimed[id];
    state.subs = out;
  }
  if (Array.isArray(b.announce)) state.announce = b.announce.slice(0, 20).map((a) => ({ text: str(a.text, 1000), t: num(a.t, Date.now()) }));
  await saveState();
  res.json({ ok: true });
});

app.post('/api/msg/:id', need('a'), async (req, res) => {
  const sub = state.subs.find((s) => s.id === req.params.id);
  const text = str(req.body && req.body.text, 2000).trim();
  if (!sub || !text) return res.status(400).json({ error: 'Message invalide' });
  (state.msgs[sub.id] = state.msgs[sub.id] || []).push({ from: 'a', text, t: Date.now() });
  await saveState(); res.json({ ok: true });
});
app.post('/api/pay/:id/paid', need('a'), async (req, res) => {
  const p = state.payments.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Introuvable' });
  p.status = 'paid'; p.paidAt = Date.now();
  await saveState(); res.json({ ok: true });
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
  state = {
    settings: Object.assign(base.settings, d.settings || {}, { adminCode: code }),
    subs: (Array.isArray(d.subs) ? d.subs : []).map((x) => ({ id: str(x.id, 40) || uid(), name: str(x.name, 80), code: str(x.code, 60), links: cleanLinks(x.links), commission: num(x.commission, 30), landing: str(x.landing, 600), referrer: str(x.referrer, 40), created: num(x.created, Date.now()) })),
    payments: Array.isArray(d.payments) ? d.payments : [],
    msgs: d.msgs && typeof d.msgs === 'object' ? d.msgs : {},
    rewardsClaimed: d.rewardsClaimed && typeof d.rewardsClaimed === 'object' ? d.rewardsClaimed : {},
    announce: Array.isArray(d.announce) ? d.announce : []
  };
  await saveState(); res.json({ ok: true });
});
app.post('/api/reset', need('a'), async (req, res) => {
  const code = state.settings.adminCode;
  state = defState(); state.settings.adminCode = code;
  await saveState(); await clearEvents(); res.json({ ok: true });
});
app.post('/api/tg-test', need('a'), async (req, res) => {
  const ok = await tg('✅ Test ' + state.settings.brand);
  res.status(ok ? 200 : 400).json(ok ? { ok: true } : { error: 'Échec : vérifie le token, le chat ID et que les notifications sont activées (enregistre d\'abord)' });
});

/* ================= Membre ================= */
app.post('/api/me/msg', need('m'), async (req, res) => {
  const sub = req.auth.sub, text = str(req.body && req.body.text, 2000).trim();
  if (!text) return res.status(400).json({ error: 'Message vide' });
  (state.msgs[sub.id] = state.msgs[sub.id] || []).push({ from: 'm', text, t: Date.now() });
  await saveState(); tg(`💬 Nouveau message de ${sub.name}`); res.json({ ok: true });
});
app.post('/api/me/withdraw', need('m'), async (req, res) => {
  const sub = req.auth.sub, details = str(req.body && req.body.details, 500).trim();
  if (!details) return res.status(400).json({ error: 'Coordonnées de paiement requises' });
  if (parisDay() !== state.settings.wDay) return res.status(400).json({ error: `Les retraits sont ouverts le ${state.settings.wDay} de chaque mois` });
  if (state.payments.some((p) => p.subId === sub.id && p.type === 'w' && p.status === 'pending')) return res.status(400).json({ error: 'Tu as déjà une demande en attente' });
  const amount = Math.round((earnedOf(sub) - withdrawnOf(sub.id)) * 100) / 100;
  if (amount <= 0) return res.status(400).json({ error: 'Solde insuffisant' });
  state.payments.push({ id: uid(), subId: sub.id, type: 'w', amount, date: Date.now(), details, status: 'pending' });
  await saveState(); tg(`💸 Demande de retrait ${amount.toFixed(2)} € — ${sub.name}`); res.json({ ok: true });
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
  await saveState(); tg(`🎁 Reward ${tier.reward} € demandé — ${sub.name}`); res.json({ ok: true });
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
});

/* ================= App ================= */
const escHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
app.use('/assets', express.static(path.join(__dirname, 'assets'), { maxAge: '7d' }));
app.get('/favicon.ico', (_, res) => res.redirect(301, '/assets/favicon-32.png'));
app.get('/manifest.webmanifest', (_, res) => {
  const st = state.settings;
  res.type('application/manifest+json').json({
    name: st.brand, short_name: st.brand.slice(0, 12), start_url: '/', scope: '/', display: 'standalone',
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
  const b = { brand: st.brand, colorA: st.colorA, colorB: st.colorB, logo: st.logo };
  html = html.replace('<title>AFFIX</title>', '<title>' + escHtml(st.brand) + '</title>')
    .replace('</head>', '<style>:root{--a:' + st.colorA + ';--b:' + st.colorB + '}</style><script>window.BRAND=' + JSON.stringify(b).replace(/</g, '\\u003c') + '</script></head>');
  res.set('Cache-Control', 'no-cache'); res.type('html').send(html);
});
app.get('/health', (_, res) => res.json({ ok: true, storage: pool ? 'postgres' : 'fichier', subs: state.subs.length, events: events.length }));

initStore().then(() => {
  app.listen(process.env.PORT || 3000, () => console.log('AFFIX OK — stockage : ' + (pool ? 'Postgres' : 'fichiers')));
}).catch((e) => { console.error('Init échouée', e); process.exit(1); });
