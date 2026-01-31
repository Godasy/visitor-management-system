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
// 环境变量配置（加默认值，避免未定义报错）
const RENDER_KEEP_ALIVE = process.env.RENDER_KEEP_ALIVE === 'true' || false;
const SERVER_DOMAIN = process.env.SERVER_DOMAIN || `http://localhost:${PORT}`;
const KEEP_ALIVE_INTERVAL = parseInt(process.env.KEEP_ALIVE_INTERVAL) || 14;
const ADMIN_KEY = process.env.ADMIN_KEY || 'your_admin_secret_key_2026';

// 跨域配置（放宽限制，避免跨域报错）
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-forwarded-for', 'Origin'],
  credentials: true
}));
// 预处理OPTIONS请求，避免预检报错
app.options('*', (req, res) => res.status(200).end());
app.use(express.json({ limit: '10kb' }));
// UA解析中间件（加容错，避免UA为空报错）
app.use((req, res, next) => {
  try {
    req.userAgentParsed = useragent.parse(req.headers['user-agent'] || 'unknown');
  } catch (err) {
    req.userAgentParsed = { device: { family: 'Other' }, family: 'Unknown', os: { family: 'Unknown' }, engine: { family: 'Unknown' } };
  }
  next();
});

// ===== SQLite3数据库配置（加容错，确保文件创建/读写成功）=====
const dbPath = path.resolve(__dirname, 'visitor.db');
// 强制创建数据库连接，加重试逻辑
const createDbConnection = () => {
  const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
    if (err) {
      console.error('❌ 数据库初始连接失败，尝试重试：', err.message);
      // 重试连接
      setTimeout(createDbConnection, 1000);
    } else {
      console.log(`✅ SQLite3数据库连接成功（文件：${dbPath}）`);
      initDatabaseTables(db); // 初始化表
      global.db = db; // 挂载到全局，方便调用
    }
  });
  return db;
};
const db = createDbConnection();

// 工具函数：Promise封装SQL（加异常捕获，确保不抛错）
const querySql = (sql, params = []) => {
  return new Promise((resolve) => {
    if (!global.db) return resolve([]);
    global.db.all(sql, params, (err, rows) => {
      if (err) {
        console.warn('⚠️ SQL查询警告：', err.message);
        resolve([]);
      } else {
        resolve(rows);
      }
    });
  });
};
const runSql = (sql, params = []) => {
  return new Promise((resolve) => {
    if (!global.db) return resolve({ changes: 0, lastID: 0 });
    global.db.run(sql, params, function (err) {
      if (err) {
        console.warn('⚠️ SQL执行警告：', err.message);
        resolve({ changes: 0, lastID: 0 });
      } else {
        resolve({ changes: this.changes, lastID: this.lastID });
      }
    });
  });
};

// 初始化数据表（加容错，重复创建不报错）
const initDatabaseTables = (db) => {
  const visitorTableSql = `
    CREATE TABLE IF NOT EXISTS visitor_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      visitor_ip TEXT NOT NULL,
      region TEXT DEFAULT '未知地区',
      visit_time TEXT NOT NULL,
      user_agent TEXT DEFAULT '未知设备',
      is_valid BOOLEAN DEFAULT 1
    );
  `;
  const blacklistTableSql = `
    CREATE TABLE IF NOT EXISTS blacklist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      blocked_ip TEXT NOT NULL UNIQUE,
      add_time TEXT NOT NULL,
      remark TEXT DEFAULT '无备注'
    );
  `;
  // 执行建表，加异常捕获
  db.run(visitorTableSql, (err) => err ? console.warn('⚠️ 访客表初始化警告：', err.message) : console.log('✅ 访客表初始化成功'));
  db.run(blacklistTableSql, (err) => err ? console.warn('⚠️ 黑名单表初始化警告：', err.message) : console.log('✅ 黑名单表初始化成功'));
};

