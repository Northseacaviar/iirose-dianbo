// M1 验收测试 v2：直接提取插件里 #region QQ-LAYER 的真实代码在 Node 里执行（不复制实现）。
// 覆盖：审查报告指出的 S1 降级链 / S2 时长必需 / S3 官方链接形式，+ 纯函数边界 + 真实接口三类样本。
// 用法：node m1_verify.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PLUGIN = path.join(__dirname, '..', 'iirose-dianbo.js');
const src = fs.readFileSync(PLUGIN, 'utf8');

const m = src.match(/\/\/ #region QQ-LAYER([\s\S]*?)\/\/ #endregion/);
if (!m) { console.error('FAIL: 未找到 #region QQ-LAYER 标记'); process.exit(1); }

const sandbox = { fetch, AbortSignal, console, setTimeout, clearTimeout, URLSearchParams };
vm.createContext(sandbox);
vm.runInContext(m[1] + `
__exp = { qqSearch, qqDetail, qqLyrics, qqGetUrl, isCompleteAudio, toHttps, parseSize, parseInterval,
          parseKbps, qqExtractMid, classifyQqError, mapQqSong, QQ_TYPE, QQ_URL_PROVIDERS };
`, sandbox);
const L = sandbox.__exp;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '   ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '   ' + extra : '')); }
}

