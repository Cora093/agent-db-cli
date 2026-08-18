import type { DatasourceConfig } from '../config/types.js';
import type { OutputFormat, SqlValue } from '../types.js';
import { getDialect } from '../dialects/registry.js';
import { resolveDatasource } from '../config/resolve.js';
import { renderView, type View } from './common.js';

/** tables:列某数据源的表(schema 限定;可 --like 过滤)(§8)。 */
export async function tablesCommand(
  ds: DatasourceConfig,
  like: string | undefined,
  format: OutputFormat,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const dialect = getDialect(ds.driver);
  const conn = await dialect.connect(resolveDatasource(ds, env));
  try {
    const tables = await dialect.listTables(conn, like);
    const view: View = {
      command: 'tables',
      ds: ds.id,
      json: { ds: ds.id, tables },
      columns: ['schema', 'name', 'type', 'comment'],
      rows: tables.map(
        (t): SqlValue[] => [t.schema, t.name, t.type ?? null, t.comment ?? null],
      ),
    };
    return renderView(view, format);
  } finally {
    await conn.close();
  }
}
