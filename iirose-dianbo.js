// ============================================================
//  iirose 点歌（网易云）v0.5.0 —— 网页发布版
// ============================================================
//  单文件、纯前端、零账号、无混淆，可直接阅读审计。
//
//  使用（把本文件发布到任意公网地址，朋友在 iirose 网页注入该地址即可）：
//    1. 打开 https://iirose.com ，登录并进入房间
//    2. 按 Ctrl+S 打开内置终端
//    3. 输入 js -s 回车（打开「自定义 JS」开关，输出 Custom JS : 1 即成功）
//    4. 输入 js 回车，弹窗粘贴本脚本的【地址】，确定
//    5. 刷新页面，右下角出现可拖动的 🎵 悬浮球，点击即可搜歌点播
//
//  支持两种点歌方式（同一个输入框，自动识别）：
//    - 歌名/歌手搜索：输入「青花瓷」等关键词 → 列出结果 → 点「点播」
//    - 网易云链接点播：粘贴 https://music.163.com/song?id=xxx 或纯歌曲 id → 点「点播」
//
//  说明：
//    - 点播使用「使用者自己登录的 iirose 账号」，本脚本不含任何他人账号/密码
//    - 音乐数据多源 fallback：直链/歌词/搜索走 GD-Studio + NeteaseCloudMusicApi 公共实例，
//      详情走 NeteaseCloudMusicApi 多实例；任一源失效自动切换下一个
//    - 站点每次刷新会重新加载本地址，改版后朋友刷新即更新
//
//  原理：站点把地址存 localStorage extJs，每次页面加载以 <script src> 注入到
//  聊天 iframe 上下文，脚本可直接访问 window.socket / window.Objs。
// ============================================================
(function () {
  'use strict';

  function init() {
    if (window.__IIROSE_DIANBO__) return;
    window.__IIROSE_DIANBO__ = true;

    /* ============ 点播消息拼装（协议见 iirose-docs api_media.md） ============ */
    const NETEASE_TYPE = '@0';

    function encodeHTML(str) {
      const map = { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' };
      return String(str).replace(/[<>&"']/g, (c) => map[c] || c);
    }
    function stripScheme(url) {
      if (typeof url !== 'string') return '';
      if (url.startsWith('http://') || url.startsWith('https://')) return url.substring(4);
      return url;
    }
    function normalizeColor(color) {
      const c = String(color || '').replace('#', '');
      return /^[0-9a-fA-F]{6}$/.test(c) ? c : 'ec4141';
    }
    function buildMediaCard(name, singer, cover, color, bitrate) {
      const c = normalizeColor(color);
      const m = `m__4${NETEASE_TYPE}>${encodeHTML(name)}>${encodeHTML(singer)}>${cover}>${c}>${bitrate}`;
      return JSON.stringify({ m: m, mc: c, i: String(Date.now()) });
    }
    function buildMediaEvent(url, duration, cover, name, singer, link, lyrics) {
      const data = {
        s: stripScheme(url),
        d: duration,
        c: stripScheme(cover),
        n: name,
        r: singer,
        b: NETEASE_TYPE,
        o: stripScheme(link),
        l: lyrics || '',
      };
      return '&1' + JSON.stringify(data);
    }

    /* ============ 多源数据层（每个操作多源 fallback） ============ */
    // 源清单：
    //  - GD-Studio：直链（能解 VIP）、歌词、封面、搜索（types=search/url/lyric/pic）
    //  - NeteaseCloudMusicApi 公共实例：详情 /song/detail、歌词 /lyric、搜索 /search、
    //    非 VIP 直链 /song/url（VIP 歌 url=null，解不了）。必须 https（https 页面 fetch http 会被混合内容阻止）。
    const GD_API = 'https://music-api.gdstudio.xyz/api.php';
    const NCM_APIS = [
      'https://api.jimsdeng.eu.org',
      'https://netease-cloud-music-api-delta.vercel.app',
    ];

    // 依次尝试多个 URL，返回第一个 res.ok 的响应
    async function fetchAny(urls) {
      let lastErr = null;
      for (const u of urls) {
        try {
          const res = await fetch(u, { signal: AbortSignal.timeout(10000) });
          if (res.ok) return res;
          lastErr = new Error('HTTP ' + res.status);
        } catch (e) { lastErr = e; }
      }
      throw lastErr || new Error('接口不可用');
    }

    // GD-Studio 通用请求
    async function gdGet(params) {
      const qs = new URLSearchParams({ source: 'netease', ...params }).toString();
      const res = await fetch(`${GD_API}?${qs}`, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error('GD-Studio HTTP ' + res.status);
      return res.json();
    }

    // 搜索：GD-Studio 优先，NeteaseCloudMusicApi /search 兜底
    async function searchSongs(keyword, count) {
      count = count || 8;
      try {
        const list = await gdGet({ types: 'search', name: keyword, count: String(count) });
        if (Array.isArray(list) && list.length) {
          return list.map((s) => ({
            id: String(s.id),
            name: s.name,
            singer: Array.isArray(s.artist) ? s.artist.join('/') : (s.artist || ''),
            album: s.album || '',
          }));
        }
      } catch (e) { /* 落到 NCM */ }
      const res = await fetchAny(NCM_APIS.map((b) => `${b}/search?keywords=${encodeURIComponent(keyword)}&limit=${count}`));
      const d = await res.json();
      const songs = d.result && d.result.songs;
      if (!Array.isArray(songs)) throw new Error('搜索返回格式异常');
      return songs.map((s) => ({
        id: String(s.id),
        name: s.name,
        singer: (s.ar || []).map((a) => a.name).join('/'),
        album: (s.al && s.al.name) || '',
        cover: (s.al && s.al.picUrl) || '',
      }));
    }

    /* ============ 网易云链接解析 + 歌曲详情 ============ */
    // 从文本提取歌曲 id：纯数字 或 链接里的 id=xxx
    function extractSongId(text) {
      const t = String(text).trim();
      if (/^\d{5,12}$/.test(t)) return t;
      const m = t.match(/[?&]id=(\d+)/);
      return m ? m[1] : null;
    }

    // 按 id 拿歌曲详情：name / singer / cover / duration
    async function getSongDetail(id) {
      const res = await fetchAny(NCM_APIS.map((b) => `${b}/song/detail?ids=${id}`));
      const data = await res.json();
      const s = data.songs && data.songs[0];
      if (!s) throw new Error('无法获取歌曲信息（接口失效或链接有误）');
      return {
        id: String(s.id),
        name: s.name,
        singer: (s.ar || []).map((a) => a.name).join('/'),
        cover: (s.al && s.al.picUrl) || '',
        duration: (s.dt || 0) / 1000, // 毫秒 → 秒
      };
    }

    // 直链：GD-Studio 优先（解 VIP），NeteaseCloudMusicApi /song/url 兜底（仅免费歌）
    async function getMp3Url(id) {
      try {
        const r = await gdGet({ types: 'url', id, br: '320' });
        if (r && r.url) return { url: r.url, size: r.size, br: r.br };
      } catch (e) { /* 落到 NCM */ }
      const res = await fetchAny(NCM_APIS.map((b) => `${b}/song/url?id=${id}&br=320`));
      const d = await res.json();
      const it = d.data && d.data[0];
      if (it && it.url) return { url: it.url, size: it.size, br: it.br };
      throw new Error('无法获取播放链接（可能无版权或接口限制）');
    }

    // 歌词：GD-Studio 优先，NeteaseCloudMusicApi /lyric 兜底
    async function getLyrics(id) {
      try {
        const r = await gdGet({ types: 'lyric', id });
        if (r && r.lyric) return r.lyric;
      } catch (e) { /* 落到 NCM */ }
      try {
        const res = await fetchAny(NCM_APIS.map((b) => `${b}/lyric?id=${id}`));
        const d = await res.json();
        if (d.lrc && d.lrc.lyric) return d.lrc.lyric;
      } catch (e) { /* 忽略，歌词可为空 */ }
      return '';
    }

    // 颜色美化：深色提亮、浅色压暗、偏灰保底饱和，保证卡片色可读且不刺眼
    function beautifyColor(hex) {
      const r0 = parseInt(hex.slice(0, 2), 16), g0 = parseInt(hex.slice(2, 4), 16), b0 = parseInt(hex.slice(4, 6), 16);
      const r = r0 / 255, g = g0 / 255, b = b0 / 255;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      let h = 0, s = 0, l = (mx + mn) / 2;
      if (mx !== mn) {
        const d = mx - mn;
        s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
        if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
        else if (mx === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h /= 6;
      }
      if (l < 0.32) l = 0.32;              // 深色提亮，避免纯黑
      if (l > 0.62) l = 0.62;              // 浅色压暗，避免刺眼
      if (s > 0.06 && s < 0.20) s = 0.20;  // 偏灰保底饱和
      const hue2rgb = (p, q, t) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
      };
      let rr, gg, bb;
      if (s === 0) { rr = gg = bb = l * 255; }
      else {
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        rr = hue2rgb(p, q, h + 1 / 3) * 255;
        gg = hue2rgb(p, q, h) * 255;
        bb = hue2rgb(p, q, h - 1 / 3) * 255;
      }
      return ((1 << 24) + (Math.round(rr) << 16) + (Math.round(gg) << 8) + Math.round(bb)).toString(16).slice(1);
    }

    // 从封面图提取主色（卡片背景色适配封面）。封面域 music.126.net 已确认返回 CORS *，
    // 故 crossOrigin 读取像素不会被 canvas 污染。
    async function getDominantColor(coverUrl) {
      const fallback = 'ec4141';
      if (!coverUrl) return fallback;
      try {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = () => reject(new Error('封面加载失败'));
          img.src = coverUrl;
        });
        const size = 40;
        const canvas = document.createElement('canvas');
        canvas.width = size; canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, size, size);
        const px = ctx.getImageData(0, 0, size, size).data;

        // 收集所有不透明像素
        const pixels = [];
        let sumR = 0, sumG = 0, sumB = 0;
        for (let i = 0; i < px.length; i += 4) {
          const r = px[i], g = px[i + 1], b = px[i + 2], a = px[i + 3];
          if (a < 128) continue;
          pixels.push([r, g, b]);
          sumR += r; sumG += g; sumB += b;
        }
        if (!pixels.length) return fallback;

        const quantize = (list, minMax, maxMin, minSat) => {
          const buckets = new Map();
          for (const [r, g, b] of list) {
            const max = Math.max(r, g, b), min = Math.min(r, g, b);
            if (max < minMax || min > maxMin) continue;
            if (max - min < minSat) continue;
            const key = (r >> 4) + ',' + (g >> 4) + ',' + (b >> 4);
            buckets.set(key, (buckets.get(key) || 0) + 1);
          }
          if (!buckets.size) return null;
          let bestKey = null, bestCount = 0;
          for (const [k, c] of buckets) {
            if (c > bestCount) { bestCount = c; bestKey = k; }
          }
          const [rr, gg, bb] = bestKey.split(',').map((v) => (Number(v) << 4) | 8);
          return ((1 << 24) + (rr << 16) + (gg << 8) + bb).toString(16).slice(1);
        };

        // 三级降级：鲜艳主色 → 任意主色(只滤极端明暗) → 平均色
        let hex = quantize(pixels, 40, 235, 25);
        if (!hex) hex = quantize(pixels, 15, 250, 0);
        if (!hex) {
          const rr = Math.round(sumR / pixels.length);
          const gg = Math.round(sumG / pixels.length);
          const bb = Math.round(sumB / pixels.length);
          hex = ((1 << 24) + (rr << 16) + (gg << 8) + bb).toString(16).slice(1);
        }
        return beautifyColor(hex);
      } catch (e) {
        return fallback;
      }
    }

    /* ============ 点播流程（搜索路径与链接路径共用） ============ */
    async function dianbo(song) {
      // 封面：搜索路径无 cover，走详情接口拿真实 al.picUrl（GD-Studio types=pic 返回 id 拼的假 URL，实测 404，弃用）
      const coverPromise = song.cover
        ? Promise.resolve(song.cover)
        : getSongDetail(song.id).then((d) => d.cover).catch(() => '');
      const [mp3Res, lyrics, cover] = await Promise.all([
        getMp3Url(song.id),
        getLyrics(song.id),
        coverPromise,
      ]);
      const mp3 = mp3Res.url;

      let duration = song.duration;
      if (!duration) duration = mp3Res.size && mp3Res.br ? (mp3Res.size * 8) / (mp3Res.br * 1000) : 0;

      const link = 'https://music.163.com/#/song?id=' + song.id;
      const color = await getDominantColor(cover);

      const sock = getSocket();
      sock.send(buildMediaCard(song.name, song.singer, cover, color, 320));
      sock.send(buildMediaEvent(mp3, duration, cover, song.name, song.singer, link, lyrics));
    }

    function getSocket() {
      if (window.socket && typeof window.socket.send === 'function') return window.socket;
      throw new Error('未连接 iirose（请先登录进入房间）');
    }

    /* ============ UI 工具 ============ */
    const Z = '2147483647';
    function el(tag, style, text) {
      const n = document.createElement(tag);
      if (style) for (const k in style) n.style[k] = style[k];
      if (text !== undefined) n.textContent = text;
      return n;
    }
    // 让元素可拖动（handle 为拖动把手）；移动 < 5px 视为点击，触发 onClick
    function makeDraggable(node, handle, onClick) {
      let sx = 0, sy = 0, ox = 0, oy = 0, moved = 0, dragging = false;
      handle.addEventListener('mousedown', (e) => {
        dragging = true; moved = 0;
        sx = e.clientX; sy = e.clientY;
        ox = node.offsetLeft; oy = node.offsetTop;
        e.preventDefault();
      });
      document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const dx = e.clientX - sx, dy = e.clientY - sy;
        moved = Math.max(moved, Math.abs(dx) + Math.abs(dy));
        node.style.left = (ox + dx) + 'px';
        node.style.top = (oy + dy) + 'px';
      });
      document.addEventListener('mouseup', () => {
        if (dragging && moved < 5 && onClick) onClick();
        dragging = false;
      });
    }

    /* ============ 悬浮球（可拖动，点击召唤面板） ============ */
    const fab = el('div', {
      position: 'fixed', left: (window.innerWidth - 60) + 'px', top: (window.innerHeight - 200) + 'px',
      width: '48px', height: '48px', borderRadius: '50%', background: '#ec4141', color: '#fff',
      fontSize: '22px', cursor: 'grab', boxShadow: '0 4px 14px rgba(0,0,0,.5)', zIndex: Z,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      userSelect: 'none', touchAction: 'none',
    }, '🎵');
    fab.title = '点歌（可拖动）';

    /* ============ 面板（可拖动标题栏） ============ */
    const panel = el('div', {
      position: 'fixed', left: (window.innerWidth - 320) + 'px', top: (window.innerHeight - 480) + 'px',
      width: '300px', maxHeight: '460px', background: '#1e1f26', borderRadius: '10px',
      boxShadow: '0 4px 24px rgba(0,0,0,.6)', zIndex: Z, display: 'none',
      flexDirection: 'column', overflow: 'hidden', fontFamily: 'PingFang SC, Microsoft YaHei, sans-serif',
    });

    const title = el('div', {
      padding: '10px 12px', color: '#fff', fontSize: '14px', fontWeight: '700', borderBottom: '1px solid #333',
      display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'grab', userSelect: 'none',
    });
    title.appendChild(el('span', null, '🎵 点歌（网易云）'));
    const closeBtn = el('span', { cursor: 'pointer', color: '#888', fontSize: '16px' }, '×');
    closeBtn.onclick = () => { panel.style.display = 'none'; };
    title.appendChild(closeBtn);
    panel.appendChild(title);

    const searchRow = el('div', { display: 'flex', gap: '6px', padding: '10px 12px' });
    const input = el('input', { flex: '1', background: '#2a2b33', border: '1px solid #444', borderRadius: '6px', color: '#eee', padding: '7px 10px', fontSize: '13px', outline: 'none' });
    input.placeholder = '歌名 / 歌手，或网易云链接';
    const searchBtn = el('button', { background: '#ec4141', color: '#fff', border: 'none', borderRadius: '6px', padding: '7px 14px', cursor: 'pointer', fontSize: '13px' }, '搜索');
    searchRow.appendChild(input); searchRow.appendChild(searchBtn);
    panel.appendChild(searchRow);

    const status = el('div', { padding: '0 12px 8px', color: '#999', fontSize: '12px', minHeight: '16px' }, '登录 iirose 后即可点播');
    panel.appendChild(status);

    const list = el('div', { overflowY: 'auto', flex: '1' });
    panel.appendChild(list);

    function setStatus(t, color) { status.textContent = t; status.style.color = color || '#999'; }

    // 渲染一个歌曲结果行（搜索与链接点播共用）
    function addSongRow(song) {
      const row = el('div', { padding: '8px 12px', borderTop: '1px solid #2a2b33', display: 'flex', alignItems: 'center', gap: '8px' });
      const info = el('div', { flex: '1', minWidth: '0' });
      info.appendChild(el('div', { color: '#eee', fontSize: '13px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }, song.name));
      const sub = song.singer + (song.album ? ' · ' + song.album : '');
      info.appendChild(el('div', { color: '#888', fontSize: '11px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }, sub));
      const btn = el('button', { background: '#3a7afe', color: '#fff', border: 'none', borderRadius: '5px', padding: '5px 12px', cursor: 'pointer', fontSize: '12px' }, '点播');
      btn.onclick = async () => {
        btn.disabled = true; btn.textContent = '点播中…';
        try {
          await dianbo(song);
          setStatus('已点播：' + song.name + ' - ' + song.singer, '#68b26d');
        } catch (e) {
          setStatus('失败：' + e.message, '#ec4141');
        }
        btn.disabled = false; btn.textContent = '点播';
      };
      row.appendChild(info); row.appendChild(btn);
      list.appendChild(row);
    }

    async function doSearch() {
      const kw = input.value.trim();
      if (!kw) { setStatus('请输入歌名或链接', '#ec4141'); return; }
      list.innerHTML = '';

      // —— 网易云链接点播：提取 id 直接拿歌曲 ——
      const songId = extractSongId(kw);
      if (songId) {
        setStatus('解析链接中…', '#999');
        try {
          const song = await getSongDetail(songId);
          setStatus('找到「' + song.name + '」，点「点播」发送到房间', '#999');
          addSongRow(song);
        } catch (e) {
          setStatus('失败：' + e.message, '#ec4141');
        }
        return;
      }

      // —— 关键词搜索 ——
      setStatus('搜索中…', '#999');
      try {
        const songs = await searchSongs(kw, 8);
        if (!songs.length) { setStatus('无结果', '#ec4141'); return; }
        setStatus('找到 ' + songs.length + ' 首，点「点播」发送到房间', '#999');
        songs.forEach(addSongRow);
      } catch (e) {
        setStatus('搜索失败：' + e.message, '#ec4141');
      }
    }
    searchBtn.onclick = doSearch;
    input.onkeydown = (e) => { if (e.key === 'Enter') doSearch(); };

    /* 挂载 + 拖动绑定 */
    document.body.appendChild(panel);
    document.body.appendChild(fab);
    makeDraggable(fab, fab, () => { panel.style.display = panel.style.display === 'none' ? 'flex' : 'none'; });
    makeDraggable(panel, title);

    console.log('%c[iirose 点歌] 已加载', 'color:#ec4141;font-weight:bold');
  }

  /* 启动时机兜底：body 可能未就绪（对照 collector.js） */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
