/**
 * 桌面端 DLNA 投屏（发送端）。
 *
 * 做三件事：
 * 1. SSDP 组播搜索局域网内的 MediaRenderer（电视 / 盒子 / 投影）；
 * 2. 拉取设备描述，找到 AVTransport 的控制地址；
 * 3. 通过 SOAP 把当前播放地址推给设备（SetAVTransportURI + Play）。
 *
 * 刻意不依赖 Electron：纯 Node 实现，便于用假渲染器做端到端测试。
 */

import dgram from 'node:dgram';

const SSDP_HOST = '239.255.255.250';
const SSDP_PORT = 1900;
const AVT_SERVICE = 'urn:schemas-upnp-org:service:AVTransport:1';

export interface DlnaDevice {
  /** 设备友好名 */
  name: string;
  /** 设备描述 URL */
  location: string;
  /** AVTransport 控制地址 */
  controlUrl: string;
}

interface DiscoverOptions {
  /** 搜索等待时间（毫秒），局域网通常 1-2 秒足够 */
  timeoutMs?: number;
  /** 额外指定的设备描述地址（手动添加） */
  locations?: string[];
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 从设备描述 XML 中提取名称与 AVTransport 控制地址 */
export function parseDeviceDescription(xml: string, location: string): DlnaDevice | null {
  const nameMatch = /<friendlyName>([\s\S]*?)<\/friendlyName>/i.exec(xml);
  const serviceBlocks = xml.match(/<service>[\s\S]*?<\/service>/gi) ?? [];
  for (const block of serviceBlocks) {
    if (!block.includes(AVT_SERVICE)) continue;
    const control = /<controlURL>([\s\S]*?)<\/controlURL>/i.exec(block)?.[1]?.trim();
    if (!control) continue;
    let controlUrl: string;
    try {
      controlUrl = new URL(control, location).href;
    } catch {
      continue;
    }
    return {
      name: nameMatch ? decodeXml(nameMatch[1]) : new URL(location).hostname,
      location,
      controlUrl,
    };
  }
  return null;
}

async function describe(location: string): Promise<DlnaDevice | null> {
  try {
    const res = await fetch(location, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    return parseDeviceDescription(await res.text(), location);
  } catch {
    return null;
  }
}

/** SSDP 搜索：返回局域网内可投屏的设备 */
export async function discoverDevices(options: DiscoverOptions = {}): Promise<DlnaDevice[]> {
  const timeoutMs = options.timeoutMs ?? 2200;
  const locations = new Set<string>(options.locations ?? []);

  await new Promise<void>((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      try {
        socket.close();
      } catch {
        /* 已关闭 */
      }
      resolve();
    };

    socket.on('message', (msg, rinfo) => {
      const text = msg.toString('utf8');
      const location = /^location:\s*(.+)$/im.exec(text)?.[1]?.trim();
      if (location && /^https?:\/\//i.test(location)) {
        locations.add(location);
        // 回包不带端口时补上来源端口（极少数设备如此）
        void rinfo;
      }
    });

    socket.on('error', () => finish());
    socket.bind(() => {
      try {
        socket.setBroadcast(true);
      } catch {
        /* 部分网卡不支持广播 */
      }
      const targets = [AVT_SERVICE, 'ssdp:all'];
      for (const st of targets) {
        const message = Buffer.from(
          [
            'M-SEARCH * HTTP/1.1',
            `HOST: ${SSDP_HOST}:${SSDP_PORT}`,
            'MAN: "ssdp:discover"',
            'MX: 2',
            `ST: ${st}`,
            '',
            '',
          ].join('\r\n')
        );
        try {
          socket.send(message, 0, message.length, SSDP_PORT, SSDP_HOST);
        } catch {
          /* 网络不可用时静默跳过 */
        }
      }
      setTimeout(finish, timeoutMs);
    });
  });

  const devices = await Promise.all([...locations].map(describe));
  const unique = new Map<string, DlnaDevice>();
  for (const device of devices) {
    if (device && !unique.has(device.controlUrl)) unique.set(device.controlUrl, device);
  }
  return [...unique.values()];
}

function buildMetadata(url: string, title: string): string {
  return (
    '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">' +
    '<item id="0" parentID="-1" restricted="1">' +
    `<dc:title>${escapeXml(title)}</dc:title>` +
    '<upnp:class>object.item.videoItem</upnp:class>' +
    `<res protocolInfo="http-get:*:video/mp4:*">${escapeXml(url)}</res>` +
    '</item></DIDL-Lite>'
  );
}

async function soap(controlUrl: string, action: string, args: Record<string, string | number>): Promise<string> {
  const argsXml = Object.entries(args)
    .map(([key, value]) => `<${key}>${typeof value === 'number' ? value : escapeXml(String(value))}</${key}>`)
    .join('');
  const body =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    `<s:Body><u:${action} xmlns:u="${AVT_SERVICE}">${argsXml}</u:${action}></s:Body></s:Envelope>`;

  const res = await fetch(controlUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset="utf-8"',
      SOAPACTION: `"${AVT_SERVICE}#${action}"`,
    },
    body,
    signal: AbortSignal.timeout(6000),
  });
  const text = await res.text();
  if (!res.ok) {
    // UPnP 错误也返回 200，真正的失败通常在 body 的 errorCode 里
    throw new Error(`投屏失败（HTTP ${res.status}）`);
  }
  const errorCode = /<errorCode>(\d+)<\/errorCode>/i.exec(text)?.[1];
  if (errorCode && errorCode !== '0') {
    const description = /<errorDescription>([\s\S]*?)<\/errorDescription>/i.exec(text)?.[1];
    throw new Error(`设备拒绝投屏（${errorCode}${description ? `：${decodeXml(description)}` : ''}）`);
  }
  return text;
}

/** 把视频地址推送到设备并开始播放 */
export async function castToDevice(device: DlnaDevice, url: string, title: string): Promise<void> {
  await soap(device.controlUrl, 'SetAVTransportURI', {
    InstanceID: 0,
    CurrentURI: url,
    CurrentURIMetaData: buildMetadata(url, title),
  });
  await soap(device.controlUrl, 'Play', { InstanceID: 0, Speed: 1 });
}

/** 停止设备上的投屏 */
export async function stopCast(device: DlnaDevice): Promise<void> {
  await soap(device.controlUrl, 'Stop', { InstanceID: 0 });
}
