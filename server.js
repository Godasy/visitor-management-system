// 加固版UA解析：入参校验+全层级属性兜底，彻底杜绝.family访问报错
const parseUaFullInfo = (uaParsed) => {
  // 第一步：强制校验入参，无效直接返回兜底设备信息
  if (!uaParsed || typeof uaParsed !== 'object') {
    return {
      fullUa: '未知设备 | 未知浏览器 | 未知系统',
      deviceType: '未知设备',
      browser: '未知浏览器',
      os: '未知系统',
      engine: '未知内核',
      deviceModel: '未知型号'
    };
  }

  try {
    // 第二步：所有层级属性做存在性兜底，避免深层访问报错
    const deviceFamily = uaParsed.device?.family || 'Other';
    const osFamily = uaParsed.os?.family || '未知系统';
    const browserFamily = uaParsed.family || '未知浏览器';
    const browserMajor = uaParsed.major || '';
    const osMajor = uaParsed.os?.major || '';
    const osMinor = uaParsed.os?.minor || '';
    const engineFamily = uaParsed.engine?.family || '未知内核';
    const deviceModel = uaParsed.device?.model || '未知型号';

    // 原有设备类型判断逻辑（保留不变）
    const deviceType = deviceFamily === 'Other'
      ? (osFamily.includes('Android') || osFamily.includes('iOS') ? '手机' : '电脑')
      : deviceFamily === 'iPad' ? '平板' : (deviceFamily || '未知设备');
    
    // 格式化浏览器/系统信息（保留不变）
    const browser = `${browserFamily} ${browserMajor}`.trim() || '未知浏览器';
    const os = `${osFamily} ${osMajor}.${osMinor}`.trim() || '未知系统';

    return {
      fullUa: `${deviceType} | ${browser} | ${os}`,
      deviceType,
      browser,
      os,
      engine: engineFamily,
      deviceModel
    };
  } catch (err) {
    // 任何意外异常，直接返回兜底信息
    console.warn(`⚠️ UA解析函数异常，返回兜底设备信息：`, err.message.slice(0, 50));
    return {
      fullUa: '未知设备 | 未知浏览器 | 未知系统',
      deviceType: '未知设备',
      browser: '未知浏览器',
      os: '未知系统',
      engine: '未知内核',
      deviceModel: '未知型号'
    };
  }
};