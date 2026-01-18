-- 访客统计表（visitor_stats）
CREATE TABLE IF NOT EXISTS visitor_stats (
  id SERIAL PRIMARY KEY,
  visitor_ip VARCHAR(45) NOT NULL, -- 支持IPv4/IPv6
  visit_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP, -- 默认当前时间
  user_agent TEXT, -- 访客设备信息
  is_valid BOOLEAN DEFAULT TRUE -- 是否为有效访问
);

-- 黑名单表（blacklist）
CREATE TABLE IF NOT EXISTS blacklist (
  id SERIAL PRIMARY KEY,
  blocked_ip VARCHAR(45) NOT NULL UNIQUE, -- 唯一约束，避免重复IP
  add_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP, -- 添加时间
  remark VARCHAR(255) -- 备注信息
);