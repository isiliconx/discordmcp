import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import type { DiscordRuntime } from './server.js';

const entry = fileURLToPath(new URL('./index.js', import.meta.url));
export async function runRecorder(runtime: DiscordRuntime) {
  if (runtime.config.authType === 'oauth') throw new Error('Continuous Gateway recording requires user or bot authentication. OAuth can archive REST reads only.');
  const archive = runtime.requireArchive(), owner = randomUUID();
  if (!archive.claimRecorder(owner)) throw new Error('A background recorder is already active for this archive.');
  let stopped = false, connecting = false, nextAttempt = 0, failure: string | null = null;
  const shutdown = () => {
    if (stopped) return;
    stopped = true; clearInterval(timer); archive.releaseRecorder(owner); runtime.close();
  };
  const tick = async () => {
    if (stopped) return;
    const safety = runtime.pacer?.status();
    if (safety?.paused && !safety.resume_after) {
      runtime.gateway.disconnect(); archive.heartbeat(owner, 'paused', safety.reason); return;
    }
    const status = runtime.gateway.status();
    if (!archive.heartbeat(owner, status.state, failure ?? status.last_error)) { shutdown(); return; }
    if (!connecting && status.state === 'disconnected' && Date.now() >= nextAttempt) {
      connecting = true;
      try { await runtime.gateway.connect(); failure = null; }
      catch { nextAttempt = Date.now() + 60_000; failure = 'Gateway connection unavailable; retrying in at least 60 seconds. Content during unresumable gaps may be missing.'; }
      finally { connecting = false; }
      if (!stopped) archive.heartbeat(owner, runtime.gateway.status().state, failure);
    }
  };
  const timer = setInterval(() => { void tick().catch(() => { console.error('Recorder could not update its database; stopping.'); shutdown(); process.exitCode = 1; }); }, 5000);
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  process.once('exit', shutdown);
  await tick();
  console.error('Discord message recorder started. Query discord_archive_status to inspect coverage and connection state.');
}

export async function archiveCommand(runtime: DiscordRuntime, command: string, envFile?: string) {
  const archive = runtime.requireArchive();
  if (command === 'status') { process.stdout.write(JSON.stringify(archive.status(), null, 2) + '\n'); return; }
  if (command === 'start') {
    if (archive.status().recorder?.active) { process.stdout.write('A background recorder is already active.\n'); return; }
    if (!envFile) throw new Error('Background start requires --env-file with an absolute credential-file path.');
    const descriptor = openSync(archive.path + '.recorder.log', 'a', 0o600);
    const child = spawn(process.execPath, [entry, '--archive-only', '--env-file', envFile], {
      detached: true, stdio: ['ignore', descriptor, descriptor], windowsHide: true,
    });
    closeSync(descriptor);
    let spawnError = false; child.once('error', () => { spawnError = true; }); child.unref();
    for (let attempt = 0; attempt < 50; attempt++) {
      if (spawnError) throw new Error('Could not launch the background recorder.');
      const status = archive.status().recorder;
      if (status?.active && status.state === 'ready') { process.stdout.write('Background message recorder is connected.\n'); return; }
      await sleep(500);
    }
    if (!archive.status().recorder?.active) throw new Error('Background recorder did not start. Inspect the private recorder log beside the archive database.');
    process.stdout.write('Background recorder started; connection is still pending. Inspect discord_archive_status.\n');
    return;
  }
  if (command === 'stop') {
    const recorder = archive.status().recorder;
    if (!recorder?.active) { process.stdout.write('No active background recorder.\n'); return; }
    if (process.platform !== 'linux') throw new Error('Use your OS service manager to stop recording on this platform.');
    let argv: string[];
    try { argv = readFileSync(`/proc/${recorder.pid}/cmdline`, 'utf8').split('\0'); }
    catch { throw new Error('Recorder process could not be verified; no signal was sent.'); }
    if (!argv.includes(entry) || !argv.includes('--archive-only') || (envFile && !argv.includes(envFile))) throw new Error('Recorder process identity did not match; no signal was sent.');
    process.kill(recorder.pid, 'SIGTERM');
    for (let attempt = 0; attempt < 20; attempt++) {
      if (!archive.status().recorder?.active) { process.stdout.write('Background message recorder stopped.\n'); return; }
      await sleep(250);
    }
    throw new Error('Recorder is still shutting down. Inspect archive status before restarting.');
  }
  throw new Error('Usage: discordmcp archive start|stop|status --env-file /absolute/path/.env');
}
