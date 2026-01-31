require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const fetch = require('node-fetch');
const schedule = require('node-schedule'); // 定时任务（Render唤醒）
const useragent = require('useragent');     // 精准解析UA（设备/浏览器/系统）

const app = express();
const PORT = process.env.PORT || 3000;
// 配置项
const RENDER_KEEP_ALIVE = process.env.RENDER_KEEP_ALIVE === 'true';
const SERVER_DOMAIN = process.env.SERVER_DOMAIN || `http://localhost:${PORT}`;
const KEEP_ALIVE_INTERVAL = parseInt(process.env.KEEP_ALIVE_INTERVAL) || 14;

// 跨域配置
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type', 'x-forwarded-for']
}));
app.use(express.json());
// 预解析UA
app.use((req, res, next) => {
  req.userAgentParsed = useragent.parse(req.headers['user-agent'] || '');
  next();
});

// ===== SQLite3 数据库配置（无需修改表结构，兼容原有数据）=====
const dbPath = path.resolve(__dirname, 'visitor.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) console.error('❌ SQLite3连接失败：', err.message);
  else {
    console.log(`✅ SQLite3连接成功（文件：${dbPath}）`);
    initDatabaseTables();
  }
});

// ===== 工具函数 =====
// Promise封装SQLite3查询
function querySql(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
  });
}
// Promise封装SQLite3执行
function runSql(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
}

