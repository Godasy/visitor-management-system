-- 访客统计表（含IP地区字段）
CREATE TABLE IF NOT EXISTS visitor_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  visitor_ip TEXT NOT NULL,
  region TEXT DEFAULT '未知地区', -- IP归属地
  visit_time DATETIME DEFAULT CURRENT_TIMESTAMP,
  user_agent TEXT DEFAULT '未知设备',
  is_valid BOOLEAN DEFAULT 1
);

-- 黑名单表
CREATE TABLE IF NOT EXISTS blacklist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  blocked_ip TEXT NOT NULL UNIQUE,
  add_time DATETIME DEFAULT CURRENT_TIMESTAMP,
  remark TEXT DEFAULT '无备注'
);

-- 验证表结构
SELECT name, sql FROM sqlite_master WHERE type='table';