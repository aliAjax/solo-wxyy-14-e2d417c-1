# 传统木偶戏班偶头与巡演装箱API

维护偶头、服装配件、修补流转、巡演装箱和返场缺损追踪。核心是按顺序流转的巡演闭环：

```
装箱(已装箱) → 出发巡演(巡演中) → 返场清点(返场清点中) → 闭环(已闭环)
```

- 装箱时校验：物品必须可演出（偶头`可演出`/配件`在库`）、未被其他未闭环巡演占用、同单不重复；任一不满足整单拒绝。
- 返场清点必须逐项覆盖箱内全部物品；`缺损`/`遗失`会同步物品状态并自动生成`待处理`缺损单。
- 缺损单处理为`已补齐`（物品恢复可用）或`确认为遗失`（物品保持不可用）后，装箱单才允许闭环。
- 所有多步写入在同一事务内，任一步失败整体回滚；并发重复请求由幂等键 + 状态乐观锁保证只成功一次；每次状态变化写入审计事件（`GET /api/:collection/:id/timeline` 可查）。

## 启动

```bash
npm install
npm start
```

默认地址：http://localhost:3914

## 验证

```bash
npm run verify
```

脚本会启动一个真实服务（独立临时数据库），用 HTTP 请求跑 68 项断言：完整闭环、各类冲突、并发幂等（同键重放/抢同一物品/并发流转）、事务回滚、审计时间线。

## 闭环接口

| 接口 | 说明 |
| --- | --- |
| `POST /api/tourBoxes` | 创建装箱单（装箱）。Body：`showName, venue, play, headIds[], accessoryIds[], actor`；请求头 `Idempotency-Key` 保证重复提交只成功一次 |
| `POST /api/tourBoxes/:id/depart` | 出发巡演：`已装箱 → 巡演中` |
| `POST /api/tourBoxes/:id/return` | 返场清点：`巡演中 → 返场清点中`。Body：`checks: [{itemType: puppetHead/accessory, itemId, condition: 完好/缺损/遗失, note}]`，必须与箱内物品一一对应 |
| `POST /api/tourBoxes/:id/close` | 闭环：`返场清点中 → 已闭环`，有未处理缺损单时 409 |
| `POST /api/lossReports/:id/resolve` | 处理缺损单。Body：`resolution: 已补齐/确认为遗失`，同步物品状态 |
| `GET /api/tourBoxes/:id` | 装箱单详情（含箱内物品当前状态、关联缺损单） |

物品状态联动：装箱→`已装箱`；返场`完好`→`可演出/在库`，`缺损`→`待修补/缺损`，`遗失`→`不可演出/遗失`；缺损单`已补齐`→`可演出/在库`，`确认为遗失`→`不可演出/遗失`。

`tourBoxes` 与 `lossReports` 由工作流托管，通用 `POST/PATCH/DELETE` 返回 403，状态只能经上述接口流转。

## 通用接口（物品档案等）

- `GET /api/puppetHeads?play=火焰山&status=可演出`
- `POST /api/puppetHeads` / `POST /api/accessories` / `POST /api/repairRecords`
- `GET /api/:collection/:id/timeline` 状态变化时间线（审计）
- `GET /api/meta` 集合与状态定义

SQLite数据库文件会在首次启动时创建到`data/app.db`（可用环境变量 `DB_FILE` 覆盖）。
