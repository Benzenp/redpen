import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { installRedpen } from './install.js';

async function withTempDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'redpen-install-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

test('installs Claude slash command and Codex skill without losing existing config', async () => {
  await withTempDirectory(async (directory) => {
    const projectRoot = path.join(directory, 'project');
    const codexHome = path.join(directory, 'codex');
    await mkdir(projectRoot, { recursive: true });
    await writeFile(
      path.join(projectRoot, '.mcp.json'),
      `${JSON.stringify({ mcpServers: { existing: { command: 'existing-mcp' } }, projectSetting: true }, null, 2)}\n`,
    );
    await mkdir(codexHome, { recursive: true });
    await writeFile(
      path.join(codexHome, 'config.toml'),
      '[model]\nname = "existing"\n\n[mcp_servers."redpen"]\ncommand = "old"\nargs = ["old"]\nenvironment = "keep"\n',
    );

    const results = await installRedpen({
      host: 'all',
      projectRoot,
      codexHome,
      cliCommand: 'redpen',
    });

    assert.deepEqual(results.map((result) => result.host), ['claude', 'codex']);
    const command = await readFile(path.join(projectRoot, '.claude', 'commands', 'redpen.md'), 'utf8');
    assert.match(command, /\$ARGUMENTS/);
    assert.match(command, /Empty: open the detected local app's root page/);
    const skill = await readFile(path.join(projectRoot, '.claude', 'skills', 'redpen', 'SKILL.md'), 'utf8');
    assert.match(skill, /name: redpen/);

    const claudeConfig = JSON.parse(await readFile(path.join(projectRoot, '.mcp.json'), 'utf8')) as {
      projectSetting: boolean;
      mcpServers: Record<string, { command: string; args?: string[] }>;
    };
    assert.equal(claudeConfig.projectSetting, true);
    assert.equal(claudeConfig.mcpServers.existing.command, 'existing-mcp');
    assert.deepEqual(claudeConfig.mcpServers.redpen, { command: 'redpen', args: ['mcp'] });

    await installRedpen({ host: 'codex', projectRoot, codexHome, cliCommand: 'redpen-next' });
    const codexConfig = await readFile(path.join(codexHome, 'config.toml'), 'utf8');
    assert.match(codexConfig, /\[model\]\nname = "existing"/);
    assert.equal((codexConfig.match(/\[mcp_servers\.redpen\]/g) ?? []).length, 1);
    assert.match(codexConfig, /command = "redpen-next"/);
    assert.match(codexConfig, /args = \[\s*"mcp"\s*\]/);
    assert.match(codexConfig, /environment = "keep"/);
  });
});

test('refuses to overwrite malformed Claude MCP config', async () => {
  await withTempDirectory(async (directory) => {
    const projectRoot = path.join(directory, 'project');
    const skillPath = path.join(projectRoot, '.claude', 'skills', 'redpen', 'SKILL.md');
    const commandPath = path.join(projectRoot, '.claude', 'commands', 'redpen.md');
    await mkdir(path.dirname(skillPath), { recursive: true });
    await mkdir(path.dirname(commandPath), { recursive: true });
    await writeFile(skillPath, 'existing skill');
    await writeFile(commandPath, 'existing command');
    await writeFile(path.join(projectRoot, '.mcp.json'), '{broken');

    await assert.rejects(
      installRedpen({ host: 'claude', projectRoot }),
      /Cannot update malformed Claude MCP config/,
    );
    assert.equal(await readFile(path.join(projectRoot, '.mcp.json'), 'utf8'), '{broken');
    assert.equal(await readFile(skillPath, 'utf8'), 'existing skill');
    assert.equal(await readFile(commandPath, 'utf8'), 'existing command');
  });
});

test('refuses malformed Codex TOML before replacing an existing skill', async () => {
  await withTempDirectory(async (directory) => {
    const projectRoot = path.join(directory, 'project');
    const codexHome = path.join(directory, 'codex');
    const skillPath = path.join(codexHome, 'skills', 'redpen', 'SKILL.md');
    await mkdir(path.dirname(skillPath), { recursive: true });
    await writeFile(skillPath, 'existing codex skill');
    await writeFile(path.join(codexHome, 'config.toml'), '[broken');

    await assert.rejects(
      installRedpen({ host: 'codex', projectRoot, codexHome }),
      /Cannot update malformed Codex config/,
    );
    assert.equal(await readFile(skillPath, 'utf8'), 'existing codex skill');
    assert.equal(await readFile(path.join(codexHome, 'config.toml'), 'utf8'), '[broken');
  });
});