// ！！！核心1：北京时间工具函数（保留，确保时间准确）
function getBeijingTime() {
  const now = new Date();
  const beijingTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const year = beijingTime.getUTCFullYear();
  const month = String(beijingTime.getUTCMonth() + 1).padStart(2, '0');
  const day = String(beijingTime.getUTCDate()).padStart(2, '0');
  const hours = String(beijingTime.getUTCHours()).padStart(2, '0');
  const minutes = String(beijingTime.getUTCMinutes()).padStart(2, '0');
  const seconds = String(beijingTime.getUTCSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}
function getBeijingDate() { return getBeijingTime().split(' ')[0]; }

// ！！！核心2：稳定IP查询+最大化提取地区/运营商信息（双接口：ip.sb主+ipapi.co备）
async function getIpFullInfo(ip) {
  // 第一步：过滤本地/内网/无效IP，直接返回标识
  const invalidIpPatterns = [
    '127.0.0.1', '::1', '::ffff:127.0.0.1',
    /^192\.168\.\d{1,3}\.\d{1,3}$/, /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
    /^172\.(1[6-9]|2[0-9]|3[0-1])\.\d{1,3}\.\d{1,3}$/, /^169\.254\.\d{1,3}\.\d{1,3}$/
  ];
  for (const pattern of invalidIpPatterns) {
    if (typeof pattern === 'string' && ip === pattern) return { region: '本地网络', isp: '本地网络' };
    if (pattern instanceof RegExp && pattern.test(ip)) return { region: '内网IP', isp: '内网IP' };
  }

  // 第二步：处理IPv6，提取有效IPv4（避免查询失败）
  let queryIp = ip;
  if (queryIp && queryIp.startsWith('::ffff:')) queryIp = queryIp.replace('::ffff:', '');

  // 第三步：主接口 - ip.sb（稳定无限制，返回信息最全：国家/省/市/运营商/经纬度/时区）
  try {
    const res = await fetch(`https://api.ip.sb/geoip/${queryIp}`, { timeout: 5000 });
    const data = await res.json();
    if (data.ip) {
      const country = data.country || '未知国家';
      const region = data.region || data.state || '未知省份';
      const city = data.city || '未知城市';
      const isp = data.isp || data.org || '未知运营商';
      // 格式化完整地区（国家 省份 城市 运营商），用于存储和展示
      const fullRegion = [country, region, city, isp].filter(Boolean).join(' ');
      return {
        region: fullRegion, // 核心地区字段（兼容原有数据库）
        isp,
        country,
        province: region,
        city,
        lat: data.latitude || '0',
        lng: data.longitude || '0',
        timezone: data.timezone || '未知时区'
      };
    }
  } catch (err) {
    console.log(`📌 ip.sb查询失败（IP：${queryIp}），切换备用接口：`, err.message.slice(0, 50));
  }

  // 第四步：备用接口 - ipapi.co（国际稳定，补充查询）
  try {
    const res = await fetch(`https://ipapi.co/${queryIp}/json/`, { timeout: 5000 });
    const data = await res.json();
    if (data.ip) {
      const country = data.country_name || '未知国家';
      const region = data.region || '未知省份';
      const city = data.city || '未知城市';
      const isp = data.org || '未知运营商';
      const fullRegion = [country, region, city, isp].filter(Boolean).join(' ');
      return {
        region: fullRegion,
        isp,
        country,
        province: region,
        city,
        lat: data.latitude || '0',
        lng: data.longitude || '0',
        timezone: data.timezone || '未知时区'
      };
    }
  } catch (err) {
    console.log(`📌 ipapi.co查询失败（IP：${queryIp}）：`, err.message.slice(0, 50));
  }

  // 所有接口失败，返回默认值
  return { region: '未知地区', isp: '未知运营商', country: '未知', province: '未知', city: '未知' };
}

// ！！！核心3：解析UA，最大化提取设备信息（设备类型/浏览器/系统/版本）
function parseUaFullInfo(uaParsed) {
  const deviceType = uaParsed.device.family === 'Other' 
    ? (uaParsed.os.family.includes('Android') || uaParsed.os.family.includes('iOS') ? '手机' : '电脑')
    : uaParsed.device.family === 'iPad' ? '平板' : uaParsed.device.family || '未知设备';
  const browser = `${uaParsed.family} ${uaParsed.major || ''}`.trim() || '未知浏览器';
  const os = `${uaParsed.os.family} ${uaParsed.os.major || ''}.${uaParsed.os.minor || ''}`.trim() || '未知系统';
  const engine = uaParsed.engine.family || '未知内核';
  // 格式化设备信息（兼容原有数据库，同时返回详细信息）
  const fullUa = `${deviceType} | ${browser} | ${os}`;
  return {
    fullUa, // 核心UA字段（存储到数据库）
    deviceType,
    browser,
    os,
    engine,
    deviceModel: uaParsed.device.model || '未知型号'
  };
}

// ！！！核心4：Render自动唤醒功能（定时自请求，避免休眠）
function startRenderKeepAlive() {
  if (!RENDER_KEEP_ALIVE) {
    console.log('📌 Render自动唤醒已关闭（可在.env中设置RENDER_KEEP_ALIVE=true开启）');
    return;
  }
  // 定时任务：每X分钟请求一次自身健康检查接口（避开15分钟休眠阈值）
  const rule = new schedule.RecurrenceRule();
  rule.minute = new schedule.Range(0, 59, KEEP_ALIVE_INTERVAL);
  schedule.scheduleJob(rule, async () => {
    try {
      const res = await fetch(`${SERVER_DOMAIN}/api/health`, { timeout: 10000 });
      const data = await res.json();
      console.log(`⏰ Render自动唤醒请求成功 | 时间：${getBeijingTime()} | 状态：${data.status}`);
    } catch (err) {
      console.error(`⏰ Render自动唤醒请求失败 | 时间：${getBeijingTime()} | 错误：`, err.message.slice(0, 50));
    }
  });
  console.log(`✅ Render自动唤醒已开启 | 间隔：${KEEP_ALIVE_INTERVAL}分钟 | 请求地址：${SERVER_DOMAIN}/api/health`);
}

// ===== 初始化数据表（保留原有结构，无需修改）=====
function initDatabaseTables() {
  const createVisitorTable = `
    CREATE TABLE IF NOT EXISTS visitor_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      visitor_ip TEXT NOT NULL,
      region TEXT DEFAULT '未知地区',
      visit_time TEXT NOT NULL,
      user_agent TEXT DEFAULT '未知设备',
      is_valid BOOLEAN DEFAULT 1
    );
  `;
  const createBlacklistTable = `
    CREATE TABLE IF NOT EXISTS blacklist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      blocked_ip TEXT NOT NULL UNIQUE,
      add_time TEXT NOT NULL,
      remark TEXT DEFAULT '无备注'
    );
  `;
  db.run(createVisitorTable, (err) => err ? console.error('❌ 访客表创建失败：', err.message) : console.log('✅ 访客表初始化成功'));
  db.run(createBlacklistTable, (err) => err ? console.error('❌ 黑名单表创建失败：', err.message) : console.log('✅ 黑名单表初始化成功'));
}

// ===== 接口：健康检查（供Render自动唤醒调用）=====
app.get('/api/health', (req, res) => {
  res.json({
    status: 'online',
    time: getBeijingTime(),
    server: 'visitor-management-system',
    message: '服务器正常运行'
  });
});

// ===== 接口1：记录访客（存储最大化信息，北京时间）=====
app.get('/api/visitor/record', async (req, res) => {
  try {
    // 获取真实IP
    let visitorIp = req.headers['x-forwarded-for']?.split(',').map(ip => ip.trim())[0] 
                  || req.connection.remoteAddress 
                  || req.socket.remoteAddress;
    visitorIp = visitorIp || '127.0.0.1';

    // 检查黑名单
    const blacklist = await querySql('SELECT * FROM blacklist WHERE blocked_ip = ?', [visitorIp]);
    if (blacklist.length > 0) return res.json({ success: false, msg: '您的IP已被拦截', isBlocked: true });

    // 最大化获取访客信息
    const ipInfo = await getIpFullInfo(visitorIp); // IP/地区/运营商/经纬度
    const uaInfo = parseUaFullInfo(req.userAgentParsed); // 设备/浏览器/系统
    const beijingTime = getBeijingTime(); // 北京时间

    // 写入数据库（兼容原有结构，存储核心字段）
    await runSql(
      'INSERT INTO visitor_stats (visitor_ip, region, visit_time, user_agent) VALUES (?, ?, ?, ?)',
      [visitorIp, ipInfo.region, beijingTime, uaInfo.fullUa]
    );

    // 返回完整信息（供前端调试/展示）
    res.json({
      success: true, msg: '访问记录成功', isBlocked: false,
      visitorIp, beijingTime,
      ...ipInfo, ...uaInfo // 展开所有详细信息
    });
  } catch (err) {
    console.error('❌ 记录访客失败：', err.message);
    res.status(500).json({ success: false, msg: '服务器内部错误' });
  }
});

// ===== 接口2：获取访客统计（返回最大化信息，供前端展示）=====
app.get('/api/visitor/stats', async (req, res) => {
  try {
    // 基础统计
    const total = await querySql('SELECT COUNT(*) AS total FROM visitor_stats WHERE is_valid = 1');
    const today = getBeijingDate();
    const todayData = await querySql("SELECT COUNT(*) AS today FROM visitor_stats WHERE DATE(visit_time) = ? AND is_valid = 1", [today]);
    const sevenDaysAgo = new Date(Date.now() + 8 * 60 * 60 * 1000 - 7 * 24 * 60 * 60 * 1000);
    const sevenDaysAgoStr = `${sevenDaysAgo.getUTCFullYear()}-${String(sevenDaysAgo.getUTCMonth() + 1).padStart(2, '0')}-${String(sevenDaysAgo.getUTCDate()).padStart(2, '0')}`;
    
    // 近7天趋势
    const sevenDays = await querySql(`
      SELECT DATE(visit_time) AS visit_date, COUNT(*) AS visitor_count
      FROM visitor_stats WHERE visit_time >= ? AND is_valid = 1 GROUP BY DATE(visit_time) ORDER BY visit_date ASC
    `, [sevenDaysAgoStr]);

    // TOP10 IP（含详细地区）
    const topIp = await querySql(`
      SELECT visitor_ip, region, COUNT(*) AS visit_count
      FROM visitor_stats WHERE is_valid = 1 GROUP BY visitor_ip ORDER BY visit_count DESC LIMIT 10
    `);

    // 访客明细（最新100条，含完整信息）
    const visitorList = await querySql(`
      SELECT id, visitor_ip, region, visit_time, user_agent
      FROM visitor_stats WHERE is_valid = 1 ORDER BY visit_time DESC LIMIT 100
    `);
    // 对明细数据补充分解后的详细信息（供前端展示）
    const visitorListWithFullInfo = visitorList.map(item => {
      // 从region拆分基础地区信息
      const regionParts = item.region.split(' ');
      // 从user_agent拆分设备信息
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

    res.json({
      success: true,
      data: {
        totalVisitors: parseInt(total[0].total || 0),
        todayVisitors: parseInt(todayData[0].today || 0),
        sevenDaysTrend: sevenDays,
        topIpList: topIp,
        visitorList: visitorListWithFullInfo // 含详细信息的明细
      }
    });
  } catch (err) {
    console.error('❌ 获取统计数据失败：', err.message);
    res.status(500).json({ success: false, msg: '获取数据失败' });
  }
});

// ===== 原有接口：重置数据/黑名单管理（全部保留，无修改）=====
app.post('/api/visitor/reset', async (req, res) => {
  try {
    const { adminKey } = req.body;
    if (adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ success: false, msg: '鉴权失败' });
    await runSql('DELETE FROM visitor_stats');
    await runSql('DELETE FROM sqlite_sequence WHERE name = "visitor_stats"');
    res.json({ success: true, msg: '访客数据已全部重置' });
  } catch (err) {
    res.status(500).json({ success: false, msg: '重置失败' });
  }
});
app.get('/api/blacklist', async (req, res) => {
  try {
    const list = await querySql('SELECT * FROM blacklist ORDER BY add_time DESC');
    res.json({ success: true, data: list, count: list.length });
  } catch (err) {
    res.status(500).json({ success: false, msg: '获取黑名单失败' });
  }
});
app.post('/api/blacklist/add', async (req, res) => {
  try {
    const { ip, remark } = req.body;
    if (!ip) return res.status(400).json({ success: false, msg: '请输入IP地址' });
    const exist = await querySql('SELECT * FROM blacklist WHERE blocked_ip = ?', [ip]);
    if (exist.length > 0) return res.json({ success: false, msg: '该IP已在黑名单' });
    await runSql('INSERT INTO blacklist (blocked_ip, add_time, remark) VALUES (?, ?, ?)', [ip, getBeijingTime(), remark || '无备注']);
    res.json({ success: true, msg: 'IP添加到黑名单成功' });
  } catch (err) {
    res.status(500).json({ success: false, msg: '添加黑名单失败' });
  }
});
app.delete('/api/blacklist/delete/:id', async (req, res) => {
  try {
    await runSql('DELETE FROM blacklist WHERE id = ?', [req.params.id]);
    res.json({ success: true, msg: 'IP已移出黑名单' });
  } catch (err) {
    res.status(500).json({ success: false, msg: '删除黑名单IP失败' });
  }
});

// ===== 托管前端静态文件 =====
app.use(express.static('public'));

// ===== 启动服务器 + 开启Render自动唤醒 =====
app.listen(PORT, () => {
  console.log(`🚀 服务器运行在 ${SERVER_DOMAIN}`);
  console.log(`⏰ 当前北京时间：${getBeijingTime()}`);
  console.log(`📍 IP查询接口：ip.sb（主）+ ipapi.co（备）`);
  console.log(`📱 访客信息：IP/地区/运营商/设备/浏览器/系统/经纬度`);
  startRenderKeepAlive(); // 启动自动唤醒
});

// 进程退出时关闭数据库
process.on('exit', () => {
  db.close((err) => {
    if (err) console.error('❌ 关闭数据库失败：', err.message);
    else console.log('✅ 数据库连接已关闭');
  });
});