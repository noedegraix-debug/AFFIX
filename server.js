/**
 * Blue Dash — serveur de postbacks (équivalent de lexora-postback-server)
 * Reçoit les postbacks Blue Affiliates, agrège par code sous-affilié,
 * et expose /api/sync que l'app (Paramètres → Synchronisation) interroge.
 *
 * Variables Render : ADMIN_API_KEY (obligatoire), BLUE_AFFILIATES_SECRET (optionnel,
 * active la vérification de {sig}), SUB_PARAM (défaut "sub1").
 */
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const FILE = path.join(process.env.DATA_DIR || __dirname, 'events.json');
const API_KEY = process.env.ADMIN_API_KEY || '';
const SECRET = process.env.BLUE_AFFILIATES_SECRET || '';
const SUB_PARAM = process.env.SUB_PARAM || 'sub1';

let events = [];
try { events = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) {}
const persist = () => { try { fs.writeFileSync(FILE, JSON.stringify(events)); } catch (e) { console.error(e); } };

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'x-api-key, content-type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// {sig} = HMAC-SHA256 de la query string canonicalisée (clés triées, hors sig).
// Si le test Blue Affiliates échoue, ajuste seulement canonical().
const canonical = (q) => Object.keys(q).filter(k => k !== 'sig').sort().map(k => `${k}=${q[k]}`).join('&');
function sigOk(q) {
  if (!SECRET) return true;
  if (!q.sig) return false;
  const exp = crypto.createHmac('sha256', SECRET).update(canonical(q)).digest('hex');
  const a = Buffer.from(String(q.sig)), b = Buffer.from(exp);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// URL à coller dans Blue Affiliates (Postback Tracking → URL template)
app.get('/postback', (req, res) => {
  const q = req.query;
  if (!sigOk(q)) return res.status(401).send('invalid signature');
  events.push({
    t: Date.now(),
    type: q.event || 'unknown',
    code: q[SUB_PARAM] || q.sub || q.sub1 || '',
    clickid: q.clickid || '',
    tx: q.transaction_id || '',
    amount: parseFloat(q.amount) || 0,
    commission: parseFloat(q.commission) || 0,
    country: q.country || ''
  });
  if (events.length > 50000) events = events.slice(-40000);
  persist();
  res.send('ok');
});

// Stats agrégées par code — appelé par l'app (fusion côté app, jamais d'écrasement)
app.get('/api/sync', (req, res) => {
  if (!API_KEY || req.headers['x-api-key'] !== API_KEY) return res.status(401).json({ error: 'clé API invalide' });
  const codes = {};
  const seen = new Set();
  for (const e of events) {
    if (!e.code) continue;
    if (e.tx && seen.has(e.type + e.tx)) continue; // dédoublonne les retries
    if (e.tx) seen.add(e.type + e.tx);
    const c = codes[e.code] = codes[e.code] || { inscriptions: 0, ftd: 0, deposits: 0, depositsAmount: 0, commission: 0, events: [] };
    if (e.type === 'registration') c.inscriptions++;
    if (e.type === 'ftd') { c.ftd++; }
    if (e.type === 'deposit') { c.deposits++; c.depositsAmount += e.amount; }
    if (e.type === 'commission_paid') c.commission += e.commission;
    if (e.type === 'commission_paid') c.events.push({ t: e.t, type: e.type, commission: e.commission, amount: e.amount });
  }
  res.json({ codes, total: events.length });
});

// Sert l'app (index.html) sur la racine : un seul service Render héberge tout
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/health', (_, res) => res.json({ ok: true, events: events.length }));
app.listen(process.env.PORT || 3000, () => console.log('Blue Dash server OK'));
