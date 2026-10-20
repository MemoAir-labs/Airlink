import { NekoClient } from "@m1k1o/neko";

export type BrowserVideoConnection = {
  client: NekoClient;
  detach(): Promise<void>;
};

// A viewer's way onto the shared browser's own video: the browser container runs neko, which
// encodes its X screen to WebRTC; the session token comes from live-server (`browser-video`).
// Pixels only — input keeps going to live-server on the doc socket, so the session never hosts.
export async function connectBrowserVideo({
  url,
  token,
  container,
}: {
  url: string;
  token: string;
  container: HTMLElement;
}): Promise<BrowserVideoConnection> {
  const client = new NekoClient({ autoplay: true });
  client.setUrl(url);
  await client.authenticate(token);
  const detachVideo = client.transport.attach(container);
  client.mute();
  client.connect();
  return {
    client,
    async detach() {
      detachVideo();
      client.disconnect();
      await client.logout().catch(() => {});
    },
  };
}
