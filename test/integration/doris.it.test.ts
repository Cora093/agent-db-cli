import { parseDbUrl, standardSuite, gatedDescribe, type ParsedDb } from './helpers.js';

/**
 * Doris 集成测试(MySQL 协议,driver=doris)。门控 AGENT_DB_CLI_IT_DORIS=mysql://user:pass@host:9030。
 * Doris 走 OLAP:无显式只读事务、自省 best-effort(indexes='N/A')。
 * 夹具命名空间 test20260609 须已由一次性脚本建好。
 */
const ENV = 'AGENT_DB_CLI_IT_DORIS';

gatedDescribe(ENV)('integration: doris', () => {
  // env 未设时整组 skip,但 describe 回调仍会被收集 → parse 要兜底避免抛错
  const url = process.env[ENV];
  const db: ParsedDb = url ? parseDbUrl(url) : { host: '', port: 0, user: '', password: '' };
  standardSuite({
    dsId: 'it-doris',
    datasource: {
      driver: 'doris',
      host: db.host,
      port: db.port,
      database: 'test20260609',
      user: db.user,
      password: db.password,
    },
    employeesTable: 'employees',
    departmentsTable: 'departments',
    empLike: '%emp%',
    salaryTypeContains: 'decimal',
    salaryKind: 'string',
    fullIntrospection: false,
    missingTable: 'no_such_table',
  });
});
