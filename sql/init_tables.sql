-- 访客统计表（visitor_stats）- 确保访客能被正常统计
-- 执行此脚本可手动创建表，解决自动建表失败的问题
CREATE TABLE IF NOT EXISTS visitor_stats (
  id SERIAL PRIMARY KEY,
  visitor_ip VARCHAR(45) NOT NULL, -- 支持IPv4（15位）和IPv6（45位）
  visit_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP, -- 访问时间，默认当前时间
  user_agent TEXT, -- 访客设备/浏览器信息
  is_valid BOOLEAN DEFAULT TRUE -- 是否为有效访问（未被黑名单拦截）
);

-- 黑名单表（blacklist）
CREATE TABLE IF NOT EXISTS blacklist (
  id SERIAL PRIMARY KEY,
  blocked_ip VARCHAR(45) NOT NULL UNIQUE, -- 被拦截IP，唯一约束避免重复
  add_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP, -- 添加时间
  remark VARCHAR(255) -- 备注（如：恶意访问、爬虫）
);

-- 验证表是否创建成功（执行后返回表结构即成功）
SELECT * FROM visitor_stats LIMIT 1;
SELECT * FROM blacklist LIMIT 1;