require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

// 初始化Express应用
const app = express();
const PORT = process.env.PORT || 3000;

// 中间件配置（强制启用跨域，解决前端请求被拦截）
app.use(cors({
  origin: '*', // 允许所有域名访问（生产环境可替换为你的前端域名，如https://xxx.epizy.com）
  methods: ['GET', 'POST', 'DELETE'], // 允许的请求方法
  allowedHeaders: ['Content-Type', 'x-forwarded-for'] // 允许的请求头
}));
app.use(express.json()); // 解析JSON请求体

// 配置PostgreSQL数据库连接（适配Render生产环境）
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { 
    rejectUnauthorized: false // 关闭SSL证书验证，适配Render PostgreSQL
  } : false,
  idleTimeoutMillis: 30000, // 连接闲置超时时间，避免数据库连接断开
  connectionTimeoutMillis: 20000 // 连接建立超时时间
});

// 验证数据库连接并自动初始化数据表（修复表创建逻辑，确保表必被创建）
pool.connect(async (err) => {
  if (err) {
    console.error('数据库连接失败：', err.stack);
    return;
  }
  console.log('数据库连接成功');
  await initDatabaseTables(); // 同步执行表初始化，避免接口先于表创建
});

// 自动初始化数据表（加固SQL语句，无语法错误）
async function initDatabaseTables() {
  try {
    // 1. 创建访客统计表（visitor_stats）- 解决访客无法统计的核心：确保表存在
    await pool.query(`
      CREATE TABLE IF NOT EXISTS visitor_stats (
        id SERIAL PRIMARY KEY,
        visitor_ip VARCHAR(45) NOT NULL, -- 支持IPv4（15位）和IPv6（45位）
        visit_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP, -- 访问时间，默认当前时间
        user_agent TEXT, -- 访客设备/浏览器信息
        is_valid BOOLEAN DEFAULT TRUE -- 是否为有效访问（未被黑名单拦截）
      );
    `);

    // 2. 创建黑名单表（blacklist）
    await pool.query(`
      CREATE TABLE IF NOT EXISTS blacklist (
        id SERIAL PRIMARY KEY,
        blocked_ip VARCHAR(45) NOT NULL UNIQUE, -- 被拦截IP，唯一约束避免重复
        add_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP, -- 添加时间
        remark VARCHAR(255) -- 备注（如：恶意访问、爬虫）
      );
    `);

    console.log('数据表初始化成功（visitor_stats和blacklist已创建/已存在）');
  } catch (err) {
    console.error('数据表初始化失败：', err.stack);
  }
}

// 接口1：记录访客访问（修复IP获取逻辑，兼容代理环境如Render/InfinityFree）
app.get('/api/visitor/record', async (req, res) => {
  try {
    // 优化：兼容多代理环境，正确获取访客真实IP（解决无法获取IP导致不统计的问题）
    let visitorIp = '';
    if (req.headers['x-forwarded-for']) {
      // x-forwarded-for 可能包含多个IP，取第一个（真实访客IP）
      visitorIp = req.headers['x-forwarded-for'].split(',').map(ip => ip.trim())[0];
    } else if (req.connection.remoteAddress) {
      visitorIp = req.connection.remoteAddress;
    } else if (req.socket.remoteAddress) {
      visitorIp = req.socket.remoteAddress;
    }

    // 过滤无效IP，避免空值写入数据库
    if (!visitorIp || visitorIp === '::1' || visitorIp === '127.0.0.1') {
      // 本地访问时的默认IP，避免报错
      visitorIp = '127.0.0.1';
    }

    // 2. 检查该IP是否在黑名单中（避免拦截IP被统计）
    const blacklistQuery = await pool.query(
      'SELECT * FROM blacklist WHERE blocked_ip = $1', 
      [visitorIp]
    );
    if (blacklistQuery.rows.length > 0) {
      return res.json({ 
        success: false, 
        msg: '您的IP已被拦截', 
        isBlocked: true 
      });
    }

    // 3. 记录访客信息到数据库（确保插入语句无语法错误）
    const userAgent = req.headers['user-agent'] || '未知设备/浏览器';
    await pool.query(
      'INSERT INTO visitor_stats (visitor_ip, user_agent) VALUES ($1, $2)',
      [visitorIp, userAgent]
    );

    // 4. 返回成功响应，告知前端统计完成
    res.json({ 
      success: true, 
      msg: '访问记录成功，已纳入统计', 
      isBlocked: false,
      visitorIp: visitorIp // 返回IP，方便前端调试
    });
  } catch (err) {
    console.error('记录访客失败（核心报错，影响统计）：', err.stack);
    res.status(500).json({ 
      success: false, 
      msg: '服务器内部错误，无法记录访问', 
      error: err.message 
    });
  }
});

