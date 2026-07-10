import type { DatasourceConfig } from '../config/types.js';
import type { OutputFormat, SqlValue } from '../types.js';
import { getDialect } from '../dialects/registry.js';
import { resolveDatasource } from '../config/resolve.js';
import { renderView, parseTableArg, type View } from './common.js';

/** schema:单表结构(列/类型/主键/索引/注释)(§8)。 */
export async function schemaCommand(
  ds: DatasourceConfig,
  tableArg: string,
  schemaFlag: string | undefined,
  format: OutputFormat,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const { schema, table } = parseTableArg(tableArg, schemaFlag);
  const dialect = getDialect(ds.driver);
  const conn = await dialect.connect(resolveDatasource(ds, env));
  try {
    const s = await dialect.getSchema(conn, table, schema);
    const view: View = {
      json: { ds: ds.id, ...s },
      columns: ['column', 'type', 'nullable', 'default', 'comment'],
      rows: s.columns.map(
        (c): SqlValue[] => [c.name, c.type, c.nullable, c.default ?? null, c.comment ?? null],
      ),
    };
    return renderView(view, format);
  } finally {
    await conn.close();
  }
}
