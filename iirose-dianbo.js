// ============================================================
//  iirose 点歌（网易云）v0.2.0 —— 网页发布版
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
//    - 音乐数据来自第三方公共 API（GD-Studio 直链/歌词 + NeteaseCloudMusicApi 详情），免费、无需登录
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

    /* ============ GD-Studio 网易云 API（直链 / 歌词 / 封面 / 搜索） ============ */
    const API_BASE = 'https://music-api.gdstudio.xyz/api.php';
    async function apiGet(params) {
      const qs = new URLSearchParams({ source: 'netease', ...params }).toString();
      const res = await fetch(`${API_BASE}?${qs}`);
      if (!res.ok) throw new Error('GD-Studio API HTTP ' + res.status);
      return res.json();
    }
    async function searchSongs(keyword, count) {
      const list = await apiGet({ types: 'search', name: keyword, count: String(count || 10) });
      if (!Array.isArray(list)) throw new Error('搜索返回格式异常');
      return list.map((s) => ({
        id: String(s.id),
        name: s.name,
        singer: Array.isArray(s.artist) ? s.artist.join('/') : (s.artist || ''),
        album: s.album || '',
      }));
    }

    /* ============ 网易云链接解析 + 歌曲详情 ============ */
    // 详情接口：NeteaseCloudMusicApi 公共实例（需 https，因为 iirose 是 https 页面，
    // fetch http:// 会被混合内容阻止）。带 CORS，浏览器可直接 fetch。
    const DETAIL_APIS = [
      'https://api.jimsdeng.eu.org',
    ];

    // 从文本提取歌曲 id：纯数字 或 链接里的 id=xxx
    function extractSongId(text) {
      const t = String(text).trim();
      if (/^\d{5,12}$/.test(t)) return t;
      const m = t.match(/[?&]id=(\d+)/);
      return m ? m[1] : null;
    }

    // 按 id 拿歌曲详情：name / singer / cover / duration
    async function getSongDetail(id) {
      for (const base of DETAIL_APIS) {
        try {
          const res = await fetch(`${base}/song/detail?ids=${id}`);
          if (!res.ok) continue;
          const data = await res.json();
          const s = data.songs && data.songs[0];
          if (!s) continue;
          return {
            id: String(s.id),
            name: s.name,
            singer: (s.ar || []).map((a) => a.name).join('/'),
            cover: (s.al && s.al.picUrl) || '',
            duration: (s.dt || 0) / 1000, // 毫秒 → 秒
          };
        } catch (e) { /* 试下一个实例 */ }
      }
      throw new Error('无法获取歌曲信息（接口失效或链接有误）');
    }

    /* ============ 点播流程（搜索路径与链接路径共用） ============ */
    async function dianbo(song) {
      const [urlRes, lyricRes] = await Promise.all([
        apiGet({ types: 'url', id: song.id, br: '320' }),
        apiGet({ types: 'lyric', id: song.id }),
      ]);
      const mp3 = urlRes && urlRes.url;
      if (!mp3) throw new Error('无法获取播放链接（可能无版权或接口限制）');

      let duration = song.duration;
      if (!duration) duration = urlRes.size && urlRes.br ? (urlRes.size * 8) / (urlRes.br * 1000) : 0;

      let cover = song.cover || '';
      if (!cover) {
        try { cover = (await apiGet({ types: 'pic', id: song.id })).url || ''; }
        catch (e) { cover = ''; }
      }

      const lyrics = (lyricRes && lyricRes.lyric) || '';
      const link = 'https://music.163.com/#/song?id=' + song.id;
      const color = 'ec4141';

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
