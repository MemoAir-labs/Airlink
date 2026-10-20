# The self-hosted shared desktop: neko's XFCE image (Xorg, PulseAudio, GStreamer, Pion) with the
# apps an agent reaches for and a small control server that turns AirLink's mouse, keyboard and
# screenshot calls into xdotool and scrot. DESKTOP_EXTRAS=1 adds LibreOffice and Firefox (large).
# DESKTOP_CONTROL_TOKEN must be set at run time. Build context: this repository's root.
FROM ghcr.io/m1k1o/neko/xfce:3.2.0

ARG DESKTOP_EXTRAS=
RUN apt-get update \
  && apt-get install -y --no-install-recommends xdotool scrot nodejs xdg-utils thunar mousepad \
    ${DESKTOP_EXTRAS:+libreoffice-writer libreoffice-calc firefox-esr} \
  && rm -rf /var/lib/apt/lists/*

COPY docker/desktop/control.mjs /opt/desktop/control.mjs
COPY docker/desktop/control.conf /etc/neko/supervisord/control.conf

EXPOSE 8080 7000
