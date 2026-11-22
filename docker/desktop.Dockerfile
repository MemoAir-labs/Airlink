# The self-hosted shared desktop: neko's XFCE image (Xorg, PulseAudio, GStreamer, Pion) with the
# apps an agent reaches for and a small control server that turns AirLink's mouse, keyboard and
# screenshot calls into xdotool and scrot. DESKTOP_EXTRAS=1 adds LibreOffice and Firefox (large).
# DESKTOP_CONTROL_TOKEN must be set at run time. Build context: this repository's root.
#
# The base weighs ~456 MB compressed (~1.2 GB unpacked), mostly Xorg, Mesa, GStreamer and CJK
# fonts this layer cannot remove; the install below adds ~65 MB. Only packages the base lacks
# are installed: xdotool already ships in neko's runtime and thunar comes with the xfce4
# metapackage, so what remains is nodejs (control.mjs), scrot (screenshots), xdg-utils (xdg-open)
# and mousepad (the editor op). The find keeps each package's copyright notice but drops the docs,
# changelogs and man pages nobody reads inside an image (man-db is not installed).
FROM ghcr.io/m1k1o/neko/xfce:3.2.0

ARG DESKTOP_EXTRAS=
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    nodejs scrot xdg-utils mousepad \
    ${DESKTOP_EXTRAS:+libreoffice-writer libreoffice-calc firefox-esr} \
  && find /usr/share/doc -mindepth 2 -type f ! -name copyright -delete \
  && rm -rf /usr/share/man/* \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/* /var/cache/apt/*

COPY docker/desktop/control.mjs /opt/desktop/control.mjs
COPY docker/desktop/control.conf /etc/neko/supervisord/control.conf

EXPOSE 8080 7000