// 接口2：获取访客统计数据（admin.html图表展示用，确保查询逻辑正确）
app.get('/api/visitor/stats', async (req, res) => {
  try {
    // 1. 获取总访客数
    const totalQuery = await pool.query(
      'SELECT COUNT(*) AS total_visitors FROM visitor_stats WHERE is_valid = true'
    );
    const totalVisitors = parseInt(totalQuery.rows[0].total_visitors);

    // 2. 获取今日访客数（按UTC日期，适配Render服务器时间，避免日期偏差）
    const today = new Date().toISOString().split('T')[0];
    const todayQuery = await pool.query(
      'SELECT COUNT(*) AS today_visitors FROM visitor_stats WHERE DATE(visit_time) = $1 AND is_valid = true',
      [today]
    );
    const todayVisitors = parseInt(todayQuery.rows[0].today_visitors);

    // 3. 获取近7天访客趋势数据（用于折线图）
    const sevenDaysQuery = await pool.query(`
      SELECT DATE(visit_time) AS visit_date, COUNT(*) AS visitor_count
      FROM visitor_stats
      WHERE visit_time >= NOW() - INTERVAL '7 days' AND is_valid = true
      GROUP BY DATE(visit_time)
      ORDER BY DATE(visit_time) ASC
    `);

    // 4. 获取TOP10访客IP（用于柱状图）
    const topIpQuery = await pool.query(`
      SELECT visitor_ip, COUNT(*) AS visit_count
      FROM visitor_stats
      WHERE is_valid = true
      GROUP BY visitor_ip
      ORDER BY visit_count DESC
      LIMIT 10
    `);

    // 5. 返回完整统计数据，确保前端能正常渲染
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
    console.error('获取访客统计失败：', err.stack);
    res.status(500).json({ 
      success: false, 
      msg: '服务器内部错误，无法获取统计数据',
      error: err.message
    });
  }
});

// 接口3：重置访客统计数据（管理员操作，保持鉴权逻辑）
app.post('/api/visitor/reset', async (req, res) => {
  try {
    // 简单鉴权（生产环境可升级为JWT）
    const { adminKey } = req.body;
    if (adminKey !== process.env.ADMIN_KEY) {
      return res.status(403).json({ 
        success: false, 
        msg: '鉴权失败，无操作权限（管理员密钥错误）' 
      });
    }

    // 清空访客统计表（保留表结构，重置自增ID）
    await pool.query('TRUNCATE TABLE visitor_stats RESTART IDENTITY');
    res.json({ success: true, msg: '访客数据已全部重置，统计清零' });
  } catch (err) {
    console.error('重置访客数据失败：', err.stack);
    res.status(500).json({ 
      success: false, 
      msg: '服务器内部错误，无法重置访客数据' 
    });
  }
});

// 接口4：黑名单管理 - 获取所有黑名单IP
app.get('/api/blacklist', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM blacklist ORDER BY add_time DESC');
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('获取黑名单失败：', err.stack);
    res.status(500).json({ success: false, msg: '服务器内部错误，无法获取黑名单' });
  }
});

// 接口5：黑名单管理 - 添加IP到黑名单
app.post('/api/blacklist/add', async (req, res) => {
  try {
    const { ip, remark = '无备注' } = req.body;
    if (!ip) return res.status(400).json({ success: false, msg: '请输入需要拦截的IP地址' });

    // 检查IP是否已存在
    const existQuery = await pool.query('SELECT * FROM blacklist WHERE blocked_ip = $1', [ip]);
    if (existQuery.rows.length > 0) {
      return res.json({ success: false, msg: '该IP已在黑名单中，无需重复添加' });
    }

    // 添加到黑名单
    await pool.query(
      'INSERT INTO blacklist (blocked_ip, remark) VALUES ($1, $2)',
      [ip, remark]
    );
    res.json({ success: true, msg: 'IP已成功添加到黑名单，将被拦截访问' });
  } catch (err) {
    console.error('添加黑名单失败：', err.stack);
    res.status(500).json({ success: false, msg: '服务器内部错误，无法添加黑名单' });
  }
});

// 接口6：黑名单管理 - 从黑名单删除IP
app.delete('/api/blacklist/delete/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ success: false, msg: '缺少黑名单ID参数' });

    await pool.query('DELETE FROM blacklist WHERE id = $1', [id]);
    res.json({ success: true, msg: 'IP已成功从黑名单移除，可正常访问' });
  } catch (err) {
    console.error('删除黑名单IP失败：', err.stack);
    res.status(500).json({ success: false, msg: '服务器内部错误，无法删除黑名单IP' });
  }
});

// 托管前端静态文件（本地调试用，部署时前端单独部署到InfinityFree）
app.use(express.static('public'));

// 启动服务器，监听端口
app.listen(PORT, () => {
  console.log(`服务器运行在端口 ${PORT}，环境：${process.env.NODE_ENV || 'development'}`);
  console.log(`本地访问地址：http://localhost:${PORT}`);
  console.log(`访客统计接口：http://localhost:${PORT}/api/visitor/record`);
});