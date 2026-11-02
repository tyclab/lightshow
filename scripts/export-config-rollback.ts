#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Export only: never replace the running server's files or restart its outputs.
const args = process.argv.slice(2);
if (args.length !== 2 || args.some(arg => arg.startsWith('-'))) {
  console.error('Usage: node scripts/export-config-rollback.ts <config-directory> <new-export-directory>');
  process.exitCode = 2;
} else {
  let validationDirectory: string | undefined;
  try {
    const source = path.resolve(args[0]);
    const destination = path.resolve(args[1]);
    const settingsDocument = JSON.parse(fs.readFileSync(path.join(source, 'settings.json'), 'utf8'));
    const rigDocument = JSON.parse(fs.readFileSync(path.join(source, 'show.json'), 'utf8'));
    if (settingsDocument.formatVersion !== 1 || rigDocument.formatVersion !== 1 || !rigDocument.show?.artnet) {
      throw new Error('Export requires version 1 settings and rig files; preserve legacy backups unchanged instead');
    }
    // Schema imports initialize the settings singleton. Isolate it from the source
    // so even malformed input cannot trigger a migration or quarantine there.
    validationDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'lightshow-rollback-validation-'));
    process.env.LIGHTSHOW_CONFIG_DIR = validationDirectory;
    const { DEFAULTS, schema } = await import('../src/server/settings.ts');
    const { showSchema } = await import('../src/server/validation.ts');
    const show = showSchema.parse(rigDocument.show);
    const raw = settingsDocument.values;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid settings values');
    const merged = structuredClone(DEFAULTS) as Record<string, unknown>;
    for (const [group, value] of Object.entries(raw)) {
      merged[group] = value && typeof value === 'object' && !Array.isArray(value)
        ? { ...(merged[group] as object), ...value } : value;
    }
    const values = schema.parse(merged);
    values.artnet = { ...values.artnet, ...show.artnet };
    values.outputs.armed = false;
    schema.parse(values);
    fs.mkdirSync(destination, { mode: 0o700 });
    for (const [name, value] of [['settings.json', values], ['show.json', show]] as const) {
      fs.writeFileSync(path.join(destination, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx', flush: true });
    }
    fs.writeFileSync(path.join(destination, 'COMPLETE.txt'),
      'Legacy settings/show export. Both files belong together. Stop the server and verify outputs are disarmed before restoring with the matching old binary.\n'
      + 'Legacy binaries apply former-default migrations to flat files. Recheck intentional picture grade and source-name choices after rollback.\n',
      { mode: 0o600, flag: 'wx', flush: true });
    console.log('Created protected legacy settings/show export. No running configuration was changed.');
  } catch (err) {
    console.error(`Rollback export failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    if (validationDirectory) fs.rmSync(validationDirectory, { recursive: true, force: true });
  }
}
