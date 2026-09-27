import { createRegistry } from './registry.js';
import { db } from '../db.js';
import { getSettings } from '../settings.js';
import { syncRemote } from '../share.js';

interface RemoteRow { id: string; owner_id: string; url: string }

const store = { get: db.getKv, set: db.setKv };
export const tasks = createRegistry(store);

tasks.register({
  name: 'sync-remotes',
  label: 'Sync remotes',
  description: 'Pull every configured remote instance\'s share link and upsert its spots, places and sightings.',
  schedule: '0 6 * * *', // daily at 6am
  intervalMinutes: () => 24 * 60,
  enabled: () => true,
  run: async (log) => {
    const remotes = db.handle.prepare('SELECT id, owner_id, url FROM remotes').all() as unknown as RemoteRow[];
    const allowPrivate = getSettings(db).allowPrivateRemotes;
    let ok = 0;
    let failed = 0;
    for (const remote of remotes) {
      try {
        const result = await syncRemote(db, remote, allowPrivate);
        db.handle.prepare('UPDATE remotes SET last_sync = ?, last_error = NULL WHERE id = ?').run(new Date().toISOString(), remote.id);
        log(`${remote.url}: ${result.places} places, ${result.spots} spots, ${result.sightings} sightings`);
        ok++;
      } catch (err) {
        const message = (err as Error).message;
        db.handle.prepare('UPDATE remotes SET last_error = ? WHERE id = ?').run(message, remote.id);
        log(`${remote.url}: failed — ${message}`);
        failed++;
      }
    }
    return { ok: failed === 0, message: `${ok} synced, ${failed} failed` };
  },
});
