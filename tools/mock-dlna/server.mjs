/**
 * 假 DLNA 渲染器：用于验证桌面端投屏发送链路（SSDP 发现 → 设备描述 → SOAP 控制）。
 *
 * 只实现测试需要的两个端点：/description.xml 与 /control/AVTransport。
 * 收到的 SOAP 动作会记录在内存里，测试脚本通过 GET /requests 读取。
 */

import dgram from 'node:dgram';
import http from 'node:http';

const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;

export function startMockRenderer({ ssdp = true, port = 0 } = {}) {
  const requests = [];

  const httpServer = http.createServer((req, res) => {
    if (req.url === '/description.xml') {
      const addr = `http://127.0.0.1:${httpServer.address().port}`;
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end(`<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <device>
    <deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
    <friendlyName>Mock TV 客厅</friendlyName>
    <manufacturer>Test</manufacturer>
    <UDN>uuid:test-mock-renderer</UDN>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:AVTransport</serviceId>
        <controlURL>/control/AVTransport</controlURL>
        <eventSubURL>/event/AVTransport</eventSubURL>
        <SCPDURL>/scpd/AVTransport.xml</SCPDURL>
      </service>
    </serviceList>
  </device>
</root>`);
      return;
    }
    if (req.url === '/requests') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(requests));
      return;
    }
    if (req.url === '/control/AVTransport') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        const action = /<u:([A-Za-z]+)[\s>]/.exec(body)?.[1] ?? '';
        const unescape = (value) =>
          value
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&apos;/g, "'")
            .replace(/&amp;/g, '&');
        const uri = unescape(/<CurrentURI>([\s\S]*?)<\/CurrentURI>/.exec(body)?.[1] ?? '');
        // CurrentURIMetaData 本身是转义过的 DIDL-Lite XML，真实设备会先反转义再解析
        const metaRaw = /<CurrentURIMetaData>([\s\S]*?)<\/CurrentURIMetaData>/.exec(body)?.[1] ?? '';
        const title = unescape(/<dc:title>([\s\S]*?)<\/dc:title>/.exec(unescape(metaRaw))?.[1] ?? '');
        requests.push({ action, uri, title, soapAction: req.headers.soapaction });
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        res.end(
          `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action}Response xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"></u:${action}Response></s:Body></s:Envelope>`
        );
      });
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  let ssdpSocket = null;

  return new Promise((resolve) => {
    httpServer.listen(port, '0.0.0.0', () => {
      const location = `http://127.0.0.1:${httpServer.address().port}/description.xml`;

      if (ssdp) {
        ssdpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        ssdpSocket.on('error', () => {});
        ssdpSocket.bind(SSDP_PORT, () => {
          try {
            ssdpSocket.addMembership(SSDP_ADDRESS);
          } catch {
            /* 某些环境不支持组播回环 */
          }
          ssdpSocket.on('message', (msg, rinfo) => {
            const text = msg.toString('utf8');
            if (!/^M-SEARCH/i.test(text)) return;
            const st = /^ST:\s*(.+)$/im.exec(text)?.[1]?.trim() ?? 'ssdp:all';
            const reply = [
              'HTTP/1.1 200 OK',
              'CACHE-CONTROL: max-age=1800',
              'EXT:',
              `LOCATION: ${location}`,
              'SERVER: Test/1.0 UPnP/1.0 MockRenderer/1.0',
              `ST: ${st}`,
              `USN: uuid:test-mock-renderer::${st}`,
              '',
              '',
            ].join('\r\n');
            ssdpSocket.send(Buffer.from(reply), rinfo.port, rinfo.address);
          });
        });
      }

      resolve({
        location,
        port: httpServer.address().port,
        requests,
        close: () =>
          new Promise((done) => {
            try {
              ssdpSocket?.close();
            } catch {
              /* ignore */
            }
            httpServer.close(() => done());
          }),
      });
    });
  });
}

// 直接运行时：启动并打印地址，方便手动验证
if (process.argv[1] && process.argv[1].endsWith('server.mjs')) {
  const server = await startMockRenderer();
  console.log(`mock renderer: ${server.location}`);
}
