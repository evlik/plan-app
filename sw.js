/* Service worker: keeps the app shell available offline.
   Bump CACHE when index.html changes so phones pick up the new version. */
"use strict";

const CACHE = "plan-v5";
const ASSETS = ["./", "./index.html", "./manifest.webmanifest", "./icon.svg", "./FORMAT.md"];

/** Pre-cache the app shell on install. */
self.addEventListener("install", event => {
	event.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

/** Drop caches from older versions. */
self.addEventListener("activate", event => {
	event.waitUntil(
		caches.keys()
			.then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
			.then(() => self.clients.claim())
	);
});

/** Network first for fresh updates, cache as offline fallback. */
self.addEventListener("fetch", event => {
	if (event.request.method !== "GET" || !event.request.url.startsWith(self.location.origin)) return;
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
