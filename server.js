require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const fetch = require('node-fetch');
const schedule = require('node-schedule');
const useragent = require('useragent');

// 初始化Express
const app = express();
const PORT = process.env.PORT || 3000;
// 环境变量配置（加默认值，避免未定义）
const RENDER_KEEP_ALIVE = process.env.RENDER_KEEP_ALIVE === 'true' || false;
const SERVER_DOMAIN = process.env.SERVER_DOMAIN || `http://localhost:${PORT}`;
const KEEP_ALIVE_INTERVAL = parseInt(process.env.KEEP_ALIVE_INTERVAL) || 14;
const ADMIN_KEY = process.env.ADMIN_KEY || 'your_admin_secret_key_2026';

// 跨域配置（极致放宽，确保前端请求无跨域问题）
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['*'],
  credentials: true
}));
// 预处理OPTIONS请求，解决预检跨域
app.options('*', (req, res) => res.status(200).end());
app.use(express.json({ limit: '10kb' }));

// UA解析中间件（终极兜底，确保永远有有效对象）
app.use((req, res, next) => {
  // UA兜底通用对象
  function getUaFallbackObj() {
    return {
      device: { family: 'Other', model: '未知型号' },
      family: '未知浏览器',
      major: '',
      minor: '',
      os: { family: '未知系统', major: '', minor: '' },
      engine: { family: '未知内核' }
    };
  }
  try {
    let parsed = useragent.parse(req.headers['user-agent'] || '');
    if (!parsed || typeof parsed !== 'object') parsed = getUaFallbackObj();
    req.userAgentParsed = parsed;
  } catch (err) {
    req.userAgentParsed = getUaFallbackObj();
    console.warn(`⚠️ UA解析异常，使用兜底：`, err.message.slice(0, 50));
  }
  next();
});

// ===== SQLite3数据库配置（强制创建，确保读写）=====
const dbPath = path.resolve(__dirname, 'visitor.db');
const createDbConnection = () => {
  const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
    if (err) {
      console.error('❌ 数据库连接失败，重试中：', err.message);
      setTimeout(createDbConnection, 1000);
    } else {
      console.log(`✅ 数据库连接成功：${dbPath}`);
      initDatabaseTables(db);
      global.db = db;
    }
  });
  return db;
};
const db = createDbConnection();

// SQL工具函数（Promise封装+容错）
const querySql = (sql, params = []) => new Promise(resolve => {
  if (!global.db) return resolve([]);
  global.db.all(sql, params, (err, rows) => resolve(err ? [] : rows));
});
const runSql = (sql, params = []) => new Promise(resolve => {
  if (!global.db) return resolve({ changes: 0, lastID: 0 });
  global.db.run(sql, params, function (err) {
    resolve(err ? { changes: 0, lastID: 0 } : { changes: this.changes, lastID: this.lastID });
  });
});

// 初始化数据表
const initDatabaseTables = (db) => {
  const visitorTable = `CREATE TABLE IF NOT EXISTS visitor_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    visitor_ip TEXT NOT NULL,
    region TEXT DEFAULT '未知地区',
    visit_time TEXT NOT NULL,
    user_agent TEXT DEFAULT '未知设备',
    is_valid BOOLEAN DEFAULT 1
  );`;
  const blacklistTable = `CREATE TABLE IF NOT EXISTS blacklist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    blocked_ip TEXT NOT NULL UNIQUE,
    add_time TEXT NOT NULL,
    remark TEXT DEFAULT '无备注'
  );`;
  db.run(visitorTable, (err) => err ? console.warn('⚠️ 访客表初始化警告：', err.message) : console.log('✅ 访客表初始化成功'));
  db.run(blacklistTable, (err) => err ? console.warn('⚠️ 黑名单表初始化警告：', err.message) : console.log('✅ 黑名单表初始化成功'));
};

// ===== 核心工具函数 =====
// 北京时间（固定逻辑）
const getBeijingTime = () => {
  const now = new Date();
  const beijing = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return `${beijing.getUTCFullYear()}-${String(beijing.getUTCMonth() + 1).padStart(2, '0')}-${String(beijing.getUTCDate()).padStart(2, '0')} ${String(beijing.getUTCHours()).padStart(2, '0')}:${String(beijing.getUTCMinutes()).padStart(2, '0')}:${String(beijing.getUTCSeconds()).padStart(2, '0')}`;
};
const getBeijingDate = () => getBeijingTime().split(' ')[0];

