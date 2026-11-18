/**
 * 本地 WebSocket 测试服务器（零依赖：手写握手 + 帧发送）
 * 用法：node scripts/ws-fixture.mjs [port] [frames] [intervalMs]
 */
import http from 'node:http';
import crypto from 'node:crypto';

const port = Number(process.argv[2] || 8123);
const frames = Number(process.argv[3] || 5);
const interval = Number(process.argv[4] || 200);

const server = http.createServer((req, res) => {
  res.writeHead(426, { 'content-type': 'text/plain' });
  res.end('upgrade required');
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );

  // 服务端 → 客户端帧（不掩码）
  const sendFrame = (text) => {
    const payload = Buffer.from(text, 'utf8');
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x81, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    socket.write(Buffer.concat([header, payload]));
  };

  let i = 0;
  let timer = null;
  const start = () => {
    timer = setInterval(() => {
      i++;
      sendFrame(JSON.stringify({ seq: i, price: 100 + i, ts: Date.now() }));
      if (i >= frames) {
        clearInterval(timer);
        // 发送关闭帧
        socket.write(Buffer.from([0x88, 0x00]));
        setTimeout(() => socket.destroy(), 100);
      }
    }, interval);
    timer.unref?.();
  };

  // 收到客户端消息就回显一次，然后开始推流
  socket.on('data', (buf) => {
    // 简化：任何数据都当作"订阅"，回一条确认后开始
    sendFrame(JSON.stringify({ ack: true, note: 'subscribed' }));
    start();
  });

  // 没收到订阅也推流（3 秒后）
  setTimeout(() => { if (!timer) start(); }, 3000).unref?.();

  socket.on('error', () => { /* ignore */ });
  socket.on('close', () => { if (timer) clearInterval(timer); });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`ws fixture on ws://127.0.0.1:${port} (${frames} frames @ ${interval}ms)`);
});
setTimeout(() => process.exit(0), 180000).unref?.();