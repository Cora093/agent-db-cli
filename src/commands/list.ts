import type { Config } from '../config/types.js';
import type { OutputFormat } from '../types.js';
import { renderView, type View } from './common.js';

/** list:列所有数据源(§8)。无需连接 DB。 */
export function listCommand(config: Config, format: OutputFormat): string {
  const dss = Object.values(config.datasources);
  const view: View = {
    json: {
      datasources: dss.map((d) => ({
        id: d.id,
        label: d.label ?? null,
        driver: d.driver,
        host: d.host,
        database: d.database ?? null,
      })),
    },
    columns: ['id', 'label', 'driver', 'host', 'database'],
    rows: dss.map((d) => [d.id, d.label ?? d.id, d.driver, d.host, d.database ?? null]),
  };
  return renderView(view, format);
}
