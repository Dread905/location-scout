import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterEventsNearby, flagEventKeywords, nearestVenue, ScoutEvent } from '../src/feeds/eventScout.js';

const bathurst = { lat: -33.419, lng: 149.577 };

function event(title: string, lat: number, lng: number): ScoutEvent {
  return { group: 'g', title, description: '', startTime: '', endTime: '', venueName: '', address: '', locality: '', lat, lng, imageUrl: null, category: '' };
}

test('filterEventsNearby: keeps only events within the radius', () => {
  const events = [
    event('Close by', bathurst.lat + 0.01, bathurst.lng), // ~1.1km
    event('Far away', bathurst.lat + 5, bathurst.lng), // ~555km
  ];
  const near = filterEventsNearby(events, bathurst.lat, bathurst.lng, 10);
  assert.deepEqual(near.map((e) => e.title), ['Close by']);
});

test('flagEventKeywords: case-insensitive title match', () => {
  const events = [event('Bathurst 1000 practice day', 0, 0), event('Farmers market', 0, 0)];
  const flagged = flagEventKeywords(events, ['bathurst 1000']);
  assert.equal(flagged[0].goodDuring, true);
  assert.equal(flagged[1].goodDuring, false);
});

test('nearestVenue: picks the closest venue across areas, within maxKm', () => {
  const venue = (name: string, lat: number, lon: number) => ({
    name, lat, lon, live: 50, typical: 40, score: 0.5, observedAt: null, busiestDay: null, busiestHour: null,
    quietestDay: null, openDays: [], shoot: false,
  });
  const areaVenues = [
    { slug: 'a', venues: [venue('Near', bathurst.lat + 0.005, bathurst.lng)] }, // ~0.55km
    { slug: 'b', venues: [venue('Farther', bathurst.lat + 0.015, bathurst.lng), venue('Too far', bathurst.lat + 1, bathurst.lng)] },
  ];
  const hit = nearestVenue(areaVenues, bathurst.lat, bathurst.lng);
  assert.equal(hit?.venue.name, 'Near');
  assert.equal(hit?.slug, 'a');
});

test('nearestVenue: null when nothing is within range', () => {
  const areaVenues = [{ slug: 'a', venues: [{ name: 'Distant', lat: bathurst.lat + 10, lon: bathurst.lng, live: null, typical: null, score: null, observedAt: null, busiestDay: null, busiestHour: null, quietestDay: null, openDays: [], shoot: false }] }];
  assert.equal(nearestVenue(areaVenues, bathurst.lat, bathurst.lng), null);
});
