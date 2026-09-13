// 端到端验证：启动真实服务，用 HTTP 请求验证完整流程、冲突、并发幂等、事务回滚与审计。
// 运行：npm run verify
const { spawn } = require('child_process');
const fs = require('fs');

const PORT = Number(process.env.VERIFY_PORT || 3921);
const BASE = `http://127.0.0.1:${PORT}`;
const DB_FILE = `/tmp/tour-verify-${process.pid}.db`;

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, extra) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  ✗ ${name}${extra !== undefined ? ' — ' + JSON.stringify(extra) : ''}`);
  }
}

async function api(method, path, opts = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(opts.key ? { 'Idempotency-Key': opts.key } : {})
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // 204 等无响应体
  }
  return { status: res.status, json, replay: res.headers.get('idempotent-replay') === 'true' };
}

const get = (p) => api('GET', p);
const post = (p, body, key) => api('POST', p, { body, key });

async function waitReady(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE + '/health');
      if (res.ok) return;
    } catch {
      // 服务尚未就绪
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('服务启动超时');
}

async function boxCount() {
  return (await get('/api/tourBoxes')).json.length;
}

async function timeline(collection, id) {
  return (await get(`/api/${collection}/${id}/timeline`)).json.events.map((e) => e.action);
}

async function main() {
  console.log('\n[0] 准备物品');
  const headFields = (role, play) => ({ role, play, paintStatus: '完好', mechanism: '正常', boxNo: '木箱丙-01' });
  const accFields = (name, play) => ({ name, role: '武生', play, boxNo: '配件箱-09' });
  const headA = (await post('/api/puppetHeads', headFields('武生', '火焰山'))).json.id;
  const headB = (await post('/api/puppetHeads', headFields('老生', '火焰山'))).json.id;
  const headC = (await post('/api/puppetHeads', { ...headFields('花脸', '火焰山'), status: '待修补' })).json.id;
  const headD = (await post('/api/puppetHeads', headFields('小生', '白蛇传'))).json.id;
  const accX = (await post('/api/accessories', accFields('红缨冠', '火焰山'))).json.id;
  const accY = (await post('/api/accessories', accFields('短靠', '火焰山'))).json.id;
  const accZ = (await post('/api/accessories', { ...accFields('翎子', '火焰山'), status: '缺损' })).json.id;
  check('物品已建好（3 可演出偶头 + 1 待修补偶头 + 2 在库配件 + 1 缺损配件）',
    [headA, headB, headC, headD, accX, accY, accZ].every(Boolean));

  console.log('\n[1] 装箱冲突：不可演出 / 不存在 / 重复选择 / 缺字段');
  let r = await post('/api/tourBoxes', { showName: '巡演', venue: '泉州', play: '火焰山', headIds: [headC], accessoryIds: [] });
  check('待修补偶头被拒（409）', r.status === 409, r);
  r = await post('/api/tourBoxes', { showName: '巡演', venue: '泉州', play: '火焰山', headIds: [headA], accessoryIds: [accZ] });
  check('缺损配件被拒（409）', r.status === 409, r);
  r = await post('/api/tourBoxes', { showName: '巡演', venue: '泉州', play: '火焰山', headIds: ['no-such-id'], accessoryIds: [] });
  check('不存在的物品被拒（409，原因=不存在）', r.status === 409 && /不存在/.test(JSON.stringify(r.json)), r);
  r = await post('/api/tourBoxes', { showName: '巡演', venue: '泉州', play: '火焰山', headIds: [headA, headA], accessoryIds: [] });
  check('同一物品重复选择被拒（400）', r.status === 400, r);
  r = await post('/api/tourBoxes', { showName: '巡演', venue: '泉州', play: '火焰山', headIds: [headA], accessoryIds: [headA] });
  check('偶头配件交叉重复被拒（400）', r.status === 400, r);
  r = await post('/api/tourBoxes', { venue: '泉州', play: '火焰山', headIds: [headA] });
  check('缺少必填字段被拒（400）', r.status === 400, r);

  console.log('\n[2] 创建装箱单 box1（偶头A + 配件X），幂等键重放');
  const k1 = 'key-box1-' + process.pid;
  const box1Body = { showName: '元宵巡演', venue: '泉州', play: '火焰山', headIds: [headA], accessoryIds: [accX], actor: '班主' };
  r = await post('/api/tourBoxes', box1Body, k1);
  check('装箱成功（201，状态=已装箱）', r.status === 201 && r.json.status === '已装箱', r);
  const box1 = r.json.id;
  check('箱内物品 2 件', r.json.items.length === 2, r.json);
  check('偶头A 状态=已装箱', (await get(`/api/puppetHeads/${headA}`)).json.status === '已装箱');
  check('配件X 状态=已装箱', (await get(`/api/accessories/${accX}`)).json.status === '已装箱');
  r = await post('/api/tourBoxes', box1Body, k1);
  check('同键同体重放返回首次结果（200 + Idempotent-Replay）', r.status === 200 && r.replay && r.json.id === box1, r);
  check('重放没有产生新装箱单', (await boxCount()) === 1);
  r = await post('/api/tourBoxes', { ...box1Body, venue: '厦门' }, k1);
  check('同键不同体被拒（409）', r.status === 409, r);

  console.log('\n[3] 占用冲突与装箱事务回滚');
  r = await post('/api/tourBoxes', { showName: '另一台', venue: '漳州', play: '火焰山', headIds: [headA], accessoryIds: [] });
  check('已被未闭环巡演占用的偶头被拒（409）', r.status === 409, r);
  const before = await boxCount();
  r = await post('/api/tourBoxes', { showName: '混合', venue: '漳州', play: '火焰山', headIds: [headB, headC], accessoryIds: [] });
  check('部分物品不可装箱 → 整单被拒（409）', r.status === 409, r);
  check('回滚：没有留下装箱单', (await boxCount()) === before);
  check('回滚：合法偶头B 状态仍是可演出', (await get(`/api/puppetHeads/${headB}`)).json.status === '可演出');
  check('回滚：偶头B 没有装箱事件', !(await timeline('puppetHeads', headB)).includes('装箱'));

  console.log('\n[4] 并发同幂等键创建：8 个并发请求只能成功一次');
  const k2 = 'key-storm-' + process.pid;
  const box2Body = { showName: '清明巡演', venue: '厦门', play: '火焰山', headIds: [headB], accessoryIds: [accY] };
  const storm = await Promise.all(Array.from({ length: 8 }, () => post('/api/tourBoxes', box2Body, k2)));
  const ids = new Set(storm.map((x) => x.json && x.json.id));
  check('8 个并发都拿到同一个装箱单 id', ids.size === 1 && !ids.has(undefined), [...ids]);
  check('其中 201 恰好 1 个，其余为幂等重放', storm.filter((x) => x.status === 201).length === 1);
  check('只新增了 1 个装箱单', (await boxCount()) === before + 1);
  check('偶头B 只有 1 条装箱事件', (await timeline('puppetHeads', headB)).filter((a) => a === '装箱').length === 1);
  const box2 = [...ids][0];

  console.log('\n[5] 并发抢同一物品：6 个不同键请求只能成功一次');
  const race = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      post('/api/tourBoxes', { showName: '抢箱' + i, venue: '泉州', play: '白蛇传', headIds: [headD], accessoryIds: [] }, 'race-' + i + '-' + process.pid))
  );
  check('恰好 1 个 201，其余 409', race.filter((x) => x.status === 201).length === 1 && race.every((x) => x.status === 201 || x.status === 409), race.map((x) => x.status));
  check('偶头D 只被装过 1 次', (await timeline('puppetHeads', headD)).filter((a) => a === '装箱').length === 1);

  console.log('\n[6] 状态机只能按顺序流转');
  r = await post(`/api/tourBoxes/${box1}/return`, { checks: [{ itemType: 'puppetHead', itemId: headA, condition: '完好' }, { itemType: 'accessory', itemId: accX, condition: '完好' }] });
  check('未出发不能返场（409）', r.status === 409, r);
  r = await post(`/api/tourBoxes/${box1}/close`, {});
  check('未返场不能闭环（409）', r.status === 409, r);
  r = await post(`/api/tourBoxes/${box1}/depart`, { actor: '班主' });
  check('出发巡演（200，巡演中）', r.status === 200 && r.json.status === '巡演中', r);
  r = await post(`/api/tourBoxes/${box1}/depart`, {});
  check('重复出发被拒（409）', r.status === 409, r);

  console.log('\n[7] 并发出发：5 个并发只能成功一次');
  const departs = await Promise.all(Array.from({ length: 5 }, () => post(`/api/tourBoxes/${box2}/depart`, {})));
  check('恰好 1 个 200，其余 409', departs.filter((x) => x.status === 200).length === 1 && departs.every((x) => x.status === 200 || x.status === 409), departs.map((x) => x.status));

  console.log('\n[8] 返场清点校验失败 → 回滚不留半成品');
  r = await post(`/api/tourBoxes/${box1}/return`, { checks: [{ itemType: 'puppetHead', itemId: headA, condition: '完好' }] });
  check('漏清点配件X 被拒（400）', r.status === 400 && /漏清点/.test(JSON.stringify(r.json)), r);
  r = await post(`/api/tourBoxes/${box1}/return`, { checks: [{ itemType: 'puppetHead', itemId: headA, condition: '完好' }, { itemType: 'accessory', itemId: accX, condition: '完好' }, { itemType: 'accessory', itemId: accY, condition: '完好' }] });
  check('清点了别箱物品被拒（400）', r.status === 400, r);
  r = await post(`/api/tourBoxes/${box1}/return`, { checks: [{ itemType: 'puppetHead', itemId: headA, condition: '掉漆' }, { itemType: 'accessory', itemId: accX, condition: '完好' }] });
  check('非法清点结论被拒（400）', r.status === 400, r);
  r = await post(`/api/tourBoxes/${box1}/return`, { checks: [{ itemType: 'puppetHead', itemId: headA, condition: '完好' }, { itemType: 'puppetHead', itemId: headA, condition: '缺损' }, { itemType: 'accessory', itemId: accX, condition: '完好' }] });
  check('重复清点同一物品被拒（400）', r.status === 400, r);
  check('回滚：box1 仍是巡演中', (await get(`/api/tourBoxes/${box1}`)).json.status === '巡演中');
  check('回滚：偶头A 仍是已装箱', (await get(`/api/puppetHeads/${headA}`)).json.status === '已装箱');
  check('回滚：没有产生缺损单', (await get('/api/lossReports')).json.length === 0);

  console.log('\n[9] 返场清点成功：偶头A 缺损、配件X 完好，缺损同步物品状态');
  r = await post(`/api/tourBoxes/${box1}/return`, {
    actor: '班主',
    checks: [
      { itemType: 'puppetHead', itemId: headA, condition: '缺损', note: '左颊掉彩' },
      { itemType: 'accessory', itemId: accX, condition: '完好' }
    ]
  });
  check('返场清点成功（200，返场清点中）', r.status === 200 && r.json.status === '返场清点中', r);
  check('偶头A 状态=待修补', (await get(`/api/puppetHeads/${headA}`)).json.status === '待修补');
  check('配件X 状态=在库', (await get(`/api/accessories/${accX}`)).json.status === '在库');
  let reports = (await get('/api/lossReports')).json;
  check('生成 1 张待处理缺损单', reports.length === 1 && reports[0].status === '待处理' && reports[0].problem === '缺损', reports);
  const report1 = reports[0].id;

  console.log('\n[10] 缺损未处理完不能闭环');
  r = await post(`/api/tourBoxes/${box1}/close`, {});
  check('闭环被拒（409，列出未处理缺损）', r.status === 409 && Array.isArray(r.json.details) && r.json.details.length === 1, r);
  check('box1 仍是返场清点中', (await get(`/api/tourBoxes/${box1}`)).json.status === '返场清点中');

  console.log('\n[11] 处理缺损单 → 物品状态同步 → 闭环');
  r = await post(`/api/lossReports/${report1}/resolve`, { resolution: '随便修修' });
  check('非法处理结论被拒（400）', r.status === 400, r);
  r = await post(`/api/lossReports/${report1}/resolve`, { resolution: '已补齐', actor: '修补师傅' });
  check('缺损单处理为已补齐（200）', r.status === 200 && r.json.status === '已补齐', r);
  check('偶头A 恢复可演出', (await get(`/api/puppetHeads/${headA}`)).json.status === '可演出');
  r = await post(`/api/lossReports/${report1}/resolve`, { resolution: '已补齐' });
  check('重复处理被拒（409）', r.status === 409, r);
  r = await post(`/api/tourBoxes/${box1}/close`, { actor: '班主' });
  check('闭环成功（200，已闭环）', r.status === 200 && r.json.status === '已闭环', r);
  r = await post(`/api/tourBoxes/${box1}/close`, {});
  check('重复闭环被拒（409）', r.status === 409, r);

  console.log('\n[12] box2：并发返场只能成功一次；遗失确认后物品不可用');
  const box2Checks = {
    checks: [
      { itemType: 'puppetHead', itemId: headB, condition: '遗失', note: '回程清点缺失' },
      { itemType: 'accessory', itemId: accY, condition: '缺损', note: '靠旗撕裂' }
    ]
  };
  const returns = await Promise.all(Array.from({ length: 3 }, () => post(`/api/tourBoxes/${box2}/return`, box2Checks)));
  check('3 个并发返场恰好 1 个 200，其余 409', returns.filter((x) => x.status === 200).length === 1 && returns.every((x) => x.status === 200 || x.status === 409), returns.map((x) => x.status));
  reports = (await get(`/api/tourBoxes/${box2}`)).json.lossReports;
  check('恰好生成 2 张缺损单（遗失+缺损），无重复', reports.length === 2, reports);
  check('偶头B 状态=不可演出', (await get(`/api/puppetHeads/${headB}`)).json.status === '不可演出');
  check('配件Y 状态=缺损', (await get(`/api/accessories/${accY}`)).json.status === '缺损');
  const lostReport = reports.find((x) => x.problem === '遗失');
  const tornReport = reports.find((x) => x.problem === '缺损');
  r = await post(`/api/lossReports/${lostReport.id}/resolve`, { resolution: '确认为遗失', actor: '班主' });
  check('遗失确认（200）', r.status === 200 && r.json.status === '确认为遗失', r);
  check('偶头B 保持不可演出', (await get(`/api/puppetHeads/${headB}`)).json.status === '不可演出');
  r = await post(`/api/lossReports/${tornReport.id}/resolve`, { resolution: '已补齐', actor: '修补师傅' });
  check('配件Y 修复补齐（200）', r.status === 200, r);
  check('配件Y 恢复在库', (await get(`/api/accessories/${accY}`)).json.status === '在库');
  r = await post(`/api/tourBoxes/${box2}/close`, {});
  check('box2 闭环成功', r.status === 200 && r.json.status === '已闭环', r);

  console.log('\n[13] 闭环释放物品：可再装箱；确认遗失的偶头仍不可用');
  r = await post('/api/tourBoxes', { showName: '端午巡演', venue: '福州', play: '火焰山', headIds: [headA], accessoryIds: [accX, accY] });
  check('已闭环巡演的物品可再装箱（201）', r.status === 201, r);
  const box3 = r.json.id;
  r = await post('/api/tourBoxes', { showName: '端午巡演', venue: '福州', play: '火焰山', headIds: [headB], accessoryIds: [] });
  check('确认遗失的偶头B 仍被拒（409）', r.status === 409, r);

  console.log('\n[14] 并发闭环只能成功一次');
  await post(`/api/tourBoxes/${box3}/depart`, {});
  await post(`/api/tourBoxes/${box3}/return`, {
    checks: [
      { itemType: 'puppetHead', itemId: headA, condition: '完好' },
      { itemType: 'accessory', itemId: accX, condition: '完好' },
      { itemType: 'accessory', itemId: accY, condition: '完好' }
    ]
  });
  const closes = await Promise.all(Array.from({ length: 3 }, () => post(`/api/tourBoxes/${box3}/close`, {})));
  check('3 个并发闭环恰好 1 个 200，其余 409', closes.filter((x) => x.status === 200).length === 1 && closes.every((x) => x.status === 200 || x.status === 409), closes.map((x) => x.status));

  console.log('\n[15] 审计：每次状态变化可追溯');
  const box1Actions = await timeline('tourBoxes', box1);
  check('box1 时间线：创建装箱单→出发巡演→返场清点→清点完成→闭环',
    JSON.stringify(box1Actions) === JSON.stringify(['创建装箱单', '出发巡演', '返场清点', '清点完成', '闭环']), box1Actions);
  const headAActions = await timeline('puppetHeads', headA);
  check('偶头A 时间线含 装箱→返场-缺损→缺损处理-已补齐',
    ['装箱', '返场-缺损', '缺损处理-已补齐'].every((a) => headAActions.includes(a)), headAActions);
  const reportActions = await timeline('lossReports', report1);
  check('缺损单时间线：登记缺损→缺损处理-已补齐',
    JSON.stringify(reportActions) === JSON.stringify(['登记缺损', '缺损处理-已补齐']), reportActions);
  const box1Timeline = (await get(`/api/tourBoxes/${box1}/timeline`)).json.events;
  check('审计事件带操作人和前后状态', box1Timeline.every((e) => e.actor !== undefined) && box1Timeline[0].data.to === '已装箱', box1Timeline[0]);

  console.log('\n[16] 工作流集合不允许绕过状态机');
  r = await api('PATCH', `/api/tourBoxes/${box1}`, { body: { status: '已闭环' } });
  check('PATCH 装箱单被拒（403）', r.status === 403, r);
  r = await post('/api/lossReports', { tourBoxId: box1, itemType: 'puppetHead', itemName: 'x', problem: '缺损' });
  check('手工登记缺损单被拒（403）', r.status === 403, r);
  r = await get(`/api/tourBoxes/${box1}`);
  check('装箱单详情含物品与缺损单', Array.isArray(r.json.items) && r.json.items.length === 2 && Array.isArray(r.json.lossReports) && r.json.lossReports.length === 1, r.json);

  console.log('\n[17] 占用中的物品：不能移除、不能绕过工作流改状态');
  const headE = (await post('/api/puppetHeads', headFields('武生', '火焰山'))).json.id;
  const accW = (await post('/api/accessories', accFields('靠旗', '火焰山'))).json.id;
  const box5 = (await post('/api/tourBoxes', { showName: '占用测试', venue: '泉州', play: '火焰山', headIds: [headE], accessoryIds: [accW] })).json.id;
  r = await api('DELETE', `/api/puppetHeads/${headE}`);
  check('移除占用中的偶头被拒（409）', r.status === 409, r);
  r = await api('DELETE', `/api/accessories/${accW}`);
  check('移除占用中的配件被拒（409）', r.status === 409, r);
  check('偶头E 仍在且状态=已装箱', (await get(`/api/puppetHeads/${headE}`)).json.status === '已装箱');
  r = await api('PATCH', `/api/puppetHeads/${headE}`, { body: { status: '可演出' } });
  check('篡改占用中偶头为可演出被拒（409）', r.status === 409, r);
  r = await api('PATCH', `/api/accessories/${accW}`, { body: { status: '在库' } });
  check('篡改占用中配件为在库被拒（409）', r.status === 409, r);
  r = await post(`/api/puppetHeads/${headE}/events`, { status: '可演出' });
  check('events 接口篡改同样被拒（409）', r.status === 409, r);
  r = await api('PATCH', `/api/puppetHeads/${headE}`, { body: { paintStatus: '左颊补注' } });
  check('不改状态的字段修正仍允许（200）', r.status === 200 && r.json.status === '已装箱' && r.json.paintStatus === '左颊补注', r);
  r = await api('PATCH', `/api/puppetHeads/${headE}`, { body: { currentUsable: true } });
  check('占用中可用性标记由工作流托管，显式篡改不生效', r.status === 200 && r.json.currentUsable === false, r);
  check('篡改尝试后偶头E 状态仍是已装箱', (await get(`/api/puppetHeads/${headE}`)).json.status === '已装箱');
  await post(`/api/tourBoxes/${box5}/depart`, {});
  r = await post(`/api/tourBoxes/${box5}/return`, {
    checks: [
      { itemType: 'puppetHead', itemId: headE, condition: '完好' },
      { itemType: 'accessory', itemId: accW, condition: '完好' }
    ]
  });
  check('被篡改尝试的箱子仍能正常返场（200）', r.status === 200, r);
  r = await post(`/api/tourBoxes/${box5}/close`, {});
  check('正常闭环（200）', r.status === 200 && r.json.status === '已闭环', r);
  r = await api('DELETE', `/api/puppetHeads/${headE}`);
  check('已闭环历史单引用的物品仍不可移除（409，保证可追溯）', r.status === 409, r);
  check('历史装箱单详情物品完整', (await get(`/api/tourBoxes/${box5}`)).json.items.length === 2);
  const headF = (await post('/api/puppetHeads', headFields('小生', '白蛇传'))).json.id;
  r = await api('DELETE', `/api/puppetHeads/${headF}`);
  check('从未装箱的物品可正常移除（204）', r.status === 204, r);

  console.log('\n[18] 「已装箱」状态不能由通用接口进出');
  const headG = (await post('/api/puppetHeads', headFields('老生', '白蛇传'))).json.id;
  r = await api('PATCH', `/api/puppetHeads/${headG}`, { body: { status: '已装箱' } });
  check('手工置为已装箱被拒（409）', r.status === 409, r);
  r = await post('/api/puppetHeads', { ...headFields('老生', '白蛇传'), status: '已装箱' });
  check('直接创建已装箱物品被拒（409）', r.status === 409, r);
  r = await api('PATCH', `/api/puppetHeads/${headG}`, { body: { status: '不存在的状态' } });
  check('非法状态值被拒（400）', r.status === 400, r);
  r = await api('PATCH', `/api/puppetHeads/${headG}`, { body: { status: '待修补' } });
  check('未占用物品的状态管理不受影响（200）', r.status === 200 && r.json.status === '待修补', r);
  r = await api('DELETE', `/api/puppetHeads/${headG}`);
  check('未引用物品可移除（204）', r.status === 204, r);

  console.log('\n[19] 可用性标记：参与装箱校验、随装箱/返场/缺损处理联动');
  const headH = (await post('/api/puppetHeads', { ...headFields('净角', '火焰山'), status: '可演出', currentUsable: false })).json.id;
  r = await post('/api/tourBoxes', { showName: '标记测试', venue: '泉州', play: '火焰山', headIds: [headH], accessoryIds: [] });
  check('状态可演出但标记不可用的偶头被拒（409，原因含可用性标记）', r.status === 409 && /可用性标记|currentUsable/.test(JSON.stringify(r.json)), r);
  r = await api('PATCH', `/api/puppetHeads/${headH}`, { body: { currentUsable: true } });
  check('显式修正标记（200）', r.status === 200 && r.json.currentUsable === true, r);
  r = await post('/api/tourBoxes', { showName: '标记测试', venue: '泉州', play: '火焰山', headIds: [headH], accessoryIds: [] });
  check('标记修正后可装箱（201）', r.status === 201, r);
  const box6 = r.json.id;
  let headHNow = (await get(`/api/puppetHeads/${headH}`)).json;
  check('装箱后标记随状态联动为 false', headHNow.status === '已装箱' && headHNow.currentUsable === false, headHNow);
  check('装箱单详情带出可用性标记', (await get(`/api/tourBoxes/${box6}`)).json.items[0].currentUsable === false);
  await post(`/api/tourBoxes/${box6}/depart`, {});
  await post(`/api/tourBoxes/${box6}/return`, { checks: [{ itemType: 'puppetHead', itemId: headH, condition: '缺损' }] });
  headHNow = (await get(`/api/puppetHeads/${headH}`)).json;
  check('返场缺损后 状态=待修补 且标记=false', headHNow.status === '待修补' && headHNow.currentUsable === false, headHNow);
  const reportH = (await get(`/api/tourBoxes/${box6}`)).json.lossReports[0].id;
  await post(`/api/lossReports/${reportH}/resolve`, { resolution: '已补齐' });
  headHNow = (await get(`/api/puppetHeads/${headH}`)).json;
  check('缺损补齐后 状态=可演出 且标记=true', headHNow.status === '可演出' && headHNow.currentUsable === true, headHNow);
  r = await post(`/api/tourBoxes/${box6}/close`, {});
  check('box6 闭环成功', r.status === 200 && r.json.status === '已闭环', r);
  const headI = (await post('/api/puppetHeads', { ...headFields('丑角', '火焰山'), status: '待修补' })).json.id;
  check('创建为待修补时标记自动 false', (await get(`/api/puppetHeads/${headI}`)).json.currentUsable === false);
  r = await api('PATCH', `/api/puppetHeads/${headI}`, { body: { status: '可演出' } });
  check('通用接口改为可演出时标记自动 true', r.status === 200 && r.json.currentUsable === true, r);
  r = await api('PATCH', `/api/puppetHeads/${headI}`, { body: { status: '修补中' } });
  check('通用接口改为修补中时标记自动 false', r.status === 200 && r.json.currentUsable === false, r);
  const headJ = (await post('/api/puppetHeads', headFields('小生', '白蛇传'))).json.id;
  const box7 = (await post('/api/tourBoxes', { showName: '遗失测试', venue: '厦门', play: '白蛇传', headIds: [headJ], accessoryIds: [] })).json.id;
  await post(`/api/tourBoxes/${box7}/depart`, {});
  await post(`/api/tourBoxes/${box7}/return`, { checks: [{ itemType: 'puppetHead', itemId: headJ, condition: '遗失' }] });
  const reportJ = (await get(`/api/tourBoxes/${box7}`)).json.lossReports[0].id;
  await post(`/api/lossReports/${reportJ}/resolve`, { resolution: '确认为遗失' });
  const headJNow = (await get(`/api/puppetHeads/${headJ}`)).json;
  check('确认遗失后 状态=不可演出 且标记=false', headJNow.status === '不可演出' && headJNow.currentUsable === false, headJNow);
  await post(`/api/tourBoxes/${box7}/close`, {});
  r = await post('/api/tourBoxes', { showName: '再来', venue: '厦门', play: '白蛇传', headIds: [headJ], accessoryIds: [] });
  check('确认遗失的偶头不能再装箱（409）', r.status === 409, r);

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  if (failed) {
    console.log('失败用例：\n - ' + failures.join('\n - '));
    process.exitCode = 1;
  }
}

const server = spawn('node', ['server.js'], {
  cwd: __dirname + '/..',
  env: { ...process.env, PORT: String(PORT), DB_FILE },
  stdio: ['ignore', 'pipe', 'pipe']
});
server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

async function cleanup() {
  server.kill();
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(DB_FILE + suffix);
    } catch {
      // 文件不存在则忽略
    }
  }
}

process.on('SIGINT', async () => {
  await cleanup();
  process.exit(130);
});

waitReady()
  .then(main)
  .catch((error) => {
    console.error('验证脚本执行出错：', error);
    process.exitCode = 1;
  })
  .finally(cleanup);
