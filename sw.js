/* Service worker: keeps the app shell available offline.
   Bump CACHE when index.html or words/*.js|css|json change so phones pick up the new version.
   Audio clips never change, so they live in their own cache that survives version bumps. */
"use strict";

const CACHE = "plan-v9";
const AUDIO_CACHE = "words-audio-v1";
const ASSETS = [
	"./", "./index.html", "./manifest.webmanifest", "./icon.svg", "./FORMAT.md",
	"./words/core.js", "./words/ui.js", "./words/words.css", "./words/course.json",
	...["audio", "back", "dictionary", "done", "grammar", "hint_letter", "history_back", "peek", "search", "settings", "stats", "translate"]
		.map(n => `./words/icons/${n}.svg`),
];

/** Pre-cache the app shell on install. */
self.addEventListener("install", event => {
	event.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

/** Drop caches from older versions (the audio cache stays). */
self.addEventListener("activate", event => {
	event.waitUntil(
		caches.keys()
			.then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== AUDIO_CACHE).map(k => caches.delete(k))))
			.then(() => self.clients.claim())
	);
});

/** Audio: cache first (clips are immutable); everything else: network first, cache as offline fallback. */
self.addEventListener("fetch", event => {
	if (event.request.method !== "GET" || !event.request.url.startsWith(self.location.origin)) return;
	const url = new URL(event.request.url);
	if (url.pathname.includes("/words/audio/")) {
		event.respondWith(
			caches.open(AUDIO_CACHE).then(cache => cache.match(url.href).then(hit => hit || fetch(url.href).then(res => {
				if (res.ok) cache.put(url.href, res.clone());
				return res;
			})))
		);
		return;
	}
	event.respondWith(
		// "no-cache" revalidates with the server, so a stale HTTP cache never hides an update
		fetch(new Request(event.request.url, { cache: "no-cache" }))
			.then(res => {
				if (res.ok) {
					const copy = res.clone();
					caches.open(CACHE).then(c => c.put(event.request, copy));
				}
				return res;
			})
			.catch(() => caches.match(event.request).then(r => r || caches.match("./index.html")))
	);
});
