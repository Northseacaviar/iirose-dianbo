// 协议层单测 —— 针对发布版单文件插件（旧的 test/media.test.js 测的是历史 src/media.js 模块，覆盖不到发布版）。
// 用法：node tests/protocol.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PLUGIN = path.join(__dirname, '..', 'iirose-dianbo.js');
const src = fs.readFileSync(PLUGIN, 'utf8');
const hit = src.match(/\/\/ #region PROTOCOL([\s\S]*?)\/\/ #endregion/);
if (!hit) { console.error('FAIL: 未找到 #region PROTOCOL 标记'); process.exit(1); }

const sandbox = { JSON, Date, console };
vm.createContext(sandbox);
vm.runInContext(hit[1] + '\n__exp = { NETEASE_TYPE, encodeHTML, stripScheme, normalizeColor, buildMediaCard, buildMediaEvent };', sandbox);
const P = sandbox.__exp;

let pass = 0, fail = 0;
function eq(name, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + '   得到 ' + JSON.stringify(got) + '，期望 ' + JSON.stringify(want)); }
}
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '   ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '   ' + extra : '')); }
}

console.log('=== 协议层（卡片 / 事件 / 编解码） ===');
eq('网易云类型码是 @0', P.NETEASE_TYPE, '@0');

console.log('\n-- stripScheme（iirose 的地址约定） --');
eq('https → s://', P.stripScheme('https://music.163.com/#/song?id=1'), 's://music.163.com/#/song?id=1');
eq('http → ://', P.stripScheme('http://p2.music.126.net/x.jpg'), '://p2.music.126.net/x.jpg');
eq('非字符串不炸', P.stripScheme(null), '');

console.log('\n-- encodeHTML --');
eq('转义 <>&"\'', P.encodeHTML('a<b>&c"d\'e'), 'a&lt;b&gt;&amp;c&quot;d&#39;e');

console.log('\n-- 卡片消息 m__4<类型码>… --');
const c0 = JSON.parse(P.buildMediaCard('诀别书', '邓垚', 'http://p2.music.126.net/wzt.jpg', '202c3a', 128));
eq('默认类型码 @0，字段顺序符合协议', c0.m, 'm__4@0>诀别书>邓垚>http://p2.music.126.net/wzt.jpg>202c3a>128');
eq('mc 与颜色一致', c0.mc, '202c3a');
ok('i 是时间戳数字串', /^\d+$/.test(c0.i));
const cQq = JSON.parse(P.buildMediaCard('莫扎特钢琴曲k448', 'jaycd', 'https://y.qq.com/x.jpg', '31c27c', 319, '@2'));
eq('显式传 @2（QQ 音乐）', cQq.m, 'm__4@2>莫扎特钢琴曲k448>jaycd>https://y.qq.com/x.jpg>31c27c>319');
eq('歌名/歌手含特殊字符时转义', JSON.parse(P.buildMediaCard('a>b<c', 'x&y', 'http://c.jpg', '000000', 320)).m,
  'm__4@0>a&gt;b&lt;c>x&amp;y>http://c.jpg>000000>320');
eq('非法颜色回退 ec4141', JSON.parse(P.buildMediaCard('a', 'b', 'c', 'zzz', 128)).mc, 'ec4141');
eq('带 # 的颜色可用', JSON.parse(P.buildMediaCard('a', 'b', 'c', '#AABBCC', 128)).mc, 'AABBCC');

console.log('\n-- 媒体事件 &1{…} --');
const ev0 = P.buildMediaEvent('https://m701.music.126.net/x.mp3', 246.97, 'http://p2.music.126.net/c.jpg',
  '诀别书', '邓垚', 'https://music.163.com/#/song?id=1', '[00:00.00]t');
ok('以 &1{ 开头', ev0.startsWith('&1{'));
const o0 = JSON.parse(ev0.slice(2));
eq('s：https → s://', o0.s, 's://m701.music.126.net/x.mp3');
eq('c：http → ://', o0.c, '://p2.music.126.net/c.jpg');
eq('o：https → s://', o0.o, 's://music.163.com/#/song?id=1');
eq('默认类型码 @0', o0.b, '@0');
eq('时长原样传（秒）', o0.d, 246.97);
eq('歌词字段', o0.l, '[00:00.00]t');

const o2 = JSON.parse(P.buildMediaEvent('https://ws.stream.qqmusic.qq.com/a.mp3', 264, 'https://y.qq.com/c.jpg',
  'n', 's', 'https://y.qq.com/x', '', '@2').slice(2));
eq('显式传 @2（QQ 音乐点播）', o2.b, '@2');
eq('QQ 直链 https → s://', o2.s, 's://ws.stream.qqmusic.qq.com/a.mp3');
eq('歌词缺省为空串', o2.l, '');

console.log(`\n=== 结果: ${pass} PASS / ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);
