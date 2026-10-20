# The shared live browser: neko's Chromium image (Xorg, PulseAudio, GStreamer, Pion) with its own
# Chromium launch (kiosk, every page connection through live-server's pinning proxy) and its own
# policy file. Chromium binds CDP on loopback only in headed mode, so socat forwards 9223 to it for
# live-server. LIVE_BROWSER_PROXY must be set at run time. Build context: this repository's root.
FROM ghcr.io/m1k1o/neko/chromium:3.2.0

RUN apt-get update && apt-get install -y --no-install-recommends socat && rm -rf /var/lib/apt/lists/*

COPY docker/neko/chromium.conf /etc/neko/supervisord/chromium.conf
COPY docker/neko/policies.json /etc/chromium/policies/managed/policies.json

EXPOSE 8080 9223
