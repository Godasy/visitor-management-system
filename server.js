require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');

// 初始化Express应用
const app = express();
const PORT = process.env.PORT || 3000;

// 跨域配置（允许前端请求）
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type', 'x-forwarded-for']
}));
app.use(express.json()); // 解析JSON请求体

// ===== SQLite3 核心配置 =====
// 数据库文件路径：项目根目录下的 visitor.db（自动生成）
const dbPath = path.resolve(__dirname, 'visitor.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('❌ SQLite3数据库连接失败：', err.message);
  } else {
    console.log(`✅ SQLite3数据库连接成功（文件路径：${dbPath}）`);
    initDatabaseTables(); // 自动创建表
  }
});

// ===== 工具函数：封装SQLite3为Promise风格（适配async/await） =====
function querySql(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      err ? reject(err) : resolve(rows);
    });
  });
}

function runSql(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
}

// ===== 自动初始化数据表（SQLite3语法） =====
function initDatabaseTables() {
  // 1. 访客统计表
  const createVisitorTable = `
    CREATE TABLE IF NOT EXISTS visitor_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      visitor_ip TEXT NOT NULL,
      visit_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      user_agent TEXT,
      is_valid BOOLEAN DEFAULT 1
    );
  `;

  // 2. 黑名单表
  const createBlacklistTable = `
    CREATE TABLE IF NOT EXISTS blacklist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      blocked_ip TEXT NOT NULL UNIQUE,
      add_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      remark TEXT DEFAULT '无备注'
    );
  `;

  // 执行表创建
  db.run(createVisitorTable, (err) => {
    if (err) console.error('❌ 创建访客表失败：', err.message);
    else console.log('✅ 访客表初始化成功');
  });

  db.run(createBlacklistTable, (err) => {
    if (err) console.error('❌ 创建黑名单表失败：', err.message);
    else console.log('✅ 黑名单表初始化成功');
  });
}

// ===== 接口1：记录访客访问 =====
app.get('/api/visitor/record', async (req, res) => {
  try {
    // 获取访客真实IP（兼容代理环境）
    let visitorIp = req.headers['x-forwarded-for']?.split(',').map(ip => ip.trim())[0] 
                  || req.connection.remoteAddress 
                  || req.socket.remoteAddress;

    // 本地访问IP处理
    if (!visitorIp || visitorIp === '::1' || visitorIp === '127.0.0.1') {
      visitorIp = '127.0.0.1';
    }

    // 检查是否在黑名单
    const blacklist = await querySql('SELECT * FROM blacklist WHERE blocked_ip = ?', [visitorIp]);
    if (blacklist.length > 0) {
      return res.json({ success: false, msg: '您的IP已被拦截', isBlocked: true });
    }

    // 记录访客信息
    const userAgent = req.headers['user-agent'] || '未知设备';
    await runSql('INSERT INTO visitor_stats (visitor_ip, user_agent) VALUES (?, ?)', [visitorIp, userAgent]);

    res.json({ success: true, msg: '访问记录成功', isBlocked: false, visitorIp });
  } catch (err) {
    console.error('❌ 记录访客失败：', err.message);
    res.status(500).json({ success: false, msg: '服务器内部错误', error: err.message });
  }
});

// ===== 接口2：获取访客统计数据（图表用） =====
app.get('/api/visitor/stats', async (req, res) => {
  try {
    // 总访客数
    const total = await querySql('SELECT COUNT(*) AS total FROM visitor_stats WHERE is_valid = 1');
    const totalVisitors = parseInt(total[0].total || 0);

    // 今日访客数
    const today = new Date().toISOString().split('T')[0];
    const todayData = await querySql('SELECT COUNT(*) AS today FROM visitor_stats WHERE DATE(visit_time) = ? AND is_valid = 1', [today]);
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
      SELECT visitor_ip, COUNT(*) AS visit_count
      FROM visitor_stats
      WHERE is_valid = 1
      GROUP BY visitor_ip
      ORDER BY visit_count DESC
      LIMIT 10
    `);

    res.json({
      success: true,
      data: { totalVisitors, todayVisitors, sevenDaysTrend: sevenDays, topIpList: topIp }
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

    // 清空访客表 + 重置自增ID
    await runSql('DELETE FROM visitor_stats');
    await runSql('DELETE FROM sqlite_sequence WHERE name = "visitor_stats"');

    res.json({ success: true, msg: '访客数据已全部重置' });
  } catch (err) {
    console.error('❌ 重置数据失败：', err.message);
    res.status(500).json({ success: false, msg: '重置失败', error: err.message });
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

// ===== 托管前端静态文件（本地调试用） =====
app.use(express.static('public'));

// ===== 启动服务器 =====
app.listen(PORT, () => {
  console.log(`🚀 服务器运行在 http://localhost:${PORT}`);
  console.log(`🔗 访客记录接口：http://localhost:${PORT}/api/visitor/record`);
});

// 进程退出时关闭数据库连接
process.on('exit', () => {
  db.close((err) => {
    if (err) console.error('❌ 关闭数据库失败：', err.message);
    else console.log('✅ 数据库连接已关闭');
  });
});