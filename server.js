'use strict';
// Ausleihe-Kiosk: schlanker Server vor der Snipe-IT-API.
// Keine externen Pakete nötig (Node 20+ mit eingebautem fetch).

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '3040', 10);
const SNIPEIT_URL = (process.env.SNIPEIT_URL || '').replace(/\/+$/, '');
const SNIPEIT_TOKEN = process.env.SNIPEIT_TOKEN || '';
const IDLE_SECONDS = parseInt(process.env.IDLE_SECONDS || '45', 10);
const PUBLIC_DIR = path.join(__dirname, 'public');

if (!SNIPEIT_URL || !SNIPEIT_TOKEN) {
  console.error('SNIPEIT_URL und SNIPEIT_TOKEN müssen gesetzt sein.');
  process.exit(1);
}

// ---------------------------------------------------------------
// Snipe-IT-API
// ---------------------------------------------------------------
async function snipe(method, apiPath, body) {
  const res = await fetch(SNIPEIT_URL + '/api/v1' + apiPath, {
    method,
    headers: {
      Authorization: 'Bearer ' + SNIPEIT_TOKEN,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  if (res.status === 401 || res.status === 403) {
    const e = new Error('Snipe-IT hat den Zugriff abgelehnt (HTTP ' + res.status + ')');
    e.userMessage = 'Zugriff auf Snipe-IT abgelehnt. Bitte das API-Token prüfen.';
    throw e;
  }
  let data = null;
  try {
    data = await res.json();
  } catch (_) {
    /* keine JSON-Antwort */
  }
  return { ok: res.ok, status: res.status, data };
}

function flattenMessages(m) {
  if (!m) return '';
  if (typeof m === 'string') return m;
  if (Array.isArray(m)) return m.map(flattenMessages).join(' ');
  if (typeof m === 'object') return Object.values(m).map(flattenMessages).join(' ');
  return String(m);
}

function publicUser(u) {
  const name =
    u.name || [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || 'Unbekannt';
  return { id: u.id, name, number: u.employee_num || '' };
}

function assetLabel(a) {
  return a.name || (a.model && a.model.name) || a.asset_tag || 'Gerät #' + a.id;
}

async function findUser(code) {
  const r = await snipe('GET', '/users?limit=5&employee_num=' + encodeURIComponent(code));
  if (!r.ok || !r.data || !Array.isArray(r.data.rows)) return null;
  // Falls die Filterung serverseitig ignoriert wird, hier exakt prüfen.
  const wanted = code.trim().toLowerCase();
  return (
    r.data.rows.find((u) => String(u.employee_num || '').trim().toLowerCase() === wanted) || null
  );
}

async function findAsset(code) {
  const r = await snipe('GET', '/hardware/bytag/' + encodeURIComponent(code));
  if (!r.ok || !r.data || !r.data.id || !r.data.asset_tag) return null;
  return r.data;
}

async function userAssets(userId) {
  const r = await snipe('GET', '/users/' + userId + '/assets');
  if (!r.ok || !r.data || !Array.isArray(r.data.rows)) return [];
  return r.data.rows.map((a) => ({ id: a.id, tag: a.asset_tag, name: assetLabel(a) }));
}

// ---------------------------------------------------------------
// Ablauf eines Scans
// ---------------------------------------------------------------
async function handleScan(rawCode, userId) {
  const code = String(rawCode || '').trim();
  if (!code) return { result: 'error', message: 'Leere Eingabe.' };

  // 1) Ist es eine Karte (Mitarbeiternummer)?
  const user = await findUser(code);
  if (user) {
    if (userId && user.id === userId) {
      return { result: 'logout', message: 'Abgemeldet.' };
    }
    return {
      result: 'login',
      message: 'Angemeldet.',
      user: publicUser(user),
      assets: await userAssets(user.id),
    };
  }

  // 2) Ist es ein Gerät (Asset-Tag)?
  const asset = await findAsset(code);
  if (!asset) {
    return { result: 'error', message: '„' + code + '“ ist weder eine Karte noch ein Gerät.' };
  }
  const label = assetLabel(asset);
  const holder = asset.assigned_to;

  // Gerät ist ausgeliehen -> Rückgabe (auch ohne Anmeldung)
  if (holder) {
    const r = await snipe('POST', '/hardware/' + asset.id + '/checkin', { note: 'Kiosk' });
    if (!r.data || r.data.status !== 'success') {
      return {
        result: 'error',
        message: 'Rückgabe fehlgeschlagen: ' + (flattenMessages(r.data && r.data.messages) || 'unbekannter Fehler'),
      };
    }
    const out = {
      result: 'checkin',
      message: label + ' zurückgenommen' + (holder.name ? ' (war bei ' + holder.name + ')' : '') + '.',
      asset: { id: asset.id, tag: asset.asset_tag, name: label },
    };
    if (userId) out.assets = await userAssets(userId);
    return out;
  }

  // Gerät ist frei -> Ausleihe, dafür muss jemand angemeldet sein
  if (!userId) {
    return { result: 'need_login', message: 'Bitte zuerst die Karte scannen.' };
  }
  const meta = asset.status_label && asset.status_label.status_meta;
  if (meta && meta !== 'deployable') {
    return {
      result: 'error',
      message: label + ' ist nicht ausleihbar (Status: ' + asset.status_label.name + ').',
    };
  }
  const r = await snipe('POST', '/hardware/' + asset.id + '/checkout', {
    checkout_to_type: 'user',
    assigned_user: userId,
    note: 'Kiosk',
  });
  if (!r.data || r.data.status !== 'success') {
    return {
      result: 'error',
      message: 'Ausleihe fehlgeschlagen: ' + (flattenMessages(r.data && r.data.messages) || 'unbekannter Fehler'),
    };
  }
  return {
    result: 'checkout',
    message: label + ' ausgeliehen.',
    asset: { id: asset.id, tag: asset.asset_tag, name: label },
    assets: await userAssets(userId),
  };
}

// ---------------------------------------------------------------
// HTTP-Server
// ---------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 10_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Anfrage zu groß'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end('Verboten');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Nicht gefunden');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://x').pathname;

    if (req.method === 'GET' && pathname === '/api/health') {
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'GET' && pathname === '/api/config') {
      return sendJson(res, 200, { idleSeconds: IDLE_SECONDS });
    }
    if (req.method === 'GET' && /^\/api\/user\/\d+$/.test(pathname)) {
      const id = parseInt(pathname.split('/').pop(), 10);
      const r = await snipe('GET', '/users/' + id);
      if (!r.ok || !r.data || !r.data.id) {
        return sendJson(res, 404, { result: 'error', message: 'Benutzer nicht gefunden.' });
      }
      return sendJson(res, 200, { user: publicUser(r.data), assets: await userAssets(id) });
    }
    if (req.method === 'POST' && pathname === '/api/scan') {
      const body = await readBody(req);
      const userId = Number.isInteger(body.userId) ? body.userId : null;
      return sendJson(res, 200, await handleScan(body.code, userId));
    }
    if (req.method === 'GET') {
      return serveStatic(req, res);
    }
    res.writeHead(405);
    res.end();
  } catch (err) {
    console.error(err);
    const unreachable = err && (err.name === 'TimeoutError' || err.cause || err.name === 'TypeError');
    sendJson(res, 502, {
      result: 'error',
      message:
        (err && err.userMessage) ||
        (unreachable ? 'Snipe-IT ist nicht erreichbar.' : 'Interner Fehler.'),
    });
  }
});

server.listen(PORT, () => {
  console.log('Ausleihe-Kiosk läuft auf Port ' + PORT + ', Snipe-IT: ' + SNIPEIT_URL);
});
