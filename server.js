const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const zlib = require('zlib');
const axios = require('axios');

const PORT = process.env.PORT || 8000;

// ════════════════════════════════════════════
//  FETCHER (for scraping pages)
// ════════════════════════════════════════════
function fetchURL(targetURL, opts = {}, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 10) return reject(new Error('Too many redirects'));
    let parsed;
    try { parsed = new URL(targetURL); } catch { return reject(new Error('Invalid URL')); }

    const client = parsed.protocol === 'https:' ? https : http;
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
      'Accept-Encoding': 'gzip, deflate',
      'Referer': opts.referer || parsed.origin + '/',
      'Origin': opts.origin || parsed.origin,
      ...(opts.headers || {}),
    };
    if (opts.cookies) headers['Cookie'] = opts.cookies;

    const request = client.request(targetURL, {
      method: opts.method || 'GET',
      headers,
      rejectUnauthorized: false,
    }, (res) => {
      const setCookies = (res.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
      const allCookies = [opts.cookies, setCookies].filter(Boolean).join('; ');

      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        const next = new URL(res.headers.location, targetURL).href;
        return resolve(fetchURL(next, { ...opts, cookies: allCookies }, depth + 1));
      }

      const chunks = [];
      let stream = res;
      const enc = res.headers['content-encoding'];
      if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());

      stream.on('data', c => chunks.push(c));
      stream.on('end', () => {
        resolve({
          text: Buffer.concat(chunks).toString('utf-8'),
          headers: res.headers,
          cookies: allCookies,
          status: res.statusCode,
          finalURL: targetURL,
        });
      });
      stream.on('error', reject);
    });

    request.on('error', reject);
    request.setTimeout(25000, () => { request.destroy(); reject(new Error('Timeout')); });
    if (opts.postData) request.write(opts.postData);
    request.end();
  });
}

// ════════════════════════════════════════════
//  JS UNPACKER
// ════════════════════════════════════════════
function baseEncode(num, base) {
  const C = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  if (num < base) return C[num] || num.toString(base);
  return baseEncode(Math.floor(num / base), base) + (C[num % base] || (num % base).toString(base));
}

