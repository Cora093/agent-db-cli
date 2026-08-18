import type { DatasourceConfig } from '../config/types.js';
import type { OutputFormat, SqlValue } from '../types.js';
import { getDialect } from '../dialects/registry.js';
import { resolveDatasource } from '../config/resolve.js';
import { renderView, type View } from './common.js';

export async function namespacesCommand(
  ds: DatasourceConfig,
  format: OutputFormat,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const dialect = getDialect(ds.driver);
  const conn = await dialect.connect(resolveDatasource(ds, env));
  try {
    const namespaces = await dialect.listNamespaces(conn);
    const rows = namespaces.data.map((item): SqlValue[] => [item.name, item.system]);
    const view: View = {
      json: { ds: ds.id, namespaces },
      columns: ['name', 'system'],
      rows,
    };
    return renderView(view, format);
  } finally {
    await conn.close();
  }
}
