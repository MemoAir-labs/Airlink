# Laya, the open-source System One decision model (Apache-2.0), served behind TypeSafe's Jev wire
# (POST /v1/systemone) so live-server's decision node runs locally with no key. The multilingual
# checkpoint (322M, 100+ languages) is downloaded from the Hub on first start into /root/.cache;
# mount a volume there. CPU only: the CPU torch wheel is installed first, since the default wheel
# drags in two gigabytes of CUDA libraries this image never loads.
FROM python:3.12-slim

RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu \
  && pip install --no-cache-dir "laya[serve]==0.4.11"

ENV LAYA_HOST=0.0.0.0 \
    LAYA_PORT=8000 \
    LAYA_DEVICE=cpu \
    LAYA_MODELS=multilingual \
    LAYA_DEFAULT_MODEL=multilingual \
    LAYA_PRELOAD=1

EXPOSE 8000

CMD ["laya-serve"]
