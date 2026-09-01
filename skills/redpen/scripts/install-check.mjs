/**
 * Verifies both install scripts actually produce the files/config they claim
 * to (docs/IMPLEMENTATION_PLAN.md Phase 5 "완료 조건"), run in isolated temp
 * directories so this never touches the real ~/.codex or a real project.
 *
 * Run with: node skills/redpen/scripts/install-check.mjs
 * Requires bash (git-bash/WSL/msys on Windows) on PATH to execute the .sh
 * scripts, matching how a real user/agent would run them.
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const checks = [];
function record(name, pass, detail) {
  checks.push({ name, pass, detail });
  console.error(`${pass ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
}

function runBash(scriptPath, args, env) {
  const result = spawnSync('bash', [scriptPath, ...args], { env: { ...process.env, ...env }, encoding: 'utf8' });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', code: result.status ?? 1 };
}

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), 'redpen-codex-home-'));
  const claudeProject = await mkdtemp(path.join(os.tmpdir(), 'redpen-claude-project-'));

  try {
    const codexResult = runBash(path.join(__dirname, 'install-codex.sh'), [], { CODEX_HOME: codexHome });
    record('install-codex-script-exits-zero', codexResult.code === 0, `code=${codexResult.code} stderr=${codexResult.stderr.slice(0, 300)}`);

    const codexSkillPath = path.join(codexHome, 'skills', 'redpen', 'SKILL.md');
    record('install-codex-copies-skill-md', await exists(codexSkillPath), codexSkillPath);

    const codexConfigPath = path.join(codexHome, 'config.toml');
    const codexConfig = (await readFile(codexConfigPath, 'utf8').catch(() => '')) ;
    record('install-codex-registers-mcp-server-block', codexConfig.includes('[mcp_servers.redpen]'), codexConfig.slice(0, 200));

    const claudeResult = runBash(path.join(__dirname, 'install-claude.sh'), [claudeProject], {});
    record('install-claude-script-exits-zero', claudeResult.code === 0, `code=${claudeResult.code} stderr=${claudeResult.stderr.slice(0, 300)}`);

    const claudeSkillPath = path.join(claudeProject, '.claude', 'skills', 'redpen', 'SKILL.md');
    record('install-claude-copies-skill-md', await exists(claudeSkillPath), claudeSkillPath);

    const claudeMcpConfigPath = path.join(claudeProject, '.mcp.json');
    const claudeMcpConfig = JSON.parse(await readFile(claudeMcpConfigPath, 'utf8').catch(() => '{}'));
    record('install-claude-writes-mcp-json', Boolean(claudeMcpConfig.mcpServers?.redpen), JSON.stringify(claudeMcpConfig));

    const codexSkillContent = await readFile(codexSkillPath, 'utf8').catch(() => '');
    const claudeSkillContent = await readFile(claudeSkillPath, 'utf8').catch(() => '');
    record('both-hosts-receive-the-identical-skill-content', codexSkillContent === claudeSkillContent && codexSkillContent.length > 0, `lengths=${codexSkillContent.length}/${claudeSkillContent.length}`);

    const allPass = checks.every((c) => c.pass);
    console.error(`\n${allPass ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED'}`);
    if (!allPass) process.exitCode = 1;
  } finally {
    await rm(codexHome, { recursive: true, force: true });
    await rm(claudeProject, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('install check crashed:', err);
  process.exitCode = 1;
});