(async () => {
  console.log('=== A. 纯函数边界（离线） ===');
  check('toHttps http→https', L.toHttps('http://ws.stream.qqmusic.qq.com/x.mp3') === 'https://ws.stream.qqmusic.qq.com/x.mp3');
  check('toHttps 大写 HTTP:// 也改写（审查 M3）', L.toHttps('HTTP://a/b.mp3') === 'https://a/b.mp3', '= ' + L.toHttps('HTTP://a/b.mp3'));
  check('toHttps 已是 https 不变', L.toHttps('https://a/b') === 'https://a/b');
  check('toHttps 空值不炸', L.toHttps('') === '' && L.toHttps(null) === '');
  check('parseSize 0.92MB', L.parseSize('0.92MB') === Math.round(0.92 * 1048576), '= ' + L.parseSize('0.92MB'));
  check('parseSize 10.09MB', L.parseSize('10.09MB') === Math.round(10.09 * 1048576), '= ' + L.parseSize('10.09MB'));
  check('parseSize 单字母单位 10.09M（审查 M2）', L.parseSize('10.09M') === Math.round(10.09 * 1048576), '= ' + L.parseSize('10.09M'));
  check('parseSize 带空格 0.92 M', L.parseSize('0.92 M') === Math.round(0.92 * 1048576), '= ' + L.parseSize('0.92 M'));
  check('parseSize 千分位 1,234,567', L.parseSize('1,234,567') === 1234567, '= ' + L.parseSize('1,234,567'));
  check('parseSize 负数取绝对值', L.parseSize('-1') === 1);
  check('parseSize 非法串→0', L.parseSize('abc') === 0);
  check('parseSize 数字直通', L.parseSize(1234) === 1234);
  check('parseSize 空串→0', L.parseSize('') === 0 && L.parseSize(undefined) === 0);
  check('parseInterval 4分29秒', L.parseInterval('4分29秒') === 269, '= ' + L.parseInterval('4分29秒'));
  check('parseInterval 3分', L.parseInterval('3分') === 180);
  check('parseInterval 45秒', L.parseInterval('45秒') === 45);
  check('parseInterval 纯数字', L.parseInterval('269') === 269);
  check('parseInterval 小时 1小时2分3秒（审查 M1）', L.parseInterval('1小时2分3秒') === 3723, '= ' + L.parseInterval('1小时2分3秒'));
  check('parseInterval 冒号 1:02:03', L.parseInterval('1:02:03') === 3723, '= ' + L.parseInterval('1:02:03'));
  check('parseInterval 冒号 60:00', L.parseInterval('60:00') === 3600, '= ' + L.parseInterval('60:00'));
  check('parseKbps 350kbps', L.parseKbps('350kbps') === 350);
  check('parseKbps 28kbps', L.parseKbps('28kbps') === 28);
  check('classifyQqError 无音质→no_audio', L.classifyQqError('业务运行异常！当前歌曲无音质或付费专辑！') === 'no_audio');
  check('classifyQqError 风控→cookie', L.classifyQqError('账号被风控') === 'cookie');
  check('mapQqSong 脏数据（缺 mid）被过滤', L.mapQqSong({ song: 'x' }) === null);
  check('QQ_TYPE 是 @2', L.QQ_TYPE === '@2');

  console.log('\n=== B. QQ 链接解析（审查 S3：官方各种分享形式） ===');
  const links = [
    ['新版 songDetail 路径', 'https://y.qq.com/n/ryqq/songDetail/0039MnYb0qxYhV', '0039MnYb0qxYhV'],
    ['?mid= 形式', 'https://y.qq.com/n/ryqq/songDetail?mid=004dPfPq4VgCmz', '004dPfPq4VgCmz'],
    ['i.y.qq.com playsong songmid=', 'https://i.y.qq.com/v8/playsong.html?songmid=0039MnYb0qxYhV&type=0', '0039MnYb0qxYhV'],
    ['旧版 /n/yqq/song/*.html', 'https://y.qq.com/n/yqq/song/0039MnYb0qxYhV.html', '0039MnYb0qxYhV'],
    ['裸 mid', '0039MnYb0qxYhV', '0039MnYb0qxYhV'],
    ['普通关键词→null', '青花瓷', null],
  ];
  for (const [label, input, want] of links) {
    check('qqExtractMid ' + label, L.qqExtractMid(input) === want, '= ' + L.qqExtractMid(input));
  }

  console.log('\n=== C. 完整性判定（审查 S2：时长必需 + 短曲假阳性窗口） ===');
  const sizeVip = L.parseSize('0.92MB'), durVip = L.parseInterval('4分29秒');
  check('会员歌(试听 quality + 28kbps) → 不完整', L.isCompleteAudio('音乐试听', sizeVip, durVip, 28) === false,
    `quality=音乐试听 size=${sizeVip} dur=${durVip} kbps=28`);
  const sizeFree = L.parseSize('10.09MB'), durFree = L.parseInterval('4分24秒');
  check('免费歌(完整 HQ) → 完整', L.isCompleteAudio('HQ高音质', sizeFree, durFree, 319) === true, 'kbps=319');
  check('试听但 quality 未标注 → 靠码率拦住', L.isCompleteAudio('', sizeVip, durVip, 28) === false);
  check('短曲(120s)+试听码率 → 拦住（旧比值法此处假阳性）', L.isCompleteAudio('', sizeVip, 120, 28) === false);
  check('时长未知 → 不敢判完整（审查 S2 核心）', L.isCompleteAudio('', sizeVip, 0, 0) === false);
  check('duration=undefined → 不完整', L.isCompleteAudio('', sizeVip, undefined, 0) === false);
  check('码率缺失但比值正常 → 完整', L.isCompleteAudio('', sizeFree, durFree, 0) === true);
  check('码率缺失且比值崩 → 不完整', L.isCompleteAudio('', sizeVip, durVip, 0) === false);
  check('quality 含试听即使 size 大 → 不完整', L.isCompleteAudio('音乐试听', 50 * 1048576, 269, 320) === false);
  check('320k 完整不被误杀', L.isCompleteAudio('无损', Math.round(320 / 8 * 1000 * 300), 300, 0) === true);

  console.log('\n=== D. 降级链（审查 S1：拿到试听不能直接 return） ===');
  const n0 = L.QQ_URL_PROVIDERS.length;
  L.QQ_URL_PROVIDERS.push({
    name: 'mock-完整源',
    async getUrl() { return { url: 'https://example.com/full.mp3', size: 10580132, kbps: 320, quality: '无损' }; },
  });
  const graded = await L.qqGetUrl('0039MnYb0qxYhV', 269);
  check('拿到试听后继续降级到完整源', graded.provider === 'mock-完整源' && graded.complete === true,
    `provider=${graded.provider} complete=${graded.complete}`);
  check('降级链 provider 列表可插拔', L.QQ_URL_PROVIDERS.length === n0 + 1, 'provider 数=' + L.QQ_URL_PROVIDERS.length);
  L.QQ_URL_PROVIDERS.pop();

  console.log('\n=== E. 真实接口 3 类样本 ===');
  try {
    const s1 = await L.qqSearch('晴天 周杰伦', 3);
    check('搜索(VIP 关键词) 返回结构完整', s1.length > 0 && !!s1[0].mid && s1[0].source === 'qq' && s1[0].duration > 0,
      `首条: ${s1[0].name}/${s1[0].singer} mid=${s1[0].mid} dur=${s1[0].duration}s pay=${s1[0].pay}`);
    const det = await L.qqDetail('0039MnYb0qxYhV');
    check('qqDetail 按 mid 取详情', det.mid === '0039MnYb0qxYhV' && !!det.name, `${det.name}/${det.singer}`);
    const u1 = await L.qqGetUrl(det.mid, det.duration);
    check('① 会员歌 → 判定为不完整（试听）', u1.complete === false,
      `quality=${u1.quality} kbps=${u1.kbps} size=${u1.size} provider=${u1.provider}`);
    check('会员歌直链已 https 化', u1.url.startsWith('https://'), u1.url.slice(0, 60) + '...');
    const lyr = await L.qqLyrics(det.id);
    check('歌词接口返回 LRC', typeof lyr === 'string' && lyr.includes('['), 'len=' + lyr.length);
  } catch (e) { check('会员歌样本', false, '异常: ' + e.message); }

  try {
    const song = await L.qqDetail('004dPfPq4VgCmz');
    const u2 = await L.qqGetUrl(song.mid, song.duration);
    check('② 免费歌 → 判定为完整可播', u2.complete === true,
      `${song.name} quality=${u2.quality} kbps=${u2.kbps} size=${u2.size} dur=${song.duration}s`);
    check('② 直链为 https', u2.url.startsWith('https://'), u2.url.slice(0, 60) + '...');
    check('② cover 已 https 化', song.cover.startsWith('https://') || song.cover === '', song.cover.slice(0, 40));
  } catch (e) { check('免费歌样本', false, '异常: ' + e.message); }

  try {
    let err = null;
    try { await L.qqGetUrl('004MpJjW07rAPl', 180); } catch (e) { err = e; }
    check('③ 无音质歌 → 抛可分类错误', !!err && err.reason === 'no_audio',
      err ? `${err.reason}: ${err.message}` : '未抛错');
  } catch (e) { check('无音质样本', false, '异常: ' + e.message); }

  console.log(`\n=== 结果: ${pass} PASS / ${fail} FAIL ===`);
  process.exit(fail ? 1 : 0);
})();
