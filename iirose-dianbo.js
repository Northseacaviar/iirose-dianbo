// ============================================================
//  iirose 点歌（网易云 + QQ 音乐）v0.6.0 —— 网页发布版
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
//  点歌方式（同一个输入框，自动识别）：
//    - 关键词搜索：网易云 + QQ 音乐一起搜（结果带来源徽标）→ 点「点播」
//    - 链接点播：网易云 https://music.163.com/song?id=xxx 或纯歌曲 id；
//      QQ 音乐 songDetail/<mid>、i.y.qq.com/v8/playsong.html?songmid=<mid>、纯 14 位 mid
//
//  两个源的能力差异（重要）：
//    - 网易云：直链/歌词走 GD-Studio（能解 VIP），详情走 NeteaseCloudMusicApi 多实例
//    - QQ 音乐：走 api.vkeys.cn 聚合接口，只播「拿得到完整直链」的歌；
//      会员歌只给 60 秒试听 → 不播，自动改点网易云同名单曲（提示里写清回退到了谁）
//      —— 会员歌完整版需绿钻 cookie，纯前端拿不到（官方接口无 CORS）
//
//  说明：
//    - 点播使用「使用者自己登录的 iirose 账号」，本脚本不含任何他人账号/密码
//    - 多源 fallback：任一源失效自动切换下一个；接口全挂时如实报错，不假装「没搜到」
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

    // 版本号：控制台与悬浮球上可见，用来确认「页面里到底加载的是哪一版」
    // （jsdelivr 有 CDN/浏览器双层缓存，改了代码朋友那边不一定马上换新版）
    const VERSION = '0.6.0';
    window.__IIROSE_DIANBO_VERSION__ = VERSION;

    /* ============ 点播消息拼装（协议见 iirose-docs api_media.md） ============ */
    // #region PROTOCOL
    const NETEASE_TYPE = '@0';   // QQ 音乐的类型码是 @2（见下方 QQ 数据层），新增音源必须显式传码

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
    function buildMediaCard(name, singer, cover, color, bitrate, type) {
      const c = normalizeColor(color);
      const t = type || NETEASE_TYPE;
      const m = `m__4${t}>${encodeHTML(name)}>${encodeHTML(singer)}>${cover}>${c}>${bitrate}`;
      return JSON.stringify({ m: m, mc: c, i: String(Date.now()) });
    }
    function buildMediaEvent(url, duration, cover, name, singer, link, lyrics, type) {
      const data = {
        s: stripScheme(url),
        d: duration,
        c: stripScheme(cover),
        n: name,
        r: singer,
        b: type || NETEASE_TYPE,
        o: stripScheme(link),
        l: lyrics || '',
      };
      return '&1' + JSON.stringify(data);
    }
    // #endregion

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
            source: 'netease',
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
        source: 'netease',
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
        source: 'netease',
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

    /* ============ QQ 音乐数据层（第三方聚合接口 + 可插拔直链提供方） ============ */
    // 协议依据：iirose 媒体类型码里 QQ 音乐 = @2（卡片与事件同码）
    // 背景（见 docs/可行性报告.md）：
    //  - QQ 官方接口无 CORS，且匿名一律不给直链 → 浏览器里只能走第三方聚合接口
    //  - 会员歌的完整直链拿不到（需绿钻 cookie），本插件只播「能拿到完整直链」的歌
    // #region QQ-LAYER
    const QQ_TYPE = '@2';
    const QQ_DEFAULT_QUALITY = '8';   // 128k；实测 8/9 对免费歌返回同一份 HQ，10 才是无损，16 是「AI人声消音(试验)」
    // 聚合接口 base 列表（多实例：依次尝试，任一失效自动切下一个 —— 与网易云层的 fetchAny 同思路）
    const QQ_APIS = ['https://api.vkeys.cn/v2/music'];

    // iirose 是 https 页面：媒体地址必须是 https，否则被浏览器按混合内容拦掉。
    // 第三方给的直链默认是 http://ws.stream.qqmusic.qq.com/... —— 实测改 https 后照样 206。
    // 注意大小写：上游给 HTTP:// 也必须改写（stripScheme 只认小写 s:// 前缀，写错等于静音）
    function toHttps(url) {
      return String(url || '').replace(/^https?:\/\//i, 'https://');
    }

    // "0.92MB" / "10.09M" / "1,234,567" → 字节（上游格式不稳，多留一手）
    function parseSize(size) {
      if (typeof size === 'number') return Math.max(0, Math.round(size));
      const m = String(size || '').replace(/,/g, '').match(/^\s*(-?[\d.]+)\s*([KMGT]?)(?:i?[Bb])?\s*$/);
      if (!m) return 0;
      const n = Math.abs(parseFloat(m[1]));
      const unit = (m[2] || '').toUpperCase();
      const mul = unit === 'T' ? 1099511627776 : unit === 'G' ? 1073741824
        : unit === 'M' ? 1048576 : unit === 'K' ? 1024 : 1;
      return Math.round(n * mul);
    }

    // "350kbps" / 319 → 319
    function parseKbps(kbps) {
      const n = parseFloat(String(kbps == null ? '' : kbps).replace(/[^\d.]/g, ''));
      return isFinite(n) && n > 0 ? n : 0;
    }

    // "4分29秒" / "60分18秒" / "1小时2分3秒" / "1:02:03" / 269 → 秒
    function parseInterval(interval) {
      if (typeof interval === 'number') return interval > 0 ? interval : 0;
      const t = String(interval || '').trim();
      const hh = t.match(/(\d+)\s*小时/);
      const mm = t.match(/(\d+)\s*分/);
      const ss = t.match(/(\d+)\s*秒/);
      if (hh || mm || ss) return (hh ? Number(hh[1]) * 3600 : 0) + (mm ? Number(mm[1]) * 60 : 0) + (ss ? Number(ss[1]) : 0);
      const colon = t.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
      if (colon) {
        return colon[3] !== undefined
          ? Number(colon[1]) * 3600 + Number(colon[2]) * 60 + Number(colon[3])
          : Number(colon[1]) * 60 + Number(colon[2]);
      }
      const sec = t.match(/^\d+$/);
      return sec ? Number(sec[0]) : 0;
    }

    // 判断直链是「完整曲目」还是「试听片段」。判据按可靠性排序（阈值全部来自实测）：
    //   1) quality 含「音乐试听」—— 会员歌就是这个标签
    //   2) 文件实际码率 < 100kbps —— 试听恒为 28kbps，完整曲目 ≥128kbps。
    //      这条不依赖时长，所以短曲也不会漏判（纯比值法在 ≤120 秒的歌上会假阳性：
    //      0.92MB 试听 ÷ 120s ≈ 64kbps，正好压在阈值上）
    //   3) 拿不到码率时退回 size÷duration 比值（<64kbps 视为片段）
    //   4) 码率与时长都拿不到 → 不敢判完整（宁可走回退链，也不给用户放 60 秒还显示「已点播」）
    function isCompleteAudio(quality, size, duration, kbps) {
      if (/试听/.test(String(quality || ''))) return false;
      const rate = Number(kbps) || 0;
      if (rate > 0) return rate >= 100;
      const dur = Number(duration) || 0;
      if (dur <= 0) return false;
      if (size > 0) return (size * 8) / dur / 1000 >= 64;
      return false;
    }

    async function jsonGet(url, timeout) {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeout || 10000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); }
      catch (e) { const err = new Error('接口返回格式异常'); err.reason = 'bad_response'; throw err; }
      // vkeys 的业务错误也走 HTTP 200，必须看 code，否则错误全被当成成功
      const code = data && data.code;
      if (code !== undefined && code !== null && String(code) !== '0' && String(code) !== '200') {
        const err = new Error((data && data.message) || ('接口错误 ' + code));
        err.reason = classifyQqError(data && data.message);
        err.code = code;
        throw err;
      }
      return data;
    }

    // 业务错误分类（供回退链判断：该换源 / 该重试 / 该报链接有误）
    function classifyQqError(message) {
      const m = String(message || '');
      if (/无音质|付费专辑/.test(m)) return 'no_audio';      // 拿不到可播文件 → 换源
      if (/风控|cookie/i.test(m)) return 'cookie';           // 服务端账号问题 → 换提供方/换源
      if (/缺少|参数|必填|格式|不存在/.test(m)) return 'bad_param';
      return 'unknown';
    }

    // 多实例请求：base 依次尝试，任一失效自动切下一个
    async function qqGet(path, params, timeout) {
      const qs = params ? '?' + new URLSearchParams(params).toString() : '';
      let lastErr = null;
      for (const base of QQ_APIS) {
        try { return await jsonGet(base + path + qs, timeout); }
        catch (e) { lastErr = e; }
      }
      throw lastErr || new Error('QQ 音乐接口不可用');
    }

    // 上游字段 → 本插件统一歌曲结构
    function mapQqSong(s) {
      if (!s || !s.mid) return null;
      return {
        source: 'qq',
        id: s.id ? String(s.id) : '',
        mid: s.mid,
        name: s.song || '',
        singer: s.singer || '',
        album: s.album || '',
        cover: toHttps(s.cover || ''),
        duration: parseInterval(s.interval),
        pay: s.pay || '',            // 仅展示：实测标「付费」的歌也可能完整可播，不可当会员判据
        quality: s.quality || '',    // 注意语义：搜索给「平台最高音质」，geturl 给「实际文件音质」
        kbps: parseKbps(s.kbps),
        link: s.link || '',
      };
    }

    // 直链提供方：可插拔列表。循环语义 —— 拿到「不完整」不算成功，要继续试后面的提供方；
    // 只有所有提供方都给不出完整版，才把最后一个不完整结果交上层去走回退。
    const QQ_URL_PROVIDERS = [
      {
        name: 'vkeys',
        async getUrl(mid, quality) {
          const r = await qqGet('/tencent/geturl', { mid: mid, quality: quality || QQ_DEFAULT_QUALITY });
          const d = r && r.data;
          if (!d || !d.url) throw new Error((r && r.message) || '无直链');
          return {
            url: toHttps(d.url),
            size: parseSize(d.size),
            kbps: parseKbps(d.kbps),
            quality: d.quality || '',
          };
        },
      },
    ];

    // 关键词搜索 → 统一结构（source 用于选类型码 + 回退）
    async function qqSearch(keyword, count) {
      const r = await qqGet('/tencent', { word: keyword, page: 1, num: count || 8 });
      const data = r && r.data;
      if (!Array.isArray(data)) throw new Error((r && r.message) || '搜索返回格式异常');
      return data.map(mapQqSong).filter(Boolean);
    }

    // 按 mid 取详情（搜索返回数组、详情返回对象，两者形态不一致，这里都吃）
    async function qqDetail(mid) {
      const r = await qqGet('/tencent', { mid: mid });
      const raw = r && r.data;
      const song = mapQqSong(Array.isArray(raw) ? raw[0] : raw);
      if (!song) throw new Error('无法获取歌曲信息（接口失效或链接有误）');
      return song;
    }

    // 歌词（LRC 文本）
    async function qqLyrics(id) {
      try {
        const r = await qqGet('/tencent/lyric', { id: id });
        if (r && r.data && r.data.lrc) return r.data.lrc;
      } catch (e) { /* 歌词可为空 */ }
      return '';
    }

    // 直链 + 完整性判定：拿到完整才算成功；只剩不完整结果时返回它（complete:false）由上层回退
    async function qqGetUrl(mid, duration) {
      let lastErr = null;
      let partial = null;
      for (const p of QQ_URL_PROVIDERS) {
        try {
          const r = await p.getUrl(mid);
          const got = {
            url: r.url,
            size: r.size,
            kbps: r.kbps,
            quality: r.quality,
            provider: p.name,
            complete: isCompleteAudio(r.quality, r.size, duration, r.kbps),
          };
          if (got.complete) return got;
          if (!partial) partial = got;
        } catch (e) { lastErr = e; }
      }
      if (partial) return partial;
      throw lastErr || new Error('无法获取播放链接');
    }

    // 从文本提取 QQ 音乐 mid。覆盖官方各种分享形式：
    //   songDetail/<mid>、?songmid=、?mid=、/n/yqq/song/xxx.html、i.y.qq.com/v8/playsong.html?songmid=
    // 最后对 y.qq.com 链接做一次 14 位兜底（QQ 的 mid 恒为 14 位，实测 80/80）
    function qqExtractMid(text) {
      const t = String(text || '').trim();
      let m = t.match(/[?&](?:song)?mid=([A-Za-z0-9]{10,20})/);
      if (m) return m[1];
      m = t.match(/songDetail\/([A-Za-z0-9]{10,20})/) || t.match(/\/(?:n\/yqq\/)?song\/([A-Za-z0-9]{10,20})/);
      if (m) return m[1];
      // 裸 token 兜底：必须 14 位且字母数字混合。纯数字/纯字母的 14 位串多为 id 或页面 token，
      // 误判会让关键词搜索被整个跳过；实测 QQ 的 songmid 都同时含字母和数字
      if (/y\.qq\.com|qqmusic/i.test(t)) {
        m = t.match(/(?=[A-Za-z0-9]*[A-Za-z])(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{14}/);
        if (m) return m[0];
        return null;   // 是 QQ 链接但取不到 mid → 交给上层如实报错，别降级去搜关键词
      }
      if (/^(?=[A-Za-z0-9]*[A-Za-z])(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{14}$/.test(t)) return t;
      return null;
    }
    // #endregion

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
    // 注意：QQ 音乐的封面域 y.qq.com 实测【没有】Access-Control-Allow-Origin，
    // crossOrigin 加载必然失败 → 走 catch，由调用方传的兜底色决定卡片颜色。
    async function getDominantColor(coverUrl, fallbackHex) {
      const fallback = normalizeColor(fallbackHex || 'ec4141');
      if (!coverUrl) return fallback;
      try {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        await new Promise((resolve, reject) => {
          // 3 秒超时兜底：封面 CDN 连接挂住时既不 load 也不 error，会让「点播中…」永久卡住
          const timer = setTimeout(() => reject(new Error('封面加载超时')), 3000);
          img.onload = () => { clearTimeout(timer); resolve(); };
          img.onerror = () => { clearTimeout(timer); reject(new Error('封面加载失败')); };
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
    // 入口：按 source 分流。网易云走原路径；QQ 走「只播完整版，拿不到就回退网易云同名单曲」。
    // onProgress 为可选进度回调（回退链最坏要 ~70 秒，不刷状态栏用户会以为点了没反应）
    async function dianbo(song, onProgress) {
      const say = (t) => { try { if (onProgress) onProgress(t); } catch (e) { /* 提示失败不影响点播 */ } };

      if ((song.source || 'netease') !== 'qq') {
        say('获取播放链接中…');
        return sendNetease(song);
      }

      say('QQ 音乐：获取直链中…');
      let reason = '';
      try {
        const got = await qqGetUrl(song.mid, song.duration);
        if (got.complete) return sendQq(song, got);
        // 注意：song.duration 是【整曲时长】（vkeys 的 interval），不是试听时长 —— 试听恒为 60 秒，
        // 写成 song.duration 会输出「只给 269 秒试听片段」这种自相矛盾的文案
        reason = /试听/.test(got.quality || '')
          ? '只给 60 秒试听片段（会员曲目）'
          : '拿不到可确认的完整版（接口未给码率/时长，无法判定）';
      } catch (e) {
        // 链接/参数本身有问题 → 换源也是白搭，直接如实报错（reason 由 classifyQqError 分类）
        if (e && e.reason === 'bad_param') throw new Error('QQ 音乐歌曲信息有误：' + e.message);
        reason = (e && e.message) || '拿不到播放链接';
      }

      // 回退：网易云找同名单曲。
      // QQ 会员歌在网易云往往同样没有版权 —— 找不到就如实报错，绝不能让用户点了没反应
      say('QQ ' + reason + '，正在回退网易云…');
      const alt = await findNeteaseSame(song);
      if (!alt) throw new Error('QQ 音乐「' + song.name + '」' + reason + '，网易云也没有同名单曲');
      // 提示里报清回退到了谁的版本 —— 同名歌很可能是翻唱，用户要能一眼看出
      const altNote = '网易云「' + alt.name + (alt.singer ? ' - ' + alt.singer : '') + '」';
      try {
        return await sendNetease(alt, 'QQ 音乐' + reason + '，已自动改用' + altNote);
      } catch (e) {
        throw new Error('QQ 音乐' + reason + '；改用' + altNote + '也失败（' + e.message + '）');
      }
    }

    // 网易云点播（原路径）
    async function sendNetease(song, note) {
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

      // 事件时长必须为正数：d:0 会让播放器进度错乱，而 UI 还报「已点播」
      const dur = Math.max(1, Math.round(duration || 0));
      const sock = getSocket();
      sock.send(buildMediaCard(song.name, song.singer, cover, color, 320, NETEASE_TYPE));
      sock.send(buildMediaEvent(mp3, dur, cover, song.name, song.singer, link, lyrics, NETEASE_TYPE));
      return { note: note || '', source: 'netease', name: song.name, singer: song.singer };
    }

    // QQ 音乐点播（仅在拿到完整直链时调用）
    async function sendQq(song, got) {
      const cover = song.cover || '';
      const lyrics = song.id ? await qqLyrics(song.id).catch(() => '') : '';
      // QQ 封面域无 CORS，取色一定失败 → 兜底用腾讯绿，避免卡片退成网易云红
      const color = await getDominantColor(cover, '31c27c');
      let duration = song.duration;
      if (!duration) duration = got.size && got.kbps ? (got.size * 8) / (got.kbps * 1000) : 0;
      const link = song.link || ('https://y.qq.com/n/ryqq/songDetail/' + song.mid);
      const br = Math.round(got.kbps || 128);

      const sock = getSocket();
      sock.send(buildMediaCard(song.name, song.singer, cover, color, br, QQ_TYPE));
      sock.send(buildMediaEvent(got.url, Math.max(1, Math.round(duration || 0)), cover, song.name, song.singer, link, lyrics, QQ_TYPE));
      return { note: '', source: 'qq', name: song.name, singer: song.singer };
    }

    // 网易云同名单曲查找（QQ 回退用）：歌名归一化后匹配，优先歌手也对得上的版本（避免点了周杰伦却回退成翻唱）
    function normName(s) {
      return String(s || '').replace(/[\s\-_()（）【】\[\]·.,，、!！?？'"]/g, '').toLowerCase();
    }
    async function findNeteaseSame(song) {
      const key = normName(song.name);
      const singerKey = normName(song.singer);
      if (!key) return null;
      let list = [];
      try { list = await searchSongs((song.name + ' ' + (song.singer || '')).trim(), 5); } catch (e) { return null; }
      const same = (list || []).filter((x) => {
        const n = normName(x.name);
        return n === key || n.indexOf(key) >= 0 || key.indexOf(n) >= 0;
      });
      if (!same.length) return null;
      if (singerKey) {
        const sameSinger = same.find((x) => {
          const s = normName(x.singer);
          return s && (s === singerKey || s.indexOf(singerKey) >= 0 || singerKey.indexOf(s) >= 0);
        });
        if (sameSinger) return sameSinger;
      }
      return same[0];
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
    fab.title = '点歌 v' + VERSION + '（可拖动）';

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
    title.appendChild(el('span', null, '🎵 点歌（网易云 + QQ 音乐）'));
    const closeBtn = el('span', { cursor: 'pointer', color: '#888', fontSize: '16px' }, '×');
    closeBtn.onclick = () => { panel.style.display = 'none'; };
    title.appendChild(closeBtn);
    panel.appendChild(title);

    const searchRow = el('div', { display: 'flex', gap: '6px', padding: '10px 12px' });
    const input = el('input', { flex: '1', background: '#2a2b33', border: '1px solid #444', borderRadius: '6px', color: '#eee', padding: '7px 10px', fontSize: '13px', outline: 'none' });
    input.placeholder = '歌名 / 歌手，或网易云 / QQ 音乐链接';
    const searchBtn = el('button', { background: '#ec4141', color: '#fff', border: 'none', borderRadius: '6px', padding: '7px 14px', cursor: 'pointer', fontSize: '13px' }, '搜索');
    searchRow.appendChild(input); searchRow.appendChild(searchBtn);
    panel.appendChild(searchRow);

    const status = el('div', { padding: '0 12px 8px', color: '#999', fontSize: '12px', minHeight: '16px' }, '登录 iirose 后即可点播');
    panel.appendChild(status);

    const list = el('div', { overflowY: 'auto', flex: '1' });
    panel.appendChild(list);

    function setStatus(t, color) { status.textContent = t; status.style.color = color || '#999'; }

    function fmtDur(sec) {
      const s = Math.round(sec || 0);
      if (!s) return '';
      return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    }

    // 渲染一个歌曲结果行（搜索与链接点播共用）
    function addSongRow(song) {
      const isQq = (song.source || 'netease') === 'qq';
      const row = el('div', { padding: '8px 12px', borderTop: '1px solid #2a2b33', display: 'flex', alignItems: 'center', gap: '8px' });
      const info = el('div', { flex: '1', minWidth: '0' });
      const line1 = el('div', { display: 'flex', alignItems: 'center', gap: '5px' });
      line1.appendChild(el('span', {
        fontSize: '10px', lineHeight: '15px', padding: '0 4px', borderRadius: '3px', color: '#fff', flexShrink: '0',
        background: isQq ? '#31c27c' : '#ec4141',
      }, isQq ? 'QQ' : '网易'));
      line1.appendChild(el('span', { color: '#eee', fontSize: '13px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }, song.name));
      info.appendChild(line1);
      const sub = song.singer
        + (song.album ? ' · ' + song.album : '')
        + (song.duration ? ' · ' + fmtDur(song.duration) : '');
      info.appendChild(el('div', { color: '#888', fontSize: '11px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }, sub));
      const btn = el('button', { background: '#3a7afe', color: '#fff', border: 'none', borderRadius: '5px', padding: '5px 12px', cursor: 'pointer', fontSize: '12px' }, '点播');
      btn.onclick = async () => {
        btn.disabled = true; btn.textContent = '点播中…';
        try {
          const r = await dianbo(song, (t) => setStatus(t, '#999'));
          setStatus((r && r.note) ? r.note : '已点播：' + song.name + ' - ' + song.singer, '#68b26d');
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

      // —— QQ 音乐链接点播 ——
      // 必须放在网易云规则之前：QQ 官方分享链接里的 ?songmid= 会被别的规则误抓
      const qqMid = qqExtractMid(kw);
      if (qqMid) {
        setStatus('解析 QQ 音乐链接…', '#999');
        try {
          const song = await qqDetail(qqMid);
          setStatus('找到「' + song.name + '」（QQ 音乐），点「点播」发送到房间', '#999');
          addSongRow(song);
        } catch (e) {
          setStatus('失败：' + e.message, '#ec4141');
        }
        return;
      }
      if (/y\.qq\.com|qqmusic/i.test(kw)) {
        // 认得出是 QQ 链接但取不到 mid（歌单/歌手页等）→ 说清楚，别默默当成关键词去搜
        setStatus('这个 QQ 音乐链接里没有歌曲 mid，请用歌曲详情页链接或直接输歌名', '#ec4141');
        return;
      }

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

      // —— 关键词搜索：两个源并行，任一挂掉不影响另一个 ——
      setStatus('搜索中…（网易云 + QQ 音乐）', '#999');
      const [ncmRes, qqRes] = await Promise.all([
        searchSongs(kw, 6).then((l) => ({ ok: true, list: l })).catch((e) => ({ ok: false, list: [], err: e })),
        qqSearch(kw, 6).then((l) => ({ ok: true, list: l })).catch((e) => ({ ok: false, list: [], err: e })),
      ]);
      const ncm = ncmRes.list, qq = qqRes.list;
      const songs = ncm.concat(qq);
      if (!songs.length) {
        // 区分「真没这首歌」和「接口挂了」——把后者说成「没搜到」会误导用户以为没版权
        setStatus(ncmRes.ok || qqRes.ok
          ? '无结果（两个源都没搜到这首歌）'
          : '搜索失败：两个接口都不可用（' + ((ncmRes.err && ncmRes.err.message) || '') + '）', '#ec4141');
        return;
      }
      setStatus('找到 ' + songs.length + ' 首（网易云 ' + ncm.length + ' / QQ ' + qq.length + '），点「点播」发送到房间', '#999');
      songs.forEach(addSongRow);
    }
    searchBtn.onclick = doSearch;
    input.onkeydown = (e) => { if (e.key === 'Enter') doSearch(); };

    /* 挂载 + 拖动绑定 */
    document.body.appendChild(panel);
    document.body.appendChild(fab);
    makeDraggable(fab, fab, () => { panel.style.display = panel.style.display === 'none' ? 'flex' : 'none'; });
    makeDraggable(panel, title);

    console.log('%c[iirose 点歌] v' + VERSION + ' 已加载（网易云 + QQ 音乐）', 'color:#ec4141;font-weight:bold');
  }

  /* 启动时机兜底：body 可能未就绪（对照 collector.js） */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
