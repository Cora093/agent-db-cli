import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { resolveConfigPath } from '../src/config/paths.js';

const HOME = path.join('/tmp', 'home', 'me');

describe('resolveConfigPath (§5 解析顺序)', () => {
  it('AGENT_DB_CLI_CONFIG 短路优先,解析为绝对路径', () => {
    const target = path.resolve('/etc', 'agent-db-cli', 'custom.yaml');
    const got = resolveConfigPath({
      env: { AGENT_DB_CLI_CONFIG: target },
      platform: 'linux',
      homedir: HOME,
    });
    expect(got).toBe(path.resolve(target));
  });

  it('AGENT_DB_CLI_CONFIG 优先级高于 platform 默认', () => {
    const target = path.resolve('/custom/c.yaml');
    const got = resolveConfigPath({
      env: { AGENT_DB_CLI_CONFIG: target, APPDATA: 'C:\\Users\\me\\AppData\\Roaming' },
      platform: 'win32',
      homedir: HOME,
    });
    expect(got).toBe(path.resolve(target));
  });

  it('Windows 用 %APPDATA%\\agent-db-cli\\datasources.yaml', () => {
    const appData = path.join('C:', 'Users', 'me', 'AppData', 'Roaming');
    const got = resolveConfigPath({
      env: { APPDATA: appData },
      platform: 'win32',
      homedir: HOME,
    });
    expect(got).toBe(path.join(appData, 'agent-db-cli', 'datasources.yaml'));
  });

  it('Windows APPDATA 缺省回退 ~/AppData/Roaming', () => {
    const got = resolveConfigPath({ env: {}, platform: 'win32', homedir: HOME });
    expect(got).toBe(path.join(HOME, 'AppData', 'Roaming', 'agent-db-cli', 'datasources.yaml'));
  });

  it('Linux 用 $XDG_CONFIG_HOME/agent-db-cli/datasources.yaml', () => {
    const xdg = path.join('/tmp', 'xdg');
    const got = resolveConfigPath({
      env: { XDG_CONFIG_HOME: xdg },
      platform: 'linux',
      homedir: HOME,
    });
    expect(got).toBe(path.join(xdg, 'agent-db-cli', 'datasources.yaml'));
  });

  it('Linux XDG 缺省回退 ~/.config', () => {
    const got = resolveConfigPath({ env: {}, platform: 'linux', homedir: HOME });
    expect(got).toBe(path.join(HOME, '.config', 'agent-db-cli', 'datasources.yaml'));
  });
});
