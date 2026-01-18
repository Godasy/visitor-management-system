require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

// 初始化Express应用
const app = express();
const PORT = process.env.PORT || 3000;

// 中间件配置
app.use(cors());
app.use(express.json());

// 配置PostgreSQL连接
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// 验证数据库连接并自动初始化数据表
pool.connect((err) => {
  if (err) {
    console.error('数据库连接失败：', err.stack);
  } else {
    console.log('数据库连接成功');
    initDatabaseTables(); // 自动创建表（无需手动执行SQL）
  }
});

// 自动初始化数据表函数
async function initDatabaseTables() {
  try {
    // 创建访客统计表
    await pool.query(`
      CREATE TABLE IF NOT EXISTS visitor_stats (
        id SERIAL PRIMARY KEY,
        visitor_ip VARCHAR(45) NOT NULL,
        visit_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        user_agent TEXT,
        is_valid BOOLEAN DEFAULT TRUE
      )
    `);

    // 创建黑名单表
    await pool.query(`
      CREATE TABLE IF NOT EXISTS blacklist (
        id SERIAL PRIMARY KEY,
        blocked_ip VARCHAR(45) NOT NULL UNIQUE,
        add_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        remark VARCHAR(255)
      )
    `);

    console.log('数据表初始化成功（已创建/已存在）');
  } catch (err) {
    console.error('数据表初始化失败：', err.stack);
  }
}

// 接口1：记录访客访问
app.get('/api/visitor/record', async (req, res) => {
  try {
    // 获取访客IP
    const visitorIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    if (!visitorIp) return res.status(400).json({ success: false, msg: '无法获取访客IP' });

    // 检查黑名单
    const blacklistQuery = await pool.query('SELECT * FROM blacklist WHERE blocked_ip = $1', [visitorIp]);
    if (blacklistQuery.rows.length > 0) {
      return res.json({ success: false, msg: '您的IP已被拦截', isBlocked: true });
    }

    // 记录访客信息
    const userAgent = req.headers['user-agent'] || '未知设备';
    await pool.query(
      'INSERT INTO visitor_stats (visitor_ip, user_agent) VALUES ($1, $2)',
      [visitorIp, userAgent]
    );

    res.json({ success: true, msg: '访问记录成功', isBlocked: false });
  } catch (err) {
    console.error('记录访客失败：', err);
    res.status(500).json({ success: false, msg: '服务器内部错误' });
  }
});

// 接口2：获取访客统计数据
app.get('/api/visitor/stats', async (req, res) => {
  try {
    // 总访客数
    const totalQuery = await pool.query('SELECT COUNT(*) AS total_visitors FROM visitor_stats WHERE is_valid = true');
    const totalVisitors = parseInt(totalQuery.rows[0].total_visitors);

    // 今日访客数
    const today = new Date().toISOString().split('T')[0];
    const todayQuery = await pool.query(
      'SELECT COUNT(*) AS today_visitors FROM visitor_stats WHERE DATE(visit_time) = $1 AND is_valid = true',
      [today]
    );
    const todayVisitors = parseInt(todayQuery.rows[0].today_visitors);

    // 近7天趋势
    const sevenDaysQuery = await pool.query(`
      SELECT DATE(visit_time) AS visit_date, COUNT(*) AS visitor_count
      FROM visitor_stats
      WHERE visit_time >= NOW() - INTERVAL '7 days' AND is_valid = true
      GROUP BY DATE(visit_time)
      ORDER BY DATE(visit_time) ASC
    `);

    // TOP10 IP
    const topIpQuery = await pool.query(`
      SELECT visitor_ip, COUNT(*) AS visit_count
      FROM visitor_stats
      WHERE is_valid = true
      GROUP BY visitor_ip
      ORDER BY visit_count DESC
      LIMIT 10
    `);

    res.json({
      success: true,
      data: {
        totalVisitors,
        todayVisitors,
        sevenDaysTrend: sevenDaysQuery.rows,
        topIpList: topIpQuery.rows
      }
    });
  } catch (err) {
    console.error('获取访客统计失败：', err);
    res.status(500).json({ success: false, msg: '服务器内部错误' });
  }
});

// 接口3：重置访客数据
app.post('/api/visitor/reset', async (req, res) => {
  try {
    const { adminKey } = req.body;
    if (adminKey !== process.env.ADMIN_KEY) {
      return res.status(403).json({ success: false, msg: '鉴权失败，无操作权限' });
    }

    await pool.query('TRUNCATE TABLE visitor_stats RESTART IDENTITY');
    res.json({ success: true, msg: '访客数据已全部重置' });
  } catch (err) {
    console.error('重置访客数据失败：', err);
    res.status(500).json({ success: false, msg: '服务器内部错误' });
  }
});

// 接口4：获取黑名单
app.get('/api/blacklist', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM blacklist ORDER BY add_time DESC');
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('获取黑名单失败：', err);
    res.status(500).json({ success: false, msg: '服务器内部错误' });
  }
});

// 接口5：添加黑名单IP
app.post('/api/blacklist/add', async (req, res) => {
  try {
    const { ip, remark = '无备注' } = req.body;
    if (!ip) return res.status(400).json({ success: false, msg: '请输入需要拦截的IP地址' });

    const existQuery = await pool.query('SELECT * FROM blacklist WHERE blocked_ip = $1', [ip]);
    if (existQuery.rows.length > 0) {
      return res.json({ success: false, msg: '该IP已在黑名单中' });
    }

    await pool.query(
      'INSERT INTO blacklist (blocked_ip, remark) VALUES ($1, $2)',
      [ip, remark]
    );
    res.json({ success: true, msg: 'IP已成功添加到黑名单' });
  } catch (err) {
    console.error('添加黑名单失败：', err);
    res.status(500).json({ success: false, msg: '服务器内部错误' });
  }
});

// 接口6：删除黑名单IP
app.delete('/api/blacklist/delete/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM blacklist WHERE id = $1', [id]);
    res.json({ success: true, msg: 'IP已成功从黑名单移除' });
  } catch (err) {
    console.error('删除黑名单IP失败：', err);
    res.status(500).json({ success: false, msg: '服务器内部错误' });
  }
});

// 托管前端静态文件
app.use(express.static('public'));

// 启动服务器
app.listen(PORT, () => {
  console.log(`服务器运行在 http://localhost:${PORT}`);
});