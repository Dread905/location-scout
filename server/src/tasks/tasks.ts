import { createRegistry } from './registry.js';
import { db } from '../db.js';
import { getSettings, Settings, tfnswKey } from '../settings.js';
import { syncRemote } from '../share.js';
import { runRailTask } from '../sources/rail.js';
import { runCandidatesTask } from '../sources/osm.js';
import { importStaticGtfs, TrainFeedName } from '../feeds/trains.js';

interface RemoteRow { id: string; owner_id: string; url: string }

const store = { get: db.getKv, set: db.setKv };
export const tasks = createRegistry(store);

/** Home plus every extra area: every ingestion source filters to these. */
function areasOf(settings: Settings) {
  return [settings.home, ...settings.areas];
}

tasks.register({
  name: 'sync-remotes',
  label: 'Sync remotes',
  description: 'Pull every configured remote instance\'s share link and upsert its spots and places.',
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
        log(`${remote.url}: ${result.places} places, ${result.spots} spots`);
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

tasks.register({
  name: 'rail-network',
  label: 'Rail network',
  description: 'Pull the rail lines and nearby industrial/mine sites from OpenStreetMap Overpass for the configured areas.',
  schedule: '0 4 * * 1', // Monday 4am
  intervalMinutes: () => 7 * 24 * 60,
  enabled: () => true,
  run: (log) => runRailTask(db, areasOf(getSettings(db)), log),
});

tasks.register({
  name: 'candidates',
  label: 'Candidate spots',
  description: 'Pull viewpoints, ruins and other OpenStreetMap points of interest for the configured areas.',
  schedule: '0 4 * * 2', // Tuesday 4am, off rail-network's hour
  intervalMinutes: () => 7 * 24 * 60,
  enabled: () => true,
  run: (log) => runCandidatesTask(db, areasOf(getSettings(db)), log),
});

function trainsStaticTask(feed: TrainFeedName, cron: string) {
  tasks.register({
    name: `trains-static-${feed}`,
    label: `Trains timetable: ${feed}`,
    description: `Pull the ${feed} GTFS static timetable and keep only trips touching the configured areas.`,
    schedule: cron,
    intervalMinutes: () => 7 * 24 * 60,
    enabled: () => Boolean(tfnswKey(db)),
    run: (log) => {
      const key = tfnswKey(db);
      if (!key) return Promise.resolve({ ok: true, message: 'Not configured (no TfNSW API key)' });
      return importStaticGtfs(db, feed, key, areasOf(getSettings(db)), log);
    },
  });
}
trainsStaticTask('nswtrains', '0 5 * * 1');
trainsStaticTask('sydneytrains', '0 5 * * 2');
