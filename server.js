// ══════════════════════════════════════════════════════
//  UNIVERSAL VIDEO LINK EXTRACTOR — v2
//  Supports 20+ players, API for Android, HTTPS-ready
// ══════════════════════════════════════════════════════

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const zlib = require('zlib');

const PORT = process.env.PORT || 10000;

// ══════════════════════════════════════
// ROBUST FETCHER
// ══════════════════════════════════════
function fetchURL(targetURL, opts = {}, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 10) return reject(new Error('Too many redirects'));

    let parsed;
    try { parsed = new URL(targetURL); } catch { return reject(new Error('Invalid URL')); }

    const client = parsed.protocol === 'https:' ? https : http;

    const headers = {
      'User-Agent': opts.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
      'Accept-Encoding': 'gzip, deflate',
      'Referer': opts.referer || parsed.origin + '/',
      'Origin': opts.origin || parsed.origin,
      'Connection': 'keep-alive',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'cross-site',
      ...(opts.headers || {}),
    };

    if (opts.cookies) headers['Cookie'] = opts.cookies;

    const request = client.request(targetURL, {
      method: opts.method || 'GET',
      headers,
      rejectUnauthorized: false,
    }, (res) => {
      const setCookies = (res.headers['set-cookie'] || [])
        .map(c => c.split(';')[0]).join('; ');

      const allCookies = [opts.cookies, setCookies].filter(Boolean).join('; ');

      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const next = new URL(res.headers.location, targetURL).href;
        console.log(`    ↪ [${res.statusCode}] → ${next}`);
        return resolve(fetchURL(next, { ...opts, cookies: allCookies }, depth + 1));
      }

      const chunks = [];
      const encoding = res.headers['content-encoding'];
      let stream = res;

      if (encoding === 'gzip') {
        stream = res.pipe(zlib.createGunzip());
      } else if (encoding === 'deflate') {
        stream = res.pipe(zlib.createInflate());
      }

      stream.on('data', c => chunks.push(c));
      stream.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({
          text: body.toString('utf-8'),
          body,
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

    if (opts.postData) {
      request.write(opts.postData);
    }

    request.end();
  });
}

// Helper: POST request
function postURL(url, data, opts = {}) {
  const postData = typeof data === 'string' ? data : JSON.stringify(data);
  return fetchURL(url, {
    ...opts,
    method: 'POST',
    headers: {
      'Content-Type': typeof data === 'string'
        ? 'application/x-www-form-urlencoded'
        : 'application/json',
      'Content-Length': Buffer.byteLength(postData),
      ...(opts.headers || {}),
    },
    postData,
  });
}

// ══════════════════════════════════════
// JS UNPACKER (eval/packed)
// ══════════════════════════════════════
function baseEncode(num, base) {
  const CHARS = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  if (num < base) return CHARS[num] || num.toString(base);
  return baseEncode(Math.floor(num / base), base) + (CHARS[num % base] || (num % base).toString(base));
}

