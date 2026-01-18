require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const fetch = require('node-fetch'); // 用于IP地区查询

const app = express();
const PORT = process.env.PORT || 3000;

// 跨域配置
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

// IP归属地查询（使用ipapi.co免费接口）
async function getIpRegion(ip) {
  // 本地IP不查询
  if (ip === '127.0.0.1' || ip.includes('::')) return '本地网络';
  try {
    const response = await fetch(`https://ipapi.co/${ip}/json/`);
    const data = await response.json();
    if (data.country_name && data.region) {
      return `${data.country_name} - ${data.region}`;
    } else {
      return '未知地区';
    }
  } catch (err) {
    console.error(`❌ IP地区查询失败(${ip})：`, err.message);
    return '未知地区';
  }
}

// ===== 初始化数据表（新增region字段）=====
function initDatabaseTables() {
  // 访客表：新增region字段存储IP地区
  const createVisitorTable = `
    CREATE TABLE IF NOT EXISTS visitor_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      visitor_ip TEXT NOT NULL,
      region TEXT DEFAULT '未知地区', -- 新增：IP归属地
      visit_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      user_agent TEXT DEFAULT '未知设备',
      is_valid BOOLEAN DEFAULT 1
    );
  `;

  // 黑名单表
  const createBlacklistTable = `
    CREATE TABLE IF NOT EXISTS blacklist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      blocked_ip TEXT NOT NULL UNIQUE,
      add_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      remark TEXT DEFAULT '无备注'
    );
  `;

  db.run(createVisitorTable, (err) => {
    if (err) console.error('❌ 访客表创建失败：', err.message);
    else console.log('✅ 访客表初始化成功（含地区字段）');
  });

  db.run(createBlacklistTable, (err) => {
    if (err) console.error('❌ 黑名单表创建失败：', err.message);
    else console.log('✅ 黑名单表初始化成功');
  });
}

// ===== 接口1：记录访客访问（新增地区查询）=====
app.get('/api/visitor/record', async (req, res) => {
  try {
    // 获取真实IP
    let visitorIp = req.headers['x-forwarded-for']?.split(',').map(ip => ip.trim())[0] 
                  || req.connection.remoteAddress 
                  || req.socket.remoteAddress;

    // 本地IP处理
    if (!visitorIp || visitorIp === '::1' || visitorIp === '127.0.0.1') {
      visitorIp = '127.0.0.1';
    }

    // 检查黑名单
    const blacklist = await querySql('SELECT * FROM blacklist WHERE blocked_ip = ?', [visitorIp]);
    if (blacklist.length > 0) {
      return res.json({ success: false, msg: '您的IP已被拦截', isBlocked: true });
    }

    // 查询IP地区
    const region = await getIpRegion(visitorIp);
    const userAgent = req.headers['user-agent'] || '未知设备';

    // 写入数据库（含地区）
    await runSql(
      'INSERT INTO visitor_stats (visitor_ip, region, user_agent) VALUES (?, ?, ?)',
      [visitorIp, region, userAgent]
    );

    res.json({
      success: true,
      msg: '访问记录成功',
      isBlocked: false,
      visitorIp,
      region
    });
  } catch (err) {
    console.error('❌ 记录访客失败：', err.message);
    res.status(500).json({ success: false, msg: '服务器内部错误', error: err.message });
  }
});

// ===== 接口2：获取访客统计数据（图表+表格）=====
app.get('/api/visitor/stats', async (req, res) => {
  try {
    // 总访客数
    const total = await querySql('SELECT COUNT(*) AS total FROM visitor_stats WHERE is_valid = 1');
    const totalVisitors = parseInt(total[0].total || 0);

    // 今日访客数
    const today = new Date().toISOString().split('T')[0];
    const todayData = await querySql(
      'SELECT COUNT(*) AS today FROM visitor_stats WHERE DATE(visit_time) = ? AND is_valid = 1',
      [today]
    );
    const todayVisitors = parseInt(todayData[0].today || 0);

    // 近7天趋势
    const sevenDays = await querySql(`
      SELECT DATE(visit_time) AS visit_date, COUNT(*) AS visitor_count
      FROM visitor_stats
      WHERE visit_time >= datetime('now', '-7 days') AND is_valid = 1
      GROUP BY DATE(visit_time)
      ORDER BY visit_date ASC
    `);

    // TOP10 IP
    const topIp = await querySql(`
      SELECT visitor_ip, region, COUNT(*) AS visit_count
      FROM visitor_stats
      WHERE is_valid = 1
      GROUP BY visitor_ip
      ORDER BY visit_count DESC
      LIMIT 10
    `);

    // 访客明细（用于表格展示）
    const visitorList = await querySql(`
      SELECT id, visitor_ip, region, visit_time, user_agent
      FROM visitor_stats
      WHERE is_valid = 1
      ORDER BY visit_time DESC
      LIMIT 100 -- 限制显示最新100条
    `);

    res.json({
      success: true,
      data: {
        totalVisitors,
        todayVisitors,
        sevenDaysTrend: sevenDays,
        topIpList: topIp,
        visitorList: visitorList // 新增：访客明细列表
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

    await runSql('INSERT INTO blacklist (blocked_ip, remark) VALUES (?, ?)', [ip, remark || '无备注']);
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
  console.log(`🔗 访客记录接口：http://localhost:${PORT}/api/visitor/record`);
});

// 进程退出时关闭数据库
process.on('exit', () => {
  db.close((err) => {
    if (err) console.error('❌ 关闭数据库失败：', err.message);
    else console.log('✅ 数据库连接已关闭');
  });
});