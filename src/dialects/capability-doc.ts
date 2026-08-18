import { DRIVER_NAMES, getDriverDescriptor } from './descriptors.js';

const labels = {
  introspection: { full: 'full', 'best-effort': 'best-effort' },
  transaction: { strong: 'strong', 'dml-only': 'DML-only', 'account-only': 'account-only' },
  timeout: { milliseconds: 'ms', seconds: 's', microseconds: 'us', none: 'none' },
  cancellation: { 'connection-close': 'connection-close' },
  limit: {
    'sql-rewrite+stream': 'SQL rewrite + event stream',
    'sql-rewrite+cursor': 'SQL rewrite + cursor',
    'sql-rewrite+result-set+driver-max-rows': 'SQL rewrite + result set + maxRows',
  },
} as const;

/** Stable Markdown used in README and skill docs; tests reject hand-edited capability drift. */
export function renderDriverCapabilityTable(): string {
  const header = '| driver | protocol | default port | introspection | read-only transaction | timeout unit | cancellation | row limit |';
  const divider = '|---|---|---:|---|---|---|---|---|';
  const rows = DRIVER_NAMES.map((name) => {
    const d = getDriverDescriptor(name);
    const c = d.capabilities;
    return `| \`${name}\` | ${d.protocol} | ${d.connection.defaultPort} | ${labels.introspection[c.introspection]} | ${labels.transaction[c.readOnlyTransaction]} | ${labels.timeout[c.timeoutUnit]} | ${labels.cancellation[c.cancellation]} | ${labels.limit[c.limit]} |`;
  });
  return [header, divider, ...rows].join('\n');
}
