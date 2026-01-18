require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// 中间件配置
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type', 'x-forwarded-for']
}));
app.use(express.json());

// ！！！核心修复：完善PostgreSQL连接池配置，解决连接意外终止
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // 1. 加固SSL配置（Render PostgreSQL生产环境必须）
  ssl: process.env.NODE_ENV === 'production' ? {
    rejectUnauthorized: false,
    sslmode: 'require' // 强制启用SSL，确保连接安全稳定
  } : false,
  // 2. 优化连接池参数，避免空闲连接超时断开
  max: 10, // 最大连接数（Render免费数据库限制连接数，不要设置过大）
  min: 2, // 最小空闲连接数，保持少量连接避免频繁创建/断开
  idleTimeoutMillis: 60000, // 空闲连接超时时间（1分钟，小于Render数据库的空闲超时）
  connectionTimeoutMillis: 30000, // 连接建立超时时间（30秒，避免长时间等待）
});

// ！！！新增：数据库连接错误监听，自动重连（解决连接意外终止后无法恢复）
pool.on('error', (err, client) => {
  console.error('数据库连接意外终止（将自动尝试重连）：', err.stack);
  // 销毁出错的客户端，触发连接池重新创建连接
  if (client) client.release(true);
});

// ！！！新增：手动创建「连接心跳」，保持连接活跃（针对Render免费套餐休眠问题）
async function keepDbConnectionAlive() {
  try {
    const client = await pool.connect();
    // 执行简单查询，保持连接活跃
    await client.query('SELECT 1');
    client.release();
    console.log('数据库心跳检测成功，连接保持活跃');
  } catch (err) {
    console.error('数据库心跳检测失败，将重试：', err.stack);
  }
}

// 每5分钟执行一次心跳检测，避免空闲连接被断开
setInterval(keepDbConnectionAlive, 5 * 60 * 1000);

// 验证数据库连接并初始化数据表（新增重连逻辑）
async function connectToDatabase() {
  try {
    const client = await pool.connect();
    console.log('数据库连接成功（稳定连接）');
    client.release();
    await initDatabaseTables(); // 初始化数据表
  } catch (err) {
    console.error('数据库连接失败，将在5秒后重试：', err.stack);
    // 连接失败时，5秒后自动重试
    setTimeout(connectToDatabase, 5000);
  }
}

// 启动数据库连接（替代原有的 pool.connect()）
connectToDatabase();

// 数据表初始化函数（保持原有逻辑，无需修改）
async function initDatabaseTables() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS visitor_stats (
        id SERIAL PRIMARY KEY,
        visitor_ip VARCHAR(45) NOT NULL,
        visit_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        user_agent TEXT,
        is_valid BOOLEAN DEFAULT TRUE
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS blacklist (
        id SERIAL PRIMARY KEY,
        blocked_ip VARCHAR(45) NOT NULL UNIQUE,
        add_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        remark VARCHAR(255)
      );
    `);

    console.log('数据表初始化成功');
  } catch (err) {
    console.error('数据表初始化失败：', err.stack);
  }
}