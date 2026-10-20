# The code runner: Python 3 with the data libraries agents reach for, Node 22 with npm, and
# bubblewrap, plus the control server AirLink posts scripts to. Each run is jailed by bubblewrap
# inside this container. It starts as root to install its egress firewall (start.sh, which needs
# NET_ADMIN) and then runs the control server as `runner` with no capabilities;
# RUNNER_CONTROL_TOKEN must be set at run time. Build context: this
# repository's root.
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip bubblewrap util-linux iptables iproute2 ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN pip3 install --no-cache-dir --break-system-packages \
  pandas==2.2.3 numpy==2.1.3 matplotlib==3.9.2 requests==2.32.3 openpyxl==3.1.5
# Matplotlib's font list, built once here and copied into each run's /tmp (its MPLCONFIGDIR).
RUN MPLCONFIGDIR=/usr/local/share/runner-fonts python3 -c "import matplotlib.font_manager" \
  && chmod -R a+rX /usr/local/share/runner-fonts

RUN useradd --create-home --uid 10001 runner \
  && mkdir -p /var/runner && chown runner /var/runner && chmod 700 /var/runner
COPY docker/runner/control.mjs /opt/runner/control.mjs
COPY --chmod=755 docker/runner/start.sh /opt/runner/start.sh

ENV RUNNER_WORK_DIR=/var/runner RUNNER_FONT_CACHE=/usr/local/share/runner-fonts
EXPOSE 7000
CMD ["/opt/runner/start.sh"]
