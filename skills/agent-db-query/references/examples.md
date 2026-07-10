# 常见查询范式

> 全部默认列式 JSON 输出。给人看加 `--format table`。

## 发现:有哪些源 / 表 / 列

```bash
agent-db list
agent-db tables --ds prod-mysql-ro --like '%order%'
agent-db schema --ds prod-mysql-ro --table orders
agent-db schema --ds analytics-pg-ro --table sales.orders   # schema.table 糖
```

## 简单查询(位置参数)

```bash
agent-db query --ds prod-mysql-ro "SELECT id, status, amount FROM orders WHERE status='paid' LIMIT 20"
```

## 复杂查询(临时文件 + -f,跨平台最稳)

写 `q.sql`(UTF-8):

```sql
SELECT date(created_at) AS day, count(*) AS n, sum(amount) AS gmv
FROM orders
WHERE created_at >= '2026-06-01'
GROUP BY date(created_at)
ORDER BY day;
```

```bash
agent-db query --ds prod-mysql-ro -f q.sql
```

## 计数 / 聚合:用 SQL,别在客户端数行

```bash
# ✅ 正确:让 DB 算
agent-db query --ds prod-mysql-ro "SELECT count(*) FROM orders WHERE status='paid'"

# ❌ 错误:SELECT * 后在客户端数行 —— 会被 500 行硬顶截断,数错
```

## 排查数据问题(找异常行)

```bash
agent-db query --ds prod-mysql-ro \
  "SELECT id, status, amount FROM orders WHERE amount < 0 OR status IS NULL LIMIT 50"
```

## 大结果:落盘后切片,别灌上下文

```bash
agent-db query --ds bi-doris-ro -f big.sql
# → stdout 给前 50 行预览 + meta.spillPath(NDJSON 全量)
# 然后用 Read(offset/limit) 或 Grep 读 spillPath,而不是把全部塞进上下文
```

## 导出给人(Excel)

```bash
agent-db query --ds prod-mysql-ro -f report.sql --out ~/orders-2026-06.csv
```

## 探索 PG / DM 的库结构

```bash
agent-db query --ds analytics-pg-ro "SHOW search_path"
agent-db query --ds bi-doris-ro "SHOW CREATE TABLE dw.fact_sales"   # best-effort 引擎看键/分布
```

## 跨源对比(分两次查,工具不做联邦)

```bash
agent-db query --ds prod-mysql-ro "SELECT count(*) FROM orders"
agent-db query --ds analytics-pg-ro "SELECT count(*) FROM sales.orders"
# 在你这边比对两个结果
```

## EXPLAIN(看执行计划,只读)

```bash
agent-db query --ds prod-mysql-ro "EXPLAIN SELECT * FROM orders WHERE customer_id=42"
```