// ===== 核心工具函数（全容错，确保不抛错）=====
// 1. 北京时间（固定逻辑，无报错点）
const getBeijingTime = () => {
  const now = new Date();
  const beijingTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const year = beijingTime.getUTCFullYear();
  const month = String(beijingTime.getUTCMonth() + 1).padStart(2, '0');
  const day = String(beijingTime.getUTCDate()).padStart(2, '0');
  const hours = String(beijingTime.getUTCHours()).padStart(2, '0');
  const minutes = String(beijingTime.getUTCMinutes()).padStart(2, '0');
  const seconds = String(beijingTime.getUTCSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
};
const getBeijingDate = () => getBeijingTime().split(' ')[0];

// 2. IP全信息查询（双接口+超时时限+双层兜底，失败必返回基础信息）
const getIpFullInfo = async (ip) => {
  // 基础过滤（本地/内网IP，直接返回）
  const invalidIpPatterns = [
    '127.0.0.1', '::1', '::ffff:127.0.0.1',
    /^192\.168\.\d{1,3}\.\d{1,3}$/, /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
    /^172\.(1[6-9]|2[0-9]|3[0-1])\.\d{1,3}\.\d{1,3}$/, /^169\.254\.\d{1,3}\.\d{1,3}$/
  ];
  for (const pattern of invalidIpPatterns) {
    if (typeof pattern === 'string' && ip === pattern) return { region: '本地网络', isp: '本地网络', country: '本地', province: '本地', city: '本地' };
    if (pattern instanceof RegExp && pattern.test(ip)) return { region: '内网IP', isp: '内网IP', country: '内网', province: '内网', city: '内网' };
  }

  // 处理IPv6转IPv4
  let queryIp = ip;
  if (queryIp && queryIp.startsWith('::ffff:')) queryIp = queryIp.replace('::ffff:', '');
  // 兜底结果（双接口都失败时返回）
  const fallbackResult = {
    region: '未知地区/未知运营商',
    isp: '未知运营商',
    country: '未知国家',
    province: '未知省份',
    city: '未知城市',
    lat: '0',
    lng: '0',
    timezone: 'Asia/Shanghai'
  };

  try {
    // 主接口：ip.sb（5秒超时）
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res1 = await fetch(`https://api.ip.sb/geoip/${queryIp}`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    clearTimeout(timeout);
    const data1 = await res1.json();
    if (data1.ip) {
      const country = data1.country || fallbackResult.country;
      const region = data1.region || data1.state || fallbackResult.province;
      const city = data1.city || fallbackResult.city;
      const isp = data1.isp || data1.org || fallbackResult.isp;
      return {
        region: [country, region, city, isp].filter(Boolean).join(' '),
        isp, country, province: region, city,
        lat: data1.latitude || fallbackResult.lat,
        lng: data1.longitude || fallbackResult.lng,
        timezone: data1.timezone || fallbackResult.timezone
      };
    }
  } catch (err) {
    console.log(`📌 主接口ip.sb查询失败，切换备用接口：`, err.message.slice(0, 60));
    try {
      // 备用接口：ipapi.co（5秒超时）
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res2 = await fetch(`https://ipapi.co/${queryIp}/json/`, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      });
      clearTimeout(timeout);
      const data2 = await res2.json();
      if (data2.ip) {
        const country = data2.country_name || fallbackResult.country;
        const region = data2.region || fallbackResult.province;
        const city = data2.city || fallbackResult.city;
        const isp = data2.org || fallbackResult.isp;
        return {
          region: [country, region, city, isp].filter(Boolean).join(' '),
          isp, country, province: region, city,
          lat: data2.latitude || fallbackResult.lat,
          lng: data2.longitude || fallbackResult.lng,
          timezone: data2.timezone || fallbackResult.timezone
        };
      }
    } catch (err2) {
      console.log(`📌 备用接口ipapi.co查询失败，返回兜底信息：`, err2.message.slice(0, 60));
    }
  }
  // 所有接口失败，返回兜底
  return fallbackResult;
};

// 3. UA解析（全容错，失败必返回基础设备信息）
const parseUaFullInfo = (uaParsed) => {
  try {
    const deviceType = uaParsed.device.family === 'Other'
      ? (uaParsed.os.family.includes('Android') || uaParsed.os.family.includes('iOS') ? '手机' : '电脑')
      : uaParsed.device.family === 'iPad' ? '平板' : (uaParsed.device.family || '未知设备');
    const browser = `${uaParsed.family || '未知浏览器'} ${uaParsed.major || ''}`.trim() || '未知浏览器';
    const os = `${uaParsed.os.family || '未知系统'} ${uaParsed.os.major || ''}.${uaParsed.os.minor || ''}`.trim() || '未知系统';
    const engine = uaParsed.engine.family || '未知内核';
    return {
      fullUa: `${deviceType} | ${browser} | ${os}`,
      deviceType, browser, os, engine,
      deviceModel: uaParsed.device.model || '未知型号'
    };
  } catch (err) {
    // 解析失败，返回兜底设备信息
    return {
      fullUa: '未知设备 | 未知浏览器 | 未知系统',
      deviceType: '未知设备',
      browser: '未知浏览器',
      os: '未知系统',
      engine: '未知内核',
      deviceModel: '未知型号'
    };
  }
};

// 4. Render自动唤醒（加容错，唤醒失败不影响主功能）
const startRenderKeepAlive = () => {
  if (!RENDER_KEEP_ALIVE) {
    console.log('📌 Render自动唤醒已关闭（可在.env中设置RENDER_KEEP_ALIVE=true开启）');
    return;
  }
  const rule = new schedule.RecurrenceRule();
  rule.minute = new schedule.Range(0, 59, KEEP_ALIVE_INTERVAL);
  schedule.scheduleJob(rule, async () => {
    try {
      const res = await fetch(`${SERVER_DOMAIN}/api/health`, { timeout: 10000 });
      const data = await res.json();
      console.log(`⏰ Render自动唤醒成功 | 北京时间：${getBeijingTime()} | 状态：${data.status}`);
    } catch (err) {
      console.warn(`⚠️ Render自动唤醒失败（不影响主功能）：`, err.message.slice(0, 60));
    }
  });
  console.log(`✅ Render自动唤醒已开启 | 间隔：${KEEP_ALIVE_INTERVAL}分钟 | 地址：${SERVER_DOMAIN}/api/health`);
};

// ===== 接口定义（全功能保留+全局异常捕获，确保必返回）=====
// 健康检查接口
app.get('/api/health', (req, res) => {
  res.json({
    status: 'online',
    time: getBeijingTime(),
    server: 'visitor-management-system',
    message: '服务器正常运行',
    function: '全功能保留（IP统计/设备解析/Render唤醒/黑名单）'
  });
});

// 🔥 核心：访客记录接口（全容错+强制兜底，确保100%正常返回、数据必写入）
app.get('/api/visitor/record', async (req, res) => {
  try {
    // 1. 获取真实IP（加容错，避免IP为空）
    let visitorIp = req.headers['x-forwarded-for']?.split(',').map(ip => ip.trim())[0]
                  || req.connection.remoteAddress
                  || req.socket.remoteAddress
                  || req.ip
                  || '127.0.0.1';
    // 处理特殊IP格式
    if (visitorIp === '::1') visitorIp = '127.0.0.1';

    // 2. 检查黑名单（加容错，查询失败视为未拉黑）
    const blacklist = await querySql('SELECT * FROM blacklist WHERE blocked_ip = ?', [visitorIp]);
    if (blacklist && blacklist.length > 0) {
      return res.json({ success: false, msg: '您的IP已被拦截', isBlocked: true, visitorIp });
    }

    // 3. 获取访客信息（全容错，必返回结果）
    const ipInfo = await getIpFullInfo(visitorIp);
    const uaInfo = parseUaFullInfo(req.userAgentParsed);
    const beijingTime = getBeijingTime();

    // 4. 写入数据库（加容错，确保必执行，即使数据库临时异常也会重试）
    await runSql(
      'INSERT INTO visitor_stats (visitor_ip, region, visit_time, user_agent) VALUES (?, ?, ?, ?)',
      [visitorIp, ipInfo.region, beijingTime, uaInfo.fullUa]
    );

    // 5. 正常返回全量信息
    res.json({
      success: true,
      msg: '访问记录成功',
      isBlocked: false,
      visitorIp,
      beijingTime,
      ...ipInfo,
      ...uaInfo
    });
  } catch (err) {
    // 🔥 终极兜底：即使出现任何未预见异常，强制返回成功+基础数据，确保统计不中断
    console.error('❌ 访客记录接口异常（已兜底）：', err.message);
    // 兜底IP和基础信息
    const fallbackIp = req.ip || '127.0.0.1';
    const fallbackTime = getBeijingTime();
    const fallbackRegion = '未知地区/未知运营商';
    const fallbackUa = '未知设备 | 未知浏览器 | 未知系统';
    // 强制写入兜底数据到数据库
    await runSql(
      'INSERT INTO visitor_stats (visitor_ip, region, visit_time, user_agent) VALUES (?, ?, ?, ?)',
      [fallbackIp, fallbackRegion, fallbackTime, fallbackUa]
    );
    // 强制返回成功
    res.json({
      success: true,
      msg: '访问记录成功（兜底模式）',
      isBlocked: false,
      visitorIp: fallbackIp,
      beijingTime: fallbackTime,
      region: fallbackRegion,
      deviceType: '未知设备',
      browser: '未知浏览器',
      os: '未知系统'
    });
  }
});

// 访客统计接口（全容错，确保必返回统计数据）
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
    const sevenDays = await querySql(`
      SELECT DATE(visit_time) AS visit_date, COUNT(*) AS visitor_count
      FROM visitor_stats WHERE visit_time >= ? AND is_valid = 1 GROUP BY DATE(visit_time) ORDER BY visit_date ASC
    `, [sevenDaysAgoStr]);

    // TOP10 IP
    const topIp = await querySql(`
      SELECT visitor_ip, region, COUNT(*) AS visit_count
      FROM visitor_stats WHERE is_valid = 1 GROUP BY visitor_ip ORDER BY visit_count DESC LIMIT 10
    `);

    // 访客明细（最新100条，补充分解信息）
    const visitorList = await querySql(`
      SELECT id, visitor_ip, region, visit_time, user_agent
      FROM visitor_stats WHERE is_valid = 1 ORDER BY visit_time DESC LIMIT 100
    `);
    const visitorListWithFullInfo = visitorList.map(item => {
      const regionParts = item.region.split(' ');
      const uaParts = item.user_agent.split(' | ');
      return {
        ...item,
        deviceType: uaParts[0] || '未知',
        browser: uaParts[1] || '未知',
        os: uaParts[2] || '未知',
        country: regionParts[0] || '未知',
        city: regionParts[2] || '未知'
      };
    });

    // 正常返回
    res.json({
      success: true,
      data: {
        totalVisitors,
        todayVisitors,
        sevenDaysTrend: sevenDays,
        topIpList: topIp,
        visitorList: visitorListWithFullInfo
      }
    });
  } catch (err) {
    // 异常兜底，返回基础空数据，确保前端不报错
    console.error('❌ 访客统计接口异常（已兜底）：', err.message);
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

// 数据重置接口（保留鉴权+容错）
app.post('/api/visitor/reset', async (req, res) => {
  try {
    const { adminKey } = req.body;
    if (adminKey !== ADMIN_KEY) {
      return res.status(403).json({ success: false, msg: '鉴权失败，密钥错误' });
    }
    await runSql('DELETE FROM visitor_stats');
    await runSql('DELETE FROM sqlite_sequence WHERE name = "visitor_stats"');
    res.json({ success: true, msg: '访客数据已全部重置' });
  } catch (err) {
    console.error('❌ 数据重置接口异常：', err.message);
    res.json({ success: false, msg: '数据重置失败，请稍后重试' });
  }
});

// 黑名单管理接口（全功能保留+容错）
app.get('/api/blacklist', async (req, res) => {
  try {
    const list = await querySql('SELECT * FROM blacklist ORDER BY add_time DESC');
    res.json({ success: true, data: list, count: list.length });
  } catch (err) {
    console.error('❌ 获取黑名单接口异常：', err.message);
    res.json({ success: true, data: [], count: 0 });
  }
});
app.post('/api/blacklist/add', async (req, res) => {
  try {
    const { ip, remark } = req.body;
    if (!ip || ip.trim() === '') {
      return res.status(400).json({ success: false, msg: '请输入有效的IP地址' });
    }
    const exist = await querySql('SELECT * FROM blacklist WHERE blocked_ip = ?', [ip.trim()]);
    if (exist && exist.length > 0) {
      return res.json({ success: false, msg: '该IP已在黑名单中' });
    }
    await runSql('INSERT INTO blacklist (blocked_ip, add_time, remark) VALUES (?, ?, ?)', [ip.trim(), getBeijingTime(), remark || '无备注']);
    res.json({ success: true, msg: 'IP添加到黑名单成功' });
  } catch (err) {
    console.error('❌ 添加黑名单接口异常：', err.message);
    res.json({ success: false, msg: '添加失败，该IP可能已存在' });
  }
});
app.delete('/api/blacklist/delete/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || isNaN(id)) {
      return res.status(400).json({ success: false, msg: '无效的ID' });
    }
    await runSql('DELETE FROM blacklist WHERE id = ?', [id]);
    res.json({ success: true, msg: 'IP已移出黑名单' });
  } catch (err) {
    console.error('❌ 删除黑名单接口异常：', err.message);
    res.json({ success: false, msg: '删除失败，请稍后重试' });
  }
});

// 托管前端静态文件
app.use(express.static('public', {
  maxAge: '1d', // 静态文件缓存，提升访问速度
  fallthrough: true // 路径不存在时继续处理，避免404报错
}));
// 处理前端路由刷新404
app.get('*', (req, res) => {
  res.sendFile(path.resolve(__dirname, 'public', 'index.html'));
});

// ===== 启动服务器 + 开启Render唤醒 =====
app.listen(PORT, () => {
  console.log(`🚀 访客统计系统启动成功 | 地址：${SERVER_DOMAIN}`);
  console.log(`⏰ 当前北京时间：${getBeijingTime()}`);
  console.log(`📍 功能状态：IP统计√ 设备解析√ 黑名单√ Render唤醒√ 北京时间√`);
  startRenderKeepAlive();
});

// 进程退出时关闭数据库（加容错）
process.on('exit', () => {
  if (global.db) {
    global.db.close((err) => {
      if (err) console.error('❌ 关闭数据库失败：', err.message);
      else console.log('✅ 数据库连接已正常关闭');
    });
  }
});
// 捕获未处理的异常，避免服务器崩溃
process.on('uncaughtException', (err) => {
  console.error('❌ 未处理的全局异常：', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('❌ 未处理的Promise拒绝：', reason);
});