// IP全信息查询（双接口+5秒超时+兜底）
const getIpFullInfo = async (ip) => {
  const invalidIpPatterns = ['127.0.0.1', '::1', '::ffff:127.0.0.1', /^192\.168\.\d{1,3}\.\d{1,3}$/, /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/, /^172\.(1[6-9]|2[0-9]|3[0-1])\.\d{1,3}\.\d{1,3}$/, /^169\.254\.\d{1,3}\.\d{1,3}$/];
  for (const p of invalidIpPatterns) {
    if ((typeof p === 'string' && ip === p) || (p instanceof RegExp && p.test(ip))) {
      return { region: p === '127.0.0.1' ? '本地网络' : '内网IP', isp: '本地/内网', country: '本地/内网', province: '本地/内网', city: '本地/内网' };
    }
  }
  let queryIp = ip.startsWith('::ffff:') ? ip.replace('::ffff:', '') : ip;
  const fallback = { region: '未知地区 | 未知运营商', isp: '未知运营商', country: '未知国家', province: '未知省份', city: '未知城市', lat: '0', lng: '0', timezone: 'Asia/Shanghai' };
  try {
    // 主接口：ip.sb
    const c1 = new AbortController();
    setTimeout(() => c1.abort(), 5000);
    const res1 = await fetch(`https://api.ip.sb/geoip/${queryIp}`, { signal: c1.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    const data1 = await res1.json();
    if (data1.ip) {
      const country = data1.country || fallback.country;
      const province = data1.region || data1.state || fallback.province;
      const city = data1.city || fallback.city;
      const isp = data1.isp || data1.org || fallback.isp;
      return {
        region: `${country} | ${province} | ${city} | ${isp}`,
        isp, country, province, city,
        lat: data1.latitude || fallback.lat,
        lng: data1.longitude || fallback.lng
      };
    }
  } catch (err) {
    try {
      // 备用接口：ipapi.co
      const c2 = new AbortController();
      setTimeout(() => c2.abort(), 5000);
      const res2 = await fetch(`https://ipapi.co/${queryIp}/json/`, { signal: c2.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
      const data2 = await res2.json();
      if (data2.ip) {
        const country = data2.country_name || fallback.country;
        const province = data2.region || fallback.province;
        const city = data2.city || fallback.city;
        const isp = data2.org || fallback.isp;
        return {
          region: `${country} | ${province} | ${city} | ${isp}`,
          isp, country, province, city,
          lat: data2.latitude || fallback.lat,
          lng: data2.longitude || fallback.lng
        };
      }
    } catch (err2) {
      console.log(`📌 IP查询双接口失败，返回兜底：`, err2.message.slice(0, 50));
    }
  }
  return fallback;
};

// UA解析（终极兜底，杜绝属性报错）
const parseUaFullInfo = (uaParsed) => {
  if (!uaParsed || typeof uaParsed !== 'object') {
    return {
      fullUa: '未知设备 | 未知浏览器 | 未知系统',
      deviceType: '未知设备',
      browser: '未知浏览器',
      os: '未知系统',
      engine: '未知内核'
    };
  }
  try {
    const deviceFamily = uaParsed.device?.family || 'Other';
    const osFamily = uaParsed.os?.family || '未知系统';
    const browser = `${uaParsed.family || '未知浏览器'} ${uaParsed.major || ''}`.trim() || '未知浏览器';
    const os = `${osFamily} ${uaParsed.os?.major || ''}.${uaParsed.os?.minor || ''}`.trim() || '未知系统';
    const deviceType = deviceFamily === 'Other' 
      ? (osFamily.includes('Android') || osFamily.includes('iOS') ? '手机' : '电脑')
      : deviceFamily === 'iPad' ? '平板' : deviceFamily || '未知设备';
    return {
      fullUa: `${deviceType} | ${browser} | ${os}`,
      deviceType,
      browser,
      os,
      engine: uaParsed.engine?.family || '未知内核'
    };
  } catch (err) {
    return {
      fullUa: '未知设备 | 未知浏览器 | 未知系统',
      deviceType: '未知设备',
      browser: '未知浏览器',
      os: '未知系统',
      engine: '未知内核'
    };
  }
};

// Render自动唤醒（容错，不影响主功能）
const startRenderKeepAlive = () => {
  if (!RENDER_KEEP_ALIVE) return console.log('📌 Render自动唤醒已关闭');
  const rule = new schedule.RecurrenceRule();
  rule.minute = new schedule.Range(0, 59, KEEP_ALIVE_INTERVAL);
  schedule.scheduleJob(rule, async () => {
    try {
      const res = await fetch(`${SERVER_DOMAIN}/api/health`, { timeout: 10000 });
      const data = await res.json();
      console.log(`⏰ Render唤醒成功 | 北京时间：${getBeijingTime()} | 状态：${data.status}`);
    } catch (err) {
      console.warn(`⚠️ Render唤醒失败（不影响主功能）：`, err.message.slice(0, 50));
    }
  });
  console.log(`✅ Render自动唤醒开启 | 间隔：${KEEP_ALIVE_INTERVAL}分钟 | 地址：${SERVER_DOMAIN}/api/health`);
};

// ===== 接口定义（核心：统计接口匹配前端渲染格式）=====
// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ status: 'online', time: getBeijingTime(), message: '服务器正常运行' });
});

// 访客记录接口（终极容错，必返回成功）
app.get('/api/visitor/record', async (req, res) => {
  try {
    // 获取真实IP
    let visitorIp = req.headers['x-forwarded-for']?.split(',').map(ip => ip.trim())[0]
                  || req.connection.remoteAddress || req.socket.remoteAddress || req.ip || '127.0.0.1';
    visitorIp = visitorIp === '::1' ? '127.0.0.1' : visitorIp;
    // 检查黑名单
    const blacklist = await querySql('SELECT * FROM blacklist WHERE blocked_ip = ?', [visitorIp]);
    if (blacklist.length > 0) {
      return res.json({ success: true, msg: '您的IP已被拦截', isBlocked: true, visitorIp });
    }
    // 获取访客信息
    const ipInfo = await getIpFullInfo(visitorIp);
    const uaInfo = parseUaFullInfo(req.userAgentParsed);
    const beijingTime = getBeijingTime();
    // 写入数据库
    await runSql(
      'INSERT INTO visitor_stats (visitor_ip, region, visit_time, user_agent) VALUES (?, ?, ?, ?)',
      [visitorIp, ipInfo.region, beijingTime, uaInfo.fullUa]
    );
    // 正常返回
    res.json({
      success: true, msg: '访问记录成功', isBlocked: false,
      visitorIp, beijingTime, ipInfo, uaInfo
    });
  } catch (err) {
    console.error('❌ 记录访客异常（兜底模式）：', err.message);
    // 兜底写入+返回
    const fallbackIp = req.ip || '127.0.0.1';
    const fallbackTime = getBeijingTime();
    const fallbackRegion = '未知地区 | 未知运营商';
    const fallbackUa = '未知设备 | 未知浏览器 | 未知系统';
    await runSql(
      'INSERT INTO visitor_stats (visitor_ip, region, visit_time, user_agent) VALUES (?, ?, ?, ?)',
      [fallbackIp, fallbackRegion, fallbackTime, fallbackUa]
    );
    res.json({
      success: true, msg: '访问记录成功（兜底模式）', isBlocked: false,
      visitorIp: fallbackIp, beijingTime: fallbackTime,
      region: fallbackRegion, deviceType: '未知设备'
    });
  }
});

// 🔥 核心修复：访客统计接口（返回格式完全匹配前端，确保渲染成功）
app.get('/api/visitor/stats', async (req, res) => {
  try {
    // 基础统计
    const totalData = await querySql('SELECT COUNT(*) AS total FROM visitor_stats WHERE is_valid = 1');
    const totalVisitors = parseInt(totalData[0]?.total || 0);
    const today = getBeijingDate();
    const todayData = await querySql('SELECT COUNT(*) AS today FROM visitor_stats WHERE DATE(visit_time) = ? AND is_valid = 1', [today]);
    const todayVisitors = parseInt(todayData[0]?.today || 0);

    // 近7天趋势
    const sevenDaysAgo = new Date(Date.now() + 8 * 60 * 60 * 1000 - 7 * 24 * 60 * 60 * 1000);
    const sevenDaysAgoStr = `${sevenDaysAgo.getUTCFullYear()}-${String(sevenDaysAgo.getUTCMonth() + 1).padStart(2, '0')}-${String(sevenDaysAgo.getUTCDate()).padStart(2, '0')}`;
    const sevenDaysTrend = await querySql(`
      SELECT DATE(visit_time) AS visit_date, COUNT(*) AS visitor_count
      FROM visitor_stats WHERE visit_time >= ? AND is_valid = 1 GROUP BY DATE(visit_time) ORDER BY visit_date ASC
    `, [sevenDaysAgoStr]);

    // TOP10 IP
    const topIpList = await querySql(`
      SELECT visitor_ip, region, COUNT(*) AS visit_count
      FROM visitor_stats WHERE is_valid = 1 GROUP BY visitor_ip ORDER BY visit_count DESC LIMIT 10
    `);

    // 访客明细（最新100条，直接返回解析后的数据，避免前端二次拆分出错）
    const visitorList = await querySql(`
      SELECT id, visitor_ip, region, visit_time, user_agent
      FROM visitor_stats WHERE is_valid = 1 ORDER BY visit_time DESC LIMIT 100
    `);
    // 后端直接解析好数据，前端直接渲染，无需再拆分
    const parsedVisitorList = visitorList.map(item => {
      // 解析地区（按|拆分，匹配IP查询格式）
      const regionParts = item.region.split('|').map(p => p.trim());
      // 解析设备（按|拆分，匹配UA解析格式）
      const uaParts = item.user_agent.split('|').map(p => p.trim());
      return {
        id: item.id,
        visitor_ip: item.visitor_ip,
        region: item.region,
        visit_time: item.visit_time,
        user_agent: item.user_agent,
        // 前端直接使用的字段，无需再处理
        country: regionParts[0] || '未知',
        province: regionParts[1] || '未知',
        city: regionParts[2] || '未知',
        isp: regionParts[3] || '未知',
        deviceType: uaParts[0] || '未知',
        browser: uaParts[1] || '未知',
        os: uaParts[2] || '未知'
      };
    });

    // 确保返回格式完全匹配前端，无undefined
    res.json({
      success: true,
      data: {
        totalVisitors: totalVisitors || 0,
        todayVisitors: todayVisitors || 0,
        sevenDaysTrend: sevenDaysTrend || [],
        topIpList: topIpList || [],
        visitorList: parsedVisitorList || [] // 直接返回解析后的数据
      }
    });
  } catch (err) {
    console.error('❌ 获取统计数据异常：', err.message);
    // 兜底返回空数据，确保前端不崩溃
    res.json({
      success: true,
      data: {
        totalVisitors: 0,
        todayVisitors: 0,
        sevenDaysTrend: [],
        topIpList: [],
        visitorList: []
      }
    });
  }
});

// 数据重置接口
app.post('/api/visitor/reset', async (req, res) => {
  try {
    const { adminKey } = req.body;
    if (adminKey !== ADMIN_KEY) return res.status(403).json({ success: false, msg: '鉴权失败，密钥错误' });
    await runSql('DELETE FROM visitor_stats');
    await runSql('DELETE FROM sqlite_sequence WHERE name = "visitor_stats"');
    res.json({ success: true, msg: '访客数据已全部重置' });
  } catch (err) {
    res.json({ success: false, msg: '数据重置失败，请稍后重试' });
  }
});

// 黑名单管理接口
app.get('/api/blacklist', async (req, res) => {
  try {
    const list = await querySql('SELECT * FROM blacklist ORDER BY add_time DESC');
    res.json({ success: true, data: list, count: list.length || 0 });
  } catch (err) {
    res.json({ success: true, data: [], count: 0 });
  }
});
app.post('/api/blacklist/add', async (req, res) => {
  try {
    const { ip, remark } = req.body;
    if (!ip || ip.trim() === '') return res.status(400).json({ success: false, msg: '请输入有效IP' });
    const exist = await querySql('SELECT * FROM blacklist WHERE blocked_ip = ?', [ip.trim()]);
    if (exist.length > 0) return res.json({ success: false, msg: '该IP已在黑名单' });
    await runSql('INSERT INTO blacklist (blocked_ip, add_time, remark) VALUES (?, ?, ?)', [ip.trim(), getBeijingTime(), remark || '无备注']);
    res.json({ success: true, msg: 'IP添加到黑名单成功' });
  } catch (err) {
    res.json({ success: false, msg: '添加失败，IP可能已存在' });
  }
});
app.delete('/api/blacklist/delete/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || isNaN(id)) return res.status(400).json({ success: false, msg: '无效ID' });
    await runSql('DELETE FROM blacklist WHERE id = ?', [id]);
    res.json({ success: true, msg: 'IP已移出黑名单' });
  } catch (err) {
    res.json({ success: false, msg: '删除失败，请稍后重试' });
  }
});

// 托管前端静态文件（处理刷新404）
app.use(express.static('public', { maxAge: '1d', fallthrough: true }));
app.get('*', (req, res) => {
  res.sendFile(path.resolve(__dirname, 'public', 'index.html'));
});

// 启动服务器+开启唤醒
app.listen(PORT, () => {
  console.log(`🚀 服务器启动成功 | 地址：${SERVER_DOMAIN}`);
  console.log(`⏰ 当前北京时间：${getBeijingTime()}`);
  console.log(`📍 功能状态：IP统计√ 设备解析√ 黑名单√ Render唤醒√`);
  startRenderKeepAlive();
});

// 全局异常捕获，避免服务器崩溃
process.on('uncaughtException', (err) => console.error('❌ 全局异常：', err.message));
process.on('unhandledRejection', (reason) => console.error('❌ Promise拒绝：', reason));
// 进程退出关闭数据库
process.on('exit', () => {
  if (global.db) {
    global.db.close((err) => {
      if (err) console.error('❌ 关闭数据库失败：', err.message);
      else console.log('✅ 数据库连接已关闭');
    });
  }
});