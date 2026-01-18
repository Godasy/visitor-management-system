require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type', 'x-forwarded-for']
}));
app.use(express.json());

// ===== SQLite3 数据库配置 =====
const dbPath = path.resolve(__dirname, 'visitor.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('❌ SQLite3连接失败：', err.message);
  } else {
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

// ！！！核心修复：IP地区查询函数（双接口容错，国内IP更精准）
async function getIpRegion(ip) {
  // 过滤本地/内网IP，直接返回
  const localIps = [
    '127.0.0.1', '::1', '::ffff:127.0.0.1',
    /^192\.168\./, /^10\./, /^172\.1[6-9]\./, /^172\.2[0-9]\./, /^172\.3[0-1]\./
  ];
  for (const pattern of localIps) {
    if (typeof pattern === 'string' && ip === pattern) return '本地网络';
    if (pattern instanceof RegExp && pattern.test(ip)) return '内网IP';
  }

  // 方案1：淘宝IP接口（国内IP优先，更精准）
  try {
    const response = await fetch(`http://ip.taobao.com/outGetIpInfo?ip=${ip}&accessKey=alibaba-inc`);
    const data = await response.json();
    if (data.code === 0 && data.data) {
      const { country, region, city } = data.data;
      return `${country || ''} ${region || ''} ${city || ''}`.trim() || '未知地区';
    }
  } catch (err) {
    console.log(`淘宝接口查询失败(${ip})，切换备用接口：`, err.message);
  }

  // 方案2：ipinfo.io（国际接口，备用）
  try {
    const response = await fetch(`https://ipinfo.io/${ip}/json`);
    const data = await response.json();
    if (data.country && data.region) {
      return `${data.country} - ${data.region}`;
    }
  } catch (err) {
    console.log(`ipinfo接口查询失败(${ip})：`, err.message);
  }

  // 所有接口都失败
  return '未知地区';
}

// ！！！北京时间工具函数
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

function getBeijingDate() {
  return getBeijingTime().split(' ')[0];
}

// ===== 初始化数据表 =====
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

  db.run(createVisitorTable, (err) => {
    if (err) console.error('❌ 访客表创建失败：', err.message);
    else console.log('✅ 访客表初始化成功');
  });

  db.run(createBlacklistTable, (err) => {
    if (err) console.error('❌ 黑名单表创建失败：', err.message);
    else console.log('✅ 黑名单表初始化成功');
  });
}

// ===== 接口1：记录访客访问 =====
app.get('/api/visitor/record', async (req, res) => {
  try {
    let visitorIp = req.headers['x-forwarded-for']?.split(',').map(ip => ip.trim())[0] 
                  || req.connection.remoteAddress 
                  || req.socket.remoteAddress;

    // 处理IPv6转IPv4
    if (visitorIp && visitorIp.startsWith('::ffff:')) {
      visitorIp = visitorIp.replace('::ffff:', '');
    }

    // 本地IP处理
    if (!visitorIp || visitorIp === '::1' || visitorIp === '127.0.0.1') {
      visitorIp = '127.0.0.1';
    }

    // 检查黑名单
    const blacklist = await querySql('SELECT * FROM blacklist WHERE blocked_ip = ?', [visitorIp]);
    if (blacklist.length > 0) {
      return res.json({ success: false, msg: '您的IP已被拦截', isBlocked: true });
    }

    // 查询地区 + 生成北京时间
    const region = await getIpRegion(visitorIp);
    const userAgent = req.headers['user-agent'] || '未知设备';
    const beijingTime = getBeijingTime();

    // 写入数据库
    await runSql(
      'INSERT INTO visitor_stats (visitor_ip, region, visit_time, user_agent) VALUES (?, ?, ?, ?)',
      [visitorIp, region, beijingTime, userAgent]
    );

    res.json({
      success: true,
      msg: '访问记录成功',
      isBlocked: false,
      visitorIp,
      region,
      visitTime: beijingTime
    });
  } catch (err) {
    console.error('❌ 记录访客失败：', err.message);
    res.status(500).json({ success: false, msg: '服务器内部错误', error: err.message });
  }
});