function unpack(p, a, c, k) {
  while (c--) {
    if (k[c]) {
      const token = baseEncode(c, a);
      try {
        const re = new RegExp('\\b' + token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g');
        p = p.replace(re, k[c]);
      } catch {}
    }
  }
  return p;
}

function findAndUnpackAll(html) {
  const results = [];
  let idx = 0;

  while (true) {
    const marker = "eval(function(p,a,c,k,e,";
    idx = html.indexOf(marker, idx);
    if (idx === -1) break;

    try {
      const argStart = html.indexOf("}('", idx);
      if (argStart === -1 || argStart - idx > 5000) { idx++; continue; }

      let pos = argStart + 3;
      let packed = '';
      while (pos < html.length && pos < argStart + 500000) {
        if (html[pos] === '\\') { packed += html[pos] + html[pos + 1]; pos += 2; }
        else if (html[pos] === "'") break;
        else { packed += html[pos]; pos++; }
      }

      pos++;
      if (html[pos] === ',') pos++;
      let baseStr = '';
      while (pos < html.length && html[pos] !== ',') baseStr += html[pos++];
      pos++;
      let countStr = '';
      while (pos < html.length && html[pos] !== ',') countStr += html[pos++];
      pos++;
      while (pos < html.length && (html[pos] === ' ' || html[pos] === "'")) pos++;
      let kwStr = '';
      while (pos < html.length) {
        if (html[pos] === '\\') { kwStr += html[pos + 1]; pos += 2; }
        else if (html[pos] === "'") break;
        else { kwStr += html[pos]; pos++; }
      }

      const base = parseInt(baseStr.trim());
      const count = parseInt(countStr.trim());
      const keywords = kwStr.split('|');

      if (!isNaN(base) && !isNaN(count) && keywords.length > 0) {
        packed = packed.replace(/\\'/g, "'").replace(/\\\\/g, "\\")
                       .replace(/\\n/g, "\n").replace(/\\r/g, "\r");
        const unpacked = unpack(packed, base, count, keywords);
        if (unpacked && unpacked.length > 30) {
          results.push(unpacked);
          console.log(`    ✓ Unpacked: ${packed.length} → ${unpacked.length} chars`);
        }
      }
    } catch (e) {
      console.log(`    ✗ Unpack error: ${e.message}`);
    }
    idx++;
  }

  return results;
}

// ══════════════════════════════════════
// PLAYER-SPECIFIC EXTRACTORS
// ══════════════════════════════════════
const PLAYER_HANDLERS = {

  // ── VK Player ──
  vk: {
    match: (url) => /vk\.com|vkvideo/i.test(url),
    async extract(url, html, referer) {
      const sources = [];
      console.log('    [VK] Extracting...');

      // Method 1: Direct quality URLs in page JSON
      const qualities = ['2160', '1440', '1080', '720', '480', '360', '240', '144'];
      for (const q of qualities) {
        // Pattern: "url720":"https://..."
        const patterns = [
          new RegExp(`"url${q}"\\s*:\\s*"([^"]+)"`, 'i'),
          new RegExp(`url${q}\\s*=\\s*"([^"]+)"`, 'i'),
          new RegExp(`"url${q}"\\s*:\\s*"([^"]+)"`, 'gi'),
        ];
        for (const pat of patterns) {
          const m = html.match(pat);
          if (m) {
            let vurl = m[1].replace(/\\\//g, '/').replace(/\\u0026/g, '&');
            sources.push({ url: vurl, quality: q + 'p', type: 'video/mp4', player: 'VK' });
          }
        }
      }

      // Method 2: player.params JSON
      const paramsMatch = html.match(/var\s+playerParams\s*=\s*(\{[\s\S]*?\});/i)
        || html.match(/"params"\s*:\s*\[(\{[\s\S]*?\})\]/i)
        || html.match(/ajax\.preload\s*\(\s*"[^"]*"\s*,\s*(\{[\s\S]*?\})\s*\)/i);

      if (paramsMatch) {
        try {
          const params = JSON.parse(paramsMatch[1]);
          for (const q of qualities) {
            const key = `url${q}`;
            if (params[key]) {
              sources.push({ url: params[key], quality: q + 'p', type: 'video/mp4', player: 'VK' });
            }
          }
          if (params.hls) {
            sources.push({ url: params.hls, quality: 'HLS Master', type: 'application/x-mpegURL', player: 'VK' });
          }
          if (params.dash_webm) {
            sources.push({ url: params.dash_webm, quality: 'DASH', type: 'application/dash+xml', player: 'VK' });
          }
        } catch {}
      }

      // Method 3: HLS manifest
      const hlsMatch = html.match(/"hls"\s*:\s*"([^"]+)"/i)
        || html.match(/hls_host.*?["']([^"']+\.m3u8[^"']*?)["']/i);
      if (hlsMatch) {
        sources.push({
          url: hlsMatch[1].replace(/\\\//g, '/'),
          quality: 'HLS Master',
          type: 'application/x-mpegURL',
          player: 'VK'
        });
      }

      // Method 4: OG video meta
      const ogVideo = html.match(/property="og:video"\s+content="([^"]+)"/i)
        || html.match(/property="og:video:url"\s+content="([^"]+)"/i);
      if (ogVideo) {
        sources.push({ url: ogVideo[1], quality: 'OG', type: 'video/mp4', player: 'VK' });
      }

      return sources;
    }
  },

  // ── OK.ru (Odnoklassniki) ──
  okru: {
    match: (url) => /ok\.ru|odnoklassniki/i.test(url),
    async extract(url, html, referer) {
      const sources = [];
      console.log('    [OK.ru] Extracting...');

      // Method 1: data-options JSON
      const dataOpts = html.match(/data-options="([^"]*)"/i)
        || html.match(/data-options='([^']*)'/i);

      if (dataOpts) {
        try {
          const decoded = dataOpts[1]
            .replace(/&quot;/g, '"')
            .replace(/&amp;/g, '&')
            .replace(/&#39;/g, "'")
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>');

          const opts = JSON.parse(decoded);
          const metadata = opts.flashvars?.metadata;
          if (metadata) {
            const meta = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
            if (meta.videos) {
              meta.videos.forEach(v => {
                sources.push({
                  url: v.url,
                  quality: v.name || 'Unknown',
                  type: 'video/mp4',
                  player: 'OK.ru'
                });
              });
            }
            if (meta.hlsManifestUrl) {
              sources.push({
                url: meta.hlsManifestUrl,
                quality: 'HLS Master',
                type: 'application/x-mpegURL',
                player: 'OK.ru'
              });
            }
            if (meta.dashManifestUrl) {
              sources.push({
                url: meta.dashManifestUrl,
                quality: 'DASH',
                type: 'application/dash+xml',
                player: 'OK.ru'
              });
            }
          }
        } catch (e) {
          console.log(`    [OK.ru] data-options parse error: ${e.message}`);
        }
      }

      // Method 2: flashvars
      const fvMatch = html.match(/flashvars['"]\s*:\s*\{([\s\S]*?)\}/i);
      if (fvMatch) {
        const metaMatch = fvMatch[1].match(/metadata['"]\s*:\s*['"]([\s\S]*?)['"]/i);
        if (metaMatch) {
          try {
            const meta = JSON.parse(metaMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
            if (meta.videos) {
              meta.videos.forEach(v => {
                sources.push({ url: v.url, quality: v.name, type: 'video/mp4', player: 'OK.ru' });
              });
            }
          } catch {}
        }
      }

      // Method 3: Direct video URL patterns
      const okPatterns = [
        /["'](https?:\/\/(?:vd\d*|v\d*)\.mycdn\.me[^"']+)["']/gi,
        /["'](https?:\/\/(?:.*?)\.mycdn\.me\/video[^"']+)["']/gi,
      ];
      for (const pat of okPatterns) {
        let m;
        while ((m = pat.exec(html)) !== null) {
          sources.push({ url: m[1], quality: 'Direct', type: 'video/mp4', player: 'OK.ru' });
        }
      }

      return sources;
    }
  },

  // ── Sibnet ──
  sibnet: {
    match: (url) => /sibnet\.(ru|com)/i.test(url),
    async extract(url, html, referer) {
      const sources = [];
      console.log('    [Sibnet] Extracting...');

      const patterns = [
        /player\.src\s*\(\s*\[\s*\{\s*src\s*:\s*["']([^"']+)["']/i,
        /src\s*:\s*["'](\/v\/[^"']+)["']/i,
        /["'](https?:\/\/video\d*\.sibnet\.ru\/[^"']+\.mp4[^"']*)["']/gi,
        /file\s*:\s*["']([^"']+\.mp4[^"']*)["']/gi,
      ];

      for (const pat of patterns) {
        let m;
        while ((m = pat.exec(html)) !== null) {
          let vurl = m[1];
          if (vurl.startsWith('/')) {
            vurl = `https://video.sibnet.ru${vurl}`;
          }
          sources.push({ url: vurl, quality: 'Default', type: 'video/mp4', player: 'Sibnet' });
        }
      }

      return sources;
    }
  },

  // ── StreamWish / FileLions / AZCDNs ──
  streamwish: {
    match: (url) => /streamwish|filelions|azcdn|asnow|dwish|kswplayer|playerwish|sfastwish|obeywish/i.test(url),
    async extract(url, html, referer) {
      console.log('    [StreamWish] Extracting...');
      // Relies heavily on packed JS — handled by generic + unpack
      return [];
    }
  },

  // ── Mp4Upload ──
  mp4upload: {
    match: (url) => /mp4upload/i.test(url),
    async extract(url, html, referer) {
      const sources = [];
      console.log('    [Mp4Upload] Extracting...');

      // Pattern: player.src("URL")
      const m = html.match(/player\.src\s*\(\s*["']([^"']+)["']\s*\)/i)
        || html.match(/src\s*:\s*["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i);
      if (m) {
        sources.push({ url: m[1], quality: 'Default', type: 'video/mp4', player: 'Mp4Upload' });
      }

      return sources;
    }
  },

  // ── Uqload ──
  uqload: {
    match: (url) => /uqload/i.test(url),
    async extract(url, html, referer) {
      const sources = [];
      console.log('    [Uqload] Extracting...');

      const patterns = [
        /sources\s*:\s*\["([^"]+)"\]/i,
        /src\s*:\s*["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i,
        /video_link\s*=\s*["']([^"']+)["']/i,
      ];

      for (const pat of patterns) {
        const m = html.match(pat);
        if (m) sources.push({ url: m[1], quality: 'Default', type: 'video/mp4', player: 'Uqload' });
      }

      return sources;
    }
  },

  // ── VidBom / VidBam ──
  vidbom: {
    match: (url) => /vidbom|vidbam|vadbam|vidbm/i.test(url),
    async extract(url, html, referer) {
      console.log('    [VidBom] Extracting via packed JS...');
      return []; // Generic handler + unpack will get these
    }
  },

  // ── DoodStream ──
  dood: {
    match: (url) => /dood|d0o0d|doo0d|ds2play|doods/i.test(url),
    async extract(url, html, referer) {
      const sources = [];
      console.log('    [DoodStream] Extracting...');

      // DoodStream uses a pass_md5 token + random string
      const passMatch = html.match(/\/pass_md5\/([^'"]+)/i);
      if (passMatch) {
        try {
          const passURL = new URL(passMatch[0], url).href;
          console.log(`    [Dood] Fetching token: ${passURL}`);
          const tokenResp = await fetchURL(passURL, { referer: url });
          const token = tokenResp.text.trim();

          if (token && token.startsWith('http')) {
            // Append random string + expiry
            const rand = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
            let randStr = '';
            for (let i = 0; i < 10; i++) randStr += rand[Math.floor(Math.random() * rand.length)];
            const finalURL = `${token}${randStr}?token=${passMatch[1]}&expiry=${Date.now()}`;
            sources.push({ url: finalURL, quality: 'Default', type: 'video/mp4', player: 'DoodStream' });
          }
        } catch (e) {
          console.log(`    [Dood] Token fetch failed: ${e.message}`);
        }
      }

      return sources;
    }
  },

  // ── StreamTape ──
  streamtape: {
    match: (url) => /streamtape|strtape|stape/i.test(url),
    async extract(url, html, referer) {
      const sources = [];
      console.log('    [StreamTape] Extracting...');

      // StreamTape constructs URL from two parts
      const innerMatch = html.match(/id="(?:robotlink|nomark)"[^>]*>([^<]*)<\/div>/i);
      const tokenMatch = html.match(/innerHTML\s*=\s*['"][^'"]*['"]\s*\+\s*\('([^']+)'\)\.substring/i)
        || html.match(/innerHTML\s*=\s*"[^"]*"\s*\+\s*\('([^']+)'\)/i);

      if (innerMatch && tokenMatch) {
        const part1 = innerMatch[1].trim();
        const part2 = tokenMatch[1];
        // The substring offset varies — try common ones
        for (const offset of [3, 4, 5, 2]) {
          const token = part2.substring(offset);
          const finalURL = `https:${part1}${token}`;
          if (finalURL.includes('/get_video')) {
            sources.push({ url: finalURL, quality: 'Default', type: 'video/mp4', player: 'StreamTape' });
            break;
          }
        }
      }

      // Alternative pattern
      const altMatch = html.match(/document\.getElementById\('(?:robotlink|nomark)'\)\.innerHTML\s*=\s*["']([^"']+)["']\s*\+\s*\('([^']+)'\)\.substring\((\d+)\)/i);
      if (altMatch) {
        const finalURL = `https:${altMatch[1]}${altMatch[2].substring(parseInt(altMatch[3]))}`;
        sources.push({ url: finalURL, quality: 'Default', type: 'video/mp4', player: 'StreamTape' });
      }

      return sources;
    }
  },

  // ── GoVideo / Govid ──
  govideo: {
    match: (url) => /govideo|govid/i.test(url),
    async extract(url, html, referer) {
      console.log('    [GoVideo] Extracting...');
      return [];
    }
  },

  // ── MixDrop ──
  mixdrop: {
    match: (url) => /mixdrop/i.test(url),
    async extract(url, html, referer) {
      const sources = [];
      console.log('    [MixDrop] Extracting...');

      // MixDrop uses packed JS — after unpacking look for MDCore.wurl
      const unpacked = findAndUnpackAll(html);
      for (const code of unpacked) {
        const m = code.match(/MDCore\.wurl\s*=\s*"([^"]+)"/i)
          || code.match(/MDCore\.vsrc\s*=\s*"([^"]+)"/i);
        if (m) {
          let vurl = m[1];
          if (vurl.startsWith('//')) vurl = 'https:' + vurl;
          sources.push({ url: vurl, quality: 'Default', type: 'video/mp4', player: 'MixDrop' });
        }
      }

      return sources;
    }
  },

  // ── FileMoon ──
  filemoon: {
    match: (url) => /filemoon|moonplayer/i.test(url),
    async extract(url, html, referer) {
      console.log('    [FileMoon] Extracting...');
      return [];
    }
  },

  // ── Upstream ──
  upstream: {
    match: (url) => /upstream/i.test(url),
    async extract(url, html, referer) {
      console.log('    [Upstream] Extracting...');
      return [];
    }
  },

  // ── SendVid ──
  sendvid: {
    match: (url) => /sendvid/i.test(url),
    async extract(url, html, referer) {
      const sources = [];
      console.log('    [SendVid] Extracting...');

      const m = html.match(/source\s+src="([^"]+)"\s+type="video/i)
        || html.match(/var\s+video_source\s*=\s*["']([^"']+)["']/i);
      if (m) {
        sources.push({ url: m[1], quality: 'Default', type: 'video/mp4', player: 'SendVid' });
      }

      return sources;
    }
  },

  // ── Myvi ──
  myvi: {
    match: (url) => /myvi\.(ru|tv|top)/i.test(url),
    async extract(url, html, referer) {
      const sources = [];
      console.log('    [Myvi] Extracting...');

      // Myvi uses a playerSettings JSON
      const settingsMatch = html.match(/playerSettings\s*=\s*(\{[\s\S]*?\});/i)
        || html.match(/CreatePlayer\s*\(\s*(\{[\s\S]*?\})\s*\)/i);

      if (settingsMatch) {
        try {
          const settings = JSON.parse(settingsMatch[1]);
          if (settings.source) {
            sources.push({ url: settings.source, quality: 'Default', type: 'video/mp4', player: 'Myvi' });
          }
          if (settings.hlsSource) {
            sources.push({ url: settings.hlsSource, quality: 'HLS', type: 'application/x-mpegURL', player: 'Myvi' });
          }
        } catch {}
      }

      // Direct patterns
      const hlsMatch = html.match(/["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i);
      if (hlsMatch) {
        sources.push({ url: hlsMatch[1], quality: 'HLS', type: 'application/x-mpegURL', player: 'Myvi' });
      }

      return sources;
    }
  },

  // ── MegaMax / Mega ──
  megamax: {
    match: (url) => /megamax|mega\./i.test(url),
    async extract(url, html, referer) {
      const sources = [];
      console.log('    [MegaMax] Extracting...');

      // Usually uses packed JS or standard sources array
      const unpacked = findAndUnpackAll(html);
      const allCode = [html, ...unpacked].join('\n');

      // Look for file/source patterns
      const patterns = [
        /file\s*:\s*["']([^"']+\.(?:mp4|m3u8)[^"']*)["']/gi,
        /src\s*:\s*["']([^"']+\.(?:mp4|m3u8)[^"']*)["']/gi,
        /source\s*:\s*["']([^"']+\.(?:mp4|m3u8)[^"']*)["']/gi,
        /["'](https?:\/\/[^"'\s]+?\.mp4[^"'\s]*?)["']/gi,
        /["'](https?:\/\/[^"'\s]+?\.m3u8[^"'\s]*?)["']/gi,
      ];

      for (const pat of patterns) {
        let m;
        while ((m = pat.exec(allCode)) !== null) {
          const vurl = m[1].replace(/\\/g, '');
          if (!sources.find(s => s.url === vurl)) {
            sources.push({
              url: vurl,
              quality: detectQuality(vurl),
              type: /m3u8/i.test(vurl) ? 'application/x-mpegURL' : 'video/mp4',
              player: 'MegaMax'
            });
          }
        }
      }

      return sources;
    }
  },

  // ── Dailymotion ──
  dailymotion: {
    match: (url) => /dailymotion|dai\.ly/i.test(url),
    async extract(url, html, referer) {
      const sources = [];
      console.log('    [Dailymotion] Extracting...');

      // Get video metadata JSON
      const configMatch = html.match(/"qualities"\s*:\s*(\{[\s\S]*?\})\s*,\s*"/i);
      if (configMatch) {
        try {
          const qualities = JSON.parse(configMatch[1]);
          for (const [q, vlist] of Object.entries(qualities)) {
            if (Array.isArray(vlist)) {
              vlist.forEach(v => {
                if (v.url) {
                  sources.push({
                    url: v.url,
                    quality: q + 'p',
                    type: v.type || 'video/mp4',
                    player: 'Dailymotion'
                  });
                }
              });
            }
          }
        } catch {}
      }

      return sources;
    }
  },

  // ── Vidmoly ──
  vidmoly: {
    match: (url) => /vidmoly/i.test(url),
    async extract(url, html, referer) {
      const sources = [];
      console.log('    [Vidmoly] Extracting...');

      const m = html.match(/sources\s*:\s*\[\s*\{[^}]*file\s*:\s*["']([^"']+)["']/i);
      if (m) {
        sources.push({
          url: m[1],
          quality: 'HLS',
          type: 'application/x-mpegURL',
          player: 'Vidmoly'
        });
      }

      return sources;
    }
  },

  // ── YourUpload ──
  yourupload: {
    match: (url) => /yourupload/i.test(url),
    async extract(url, html, referer) {
      const sources = [];
      console.log('    [YourUpload] Extracting...');

      const m = html.match(/file\s*:\s*'([^']+)'/i) || html.match(/src\s*:\s*'([^']+\.mp4[^']*)'/i);
      if (m) {
        sources.push({ url: m[1], quality: 'Default', type: 'video/mp4', player: 'YourUpload' });
      }

      return sources;
    }
  },

  // ── VidHide / VidhidePlayer ──
  vidhide: {
    match: (url) => /vidhide|vid\.hide/i.test(url),
    async extract(url, html, referer) {
      console.log('    [VidHide] Extracting...');
      return [];
    }
  },

  // ── Generic JWPlayer ──
  jwplayer: {
    match: (url) => false, // Only triggered as fallback
    async extract(url, html, referer) {
      const sources = [];
      const m = html.match(/jwplayer\s*\(\s*["'][^"']+["']\s*\)\s*\.\s*setup\s*\(\s*(\{[\s\S]*?\})\s*\)/i);
      if (m) {
        try {
          // Extract file from setup config
          const fileMatch = m[1].match(/file\s*:\s*["']([^"']+)["']/i);
          if (fileMatch) {
            sources.push({ url: fileMatch[1], quality: 'Default', type: 'video/mp4', player: 'JWPlayer' });
          }
        } catch {}
      }
      return sources;
    }
  },
};

// ══════════════════════════════════════
// GENERIC EXTRACTION ENGINE
// ══════════════════════════════════════
function genericExtract(html, allCode) {
  const sources = [];
  const seen = new Set();

  function add(url, label, type, player = 'Generic') {
    if (!url || seen.has(url)) return;
    url = url.trim().replace(/\\/g, '');
    if (url.length < 10) return;
    if (!/^https?:\/\//i.test(url)) return;
    if (/\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|ttf|php|html?)(\?|$)/i.test(url)
        && !/\.mp4|\.m3u8|\.webm|\.ts|\.mkv|\.flv/i.test(url)) return;

    seen.add(url);
    sources.push({
      url,
      quality: label || detectQuality(url),
      type: type || detectType(url),
      player,
    });
  }

  // <source> tags
  let m;
  const sourceRE = /<source[^>]+src=["']([^"']+)["'][^>]*>/gi;
  while ((m = sourceRE.exec(allCode)) !== null) {
    const label = (m[0].match(/label=["']([^"']+)/i) || [])[1] || '';
    const type = (m[0].match(/type=["']([^"']+)/i) || [])[1] || '';
    add(m[1], label, type);
  }

  // <video src>
  const videoSrcRE = /<video[^>]+src=["']([^"']+)/gi;
  while ((m = videoSrcRE.exec(allCode)) !== null) add(m[1], '', '');

  // sources arrays
  const srcArrayRE = /sources\s*[:=]\s*\[([\s\S]*?)\]/gi;
  while ((m = srcArrayRE.exec(allCode)) !== null) {
    const objRE = /\{[^}]*?(?:file|src|source|url)\s*[:=]\s*["']([^"']+)["'][^}]*?\}/gi;
    let obj;
    while ((obj = objRE.exec(m[1])) !== null) {
      const label = (obj[0].match(/(?:label|quality|res)\s*[:=]\s*["']([^"']+)/i) || [])[1] || '';
      const type = (obj[0].match(/type\s*[:=]\s*["']([^"']+)/i) || [])[1] || '';
      add(obj[1], label, type);
    }
  }

  // Direct assignments
  const assignPats = [
    /(?:file|source|src|video_?url|videoUrl|stream_?url|mp4_?url)\s*[:=]\s*["']([^"']+?\.(?:mp4|m3u8|webm|mkv|flv)[^"']*?)["']/gi,
    /(?:file|source|src|video_?url|videoUrl|stream_?url)\s*[:=]\s*["'](https?:\/\/[^"']+?)["']/gi,
    /player\.src\s*\(\s*["']([^"']+)["']/gi,
    /player\.src\s*\(\s*\{[^}]*?src\s*:\s*["']([^"']+)["']/gi,
    /\.setup\s*\(\s*\{[\s\S]*?file\s*:\s*["']([^"']+)["']/gi,
    /data-src=["']([^"']+\.(?:mp4|m3u8)[^"']*?)["']/gi,
  ];

  for (const pat of assignPats) {
    while ((m = pat.exec(allCode)) !== null) add(m[1], '', '');
  }

  // Standalone video URLs
  const urlPats = [
    /["'](https?:\/\/[^"'\s]+?\.m3u8[^"'\s]*?)["']/gi,
    /["'](https?:\/\/[^"'\s]+?\.mp4[^"'\s]*?)["']/gi,
    /["'](https?:\/\/[^"'\s]+?\.webm[^"'\s]*?)["']/gi,
  ];
  for (const pat of urlPats) {
    while ((m = pat.exec(allCode)) !== null) add(m[1], '', '');
  }

  // Base64 encoded
  const b64RE = /atob\s*\(\s*["']([A-Za-z0-9+/=]{20,})["']\s*\)/gi;
  while ((m = b64RE.exec(allCode)) !== null) {
    try {
      const d = Buffer.from(m[1], 'base64').toString('utf-8');
      if (/^https?:\/\//.test(d)) add(d, 'base64', '');
    } catch {}
  }

  return sources;
}

function detectQuality(url) {
  const m = url.match(/(\d{3,4})p/i);
  if (m) return m[1] + 'p';
  if (/master\.m3u8/i.test(url)) return 'Master';
  if (/\.m3u8/i.test(url)) return 'HLS';
  if (/high|hd|1080/i.test(url)) return 'HD';
  if (/med|sd|480/i.test(url)) return 'SD';
  if (/low|360/i.test(url)) return 'Low';
  return 'Default';
}

function detectType(url) {
  if (/\.m3u8/i.test(url)) return 'application/x-mpegURL';
  if (/\.mp4/i.test(url)) return 'video/mp4';
  if (/\.webm/i.test(url)) return 'video/webm';
  if (/\.mkv/i.test(url)) return 'video/x-matroska';
  if (/\.ts/i.test(url)) return 'video/mp2t';
  if (/\.flv/i.test(url)) return 'video/x-flv';
  return 'video/mp4';
}

// ══════════════════════════════════════
// M3U8 PARSER
// ══════════════════════════════════════
function parseM3U8(content, baseURL) {
  const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
  const variants = [];

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
      const bw = (lines[i].match(/BANDWIDTH=(\d+)/i) || [])[1];
      const res = (lines[i].match(/RESOLUTION=(\d+x\d+)/i) || [])[1];
      const name = (lines[i].match(/NAME="([^"]+)"/i) || [])[1];

      let urlLine = '';
      for (let j = i + 1; j < lines.length; j++) {
        if (!lines[j].startsWith('#')) { urlLine = lines[j]; break; }
      }

      if (urlLine) {
        let fullURL = urlLine;
        if (!/^https?:\/\//i.test(urlLine)) {
          try { fullURL = new URL(urlLine, baseURL).href; } catch {}
        }
        variants.push({
          url: fullURL,
          bandwidth: bw ? parseInt(bw) : 0,
          resolution: res || '',
          quality: res ? res.split('x')[1] + 'p' : (name || (bw ? Math.round(bw / 1000) + 'kbps' : 'Unknown')),
          type: 'application/x-mpegURL',
        });
      }
    }
  }

  return variants;
}

// ══════════════════════════════════════
// MAIN EXTRACTION PIPELINE
// ══════════════════════════════════════
async function extractPipeline(url, referer) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  EXTRACTING: ${url}`);
  console.log(`${'═'.repeat(60)}`);

  // Step 1: Fetch page
  console.log('  [1] Fetching page...');
  const page = await fetchURL(url, { referer });
  console.log(`  [1] Got ${page.text.length} bytes (status ${page.status})`);

  // Detect player
  let detectedPlayer = 'Unknown';
  for (const [name, handler] of Object.entries(PLAYER_HANDLERS)) {
    if (handler.match(url) || handler.match(page.finalURL)) {
      detectedPlayer = name;
      break;
    }
  }
  console.log(`  [2] Detected player: ${detectedPlayer}`);

  // Step 2: Unpack JS
  console.log('  [3] Unpacking obfuscated JS...');
  const unpacked = findAndUnpackAll(page.text);
  const allCode = [page.text, ...unpacked].join('\n===SEP===\n');

  // Step 3: Player-specific extraction
  let sources = [];

  if (detectedPlayer !== 'Unknown') {
    console.log(`  [4] Running ${detectedPlayer} handler...`);
    const handler = PLAYER_HANDLERS[detectedPlayer];
    const playerSources = await handler.extract(url, allCode, referer);
    sources.push(...playerSources);
    console.log(`  [4] Player handler found ${playerSources.length} source(s)`);
  }

  // Step 4: Generic extraction (always run)
  console.log('  [5] Running generic extraction...');
  const genericSources = genericExtract(page.text, allCode);
  console.log(`  [5] Generic found ${genericSources.length} source(s)`);

  // Merge (avoid duplicates)
  const seenURLs = new Set(sources.map(s => s.url));
  for (const src of genericSources) {
    if (!seenURLs.has(src.url)) {
      seenURLs.add(src.url);
      sources.push(src);
    }
  }

  // Step 5: Follow iframes (recursive)
  console.log('  [6] Checking for inner iframes...');
  const iframes = [];
  const iframeRE = /<iframe[^>]+src=["']([^"']+)["']/gi;
  while ((m = iframeRE.exec(page.text)) !== null) {
    let iframeURL = m[1];
    if (iframeURL.startsWith('//')) iframeURL = 'https:' + iframeURL;
    else if (!iframeURL.startsWith('http')) {
      try { iframeURL = new URL(iframeURL, url).href; } catch { continue; }
    }
    if (!/ads|banner|social|facebook|twitter|google|analytics/i.test(iframeURL)) {
      iframes.push(iframeURL);
    }
  }

  if (iframes.length > 0) {
    console.log(`  [6] Found ${iframes.length} iframe(s), extracting...`);
    for (const iframeURL of iframes.slice(0, 5)) {
      try {
        console.log(`    ↪ Iframe: ${iframeURL}`);
        const iframePage = await fetchURL(iframeURL, { referer: url });
        const iframeUnpacked = findAndUnpackAll(iframePage.text);
        const iframeAllCode = [iframePage.text, ...iframeUnpacked].join('\n');

        // Run player-specific for iframe
        for (const [name, handler] of Object.entries(PLAYER_HANDLERS)) {
          if (handler.match(iframeURL)) {
            const ps = await handler.extract(iframeURL, iframeAllCode, url);
            ps.forEach(s => {
              if (!seenURLs.has(s.url)) { seenURLs.add(s.url); sources.push(s); }
            });
            break;
          }
        }

        // Generic for iframe
        const gs = genericExtract(iframePage.text, iframeAllCode);
        gs.forEach(s => {
          if (!seenURLs.has(s.url)) { seenURLs.add(s.url); sources.push(s); }
        });
      } catch (e) {
        console.log(`    ✗ Iframe failed: ${e.message}`);
      }
    }
  }

  // Step 6: Parse m3u8 master playlists
  console.log('  [7] Parsing m3u8 playlists...');
  const expanded = [];
  for (const src of sources) {
    if (/\.m3u8/i.test(src.url) && !src.needsToken) {
      try {
        const m3u8 = await fetchURL(src.url, { referer: url });
        const variants = parseM3U8(m3u8.text, src.url);
        if (variants.length > 0) {
          console.log(`    → ${variants.length} variants from m3u8`);
          variants.forEach(v => {
            v.player = src.player || 'HLS';
            if (!seenURLs.has(v.url)) { seenURLs.add(v.url); expanded.push(v); }
          });
          src.isMaster = true;
          src.quality = 'Master Playlist';
        }
      } catch {}
    }
    expanded.push(src);
  }

  // Sort by quality
  expanded.sort((a, b) => {
    const qa = parseInt(a.quality) || 0;
    const qb = parseInt(b.quality) || 0;
    return qb - qa;
  });

  console.log(`  ✅ Total: ${expanded.length} source(s)\n`);

  return {
    pageInfo: {
      title: (page.text.match(/<title[^>]*>([^<]+)/i) || [])[1]?.trim() || '',
      finalURL: page.finalURL,
      pageSize: page.text.length,
      status: page.status,
      detectedPlayer,
      packedScripts: unpacked.length,
      iframesFound: iframes.length,
    },
    sources: expanded,
  };
}

// ══════════════════════════════════════
// HTTP SERVER
// ══════════════════════════════════════
const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://localhost:${PORT}`);

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── Serve index.html ──
  if (parsed.pathname === '/' || parsed.pathname === '/index.html') {
    fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
      if (err) { res.writeHead(500); res.end('index.html not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  // ── POST /extract (Web UI) ──
  // ── POST /api/extract (Android API) ──
  if ((parsed.pathname === '/extract' || parsed.pathname === '/api/extract') && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { url, referer } = JSON.parse(body);
        if (!url) throw new Error('Missing url parameter');

        const result = await extractPipeline(url, referer || '');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...result }));
      } catch (err) {
        console.error(`  ✗ ${err.message}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // ── GET /api/extract?url=...&referer=... (Simple GET API) ──
  if (parsed.pathname === '/api/extract' && req.method === 'GET') {
    const url = parsed.searchParams.get('url');
    const referer = parsed.searchParams.get('referer') || '';
    if (!url) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Missing url parameter' }));
      return;
    }
    try {
      const result = await extractPipeline(url, referer);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...result }));
    } catch (err) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  // ── GET /api/players — List supported players ──
  if (parsed.pathname === '/api/players') {
    const players = Object.entries(PLAYER_HANDLERS).map(([name, h]) => ({
      name,
      patterns: h.match.toString(),
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ players }));
    return;
  }

  // ── GET /proxy?url=&referer= — Stream proxy ──
  if (parsed.pathname === '/proxy') {
    const targetURL = parsed.searchParams.get('url');
    const referer = parsed.searchParams.get('referer') || '';

    if (!targetURL) { res.writeHead(400); res.end('Missing url'); return; }

    try {
      const target = new URL(targetURL);
      const client = target.protocol === 'https:' ? https : http;

      client.get(targetURL, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': referer || target.origin + '/',
          'Origin': referer ? new URL(referer).origin : target.origin,
          'Accept': '*/*',
        },
        rejectUnauthorized: false,
      }, (proxyRes) => {
        if ([301,302,303,307,308].includes(proxyRes.statusCode) && proxyRes.headers.location) {
          const newURL = new URL(proxyRes.headers.location, targetURL).href;
          res.writeHead(302, {
            'Location': `/proxy?url=${encodeURIComponent(newURL)}&referer=${encodeURIComponent(referer)}`
          });
          res.end();
          return;
        }

        // Rewrite m3u8 segment URLs
        if (/\.m3u8/i.test(targetURL) || (proxyRes.headers['content-type'] || '').includes('mpegurl')) {
          let body = '';
          proxyRes.on('data', c => body += c);
          proxyRes.on('end', () => {
            const rewritten = body.replace(
              /^(?!#)(\S+)$/gm,
              (match) => {
                const trimmed = match.trim();
                if (!trimmed || trimmed.startsWith('#')) return match;
                const segURL = /^https?:\/\//i.test(trimmed)
                  ? trimmed
                  : new URL(trimmed, targetURL).href;
                return `/proxy?url=${encodeURIComponent(segURL)}&referer=${encodeURIComponent(targetURL)}`;
              }
            );
            res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
            res.end(rewritten);
          });
          return;
        }

        const headers = {
          'Content-Type': proxyRes.headers['content-type'] || 'application/octet-stream',
        };
        if (proxyRes.headers['content-length']) headers['Content-Length'] = proxyRes.headers['content-length'];
        if (proxyRes.headers['content-range']) headers['Content-Range'] = proxyRes.headers['content-range'];
        if (proxyRes.headers['accept-ranges']) headers['Accept-Ranges'] = proxyRes.headers['accept-ranges'];

        res.writeHead(proxyRes.statusCode || 200, headers);
        proxyRes.pipe(res);

      }).on('error', e => {
        res.writeHead(502); res.end(e.message);
      });
    } catch (e) {
      res.writeHead(400); res.end(e.message);
    }
    return;
  }

  // ── Raw fetch ──
  if (parsed.pathname === '/fetch') {
    const targetURL = parsed.searchParams.get('url');
    if (!targetURL) { res.writeHead(400); res.end('Missing url'); return; }
    try {
      const result = await fetchURL(targetURL);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(result.text);
    } catch (e) {
      res.writeHead(502); res.end(e.message);
    }
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => {
  console.log('');
  console.log('══════════════════════════════════════════════════');
  console.log(`  🎬  Nexo Extractor — port ${PORT}`);
  console.log(`  📡  http://localhost:${PORT}`);
  console.log(`  🔌  API: POST /api/extract`);
  console.log(`  🔌  API: GET  /api/extract?url=...`);
  console.log(`  📋  Players: GET /api/players`);
  console.log('══════════════════════════════════════════════════');
  console.log('');
  console.log('  Supported players:');
  Object.keys(PLAYER_HANDLERS).forEach(p => console.log(`    ✓ ${p}`));
  console.log('');
});