function unpack(p, a, c, k) {
  while (c--) {
    if (k[c]) {
      const t = baseEncode(c, a);
      try {
        p = p.replace(new RegExp('\\b' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g'), k[c]);
      } catch {}
    }
  }
  return p;
}

function findAndUnpackAll(html) {
  const results = [];
  let idx = 0;
  while (true) {
    idx = html.indexOf("eval(function(p,a,c,k,e,", idx);
    if (idx === -1) break;
    try {
      const argStart = html.indexOf("}('", idx);
      if (argStart === -1 || argStart - idx > 5000) { idx++; continue; }
      let pos = argStart + 3, packed = '';
      while (pos < html.length && pos < argStart + 500000) {
        if (html[pos] === '\\') { packed += html[pos] + html[pos + 1]; pos += 2; }
        else if (html[pos] === "'") break;
        else { packed += html[pos]; pos++; }
      }
      pos++;
      if (html[pos] === ',') pos++;
      let bs = ''; while (pos < html.length && html[pos] !== ',') bs += html[pos++]; pos++;
      let cs = ''; while (pos < html.length && html[pos] !== ',') cs += html[pos++]; pos++;
      while (pos < html.length && (html[pos] === ' ' || html[pos] === "'")) pos++;
      let kw = '';
      while (pos < html.length) {
        if (html[pos] === '\\') { kw += html[pos + 1]; pos += 2; }
        else if (html[pos] === "'") break;
        else { kw += html[pos]; pos++; }
      }
      const base = parseInt(bs.trim()), count = parseInt(cs.trim()), keywords = kw.split('|');
      if (!isNaN(base) && !isNaN(count) && keywords.length > 0) {
        packed = packed.replace(/\\'/g, "'").replace(/\\\\/g, "\\").replace(/\\n/g, "\n").replace(/\\r/g, "\r");
        const unpacked = unpack(packed, base, count, keywords);
        if (unpacked && unpacked.length > 30) {
          results.push(unpacked);
          console.log(`    ✓ Unpacked ${unpacked.length} chars`);
        }
      }
    } catch {} idx++;
  }
  return results;
}

// ════════════════════════════════════════════
//  PLAYER HANDLERS
// ════════════════════════════════════════════
const PLAYERS = {
  vk: {
    match: u => /vk\.com|vkvideo|vk-cdn|vkuser/i.test(u),
    referer: 'https://vk.com/',
    async extract(url, html) {
      const s = [];
      for (const q of ['2160','1440','1080','720','480','360','240']) {
        const m = html.match(new RegExp(`"url${q}"\\s*:\\s*"([^"]+)"`, 'i'));
        if (m) s.push({ url: m[1].replace(/\\\//g, '/').replace(/\\u0026/g, '&'), quality: q+'p', type: 'video/mp4', player: 'VK' });
      }
      const hls = html.match(/"hls"\s*:\s*"([^"]+)"/i);
      if (hls) s.push({ url: hls[1].replace(/\\\//g, '/'), quality: 'HLS', type: 'application/x-mpegURL', player: 'VK' });
      return s;
    }
  },
  okru: {
    match: u => /ok\.ru|odnoklassniki|mycdn\.me/i.test(u),
    referer: 'https://ok.ru/',
    async extract(url, html) {
      const s = [];
      const d = html.match(/data-options="([^"]*)"/i);
      if (d) {
        try {
          const opts = JSON.parse(d[1].replace(/&quot;/g,'"').replace(/&amp;/g,'&'));
          const meta = typeof opts.flashvars?.metadata === 'string' ? JSON.parse(opts.flashvars.metadata) : opts.flashvars?.metadata;
          if (meta?.videos) meta.videos.forEach(v => s.push({ url: v.url, quality: v.name||'Default', type: 'video/mp4', player: 'OK.ru' }));
          if (meta?.hlsManifestUrl) s.push({ url: meta.hlsManifestUrl, quality: 'HLS', type: 'application/x-mpegURL', player: 'OK.ru' });
        } catch {}
      }
      let m;
      const p = /["'](https?:\/\/[^"']*?mycdn\.me[^"']+(?:\.mp4|\.m3u8)[^"']*)["']/gi;
      while ((m = p.exec(html)) !== null) s.push({ url: m[1], quality: 'Direct', type: 'video/mp4', player: 'OK.ru' });
      return s;
    }
  },
  sibnet: {
    match: u => /sibnet/i.test(u),
    referer: 'https://video.sibnet.ru/',
    async extract(url, html) {
      const s = [];
      const pats = [
        /player\.src\s*\(\s*\[\s*\{[^}]*src\s*:\s*["']([^"']+)/i,
        /src\s*:\s*["'](\/v\/[^"']+)/i,
        /["'](https?:\/\/video\d*\.sibnet\.ru\/[^"']+\.mp4[^"']*)["']/gi,
      ];
      for (const p of pats) { let m; while ((m = p.exec(html)) !== null) { let u2 = m[1]; if (u2.startsWith('/')) u2 = 'https://video.sibnet.ru' + u2; s.push({ url: u2, quality: 'Default', type: 'video/mp4', player: 'Sibnet' }); } }
      return s;
    }
  },
  dood: {
    match: u => /dood|d0o0d|ds2play|doods/i.test(u),
    referer: 'https://dood.to/',
    async extract(url, html) {
      const s = [];
      const pm = html.match(/\/pass_md5\/([^'"]+)/i);
      if (pm) {
        try {
          const passURL = new URL(pm[0], url).href;
          const resp = await fetchURL(passURL, { referer: url });
          const token = resp.text.trim();
          if (token.startsWith('http')) {
            let rs = ''; const ch = 'abcdefghijklmnopqrstuvwxyz0123456789';
            for (let i = 0; i < 10; i++) rs += ch[Math.floor(Math.random() * ch.length)];
            s.push({ url: `${token}${rs}?token=${pm[1]}&expiry=${Date.now()}`, quality: 'Default', type: 'video/mp4', player: 'DoodStream' });
          }
        } catch {}
      }
      return s;
    }
  },
  streamtape: {
    match: u => /streamtape|strtape|stape/i.test(u),
    referer: 'https://streamtape.com/',
    async extract(url, html) {
      const s = [];
      const inner = html.match(/id="(?:robotlink|nomark)"[^>]*>([^<]*)<\/div>/i);
      const tok = html.match(/innerHTML\s*=\s*['"][^'"]*['"]\s*\+\s*\('([^']+)'\)\.substring\((\d+)\)/i);
      if (inner && tok) {
        const final = `https:${inner[1].trim()}${tok[1].substring(parseInt(tok[2]))}`;
        if (final.includes('/get_video')) s.push({ url: final, quality: 'Default', type: 'video/mp4', player: 'StreamTape' });
      }
      return s;
    }
  },
  mixdrop: {
    match: u => /mixdrop/i.test(u),
    referer: 'https://mixdrop.co/',
    async extract(url, html) {
      const s = [];
      for (const code of findAndUnpackAll(html)) {
        const m = code.match(/(?:MDCore\.wurl|MDCore\.vsrc)\s*=\s*"([^"]+)"/i);
        if (m) { let u2 = m[1]; if (u2.startsWith('//')) u2 = 'https:' + u2; s.push({ url: u2, quality: 'Default', type: 'video/mp4', player: 'MixDrop' }); }
      }
      return s;
    }
  },
  mp4upload: {
    match: u => /mp4upload/i.test(u),
    referer: 'https://mp4upload.com/',
    async extract(url, html) {
      const s = [];
      const m = html.match(/player\.src\s*\(\s*["']([^"']+)/i) || html.match(/src\s*:\s*["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i);
      if (m) s.push({ url: m[1], quality: 'Default', type: 'video/mp4', player: 'Mp4Upload' });
      return s;
    }
  },
  uqload: {
    match: u => /uqload/i.test(u),
    referer: 'https://uqload.co/',
    async extract(url, html) {
      const s = [];
      const pats = [/sources\s*:\s*\["([^"]+)"\]/i, /src\s*:\s*["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i, /video_link\s*=\s*["']([^"']+)/i];
      for (const p of pats) { const m = html.match(p); if (m) s.push({ url: m[1], quality: 'Default', type: 'video/mp4', player: 'Uqload' }); }
      return s;
    }
  },
  megamax: {
    match: u => /megamax|mega\./i.test(u),
    referer: 'https://megamax.me/',
    async extract(url, html) {
      const s = [], seen = new Set();
      const allCode = [html, ...findAndUnpackAll(html)].join('\n');
      const pats = [
        /file\s*:\s*["']([^"']+\.(?:mp4|m3u8)[^"']*)["']/gi,
        /src\s*:\s*["']([^"']+\.(?:mp4|m3u8)[^"']*)["']/gi,
        /["'](https?:\/\/[^"'\s]+?\.mp4[^"'\s]*?)["']/gi,
        /["'](https?:\/\/[^"'\s]+?\.m3u8[^"'\s]*?)["']/gi,
      ];
      for (const p of pats) { let m; while ((m = p.exec(allCode)) !== null) { const u2 = m[1].replace(/\\/g, ''); if (!seen.has(u2)) { seen.add(u2); s.push({ url: u2, quality: detectQuality(u2), type: /m3u8/i.test(u2) ? 'application/x-mpegURL' : 'video/mp4', player: 'MegaMax' }); } } }
      return s;
    }
  },
  vidmoly: {
    match: u => /vidmoly/i.test(u),
    referer: 'https://vidmoly.to/',
    async extract(url, html) {
      const s = [];
      const m = html.match(/sources\s*:\s*\[\s*\{[^}]*file\s*:\s*["']([^"']+)/i);
      if (m) s.push({ url: m[1], quality: 'HLS', type: 'application/x-mpegURL', player: 'Vidmoly' });
      return s;
    }
  },
  yourupload: {
    match: u => /yourupload/i.test(u),
    referer: 'https://www.yourupload.com/',
    async extract(url, html) {
      const s = [];
      const m = html.match(/file\s*:\s*'([^']+)'/i);
      if (m) s.push({ url: m[1], quality: 'Default', type: 'video/mp4', player: 'YourUpload' });
      return s;
    }
  },
  sendvid: {
    match: u => /sendvid/i.test(u),
    referer: 'https://sendvid.com/',
    async extract(url, html) {
      const s = [];
      const m = html.match(/source\s+src="([^"]+)"/i);
      if (m) s.push({ url: m[1], quality: 'Default', type: 'video/mp4', player: 'SendVid' });
      return s;
    }
  },
  myvi: {
    match: u => /myvi/i.test(u),
    referer: 'https://www.myvi.tv/',
    async extract(url, html) {
      const s = [];
      const m = html.match(/["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i);
      if (m) s.push({ url: m[1], quality: 'HLS', type: 'application/x-mpegURL', player: 'Myvi' });
      return s;
    }
  },
  dailymotion: {
    match: u => /dailymotion|dai\.ly/i.test(u),
    referer: 'https://www.dailymotion.com/',
    async extract(url, html) {
      const s = [];
      const m = html.match(/"qualities"\s*:\s*(\{[\s\S]*?\})\s*,\s*"/i);
      if (m) { try { const q = JSON.parse(m[1]); for (const [k, v] of Object.entries(q)) { if (Array.isArray(v)) v.forEach(x => { if (x.url) s.push({ url: x.url, quality: k + 'p', type: x.type || 'video/mp4', player: 'Dailymotion' }); }); } } catch {} }
      return s;
    }
  },
};

// Referer map for proxy
const REFERER_MAP = {
  'ok.ru': 'https://ok.ru/', 'mycdn.me': 'https://ok.ru/',
  'vk.com': 'https://vk.com/', 'vkuser': 'https://vk.com/', 'vk-cdn': 'https://vk.com/',
  'sibnet': 'https://video.sibnet.ru/',
  'streamtape': 'https://streamtape.com/', 'stape': 'https://streamtape.com/',
  'dood': 'https://dood.to/', 'mixdrop': 'https://mixdrop.co/',
  'mp4upload': 'https://mp4upload.com/', 'uqload': 'https://uqload.co/',
  'dailymotion': 'https://www.dailymotion.com/',
  'filemoon': 'https://filemoon.sx/', 'streamwish': 'https://streamwish.to/',
  'vidmoly': 'https://vidmoly.to/', 'megamax': 'https://megamax.me/',
  'yourupload': 'https://www.yourupload.com/', 'sendvid': 'https://sendvid.com/',
  'myvi': 'https://www.myvi.tv/',
};

function getReferer(videoURL, custom) {
  const lower = videoURL.toLowerCase();
  for (const [domain, ref] of Object.entries(REFERER_MAP)) {
    if (lower.includes(domain)) return ref;
  }
  if (custom) return custom;
  try { return new URL(videoURL).origin + '/'; } catch { return ''; }
}

// ════════════════════════════════════════════
//  GENERIC EXTRACTOR
// ════════════════════════════════════════════
function genericExtract(html, allCode) {
  const sources = [], seen = new Set();
  function add(url, label, type, player = 'Generic') {
    if (!url || seen.has(url)) return;
    url = url.trim().replace(/\\/g, '');
    if (url.length < 10 || !/^https?:\/\//i.test(url)) return;
    if (/\.(js|css|png|jpg|jpeg|gif|svg|ico|woff)(\?|$)/i.test(url) && !/\.mp4|\.m3u8|\.webm/i.test(url)) return;
    seen.add(url);
    sources.push({ url, quality: label || detectQuality(url), type: type || detectType(url), player });
  }

  let m;
  // <source> tags
  const re1 = /<source[^>]+src=["']([^"']+)["'][^>]*>/gi;
  while ((m = re1.exec(allCode)) !== null) {
    const label = (m[0].match(/label=["']([^"']+)/i)||[])[1]||'';
    add(m[1], label, (m[0].match(/type=["']([^"']+)/i)||[])[1]||'');
  }

  // sources arrays
  const re2 = /sources\s*[:=]\s*\[([\s\S]*?)\]/gi;
  while ((m = re2.exec(allCode)) !== null) {
    const re3 = /\{[^}]*?(?:file|src|source|url)\s*[:=]\s*["']([^"']+)["'][^}]*?\}/gi;
    let o;
    while ((o = re3.exec(m[1])) !== null) {
      add(o[1], (o[0].match(/(?:label|quality|res)\s*[:=]\s*["']([^"']+)/i)||[])[1]||'', (o[0].match(/type\s*[:=]\s*["']([^"']+)/i)||[])[1]||'');
    }
  }

  // Assignments
  const pats = [
    /(?:file|source|src|video_?url|videoUrl|stream_?url)\s*[:=]\s*["']([^"']+?\.(?:mp4|m3u8|webm)[^"']*?)["']/gi,
    /(?:file|source|src|video_?url|videoUrl|stream_?url)\s*[:=]\s*["'](https?:\/\/[^"']+?)["']/gi,
    /player\.src\s*\(\s*["']([^"']+)["']/gi,
    /\.setup\s*\(\s*\{[\s\S]*?file\s*:\s*["']([^"']+)["']/gi,
  ];
  for (const p of pats) { while ((m = p.exec(allCode)) !== null) add(m[1],'',''); }

  // Standalone URLs
  for (const p of [/["'](https?:\/\/[^"'\s]+?\.m3u8[^"'\s]*?)["']/gi, /["'](https?:\/\/[^"'\s]+?\.mp4[^"'\s]*?)["']/gi]) {
    while ((m = p.exec(allCode)) !== null) add(m[1],'','');
  }

  // Base64
  const b64 = /atob\s*\(\s*["']([A-Za-z0-9+/=]{20,})["']\s*\)/gi;
  while ((m = b64.exec(allCode)) !== null) {
    try { const d = Buffer.from(m[1],'base64').toString('utf-8'); if (/^https?:\/\//.test(d)) add(d,'base64',''); } catch {}
  }

  return sources;
}

function detectQuality(u) { const m = u.match(/(\d{3,4})p/i); if (m) return m[1]+'p'; if (/master\.m3u8/i.test(u)) return 'Master'; if (/\.m3u8/i.test(u)) return 'HLS'; return 'Default'; }
function detectType(u) { if (/\.m3u8/i.test(u)) return 'application/x-mpegURL'; if (/\.webm/i.test(u)) return 'video/webm'; return 'video/mp4'; }

function parseM3U8(content, base) {
  const lines = content.split('\n').map(l=>l.trim()).filter(Boolean), variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
      const bw = (lines[i].match(/BANDWIDTH=(\d+)/i)||[])[1];
      const res = (lines[i].match(/RESOLUTION=(\d+x\d+)/i)||[])[1];
      let ul = '';
      for (let j = i+1; j < lines.length; j++) { if (!lines[j].startsWith('#')) { ul = lines[j]; break; } }
      if (ul) {
        let fu = ul;
        if (!/^https?:\/\//i.test(ul)) try { fu = new URL(ul, base).href; } catch {}
        variants.push({ url: fu, bandwidth: bw?parseInt(bw):0, resolution: res||'', quality: res?res.split('x')[1]+'p':(bw?Math.round(bw/1000)+'kbps':'HLS'), type: 'application/x-mpegURL' });
      }
    }
  }
  return variants;
}

// ════════════════════════════════════════════
//  EXTRACTION PIPELINE
// ════════════════════════════════════════════
async function extractPipeline(url, referer) {
  console.log(`\n${'═'.repeat(50)}\n  EXTRACT: ${url}\n${'═'.repeat(50)}`);

  const page = await fetchURL(url, { referer });
  console.log(`  Fetched: ${page.text.length} bytes (${page.status})`);

  let player = 'Unknown';
  for (const [name, h] of Object.entries(PLAYERS)) {
    if (h.match(url) || h.match(page.finalURL)) { player = name; break; }
  }
  console.log(`  Player: ${player}`);

  const unpacked = findAndUnpackAll(page.text);
  const allCode = [page.text, ...unpacked].join('\n');
  let sources = [];

  if (player !== 'Unknown') {
    const ps = await PLAYERS[player].extract(url, allCode, referer);
    sources.push(...ps);
    console.log(`  Player handler: ${ps.length}`);
  }

  const gs = genericExtract(page.text, allCode);
  console.log(`  Generic: ${gs.length}`);
  const seen = new Set(sources.map(s => s.url));
  gs.forEach(s => { if (!seen.has(s.url)) { seen.add(s.url); sources.push(s); } });

  // Follow iframes
  const iframeRE = /<iframe[^>]+src=["']([^"']+)["']/gi;
  const iframes = [];
  let m;
  while ((m = iframeRE.exec(page.text)) !== null) {
    let iu = m[1];
    if (iu.startsWith('//')) iu = 'https:' + iu;
    else if (!iu.startsWith('http')) try { iu = new URL(iu, url).href; } catch { continue; }
    if (!/ads|banner|social|facebook|twitter|google|analytics/i.test(iu)) iframes.push(iu);
  }

  for (const iu of iframes.slice(0, 5)) {
    try {
      console.log(`  Iframe: ${iu}`);
      const ip = await fetchURL(iu, { referer: url });
      const iu2 = findAndUnpackAll(ip.text);
      const iAll = [ip.text, ...iu2].join('\n');
      for (const [name, h] of Object.entries(PLAYERS)) {
        if (h.match(iu)) {
          const ps = await h.extract(iu, iAll, url);
          ps.forEach(s => { if (!seen.has(s.url)) { seen.add(s.url); sources.push(s); } });
          break;
        }
      }
      const igs = genericExtract(ip.text, iAll);
      igs.forEach(s => { if (!seen.has(s.url)) { seen.add(s.url); sources.push(s); } });
    } catch (e) { console.log(`  Iframe fail: ${e.message}`); }
  }

  // Parse m3u8
  const expanded = [];
  for (const src of sources) {
    if (/\.m3u8/i.test(src.url)) {
      try {
        const m3 = await fetchURL(src.url, { referer: url });
        const v = parseM3U8(m3.text, src.url);
        if (v.length) {
          v.forEach(x => { x.player = src.player || 'HLS'; if (!seen.has(x.url)) { seen.add(x.url); expanded.push(x); } });
          src.isMaster = true; src.quality = 'Master';
        }
      } catch {}
    }
    expanded.push(src);
  }

  expanded.sort((a, b) => (parseInt(b.quality) || 0) - (parseInt(a.quality) || 0));
  console.log(`  Total: ${expanded.length}\n`);

  return {
    pageInfo: {
      title: (page.text.match(/<title[^>]*>([^<]+)/i)||[])[1]?.trim()||'',
      finalURL: page.finalURL, pageSize: page.text.length, status: page.status,
      detectedPlayer: player, packedScripts: unpacked.length, iframesFound: iframes.length,
    },
    sources: expanded,
  };
}

// ═══════════════════════════════════════════════════
//  ████  PROXY ROUTE — COMPLETE REWRITE  ████
// ═══════════════════════════════════════════════════
async function handleProxy(req, res) {
  // Disable all timeouts for streaming
  req.setTimeout(0);
  res.setTimeout(0);
  if (req.socket) req.socket.setTimeout(0);

  const parsed = new URL(req.url, `http://localhost:${PORT}`);
  const targetURL = parsed.searchParams.get('url');
  const customReferer = parsed.searchParams.get('referer') || '';

  if (!targetURL) {
    res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Missing url parameter' }));
    return;
  }

  let target;
  try { target = new URL(targetURL); } catch {
    res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Invalid URL' }));
    return;
  }

  const referer = getReferer(targetURL, customReferer);
  const isM3U8 = /\.m3u8/i.test(targetURL) || parsed.searchParams.get('type') === 'm3u8';

  console.log(`[PROXY] ${isM3U8 ? '[M3U8]' : '[VIDEO]'} ${targetURL.substring(0, 100)}`);
  console.log(`  Ref: ${referer} | Range: ${req.headers.range || 'none'}`);

  try {
    // Build headers
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': referer,
      'Origin': (() => { try { return new URL(referer).origin; } catch { return target.origin; } })(),
      'Connection': 'keep-alive',
      'Sec-Fetch-Dest': 'video',
      'Sec-Fetch-Mode': 'no-cors',
      'Sec-Fetch-Site': 'cross-site',
    };

    // Forward range for seeking
    if (req.headers.range) {
      headers['Range'] = req.headers.range;
    }

    if (isM3U8) {
      // ── M3U8 PLAYLIST ──
      const response = await axios.get(targetURL, {
        headers: { ...headers, 'Accept': 'application/vnd.apple.mpegurl,*/*' },
        responseType: 'text',
        timeout: 20000,
        maxRedirects: 10,
        validateStatus: () => true,
        httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      });

      if (response.status >= 400) {
        console.log(`  [M3U8] Error ${response.status}`);
        res.writeHead(response.status, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
        res.end(`Upstream: ${response.status}`);
        return;
      }

      let playlist = response.data;

      // Get base URL for relative paths (use final URL after redirects)
      const finalURL = response.request?.res?.responseUrl || targetURL;
      const baseDir = finalURL.substring(0, finalURL.lastIndexOf('/') + 1);

      console.log(`  [M3U8] Final URL: ${finalURL}`);
      console.log(`  [M3U8] Base: ${baseDir}`);

      // Rewrite ALL non-comment lines
      playlist = playlist.split('\n').map(line => {
        const trimmed = line.trim();

        // Skip empty lines and comments
        if (!trimmed || trimmed.startsWith('#')) {
          // But check for URI= in #EXT tags (like encryption keys)
          if (trimmed.includes('URI="')) {
            return trimmed.replace(/URI="([^"]+)"/g, (match, uri) => {
              const absURI = /^https?:\/\//i.test(uri) ? uri : new URL(uri, baseDir).href;
              return `URI="${'/proxy?url=' + encodeURIComponent(absURI) + '&referer=' + encodeURIComponent(referer)}"`;
            });
          }
          return line;
        }

        // This is a URL line (segment or sub-playlist)
        let segURL;
        if (/^https?:\/\//i.test(trimmed)) {
          segURL = trimmed;
        } else {
          try { segURL = new URL(trimmed, baseDir).href; } catch { return line; }
        }

        // Route through proxy — determine if it's m3u8 or segment
        const isSubM3U8 = /\.m3u8/i.test(segURL);
        return `/proxy?url=${encodeURIComponent(segURL)}&referer=${encodeURIComponent(referer)}${isSubM3U8 ? '&type=m3u8' : ''}`;
      }).join('\n');

      res.writeHead(200, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Expose-Headers': '*',
      });
      res.end(playlist);
      console.log(`  [M3U8] Rewritten OK`);
      return;
    }

    // ── VIDEO / BINARY STREAM ──
    const axiosConfig = {
      method: 'GET',
      url: targetURL,
      headers,
      responseType: 'stream',
      timeout: 0,
      maxRedirects: 10,
      validateStatus: () => true,
      decompress: false,
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    };

    const response = await axios(axiosConfig);

    const status = response.status;
    console.log(`  [VIDEO] Status: ${status} | CT: ${response.headers['content-type'] || '?'} | CL: ${response.headers['content-length'] || '?'}`);

    // If upstream returned error
    if (status >= 400) {
      let errBody = '';
      response.data.on('data', c => errBody += c);
      response.data.on('end', () => {
        console.log(`  [VIDEO] Error body: ${errBody.substring(0, 200)}`);
        res.writeHead(status, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
        res.end(`Upstream error ${status}: ${errBody.substring(0, 500)}`);
      });
      return;
    }

    // Build response headers
    const resHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Range, Content-Type',
      'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges, Content-Type',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Cache-Control': 'no-cache',
    };

    // Forward critical headers
    ['content-type', 'content-length', 'content-range', 'accept-ranges', 'content-disposition'].forEach(h => {
      if (response.headers[h]) resHeaders[h] = response.headers[h];
    });

    // Ensure content-type is set
    if (!resHeaders['content-type']) {
      if (/\.mp4/i.test(targetURL)) resHeaders['content-type'] = 'video/mp4';
      else if (/\.webm/i.test(targetURL)) resHeaders['content-type'] = 'video/webm';
      else if (/\.ts/i.test(targetURL)) resHeaders['content-type'] = 'video/mp2t';
      else resHeaders['content-type'] = 'application/octet-stream';
    }

    // Ensure accept-ranges is set
    if (!resHeaders['accept-ranges']) {
      resHeaders['accept-ranges'] = 'bytes';
    }

    res.writeHead(status, resHeaders);

    // Pipe the stream
    response.data.pipe(res);

    // Cleanup on client disconnect
    let cleaned = false;
    function cleanup() {
      if (cleaned) return;
      cleaned = true;
      try {
        if (response.data && typeof response.data.destroy === 'function') response.data.destroy();
      } catch {}
    }

    req.on('close', cleanup);
    req.on('error', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);

    response.data.on('error', (err) => {
      console.error(`  [VIDEO] Stream error: ${err.message}`);
      cleanup();
      if (!res.headersSent) {
        res.writeHead(502);
        res.end('Stream error');
      } else {
        try { res.end(); } catch {}
      }
    });

    response.data.on('end', () => {
      console.log(`  [VIDEO] Stream complete`);
    });

  } catch (err) {
    console.error(`  [PROXY] ✗ ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: err.message, url: targetURL }));
    } else {
      try { res.end(); } catch {}
    }
  }
}

// ════════════════════════════════════════════
//  HTTP SERVER
// ════════════════════════════════════════════
const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://localhost:${PORT}`);

  // Global CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type, Authorization');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── index.html ──
  if (parsed.pathname === '/' || parsed.pathname === '/index.html') {
    fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
      if (err) { res.writeHead(500); res.end('index.html not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  // ── /proxy ──
  if (parsed.pathname === '/proxy') return handleProxy(req, res);

  // ── /test — Debug a URL through proxy ──
  if (parsed.pathname === '/test') {
    const targetURL = parsed.searchParams.get('url');
    if (!targetURL) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<html><body style="background:#111;color:#eee;font-family:monospace;padding:20px">
        <h2>🧪 Proxy URL Tester</h2>
        <form method="GET"><input name="url" placeholder="Video URL" style="width:500px;padding:10px" /><button type="submit" style="padding:10px 20px">Test</button></form>
      </body></html>`);
      return;
    }

    const referer = getReferer(targetURL, parsed.searchParams.get('referer') || '');
    console.log(`[TEST] ${targetURL}`);

    try {
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': referer,
        'Origin': (() => { try { return new URL(referer).origin; } catch { return ''; } })(),
        'Accept': '*/*',
        'Range': 'bytes=0-1024',
      };

      const response = await axios({
        method: 'GET', url: targetURL, headers,
        responseType: 'arraybuffer', timeout: 15000,
        maxRedirects: 10, validateStatus: () => true,
        httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      });

      const result = {
        status: response.status,
        statusText: response.statusText,
        contentType: response.headers['content-type'],
        contentLength: response.headers['content-length'],
        contentRange: response.headers['content-range'],
        acceptRanges: response.headers['accept-ranges'],
        bodySize: response.data.length,
        bodyPreview: response.data.toString('utf-8').substring(0, 200),
        refererUsed: referer,
        finalURL: response.request?.res?.responseUrl || targetURL,
        allHeaders: response.headers,
        isVideo: /video|octet-stream|mp4|webm|mpegurl/i.test(response.headers['content-type'] || ''),
        proxyURL: `/proxy?url=${encodeURIComponent(targetURL)}&referer=${encodeURIComponent(referer)}`,
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result, null, 2));
    } catch (err) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message, url: targetURL, referer }));
    }
    return;
  }

  // ── /extract & /api/extract ──
  if ((parsed.pathname === '/extract' || parsed.pathname === '/api/extract') && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { url, referer } = JSON.parse(body);
        if (!url) throw new Error('Missing url');
        const result = await extractPipeline(url, referer || '');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...result }));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  if (parsed.pathname === '/api/extract' && req.method === 'GET') {
    const url = parsed.searchParams.get('url');
    if (!url) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Missing url' })); return; }
    try {
      const result = await extractPipeline(url, parsed.searchParams.get('referer') || '');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...result }));
    } catch (err) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  if (parsed.pathname === '/api/players') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ players: Object.keys(PLAYERS) }));
    return;
  }

  if (parsed.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime(), port: PORT }));
    return;
  }

  if (parsed.pathname === '/fetch') {
    const u = parsed.searchParams.get('url');
    if (!u) { res.writeHead(400); res.end('Missing url'); return; }
    try {
      const r = await fetchURL(u);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(r.text);
    } catch (e) { res.writeHead(502); res.end(e.message); }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.on('error', e => console.error('[SERVER]', e.message));
process.on('uncaughtException', e => console.error('[UNCAUGHT]', e.message));
process.on('unhandledRejection', e => console.error('[UNHANDLED]', e?.message || e));

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  🎬 Video Extractor v2.2 — Port ${PORT}`);
  console.log(`  📡 http://localhost:${PORT}`);
  console.log(`  🧪 http://localhost:${PORT}/test`);
  console.log(`\n  Routes:`);
  console.log(`    POST /api/extract        — Extract links`);
  console.log(`    GET  /api/extract?url=... — Extract (GET)`);
  console.log(`    GET  /proxy?url=...       — Stream proxy`);
  console.log(`    GET  /test?url=...        — Debug/test URL`);
  console.log(`    GET  /health              — Health check`);
  console.log(`${'═'.repeat(50)}\n`);
});
