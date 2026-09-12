#!/usr/bin/env node
// APRV-329: isolated installed-tarball acceptance. No checkout dependency links.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(join(repo, 'package-lock.json'), 'utf8'));
const scratch = mkdtempSync(join(tmpdir(), 'approval-installed-artifact-'));
const consumer = join(scratch, 'consumer');
mkdirSync(consumer);
// Do not inherit identity, service credentials or vault access into synthetic fixtures.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(APPROVAL_|TELEGRAM_|VAULT_|AGENTMAIL_|ZZZ_)/u.test(key)));
function run(command, args, cwd = consumer) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.error, undefined, `${command} failed to start: ${String(result.error)}`);
  assert.equal(result.status, 0, `${command} ${args.join(' ')} exit ${result.status}: ${result.stderr}\n${result.stdout}`);
  return result.stdout;
}
try {
  const packed = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', scratch], repo));
  assert.equal(packed.length, 1);
  const tarball = join(scratch, packed[0].filename);
  writeFileSync(join(consumer, 'package.json'), '{"private":true,"type":"module"}\n');
  // Offline install: transitive ranges resolve from the tarball manifest and npm cache,
  // never from symlinks to the repository. The generated lock pins the consumer.
  const nodeTypes = lock.packages['node_modules/@types/node'].version;
  run('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', tarball, `@types/node@${nodeTypes}`]);
  const installed = join(consumer, 'node_modules', 'approval-md');
  assert.equal(JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).version, manifest.version);
  for (const dependency of Object.keys(manifest.dependencies)) {
    const path = realpathSync(join(consumer, 'node_modules', dependency));
    assert.ok(path.startsWith(`${realpathSync(consumer)}/node_modules/`), `checkout dependency escaped isolation: ${dependency}`);
  }
  run('npm', ['rebuild', 'better-sqlite3', '--offline', '--no-audit', '--no-fund']);
  writeFileSync(join(consumer, 'sqlite.mjs'), "import Database from 'better-sqlite3'; const db=new Database(':memory:'); if(db.prepare('SELECT 1 AS n').get().n!==1) throw new Error('native SQLite unavailable'); db.close();\n");
  run(process.execPath, [join(consumer, 'sqlite.mjs')]);
  const cli = join(installed, 'cli.js');
  assert.match(run(process.execPath, [cli, '--version']), new RegExp(manifest.version.replaceAll('.', '\\.')));
  const policy = join(scratch, 'APPROVAL.md');
  const log = join(scratch, 'fixture', 'events.jsonl');
  writeFileSync(policy, '# Synthetic installed-package fixture\n\n```yaml approval-policy\nversion: "0.1"\ndefaults: { autonomy: manual }\nclasses:\n  probe.allow: { autonomy: autonomous, allow_irreversible: true }\n  probe.supervised: { autonomy: supervised, allow_irreversible: true }\n  probe.floor: { autonomy: autonomous }\n  probe.manual: { autonomy: manual }\n  probe.human: { autonomy: human-only }\n```\n');
  run(process.execPath, [cli, 'policy', 'attest', '--dir', scratch, '--log', log, '--as', 'human:test-fixture', '--json']);
  const payload = { body: 'synthetic local act; no provider or credentials' };
  const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  for (const suffix of ['allow', 'supervised', 'floor', 'manual', 'human']) {
    const id = `fixture-${suffix}`;
    const task = join(scratch, `${id}.md`);
    writeFileSync(task, `---\nid: ${id}\napproval:\n  origin: { app: synthetic-test, created_by: "agent:test-fixture" }\n  state: awaiting\n  actions:\n    - class: probe.${suffix}\n      summary: synthetic local adapter fixture\n      reversible: false\n      idempotency_key: ${id}:act\n      payload_hash: ${hash}\n---\n`);
    run(process.execPath, [cli, 'register', task, '--log', log, '--as', 'agent:test-fixture', '--json'], scratch);
  }
  writeFileSync(join(consumer, 'fixture.json'), JSON.stringify({ policy, log, payload }));
  writeFileSync(join(consumer, 'acceptance.mjs'), `
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as api from 'approval-md/adapters';
assert.deepEqual(Object.keys(api).sort(), ['ADAPTER_REFUSAL_CODES','CREDENTIAL_REFUSAL_CODES','executeThroughAdapter','runAdapterConformance','vaultCredentialProvider'].sort());
for (const path of ['approval-md/dist/src/adapters/contract.js','approval-md/dist/src/core/gate.js']) {
  await assert.rejects(import(path), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
}
const { policy, log, payload } = JSON.parse(readFileSync('./fixture.json','utf8'));
let acts = 0;
const adapter = { name: 'synthetic-installed', classes: ['probe.allow','probe.supervised','probe.floor','probe.manual','probe.human'], act() { acts++; return {ok:true}; } };
for (const [suffix, code] of [['allow',null],['supervised',null],['floor','token-required'],['manual','token-required'],['human','class-human-only']]) {
 const result = await api.executeThroughAdapter(adapter, { logPath:log, actionKey:'fixture-'+suffix+':act', actor:'agent:test-fixture', payload }, { policy:{file:policy} });
 assert.equal(result.ok, code===null, JSON.stringify(result));
 if(code) assert.equal(result.code,code);
}
assert.equal(acts,2);
const replay = await api.executeThroughAdapter(adapter,{logPath:log,actionKey:'fixture-allow:act',actor:'agent:test-fixture',payload},{policy:{file:policy}});
assert.equal(replay.ok,false);assert.equal(replay.code,'already-executed');assert.equal(acts,2);
const events = readFileSync(log,'utf8').trim().split('\\n').map(line=>JSON.parse(line));
assert.equal(events.filter(r=>r.event==='execution.started').length,2);
assert.equal(events.filter(r=>r.event==='execution.completed').length,2);
assert.equal(events.filter(r=>r.event==='approval.requested'||r.event==='approval.granted').length,0);
console.log('public API, private-path denial, irreversible policy act, manual/human-only refusal and replay passed');
`);
  run(process.execPath, [join(consumer, 'acceptance.mjs')]);
  run(process.execPath, [cli, 'log', 'verify', '--log', log, '--json'], scratch);
  writeFileSync(join(consumer, 'consumer.ts'), `import { executeThroughAdapter, type Adapter, type AdapterExecuteRequest, type AdapterExecuteOptions } from 'approval-md/adapters';\nconst adapter: Adapter = { name:'typed-fixture', classes:['probe.allow'], async act(){return {ok:true};} };\nexport const execute=(request:AdapterExecuteRequest, options:AdapterExecuteOptions)=>executeThroughAdapter(adapter,request,options);\n`);
  run(process.execPath, [join(repo, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '--strict', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2023', '--types', 'node', join(consumer, 'consumer.ts')]);
  console.log(JSON.stringify({ ok:true, version:manifest.version, integrity:packed[0].integrity, dependencies:'clean offline npm install with generated consumer lock; explicit offline native SQLite rebuild verified', checks:['CLI version','ESM exports','TypeScript consumer','deep-import denial','attested irreversible execution','manual/human-only refusal','single use','verified synthetic log'] }));
} finally {
  // Synthetic test records only, under this script-owned temporary root.
  rmSync(scratch, {recursive:true,force:true});
}
