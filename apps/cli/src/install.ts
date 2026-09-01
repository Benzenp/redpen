import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

export type InstallHost = 'claude' | 'codex' | 'all';

export interface InstallOptions {
  host: InstallHost;
  projectRoot: string;
  homeDir?: string;
  codexHome?: string;
  cliCommand?: string;
  cliArgs?: string[];
}

export interface InstallResult {
  host: Exclude<InstallHost, 'all'>;
  paths: string[];
}

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function assetRoot(): Promise<string> {
  const candidates = [
    path.join(moduleDir, 'assets', 'redpen'),
    path.resolve(moduleDir, '../../../skills/redpen'),
  ];
  for (const candidate of candidates) {
    if (await exists(path.join(candidate, 'SKILL.md'))) return candidate;
  }
  throw new Error('Redpen skill assets are missing; rebuild or reinstall the CLI package');
}

async function installClaude(options: InstallOptions, sourceRoot: string): Promise<InstallResult> {
  const skillDir = path.join(options.projectRoot, '.claude', 'skills', 'redpen');
  const commandsDir = path.join(options.projectRoot, '.claude', 'commands');
  const skillPath = path.join(skillDir, 'SKILL.md');
  const commandPath = path.join(commandsDir, 'redpen.md');
  const mcpPath = path.join(options.projectRoot, '.mcp.json');

  let config: { mcpServers?: Record<string, unknown>; [key: string]: unknown } = {};
  if (await exists(mcpPath)) {
    try {
      const parsed = JSON.parse(await readFile(mcpPath, 'utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('root value must be an object');
      }
      config = parsed as typeof config;
      if (
        config.mcpServers !== undefined
        && (!config.mcpServers || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers))
      ) {
        throw new Error('mcpServers must be an object');
      }
    } catch (error) {
      throw new Error(`Cannot update malformed Claude MCP config at ${mcpPath}: ${(error as Error).message}`);
    }
  }
  config.mcpServers = {
    ...(config.mcpServers ?? {}),
    redpen: { command: options.cliCommand ?? 'redpen', args: options.cliArgs ?? ['mcp'] },
  };

  await mkdir(skillDir, { recursive: true });
  await mkdir(commandsDir, { recursive: true });
  await copyFile(path.join(sourceRoot, 'SKILL.md'), skillPath);
  await copyFile(path.join(sourceRoot, 'commands', 'redpen.md'), commandPath);
  await writeFile(mcpPath, `${JSON.stringify(config, null, 2)}\n`);

  return { host: 'claude', paths: [skillPath, commandPath, mcpPath] };
}

function updatedCodexConfig(
  config: string,
  configPath: string,
  cliCommand: string,
  cliArgs: string[],
): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(config) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Cannot update malformed Codex config at ${configPath}: ${(error as Error).message}`);
  }

  const currentServers = parsed.mcp_servers;
  if (currentServers !== undefined && (!currentServers || typeof currentServers !== 'object' || Array.isArray(currentServers))) {
    throw new Error(`Cannot update malformed Codex config at ${configPath}: mcp_servers must be a table`);
  }
  const servers = (currentServers ?? {}) as Record<string, unknown>;
  const currentRedpen = servers.redpen;
  if (currentRedpen !== undefined && (!currentRedpen || typeof currentRedpen !== 'object' || Array.isArray(currentRedpen))) {
    throw new Error(`Cannot update malformed Codex config at ${configPath}: mcp_servers.redpen must be a table`);
  }
  servers.redpen = {
    ...((currentRedpen ?? {}) as Record<string, unknown>),
    command: cliCommand,
    args: cliArgs,
  };
  parsed.mcp_servers = servers;
  return stringifyToml(parsed);
}

async function installCodex(options: InstallOptions, sourceRoot: string): Promise<InstallResult> {
  const homeDir = options.homeDir ?? os.homedir();
  const codexHome = options.codexHome ?? process.env.CODEX_HOME ?? path.join(homeDir, '.codex');
  const skillDir = path.join(codexHome, 'skills', 'redpen');
  const skillPath = path.join(skillDir, 'SKILL.md');
  const configPath = path.join(codexHome, 'config.toml');

  const currentConfig = await readFile(configPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  const nextConfig = updatedCodexConfig(
    currentConfig,
    configPath,
    options.cliCommand ?? 'redpen',
    options.cliArgs ?? ['mcp'],
  );

  await mkdir(skillDir, { recursive: true });
  await copyFile(path.join(sourceRoot, 'SKILL.md'), skillPath);
  await writeFile(configPath, nextConfig);

  return { host: 'codex', paths: [skillPath, configPath] };
}

export async function installRedpen(options: InstallOptions): Promise<InstallResult[]> {
  if (!['claude', 'codex', 'all'].includes(options.host)) {
    throw new Error(`Unsupported install host: ${options.host}`);
  }
  options = { ...options, projectRoot: path.resolve(options.projectRoot) };
  const sourceRoot = await assetRoot();
  const results: InstallResult[] = [];
  if (options.host === 'claude' || options.host === 'all') {
    results.push(await installClaude(options, sourceRoot));
  }
  if (options.host === 'codex' || options.host === 'all') {
    results.push(await installCodex(options, sourceRoot));
  }
  return results;
}
