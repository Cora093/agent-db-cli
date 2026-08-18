import type { DatasourceConfig } from '../config/types.js';
import type { SqlValue } from '../types.js';
import type { OutputFormat } from '../output/plan.js';
import { getDialect } from '../dialects/registry.js';
import { resolveDatasource } from '../config/resolve.js';
import { renderView, parseTableArg, type View, type ViewSection } from './common.js';
import type { TableSchema } from '../dialects/types.js';

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
      command: 'schema',
      ds: ds.id,
      json: { ds: ds.id, ...s },
      columns: ['column', 'type', 'nullable', 'default', 'comment'],
      rows: s.columns.data.map(
        (c): SqlValue[] => [c.name, c.type, c.nullable, c.default ?? null, c.comment ?? null],
      ),
      sections: schemaSections(s),
    };
    return renderView(view, format);
  } finally {
    await conn.close();
  }
}
function schemaSections(s: TableSchema): ViewSection[] {
  const status = (name: string, value: { status: string; detail?: string }): SqlValue[] => [name, value.status, value.detail ?? null];
  return [
    { name: 'summary', columns: ['schema', 'table', 'type'], rows: [[s.schema, s.table, s.type]] },
    { name: 'capabilities', columns: ['field', 'status', 'detail'], rows: [status('columns', s.columns), status('primaryKey', s.primaryKey), status('indexes', s.indexes), status('constraints', s.constraints), status('foreignKeys', s.foreignKeys), status('comment', s.comment), status('viewDefinition', s.viewDefinition)] },
    { name: 'columns', columns: ['column', 'type', 'nullable', 'default', 'comment'], rows: s.columns.data.map((c) => [c.name, c.type, c.nullable, c.default ?? null, c.comment ?? null]) },
    { name: 'primaryKey', columns: ['column'], rows: s.primaryKey.data.map((c) => [c]) },
    { name: 'indexes', columns: ['name', 'columns', 'unique', 'primary', 'definition', 'predicate'], rows: s.indexes.data.map((i) => [i.name, i.columns.join(', '), i.unique, i.primary, i.definition ?? null, i.predicate ?? null]) },
    { name: 'constraints', columns: ['name', 'type', 'columns', 'definition'], rows: s.constraints.data.map((c) => [c.name, c.type, c.columns.join(', '), c.definition ?? null]) },
    { name: 'foreignKeys', columns: ['name', 'columns', 'references', 'onUpdate', 'onDelete'], rows: s.foreignKeys.data.map((f) => [f.name, f.columns.join(', '), `${f.referencedSchema ? `${f.referencedSchema}.` : ''}${f.referencedTable}(${f.referencedColumns.join(', ')})`, f.onUpdate ?? null, f.onDelete ?? null]) },
    { name: 'comment', columns: ['comment'], rows: [[s.comment.data]] },
    { name: 'viewDefinition', columns: ['definition'], rows: [[s.viewDefinition.data]] },
  ];
}
