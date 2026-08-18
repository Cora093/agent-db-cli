import { describe, expect, it } from 'vitest';
import { MysqlFamilyDialect, type MysqlConn } from '../src/dialects/mysql-family.js';
import { PgDialect, type PgConn } from '../src/dialects/postgres.js';
import { DmDialect, type DmConn } from '../src/dialects/dm.js';

const mysqlDialect = () => new MysqlFamilyDialect({
  defaultPort: 3306,
  introspection: 'full',
  execution: {
    timeout: { unit: 'none' },
    readOnlyTransaction: { strength: 'account-only' },
  },
});

describe('MySQL metadata fallbacks', () => {
  it('downgrades only constraints when CHECK_CONSTRAINTS is unavailable', async () => {
    const query = async (sql: string) => {
      if (sql.includes('information_schema.COLUMNS')) return [[{ COLUMN_NAME: 'id', COLUMN_TYPE: 'int', IS_NULLABLE: 'NO', COLUMN_KEY: 'PRI' }]];
      if (sql.includes('information_schema.TABLES')) return [[{ TABLE_TYPE: 'BASE TABLE', TABLE_COMMENT: 'users' }]];
      if (sql.includes('information_schema.STATISTICS')) return [[{ INDEX_NAME: 'PRIMARY', NON_UNIQUE: 0, COLUMN_NAME: 'id' }, { INDEX_NAME: 'uq_name', NON_UNIQUE: 0, COLUMN_NAME: 'name' }]];
      if (sql.includes('CHECK_CONSTRAINTS')) throw new Error("Table 'information_schema.CHECK_CONSTRAINTS' doesn't exist");
      if (sql.includes('REFERENTIAL_CONSTRAINTS')) return [[{ CONSTRAINT_NAME: 'fk_team', COLUMN_NAME: 'team_id', REFERENCED_TABLE_SCHEMA: 'app', REFERENCED_TABLE_NAME: 'teams', REFERENCED_COLUMN_NAME: 'id', UPDATE_RULE: 'CASCADE', DELETE_RULE: 'RESTRICT' }]];
      throw new Error(sql);
    };
    const conn = { database: 'app', raw: { query }, close: async () => {} } as unknown as MysqlConn;
    const schema = await mysqlDialect().getSchema(conn, 'users');
    expect(schema.primaryKey).toMatchObject({ status: 'full', data: ['id'] });
    expect(schema.indexes.status).toBe('full');
    expect(schema.constraints).toMatchObject({ status: 'best-effort' });
    expect(schema.constraints.data.map((c) => c.type)).toEqual(['PRIMARY KEY', 'UNIQUE']);
    expect(schema.foreignKeys.data[0]).toMatchObject({ onUpdate: 'CASCADE', onDelete: 'RESTRICT' });
    expect(schema.comment.data).toBe('users');
  });
});

describe('PostgreSQL metadata fidelity', () => {
  it('keeps expression, included, composite and partial index details', async () => {
    const query = async (sql: string) => {
      if (sql.includes('FROM pg_attribute')) return { rows: [{ name: 'email', type: 'text', notnull: false, default: null, comment: 'address' }] };
      if (sql.includes('FROM pg_index')) return { rows: [{ name: 'idx_users', unique: false, primary: false, columns: ['lower(email)', 'tenant_id', 'created_at'], definition: 'CREATE INDEX idx_users ON users (lower(email), tenant_id) INCLUDE (created_at) WHERE active', predicate: 'active' }] };
      if (sql.includes('con.contype IN')) return { rows: [] };
      if (sql.includes("con.contype='f'")) return { rows: [{ name: 'fk_team', columns: ['team_id'], referenced_schema: 'core', referenced_table: 'teams', referenced_columns: ['id'], update_action: 'c', delete_action: 'r' }] };
      if (sql.includes('pg_get_viewdef')) return { rows: [{ type: 'VIEW', comment: 'active users', view_definition: 'SELECT * FROM users WHERE active' }] };
      throw new Error(sql);
    };
    const conn = { defaultSchema: 'public', raw: { query }, close: async () => {} } as unknown as PgConn;
    const schema = await new PgDialect({
      defaultPort: 5432,
      execution: {
        timeout: { unit: 'none' },
        readOnlyTransaction: { strength: 'account-only' },
      },
    }).getSchema(conn, 'active_users');
    expect(schema.indexes.data[0]).toMatchObject({ columns: ['lower(email)', 'tenant_id', 'created_at'], predicate: 'active' });
    expect(schema.indexes.data[0].definition).toContain('INCLUDE (created_at)');
    expect(schema.foreignKeys.data[0]).toMatchObject({ onUpdate: 'CASCADE', onDelete: 'RESTRICT' });
    expect(schema.viewDefinition.data).toContain('SELECT');
    expect(schema.comment.data).toBe('active users');
  });
});

describe('DM metadata truthfulness', () => {
  it('derives visible namespaces and reports best-effort', async () => {
    const execute = async () => ({ metaData: [{ name: 'OWNER' }], rows: [['APP'], ['SYS']] });
    const conn = { user: 'APP', raw: { execute }, close: async () => {} } as unknown as DmConn;
    const result = await new DmDialect({
      defaultPort: 5236,
      introspection: 'best-effort',
      execution: {
        timeout: { unit: 'none' },
        readOnlyTransaction: { strength: 'account-only' },
      },
    }).listNamespaces(conn);
    expect(result.status).toBe('best-effort');
    expect(result.data).toEqual([{ name: 'APP', system: false }, { name: 'SYS', system: true }]);
  });
});