// ===== 接口2：获取访客统计数据 =====
app.get('/api/visitor/stats', async (req, res) => {
  try {
    const total = await querySql('SELECT COUNT(*) AS total FROM visitor_stats WHERE is_valid = 1');
    const totalVisitors = parseInt(total[0].total || 0);

    const today = getBeijingDate();
    const todayData = await querySql(
      "SELECT COUNT(*) AS today FROM visitor_stats WHERE DATE(visit_time) = ? AND is_valid = 1",
      [today]
    );
    const todayVisitors = parseInt(todayData[0].today || 0);

    const sevenDaysAgo = new Date(Date.now() + 8 * 60 * 60 * 1000 - 7 * 24 * 60 * 60 * 1000);
    const sevenDaysAgoStr = `${sevenDaysAgo.getUTCFullYear()}-${String(sevenDaysAgo.getUTCMonth() + 1).padStart(2, '0')}-${String(sevenDaysAgo.getUTCDate()).padStart(2, '0')}`;
    
    const sevenDays = await querySql(`
      SELECT DATE(visit_time) AS visit_date, COUNT(*) AS visitor_count
      FROM visitor_stats
      WHERE visit_time >= ? AND is_valid = 1
      GROUP BY DATE(visit_time)
      ORDER BY visit_date ASC
    `, [sevenDaysAgoStr]);

    const topIp = await querySql(`
      SELECT visitor_ip, region, COUNT(*) AS visit_count
      FROM visitor_stats
      WHERE is_valid = 1
      GROUP BY visitor_ip
      ORDER BY visit_count DESC
      LIMIT 10
    `);

    const visitorList = await querySql(`
      SELECT id, visitor_ip, region, visit_time, user_agent
      FROM visitor_stats
      WHERE is_valid = 1
      ORDER BY visit_time DESC
      LIMIT 100
    `);

    res.json({
      success: true,
      data: {
        totalVisitors,
        todayVisitors,
        sevenDaysTrend: sevenDays,
        topIpList: topIp,
        visitorList: visitorList
      }
    });
  } catch (err) {
    console.error('❌ 获取统计数据失败：', err.message);
    res.status(500).json({ success: false, msg: '获取数据失败', error: err.message });
  }
});

// ===== 接口3：重置访客数据 =====
app.post('/api/visitor/reset', async (req, res) => {
  try {
    const { adminKey } = req.body;
    if (adminKey !== process.env.ADMIN_KEY) {
      return res.status(403).json({ success: false, msg: '鉴权失败，密钥错误' });
    }

    await runSql('DELETE FROM visitor_stats');
    await runSql('DELETE FROM sqlite_sequence WHERE name = "visitor_stats"');
    res.json({ success: true, msg: '访客数据已全部重置' });
  } catch (err) {
    res.status(500).json({ success: false, msg: '重置失败' });
  }
});

// ===== 接口4-6：黑名单管理 =====
app.get('/api/blacklist', async (req, res) => {
  try {
    const list = await querySql('SELECT * FROM blacklist ORDER BY add_time DESC');
    res.json({ success: true, data: list });
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

    const beijingTime = getBeijingTime();
    await runSql(
      'INSERT INTO blacklist (blocked_ip, add_time, remark) VALUES (?, ?, ?)',
      [ip, beijingTime, remark || '无备注']
    );
    res.json({ success: true, msg: 'IP添加到黑名单成功' });
  } catch (err) {
    res.status(500).json({ success: false, msg: '添加黑名单失败' });
  }
});

app.delete('/api/blacklist/delete/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await runSql('DELETE FROM blacklist WHERE id = ?', [id]);
    res.json({ success: true, msg: 'IP已移出黑名单' });
  } catch (err) {
    res.status(500).json({ success: false, msg: '删除黑名单IP失败' });
  }
});

// ===== 托管前端静态文件 =====
app.use(express.static('public'));

// ===== 启动服务器 =====
app.listen(PORT, () => {
  console.log(`🚀 服务器运行在 http://localhost:${PORT}`);
  console.log(`⏰ 当前北京时间：${getBeijingTime()}`);
});

// 进程退出时关闭数据库
process.on('exit', () => {
  db.close((err) => {
    if (err) console.error('❌ 关闭数据库失败：', err.message);
    else console.log('✅ 数据库连接已关闭');
  });
});